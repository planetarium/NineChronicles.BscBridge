import { EventData } from "web3-eth-contract";
import { TriggerableMonitor } from "./triggerable-monitor";
import { ContractDescription } from "../types/contract-description";
import { TransactionLocation } from "../types/transaction-location";
import { ethers } from "ethers";
import { PrimaryRpcProvider } from "../primary-rpc-provider";

const BURN_EVENT_SIG = "SentToLibPlanet(address,uint256,bytes32)";

// Conservative chunk size for a single `eth_getLogs` range query when
// catching up on a backlog of blocks. Most RPC providers (including Infura)
// cap the block range (and/or result size) of a single `getLogs` call, so
// this keeps each request well within typical limits.
const MAX_LOGS_RANGE_SIZE = 1000;
const MAX_REORG_RECOVERY_DEPTH = 1000;

export class BscBurnEventMonitor extends TriggerableMonitor<EventData> {
  private readonly _provider: ethers.providers.BaseProvider;
  private readonly _contract: ethers.Contract;
  private readonly _contractDescription: ContractDescription;
  private readonly _confirmations: number;

  constructor(
    provider: ethers.providers.BaseProvider,
    contractDescription: ContractDescription,
    latestTransactionLocation: TransactionLocation | null,
    confirmations: number
  ) {
    // Always scan a bounded range, including when fewer than ten blocks lag.
    super(latestTransactionLocation, undefined, undefined, 0);

    this._provider = provider;
    this._contract = new ethers.Contract(
      contractDescription.address,
      contractDescription.abi,
      this._provider
    );
    this._contractDescription = contractDescription;
    this._confirmations = confirmations;
  }
  protected async processRemains(transactionLocation: TransactionLocation) {
    const savedBlock = await this.getRecoveryBlock(
      transactionLocation.blockHash
    );
    // The first successful dispatch selects this session's endpoint. Capture
    // its epoch afterward so selecting a healthy fallback is not a change
    // within the recovery read itself.
    const readEpoch = this.getReadEpoch();
    const blockIndex = savedBlock.number;
    const tipIndex = await this.getTipIndex();
    if (
      !Number.isSafeInteger(tipIndex) ||
      tipIndex < blockIndex + this._confirmations
    ) {
      // Also wait before orphan recovery: a lagging endpoint must not move
      // the persisted checkpoint backward before it confirms this height.
      throw new Error(
        `Cannot resume checkpoint block ${blockIndex}: RPC tip ${tipIndex} has fewer than ${this._confirmations} confirmations`
      );
    }
    const anchor = await this.getRecoveryBlock(blockIndex);
    const assertStableRead = async () => {
      const currentAnchor = await this.getRecoveryBlock(blockIndex);
      if (
        currentAnchor.hash !== anchor.hash ||
        this.getReadEpoch() !== readEpoch
      ) {
        throw new Error(
          `Chain or RPC endpoint changed while resuming block ${blockIndex}`
        );
      }
    };

    if (savedBlock.hash !== anchor.hash) {
      let ancestor = savedBlock;
      let depth = 0;
      while (
        ancestor.hash !== (await this.getRecoveryBlock(ancestor.number)).hash
      ) {
        if (depth >= MAX_REORG_RECOVERY_DEPTH || ancestor.number === 0) {
          throw new Error(
            `Cannot recover orphan checkpoint: no common ancestor within ${MAX_REORG_RECOVERY_DEPTH} blocks`
          );
        }
        if (!ancestor.parentHash) {
          throw new Error(
            `Cannot recover orphan checkpoint: parent hash unavailable at block ${ancestor.number}`
          );
        }
        const parent = await this.getRecoveryBlock(ancestor.parentHash);
        if (parent.number !== ancestor.number - 1) {
          throw new Error(
            `Cannot recover orphan checkpoint: invalid parent height at block ${ancestor.number}`
          );
        }
        ancestor = parent;
        depth += 1;
      }
      await assertStableRead();
      // Replaying the replaced branch relies on the observer's persisted
      // source-transaction history in the same database to suppress payouts
      // for transactions that were already processed and are included again.
      return {
        nextBlockIndex: ancestor.number + this._confirmations,
        remainedEvents: [{ blockHash: ancestor.hash, events: [] }],
      };
    }

    const events = await this.getEvents(blockIndex);
    if (
      events.some(
        (event) =>
          event.blockHash !== anchor.hash || event.blockNumber !== blockIndex
      )
    ) {
      throw new Error(`Burn logs disagree with checkpoint block ${blockIndex}`);
    }
    let returnEvents = events;
    if (transactionLocation.txId !== null) {
      const cursorIndex = events.findIndex(
        (event) => event.txId === transactionLocation.txId
      );
      if (cursorIndex === -1) {
        throw new Error(
          `Checkpoint transaction ${transactionLocation.txId} is missing from block ${blockIndex}`
        );
      }
      returnEvents = events.slice(cursorIndex + 1);
    }
    // A null cursor proves no transaction was saved, not that the RPC logs
    // are empty. Replay them; the same-database observer history deduplicates.
    await assertStableRead();

    return {
      nextBlockIndex: blockIndex + this._confirmations,
      remainedEvents: [
        {
          blockHash: transactionLocation.blockHash,
          events: returnEvents,
        },
      ],
    };
  }

  protected getReadEpoch(): number | undefined {
    return this._provider instanceof PrimaryRpcProvider
      ? this._provider.readEpoch
      : undefined;
  }

  protected async beginReadSession(): Promise<() => void> {
    return this._provider instanceof PrimaryRpcProvider
      ? this._provider.beginReadSession()
      : () => undefined;
  }

  private async getRecoveryBlock(
    indexOrHash: number | string
  ): Promise<ethers.providers.Block> {
    const block = await this._provider.getBlock(indexOrHash);
    if (
      !block ||
      !Number.isSafeInteger(block.number) ||
      block.number < 0 ||
      !block.hash
    ) {
      throw new Error(
        `Cannot recover checkpoint: block header unavailable or invalid for ${indexOrHash}`
      );
    }
    if (
      typeof indexOrHash === "string"
        ? block.hash !== indexOrHash
        : block.number !== indexOrHash
    ) {
      throw new Error(
        `Cannot recover checkpoint: block header disagrees with ${indexOrHash}`
      );
    }
    return block;
  }

  protected coalesceEmptyBlocks(): boolean {
    return true;
  }

  protected shouldThrottleAtTip(): boolean {
    return true;
  }

  protected triggerredBlocks(blockIndex: number): number[] {
    const confirmedBlockIndex = blockIndex - this._confirmations;
    if (confirmedBlockIndex >= 0) {
      return [confirmedBlockIndex];
    }

    return [];
  }

  protected async getBlockIndex(blockHash: string) {
    const block = await this._provider.getBlock(blockHash);
    return block.number;
  }

  protected getTipIndex(): Promise<number> {
    return this._provider.getBlockNumber();
  }

  protected async getBlockHash(blockIndex: number): Promise<string> {
    const block = await this._provider.getBlock(blockIndex);
    return block.hash;
  }

  protected async getEvents(blockIndex: number) {
    const pastEvents = await this._provider.getLogs({
      address: this._contractDescription.address,
      topics: [ethers.utils.id(BURN_EVENT_SIG)], // This is equal with Web3.utils.sha3
      fromBlock: blockIndex,
      toBlock: blockIndex,
    });

    return this.parseEvents(pastEvents);
  }

  /**
   * Fetches and parses `SentToLibPlanet` events for every block index in
   * `[fromBlockIndex, toBlockIndex]` using ranged `eth_getLogs` calls instead
   * of one call per block, chunked to `MAX_LOGS_RANGE_SIZE` blocks per call
   * to stay within typical RPC provider limits. Used when catching up on a
   * backlog (see `TriggerableMonitor.catchUp`).
   */
  protected async getEventsInRange(
    fromBlockIndex: number,
    toBlockIndex: number
  ): Promise<Map<number, (EventData & TransactionLocation)[]>> {
    const eventsByBlockIndex = new Map<
      number,
      (EventData & TransactionLocation)[]
    >();

    for (
      let blockIndex = fromBlockIndex;
      blockIndex <= toBlockIndex;
      blockIndex++
    ) {
      eventsByBlockIndex.set(blockIndex, []);
    }

    for (
      let chunkStart = fromBlockIndex;
      chunkStart <= toBlockIndex;
      chunkStart += MAX_LOGS_RANGE_SIZE
    ) {
      const chunkEnd = Math.min(
        chunkStart + MAX_LOGS_RANGE_SIZE - 1,
        toBlockIndex
      );

      const pastEvents = await this.getLogsInRange(chunkStart, chunkEnd);

      const parsedEvents = this.parseEvents(pastEvents);
      for (const event of parsedEvents) {
        eventsByBlockIndex.get(event.blockNumber)?.push(event);
      }
    }

    return eventsByBlockIndex;
  }

  private async getLogsInRange(
    fromBlock: number,
    toBlock: number
  ): Promise<ethers.providers.Log[]> {
    try {
      return await this._provider.getLogs({
        address: this._contractDescription.address,
        topics: [ethers.utils.id(BURN_EVENT_SIG)],
        fromBlock,
        toBlock,
      });
    } catch (error) {
      const wrapper = error as {
        code?: number;
        message?: string;
        error?: { code?: number; message?: string };
      };
      const cause = wrapper?.error ?? wrapper;
      const rangeLimited =
        (cause?.code === -32005 || cause?.code === -32602) &&
        /block.*range|range.*block|too many (results|logs)|query returned more than|response.*size/i.test(
          cause.message ?? ""
        );
      if (!rangeLimited || fromBlock === toBlock) throw error;

      // Only split explicit range/result-size failures, never rate limits or
      // transport errors. Query halves sequentially to avoid a request burst.
      const midpoint = fromBlock + Math.floor((toBlock - fromBlock) / 2);
      const left = await this.getLogsInRange(fromBlock, midpoint);
      const right = await this.getLogsInRange(midpoint + 1, toBlock);
      return [...left, ...right];
    }
  }

  private parseEvents(pastEvents: ethers.providers.Log[]) {
    // Keep transaction checkpoints deterministic even if an RPC endpoint
    // returns logs out of order.
    const orderedEvents = [...pastEvents].sort(
      (left, right) =>
        left.blockNumber - right.blockNumber ||
        left.transactionIndex - right.transactionIndex ||
        left.logIndex - right.logIndex
    );
    const parsedEvents = orderedEvents.map((log) =>
      this._contract.interface.parseLog(log)
    );

    return parsedEvents.map((parsedEvent, idx) => {
      return {
        ...orderedEvents[idx],
        ...parsedEvent,
        txId: orderedEvents[idx].transactionHash,
        returnValues: {
          ...parsedEvent.args,
          amount: ethers.BigNumber.from(parsedEvent.args._amount).toString(),
          _sender: parsedEvent.args?._user,
        },
        raw: {
          data: orderedEvents[idx].data,
          topics: orderedEvents[idx].topics,
        },
        event: parsedEvent.name,
      };
    });
  }
}
