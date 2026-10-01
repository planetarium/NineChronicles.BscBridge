import { ethers } from "ethers";
import { BscBurnEventMonitor } from "../../src/monitors/bsc-burn-event-monitor";
import { bscBridgeContractAbi } from "../../src/bsc-bridge-contract-abi";

type LogFilter = { fromBlock: number; toBlock: number };
const contract = {
  address: "0x1111111111111111111111111111111111111111",
  abi: bscBridgeContractAbi,
};

function burnLog(blockNumber: number): ethers.providers.Log {
  return {
    blockNumber,
    blockHash: `hash-${blockNumber}`,
    transactionHash: `tx-${blockNumber}`,
    transactionIndex: 0,
    logIndex: 0,
    removed: false,
    address: contract.address,
    topics: [
      ethers.utils.id("SentToLibPlanet(address,uint256,bytes32)"),
      ethers.utils.hexZeroPad(contract.address, 32),
    ],
    data: ethers.utils.defaultAbiCoder.encode(
      ["uint256", "bytes32"],
      [blockNumber, ethers.constants.HashZero]
    ),
  };
}

function providerFixture(logs: ethers.providers.Log[]) {
  return {
    _isProvider: true,
    getBlockNumber: jest.fn().mockResolvedValueOnce(10).mockResolvedValue(22),
    getBlock: jest.fn(async (index: number) => ({
      number: index,
      hash: `hash-${index}`,
    })),
    getLogs: jest.fn(async ({ fromBlock, toBlock }: LogFilter) =>
      logs.filter(
        (log) => log.blockNumber >= fromBlock && log.blockNumber <= toBlock
      )
    ),
  };
}

function createMonitor(
  provider: ReturnType<typeof providerFixture>,
  confirmations = 10
) {
  return new BscBurnEventMonitor(
    provider as unknown as ethers.providers.JsonRpcProvider,
    contract,
    null,
    confirmations
  );
}

describe("catch-up failure and confirmation boundaries", () => {
  beforeEach(() => {
    let delayCount = 0;
    jest.spyOn(global, "setTimeout").mockImplementation(((fn: () => void) => {
      // Bound the generator if a regression repeatedly retries the same block
      // instead of recovering. No wall-clock timers or network are involved.
      if (++delayCount > 5) throw new Error("test retry budget exceeded");
      fn();
      return 0;
    }) as unknown as typeof setTimeout);
  });

  afterEach(() => jest.restoreAllMocks());

  it("retries a partially fetched split range without yielding duplicate or missing burns", async () => {
    const logs = [1, 4, 7, 12].map(burnLog);
    const provider = providerFixture(logs);
    let failedRightHalf = false;
    let completeRangeFetched = false;
    provider.getLogs.mockImplementation(async ({ fromBlock, toBlock }) => {
      if (toBlock - fromBlock + 1 > 3) {
        throw { code: -32005, message: "block range limit exceeded" };
      }
      if (fromBlock === 4 && !failedRightHalf) {
        failedRightHalf = true;
        throw { code: "TIMEOUT" };
      }
      if (toBlock === 12) completeRangeFetched = true;
      return logs.filter(
        (log) => log.blockNumber >= fromBlock && log.blockNumber <= toBlock
      );
    });
    const loop = createMonitor(provider).loop();
    const hashes: string[] = [];
    const transactions: string[] = [];
    try {
      for (let i = 0; i < 4; i++) {
        const item = await loop.next();
        if (item.done) throw new Error("monitor ended unexpectedly");
        expect(completeRangeFetched).toBe(true);
        hashes.push(item.value.blockHash);
        for (const event of item.value.events) transactions.push(event.txId!);
      }
      expect(hashes).toEqual(["hash-1", "hash-4", "hash-7", "hash-12"]);
      expect(transactions).toEqual(["tx-1", "tx-4", "tx-7", "tx-12"]);
      const requests = provider.getLogs.mock.calls.map(([filter]) => [
        filter.fromBlock,
        filter.toBlock,
      ]);
      expect(requests).toEqual([
        [1, 12],
        [1, 6],
        [1, 3],
        [4, 6],
        [1, 12],
        [1, 6],
        [1, 3],
        [4, 6],
        [7, 12],
        [7, 9],
        [10, 12],
      ]);
    } finally {
      await loop.return?.(undefined as never);
    }
  });

  it.each([
    ["before range query", 1, [1]],
    ["after range query", 2, [1, 1]],
    ["after consuming the first block", 4, [1, 2]],
  ] as const)(
    "preserves the first unprocessed position when the range anchor fails %s",
    async (_stage, failureRead, expectedStarts) => {
      const provider = providerFixture([1, 2, 3].map(burnLog));
      let anchorReads = 0;
      provider.getBlock.mockImplementation(async (index) => {
        if (index === 12 && ++anchorReads === failureRead) {
          throw { code: "TIMEOUT" };
        }
        return { number: index, hash: `hash-${index}` };
      });
      const loop = createMonitor(provider).loop();
      const transactions: string[] = [];
      try {
        for (let i = 0; i < 3; i++) {
          const item = await loop.next();
          if (item.done) throw new Error("monitor ended unexpectedly");
          expect(item.value.blockHash).toEqual(`hash-${i + 1}`);
          for (const event of item.value.events) transactions.push(event.txId!);
        }
        expect(transactions).toEqual(["tx-1", "tx-2", "tx-3"]);
        expect(
          provider.getLogs.mock.calls.map(([filter]) => filter.fromBlock)
        ).toEqual(expectedStarts);
      } finally {
        await loop.return?.(undefined as never);
      }
    }
  );

  it("advances a fully unconfirmed batch without querying logs or a missing anchor", async () => {
    const provider = providerFixture([burnLog(0), burnLog(15), burnLog(16)]);
    provider.getBlockNumber
      .mockReset()
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(20)
      .mockImplementation(async () => {
        // Scan positions 1..20 contain no confirmed blocks with depth 25.
        expect(provider.getBlock).not.toHaveBeenCalled();
        expect(provider.getLogs).not.toHaveBeenCalled();
        return 40;
      });
    const loop = createMonitor(provider, 25).loop();
    const hashes: string[] = [];
    const transactions: string[] = [];
    try {
      for (let i = 0; i < 2; i++) {
        const item = await loop.next();
        if (item.done) throw new Error("monitor ended unexpectedly");
        hashes.push(item.value.blockHash);
        for (const event of item.value.events) transactions.push(event.txId!);
      }
      expect(hashes).toEqual(["hash-0", "hash-15"]);
      expect(transactions).toEqual(["tx-0", "tx-15"]);
      expect(provider.getLogs).toHaveBeenCalledTimes(1);
      expect(provider.getLogs).toHaveBeenCalledWith(
        expect.objectContaining({ fromBlock: 0, toBlock: 15 })
      );
      expect(
        provider.getBlock.mock.calls.every(
          ([index]) => index >= 0 && index <= 15
        )
      ).toBe(true);
    } finally {
      await loop.return?.(undefined as never);
    }
  });
});
