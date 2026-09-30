import { Monitor } from ".";
import { TransactionLocation } from "../types/transaction-location";
import { BlockHash } from "../types/block-hash";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve();
    }, ms);
  });
}

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
    if (this._latestTransactionLocation !== null) {
      const { nextBlockIndex, remainedEvents } = await this.processRemains(
        this._latestTransactionLocation
      );

      for (const remainedEvent of remainedEvents) {
        yield remainedEvent;
      }

      this.latestBlockNumber = nextBlockIndex;
    } else {
      this.latestBlockNumber = await this.getTipIndex();
    }

    while (true) {
      try {
        const tipIndex = await this.getTipIndex();
        this.debug("Try to check trigger at", this.latestBlockNumber + 1);
        if (this.latestBlockNumber + 1 <= tipIndex) {
          const backlogSize = tipIndex - this.latestBlockNumber;

          if (backlogSize > this._catchUpThresholdBlocks) {
            yield* this.catchUp(this.latestBlockNumber + 1, tipIndex);
          } else {
            const trigerredBlockIndexes = this.triggerredBlocks(
              this.latestBlockNumber + 1
            );

            for (const blockIndex of trigerredBlockIndexes) {
              this.debug("Execute triggerred block #", blockIndex);
              const blockHash = await this.getBlockHash(blockIndex);

              yield {
                blockHash,
                events: await this.getEvents(blockIndex),
              };
            }

            this.latestBlockNumber += 1;
          }
        } else {
          this.debug(
            `Skip check trigger current: ${this.latestBlockNumber} / tip: ${tipIndex}`
          );

          await delay(this._delayMilliseconds);
        }

        this.consecutiveErrorCount = 0;
      } catch (error) {
        this.consecutiveErrorCount += 1;
        const backoffDelay = Math.min(
          this._delayMilliseconds * 2 ** (this.consecutiveErrorCount - 1),
          this._maxDelayMilliseconds
        );

        this.error(
          `Ignore and continue loop without breaking though unexpected error occurred (consecutive errors: ${this.consecutiveErrorCount}, backing off ${backoffDelay}ms):`,
          error
        );

        await delay(backoffDelay);
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
    const eventsByBlockIndex =
      triggeredIndexes.length > 0
        ? await this.getEventsInRange(
            triggeredIndexes[0],
            triggeredIndexes[triggeredIndexes.length - 1]
          )
        : new Map<number, (TEventData & TransactionLocation)[]>();

    for (const { scanIndex, triggeredIndexes } of batch) {
      for (const blockIndex of triggeredIndexes) {
        this.debug("Execute triggerred block #", blockIndex);
        const blockHash = await this.getBlockHash(blockIndex);
        yield { blockHash, events: eventsByBlockIndex.get(blockIndex) ?? [] };
      }
      // Resuming after yield means the consumer finished this scan position.
      // Keep the scan index (not the confirmation-offset event block index)
      // so a later RPC failure cannot replay the already completed prefix.
      this.latestBlockNumber = scanIndex;
      this.consecutiveErrorCount = 0;
    }
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
