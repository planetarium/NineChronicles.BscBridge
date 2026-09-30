import { EventData } from "web3-eth-contract";
import { TriggerableMonitor } from "./triggerable-monitor";
import { ContractDescription } from "../types/contract-description";
import { TransactionLocation } from "../types/transaction-location";
import { ethers } from "ethers";

const BURN_EVENT_SIG = "SentToLibPlanet(address,uint256,bytes32)";

// Conservative chunk size for a single `eth_getLogs` range query when
// catching up on a backlog of blocks. Most RPC providers (including Infura)
// cap the block range (and/or result size) of a single `getLogs` call, so
// this keeps each request well within typical limits.
const MAX_LOGS_RANGE_SIZE = 1000;

export class BscBurnEventMonitor extends TriggerableMonitor<EventData> {
  private readonly _provider: ethers.providers.JsonRpcProvider;
  private readonly _contract: ethers.Contract;
  private readonly _contractDescription: ContractDescription;
  private readonly _confirmations: number;

  constructor(
    provider: ethers.providers.JsonRpcProvider,
    contractDescription: ContractDescription,
    latestTransactionLocation: TransactionLocation | null,
    confirmations: number
  ) {
    super(latestTransactionLocation);

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
    const blockIndex = await this.getBlockIndex(transactionLocation.blockHash);
    const events = await this.getEvents(blockIndex);
    const returnEvents = [];
    let skip = true;
    for (const event of events) {
      if (skip) {
        if (event.txId === transactionLocation.txId) {
          skip = false;
        }
        continue;
      } else {
        returnEvents.push(event);
      }
    }

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

      const pastEvents = await this._provider.getLogs({
        address: this._contractDescription.address,
        topics: [ethers.utils.id(BURN_EVENT_SIG)],
        fromBlock: chunkStart,
        toBlock: chunkEnd,
      });

      const parsedEvents = this.parseEvents(pastEvents);
      for (let idx = 0; idx < pastEvents.length; idx++) {
        const blockEvents = eventsByBlockIndex.get(pastEvents[idx].blockNumber);
        blockEvents?.push(parsedEvents[idx]);
      }
    }

    return eventsByBlockIndex;
  }

  private parseEvents(pastEvents: ethers.providers.Log[]) {
    const parsedEvents = pastEvents.map((log) =>
      this._contract.interface.parseLog(log)
    );

    return parsedEvents.map((parsedEvent, idx) => {
      return {
        ...pastEvents[idx],
        ...parsedEvent,
        txId: pastEvents[idx].transactionHash,
        returnValues: {
          ...parsedEvent.args,
          amount: ethers.BigNumber.from(parsedEvent.args._amount).toString(),
          _sender: parsedEvent.args?._user,
        },
        raw: {
          data: pastEvents[idx].data,
          topics: pastEvents[idx].topics,
        },
        event: parsedEvent.name,
      };
    });
  }
}
