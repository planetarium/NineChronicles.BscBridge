import { ethers } from "ethers";
import { TriggerableMonitor } from "../../src/monitors/triggerable-monitor";
import { BscBurnEventMonitor } from "../../src/monitors/bsc-burn-event-monitor";
import { bscBridgeContractAbi } from "../../src/bsc-bridge-contract-abi";

class RecoveryMonitor extends TriggerableMonitor<never> {
  private firstTip = true;
  private failed = false;
  ranges: number[][] = [];

  constructor(private readonly confirmations: number) {
    super(null, 1, 8, 5, 10);
  }
  protected async processRemains(): Promise<never> {
    throw new Error("unused");
  }
  protected triggerredBlocks(index: number) {
    return index >= this.confirmations ? [index - this.confirmations] : [];
  }
  protected async getBlockIndex() {
    return 0;
  }
  protected async getTipIndex() {
    if (this.firstTip) {
      this.firstTip = false;
      return this.confirmations;
    }
    return 100;
  }
  protected async getBlockHash(index: number) {
    if (index === 3 && !this.failed) {
      this.failed = true;
      throw { code: "TIMEOUT" };
    }
    return `hash-${index}`;
  }
  protected async getEvents() {
    return [];
  }
  protected async getEventsInRange(from: number, to: number) {
    this.ranges.push([from, to]);
    return new Map();
  }
}

const contractDescription = {
  address: "0x1111111111111111111111111111111111111111",
  abi: bscBridgeContractAbi,
};
function monitorWithLogs(getLogs: jest.Mock) {
  return new BscBurnEventMonitor(
    {
      _isProvider: true,
      getLogs,
    } as unknown as ethers.providers.JsonRpcProvider,
    contractDescription,
    null,
    10
  );
}
function logAt(blockNumber: number): ethers.providers.Log {
  return {
    blockNumber,
    blockHash: `hash-${blockNumber}`,
    transactionHash: `tx-${blockNumber}`,
    transactionIndex: 0,
    logIndex: 0,
    removed: false,
    address: contractDescription.address,
    topics: [
      ethers.utils.id("SentToLibPlanet(address,uint256,bytes32)"),
      ethers.utils.hexZeroPad(contractDescription.address, 32),
    ],
    data: ethers.utils.defaultAbiCoder.encode(
      ["uint256", "bytes32"],
      [blockNumber, ethers.constants.HashZero]
    ),
  };
}

describe("catch-up recovery", () => {
  afterEach(() => jest.restoreAllMocks());

  it.each([0, 10])(
    "resumes at the first unprocessed block with %s confirmations",
    async (confirmations) => {
      jest.spyOn(global, "setTimeout").mockImplementation(((fn: () => void) => {
        fn();
        return 0;
      }) as unknown as typeof setTimeout);
      const monitor = new RecoveryMonitor(confirmations);
      const loop = monitor.loop();
      const hashes = [];
      for (let i = 0; i < 12; i++)
        hashes.push((await loop.next()).value.blockHash);
      expect(hashes).toEqual(
        Array.from({ length: 12 }, (_, i) => `hash-${i + 1}`)
      );
      expect(monitor.ranges).toEqual([
        [1, 10],
        [3, 12],
      ]);
      await loop.return?.(undefined as never);
    }
  );

  it.each([false, true])(
    "refetches changed cached ranges without replaying their consumed prefix (empty: %s)",
    async (initiallyEmpty) => {
      jest.spyOn(global, "setTimeout").mockImplementation(((fn: () => void) => {
        fn();
        return 0;
      }) as unknown as typeof setTimeout);
      let branch = "old";
      const getLogs = jest.fn(
        async (filter: { fromBlock: number; toBlock: number }) =>
          [
            {
              ...logAt(1),
              blockHash: `${branch}-1`,
              transactionHash: `${branch}-tx1`,
            },
            ...(branch === "old" && initiallyEmpty
              ? []
              : [
                  {
                    ...logAt(2),
                    blockHash: `${branch}-2`,
                    transactionHash: `${branch}-tx2`,
                  },
                ]),
          ].filter(
            (log) =>
              log.blockNumber >= filter.fromBlock &&
              log.blockNumber <= filter.toBlock
          )
      );
      const provider = {
        _isProvider: true,
        getBlockNumber: jest
          .fn()
          .mockResolvedValueOnce(10)
          .mockResolvedValue(30),
        getBlock: jest.fn(async (index: number) => ({
          number: index,
          hash: `${branch}-${index}`,
        })),
        getLogs,
      } as unknown as ethers.providers.JsonRpcProvider;
      const monitor = new BscBurnEventMonitor(
        provider,
        contractDescription,
        null,
        10
      );
      const loop = monitor.loop();
      expect((await loop.next()).value).toEqual({
        blockHash: "old-1",
        events: [expect.objectContaining({ txId: "old-tx1" })],
      });
      branch = "new";
      const next = (await loop.next()).value;
      expect(next.blockHash).toEqual("new-2");
      expect(next.events).toEqual([
        expect.objectContaining({ txId: "new-tx2" }),
      ]);
      expect(getLogs.mock.calls.map(([filter]) => filter.fromBlock)).toEqual([
        1, 2,
      ]);
      await loop.return?.(undefined as never);
    }
  );

  it("discards empty range results when the branch changes during getLogs", async () => {
    jest.spyOn(global, "setTimeout").mockImplementation(((fn: () => void) => {
      fn();
      return 0;
    }) as unknown as typeof setTimeout);
    let branch = "old";
    const getLogs = jest.fn(async () => {
      if (branch === "old") {
        branch = "new";
        return [];
      }
      return [{ ...logAt(1), blockHash: "new-1", transactionHash: "new-tx1" }];
    });
    const provider = {
      _isProvider: true,
      getBlockNumber: jest.fn().mockResolvedValueOnce(10).mockResolvedValue(30),
      getBlock: jest.fn(async (index: number) => ({
        number: index,
        hash: `${branch}-${index}`,
      })),
      getLogs,
    } as unknown as ethers.providers.JsonRpcProvider;
    const loop = new BscBurnEventMonitor(
      provider,
      contractDescription,
      null,
      10
    ).loop();
    const next = (await loop.next()).value;
    expect(next.blockHash).toEqual("new-1");
    expect(next.events[0].txId).toEqual("new-tx1");
    expect(getLogs).toHaveBeenCalledTimes(2);
    await loop.return?.(undefined as never);
  });

  it("rejects logs from a different branch even if the range anchor stays stable", async () => {
    jest.spyOn(global, "setTimeout").mockImplementation(((fn: () => void) => {
      fn();
      return 0;
    }) as unknown as typeof setTimeout);
    const getLogs = jest
      .fn()
      .mockResolvedValueOnce([{ ...logAt(1), blockHash: "stale-1" }])
      .mockResolvedValue([logAt(1)]);
    const provider = {
      _isProvider: true,
      getBlockNumber: jest.fn().mockResolvedValueOnce(10).mockResolvedValue(30),
      getBlock: jest.fn(async (index: number) => ({
        number: index,
        hash: `hash-${index}`,
      })),
      getLogs,
    } as unknown as ethers.providers.JsonRpcProvider;
    const loop = new BscBurnEventMonitor(
      provider,
      contractDescription,
      null,
      10
    ).loop();
    const next = (await loop.next()).value;
    expect(next.blockHash).toEqual("hash-1");
    expect(next.events[0].blockHash).toEqual("hash-1");
    expect(getLogs).toHaveBeenCalledTimes(2);
    await loop.return?.(undefined as never);
  });

  it.each([-32005, -32602])(
    "splits explicit range error %s and preserves all events and empty blocks",
    async (code) => {
      const logs = [logAt(3), logAt(17), logAt(20), logAt(21)];
      const getLogs = jest.fn(async ({ fromBlock, toBlock }) => {
        if (toBlock - fromBlock + 1 > 4) {
          throw {
            code: "SERVER_ERROR",
            error: { code, message: "block range limit exceeded" },
          };
        }
        return logs.filter(
          (log) => log.blockNumber >= fromBlock && log.blockNumber <= toBlock
        );
      });
      const events = await (monitorWithLogs(getLogs) as any).getEventsInRange(
        1,
        20
      );
      expect(events.size).toBe(20);
      expect(events.get(1)).toEqual([]);
      expect(events.get(3)[0].returnValues.amount).toBe("3");
      expect(events.get(17)[0].returnValues.amount).toBe("17");
      expect(events.get(20)[0].returnValues.amount).toBe("20");
      expect(events.has(21)).toBe(false);
      const covered = getLogs.mock.calls
        .map(([filter]) => filter)
        .filter(({ fromBlock, toBlock }) => toBlock - fromBlock + 1 <= 4)
        .flatMap(({ fromBlock, toBlock }) =>
          Array.from(
            { length: toBlock - fromBlock + 1 },
            (_, i) => fromBlock + i
          )
        );
      expect(covered).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    }
  );

  it.each([
    { code: "TIMEOUT" },
    { code: -32005, message: "rate limit exceeded" },
    { code: -32005, message: "limit exceeded" },
    { code: -32602, message: "invalid address" },
  ])("does not split a non-range failure %j", async (error) => {
    const getLogs = jest.fn().mockRejectedValue(error);
    await expect(
      (monitorWithLogs(getLogs) as any).getEventsInRange(1, 20)
    ).rejects.toBe(error);
    expect(getLogs).toHaveBeenCalledTimes(1);
  });

  it("propagates a limit error on a single block without recursing forever", async () => {
    const error = {
      code: -32005,
      message: "query returned more than 10000 results",
    };
    const getLogs = jest.fn().mockRejectedValue(error);
    await expect(
      (monitorWithLogs(getLogs) as any).getEventsInRange(7, 7)
    ).rejects.toBe(error);
    expect(getLogs).toHaveBeenCalledTimes(1);
  });
});
