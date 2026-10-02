import { Monitor } from ".";
import { TransactionLocation } from "../types/transaction-location";
import { BlockHash } from "../types/block-hash";

type ProcessRemainsResult<TEventData> = {
  nextBlockIndex: number;
  remainedEvents: RemainedEvent<TEventData>[];
};
type RemainedEvent<TEventData> = {
  blockHash: string;
  events: (TEventData & TransactionLocation)[];
};

export abstract class TriggerableMonitor<TEventData> extends Monitor<
  TEventData & TransactionLocation
> {
  private latestBlockNumber: number | undefined;
  private consecutiveErrorCount: number = 0;

  private readonly _latestTransactionLocation: TransactionLocation | null;
  private readonly _delayMilliseconds: number;
  private readonly _maxDelayMilliseconds: number;
  private readonly _catchUpThresholdBlocks: number;
  private readonly _maxCatchUpBatchSize: number;

  constructor(
    latestTransactionLocation: TransactionLocation | null,
    delayMilliseconds: number = 15 * 1000,
    maxDelayMilliseconds: number = 5 * 60 * 1000,
    catchUpThresholdBlocks: number = 10,
    maxCatchUpBatchSize: number = 1000
  ) {
    super();

    this._latestTransactionLocation = latestTransactionLocation;
    this._delayMilliseconds = delayMilliseconds;
    this._maxDelayMilliseconds = maxDelayMilliseconds;
    this._catchUpThresholdBlocks = catchUpThresholdBlocks;
    this._maxCatchUpBatchSize = maxCatchUpBatchSize;
  }

  async *loop(): AsyncIterableIterator<{
    blockHash: BlockHash;
    events: (TEventData & TransactionLocation)[];
  }> {
    while (!this.stopped) {
      try {
        let waitAtTip = false;
        // Keep tip, headers and logs on the same endpoint. A slow but healthy
        // secondary may need longer than the normal primary cooldown to finish.
        const releaseSession = await this.beginReadSession();
        try {
          if (this.stopped) return;
          // Startup reads need the same retry/backoff as later ranges. A single
          // unavailable checkpoint RPC must not permanently close the iterator.
          if (this.latestBlockNumber === undefined) {
            if (this._latestTransactionLocation !== null) {
              const { nextBlockIndex, remainedEvents } =
                await this.processRemains(this._latestTransactionLocation);
              for (const remainedEvent of remainedEvents) {
                if (this.stopped) return;
                yield remainedEvent;
              }
              this.latestBlockNumber = nextBlockIndex;
            } else {
              this.latestBlockNumber = await this.getTipIndex();
            }
            this.consecutiveErrorCount = 0;
          }
          const tipIndex = await this.getTipIndex();
          if (this.stopped) return;
          this.debug("Try to check trigger at", this.latestBlockNumber + 1);
          if (this.latestBlockNumber + 1 <= tipIndex) {
            const backlogSize = tipIndex - this.latestBlockNumber;

            if (backlogSize > this._catchUpThresholdBlocks) {
              yield* this.catchUp(this.latestBlockNumber + 1, tipIndex);
              waitAtTip =
                this.shouldThrottleAtTip() &&
                this.latestBlockNumber >= tipIndex;
            } else {
              const trigerredBlockIndexes = this.triggerredBlocks(
                this.latestBlockNumber + 1
              );

              for (const blockIndex of trigerredBlockIndexes) {
                this.debug("Execute triggerred block #", blockIndex);
                const blockHash = await this.getBlockHash(blockIndex);

                const events = await this.getEvents(blockIndex);
                if (this.stopped) return;
                yield { blockHash, events };
              }

              this.latestBlockNumber += 1;
            }
          } else {
            this.debug(
              `Skip check trigger current: ${this.latestBlockNumber} / tip: ${tipIndex}`
            );

            waitAtTip = true;
          }

          this.consecutiveErrorCount = 0;
        } finally {
          releaseSession();
        }
        // A fast chain can advance during every RPC round. Still wait after
        // draining the observed tip, so normal traffic is time-bounded instead
        // of chasing each newly produced block. Release the endpoint first.
        if (waitAtTip) await this.wait(this._delayMilliseconds);
      } catch (error) {
        if (this.stopped) return;
        this.consecutiveErrorCount += 1;
        const backoffDelay = Math.min(
          this._delayMilliseconds * 2 ** (this.consecutiveErrorCount - 1),
          this._maxDelayMilliseconds
        );

        this.error(
          `Ignore and continue loop without breaking though unexpected error occurred (consecutive errors: ${this.consecutiveErrorCount}, backing off ${backoffDelay}ms):`,
          error
        );

        await this.wait(backoffDelay);
      }
    }
  }

  /**
   * Catches up on a backlog of blocks between the last processed block and
   * the current chain tip. Batches the underlying event range query (see
   * `getEventsInRange`) so that catching up after a long gap (e.g. after an
   * RPC endpoint switch, or after downtime) does not cost one `getLogs` (or
   * equivalent) call per block.
   */
  private async *catchUp(
    fromBlockIndex: number,
    tipIndex: number
  ): AsyncIterableIterator<{
    blockHash: BlockHash;
    events: (TEventData & TransactionLocation)[];
  }> {
    const batchToBlockIndex = Math.min(
      fromBlockIndex - 1 + this._maxCatchUpBatchSize,
      tipIndex
    );

    this.debug(
      `Catching up backlog: batching blocks ${fromBlockIndex}-${batchToBlockIndex} (tip: ${tipIndex})`
    );

    const batch: { scanIndex: number; triggeredIndexes: number[] }[] = [];
    for (
      let scanIndex = fromBlockIndex;
      scanIndex <= batchToBlockIndex;
      scanIndex++
    ) {
      batch.push({
        scanIndex,
        triggeredIndexes: this.triggerredBlocks(scanIndex),
      });
    }
    const triggeredIndexes = batch.flatMap((block) => block.triggeredIndexes);
    // The range endpoint commits to all of its ancestors, including blocks
    // with no events. Confirmations alone do not make cached logs immutable.
    const anchorIndex = triggeredIndexes[triggeredIndexes.length - 1];
    const anchorHash =
      anchorIndex === undefined
        ? undefined
        : await this.getBlockHash(anchorIndex);
    const readEpoch = this.getReadEpoch();
    const assertReadEpoch = () => {
      // Comparing endpoint identities only at the boundaries misses A -> B -> A.
      // Any intervening dispatch to another endpoint invalidates cached logs.
      if (this.getReadEpoch() !== readEpoch) {
        throw new Error("RPC endpoint changed while reading burn events");
      }
    };
    const assertAnchor = async () => {
      assertReadEpoch();
      if (
        anchorHash !== undefined &&
        (await this.getBlockHash(anchorIndex)) !== anchorHash
      ) {
        throw new Error(
          `Chain changed while reading burn events at block ${anchorIndex}`
        );
      }
      assertReadEpoch();
    };
    const eventsByBlockIndex =
      triggeredIndexes.length > 0
        ? await this.getEventsInRange(
            triggeredIndexes[0],
            triggeredIndexes[triggeredIndexes.length - 1]
          )
        : new Map<number, (TEventData & TransactionLocation)[]>();
    await assertAnchor();

    const coalesceEmptyBlocks = this.coalesceEmptyBlocks();
    for (const { scanIndex, triggeredIndexes } of batch) {
      let yieldedEvents = false;
      for (const blockIndex of triggeredIndexes) {
        const events = eventsByBlockIndex.get(blockIndex) ?? [];
        if (coalesceEmptyBlocks && events.length === 0) continue;
        this.debug("Execute triggerred block #", blockIndex);
        const blockHash = await this.getBlockHash(blockIndex);
        await assertAnchor();
        if (events.some((event) => event.blockHash !== blockHash)) {
          throw new Error(
            `Burn logs disagree with block hash at ${blockIndex}`
          );
        }
        if (this.stopped) return;
        yield { blockHash, events };
        yieldedEvents = true;
      }
      // Resuming after yield means the consumer finished this scan position.
      // Keep the scan index (not the confirmation-offset event block index)
      // so a later RPC failure cannot replay the already completed prefix.
      // Coalesced empty positions remain uncommitted until the next verified
      // event or end checkpoint is consumed. A changed branch can add burns
      // to those empty positions, so a retry must query them again.
      if (!coalesceEmptyBlocks || yieldedEvents) {
        this.latestBlockNumber = scanIndex;
        this.consecutiveErrorCount = 0;
      }
    }

    if (coalesceEmptyBlocks) {
      if (
        anchorHash !== undefined &&
        (eventsByBlockIndex.get(anchorIndex)?.length ?? 0) === 0
      ) {
        // Persist the empty suffix once. Never overwrite a last-block event
        // checkpoint with txId=null when no empty suffix exists.
        await assertAnchor();
        if (this.stopped) return;
        yield { blockHash: anchorHash, events: [] };
      }
      this.latestBlockNumber = batchToBlockIndex;
      this.consecutiveErrorCount = 0;
    }
  }

  // Subclasses with ordered, one-block triggers may persist an entire empty
  // suffix as one checkpoint instead of emitting every empty block.
  protected coalesceEmptyBlocks(): boolean {
    return false;
  }

  /** A monotonically increasing routing version, when the provider supports it. */
  protected getReadEpoch(): number | undefined {
    return undefined;
  }

  protected async beginReadSession(): Promise<() => void> {
    return () => undefined;
  }

  protected shouldThrottleAtTip(): boolean {
    return false;
  }

  protected abstract processRemains(
    transactionLocation: TransactionLocation
  ): Promise<ProcessRemainsResult<TEventData>>;

  protected abstract triggerredBlocks(blockIndex: number): number[];

  private debug(message?: any, ...optionalParams: any[]): void {
    console.debug(`[${this.constructor.name}]`, message, ...optionalParams);
  }

  private error(message?: any, ...optionalParams: any[]): void {
    console.error(`[${this.constructor.name}]`, message, ...optionalParams);
  }

  protected abstract getBlockIndex(blockHash: string): Promise<number>;

  protected abstract getBlockHash(blockIndex: number): Promise<string>;

  protected abstract getTipIndex(): Promise<number>;

  protected abstract getEvents(
    blockIndex: number
  ): Promise<(TEventData & TransactionLocation)[]>;

  /**
   * Fetches events for every block index in `[fromBlockIndex, toBlockIndex]`
   * in as few RPC calls as possible. The default implementation simply calls
   * `getEvents` once per block, so it is always correct, but subclasses whose
   * underlying RPC supports a ranged query (e.g. `eth_getLogs` with a block
   * range) should override this to batch that query instead.
   */
  protected async getEventsInRange(
    fromBlockIndex: number,
    toBlockIndex: number
  ): Promise<Map<number, (TEventData & TransactionLocation)[]>> {
    const eventsByBlockIndex = new Map<
      number,
      (TEventData & TransactionLocation)[]
    >();

    for (
      let blockIndex = fromBlockIndex;
      blockIndex <= toBlockIndex;
      blockIndex++
    ) {
      eventsByBlockIndex.set(blockIndex, await this.getEvents(blockIndex));
    }

    return eventsByBlockIndex;
  }
}
