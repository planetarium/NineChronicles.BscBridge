import { ethers } from "ethers";
import { BscBurnEventMonitor } from "../../src/monitors/bsc-burn-event-monitor";
import { bscBridgeContractAbi } from "../../src/bsc-bridge-contract-abi";
import { TransactionLocation } from "../../src/types/transaction-location";

type Filter = { fromBlock: number; toBlock: number };
const contract = {
  address: "0x1111111111111111111111111111111111111111",
  abi: bscBridgeContractAbi,
};
const hash = (index: number, branch = "a") => `block-${branch}-${index}`;

function burn(index: number, position = 0, branch = "a"): ethers.providers.Log {
  return {
    blockNumber: index,
    blockHash: hash(index, branch),
    transactionHash: `tx-${branch}-${index}-${position}`,
    transactionIndex: position,
    logIndex: position,
    removed: false,
    address: contract.address,
    topics: [
      ethers.utils.id("SentToLibPlanet(address,uint256,bytes32)"),
      ethers.utils.hexZeroPad(contract.address, 32),
    ],
    data: ethers.utils.defaultAbiCoder.encode(
      ["uint256", "bytes32"],
      [index + 1, ethers.constants.HashZero]
    ),
  };
}

function fixture(
  confirmedTip: number,
  logs: ethers.providers.Log[] = [],
  confirmations = 10
) {
  const state = { branch: "a", logs };
  const provider = {
    _isProvider: true,
    getBlockNumber: jest
      .fn()
      .mockResolvedValueOnce(confirmations)
      .mockResolvedValue(confirmedTip + confirmations),
    getBlock: jest.fn(async (indexOrHash: number | string) => {
      const index =
        typeof indexOrHash === "number"
          ? indexOrHash
          : Number(indexOrHash.split("-").pop());
      return { number: index, hash: hash(index, state.branch) };
    }),
    getLogs: jest.fn(async ({ fromBlock, toBlock }: Filter) =>
      state.logs.filter(
        (log) => log.blockNumber >= fromBlock && log.blockNumber <= toBlock
      )
    ),
  };
  const monitor = (checkpoint: TransactionLocation | null = null) =>
    new BscBurnEventMonitor(
      provider as unknown as ethers.providers.BaseProvider,
      contract,
      checkpoint,
      confirmations
    );
  return { provider, state, monitor };
}

async function take<T>(loop: AsyncIterator<T>): Promise<T> {
  const item = await loop.next();
  if (item.done) throw new Error("monitor ended unexpectedly");
  return item.value;
}

describe("BSC range scans and coalesced checkpoints", () => {
  beforeEach(() => {
    let delays = 0;
    jest.spyOn(global, "setTimeout").mockImplementation(((fn: () => void) => {
      if (++delays > 6) throw new Error("test retry budget exceeded");
      fn();
      return 0;
    }) as unknown as typeof setTimeout);
  });
  afterEach(() => jest.restoreAllMocks());

  it("scans 10,000 empty blocks with ten range queries and ten checkpoints", async () => {
    const { provider, monitor } = fixture(10000);
    const loop = monitor().loop();
    const persist = jest.fn(
      async (_checkpoint: TransactionLocation) => undefined
    );
    try {
      for (let range = 1; range <= 10; range++) {
        const item = await take(loop);
        expect(item).toEqual({ blockHash: hash(range * 1000), events: [] });
        await persist({ blockHash: item.blockHash, txId: null });
      }
      expect(persist).toHaveBeenCalledTimes(10);
      expect(
        provider.getLogs.mock.calls.map(([filter]) => [
          filter.fromBlock,
          filter.toBlock,
        ])
      ).toEqual(
        Array.from({ length: 10 }, (_, index) => [
          index * 1000 + 1,
          (index + 1) * 1000,
        ])
      );
      expect(provider.getBlock).toHaveBeenCalledTimes(30);
      expect(
        provider.getBlock.mock.calls.every(
          ([index]) => typeof index === "number" && index % 1000 === 0
        )
      ).toBe(true);
      expect(provider.getBlockNumber).toHaveBeenCalledTimes(11);
    } finally {
      await loop.return?.(undefined as never);
    }
  });

  it("queries short backlogs as one range and emits ordered sparse events plus one empty tail", async () => {
    const { provider, monitor } = fixture(10, [
      { ...burn(8, 1), logIndex: 2 },
      burn(2, 2),
      { ...burn(8), logIndex: 1 },
      burn(8),
      burn(2),
    ]);
    const loop = monitor().loop();
    try {
      const first = await take(loop);
      const second = await take(loop);
      const tail = await take(loop);
      expect([first.blockHash, second.blockHash, tail.blockHash]).toEqual([
        hash(2),
        hash(8),
        hash(10),
      ]);
      expect(first.events.map((event) => event.txId)).toEqual([
        "tx-a-2-0",
        "tx-a-2-2",
      ]);
      expect(second.events.map((event) => event.txId)).toEqual([
        "tx-a-8-0",
        "tx-a-8-0",
        "tx-a-8-1",
      ]);
      // Preserve all logs, including multiple logs from one transaction,
      // in transaction/log order. Payout deduplication belongs to the observer.
      expect(second.events.map((event) => event.logIndex)).toEqual([0, 1, 2]);
      expect(tail.events).toEqual([]);
      expect(provider.getLogs).toHaveBeenCalledTimes(1);
      expect(provider.getLogs).toHaveBeenCalledWith(
        expect.objectContaining({ fromBlock: 1, toBlock: 10 })
      );
      // Only event blocks and the range anchor require block RPCs.
      expect(provider.getBlock.mock.calls.map(([index]) => index)).toEqual([
        10, 10, 2, 10, 8, 10, 10,
      ]);
    } finally {
      await loop.return?.(undefined as never);
    }
  });

  it("preserves the last transaction checkpoint when the range ends with an event", async () => {
    const { provider, monitor } = fixture(10, [burn(10), burn(11)]);
    const loop = monitor().loop();
    try {
      const last = await take(loop);
      expect(last.events.map((event) => event.txId)).toEqual(["tx-a-10-0"]);
      provider.getBlockNumber.mockResolvedValue(21);
      const next = await take(loop);
      expect(next.blockHash).toBe(hash(11));
      expect(next.events.map((event) => event.txId)).toEqual(["tx-a-11-0"]);
      expect(
        provider.getLogs.mock.calls.map(([filter]) => [
          filter.fromBlock,
          filter.toBlock,
        ])
      ).toEqual([
        [1, 10],
        [11, 11],
      ]);
    } finally {
      await loop.return?.(undefined as never);
    }
  });

  it("requeries skipped empty positions when the branch changes before the next event", async () => {
    const { provider, state, monitor } = fixture(10, [burn(2), burn(9)]);
    const loop = monitor().loop();
    try {
      expect((await take(loop)).blockHash).toBe(hash(2));
      state.branch = "b";
      state.logs = [burn(5, 0, "b"), burn(9, 0, "b")];
      const recovered = await take(loop);
      expect(recovered.blockHash).toBe(hash(5, "b"));
      expect(recovered.events[0].txId).toBe("tx-b-5-0");
      expect((await take(loop)).blockHash).toBe(hash(9, "b"));
      expect(await take(loop)).toEqual({
        blockHash: hash(10, "b"),
        events: [],
      });
      expect(
        provider.getLogs.mock.calls.map(([filter]) => filter.fromBlock)
      ).toEqual([1, 3]);
    } finally {
      await loop.return?.(undefined as never);
    }
  });

  it("requeries an empty tail when its anchor changes instead of committing stale emptiness", async () => {
    const { provider, state, monitor } = fixture(10, [burn(2)]);
    const loop = monitor().loop();
    try {
      expect((await take(loop)).blockHash).toBe(hash(2));
      state.branch = "b";
      state.logs = [burn(7, 0, "b")];
      const recovered = await take(loop);
      expect(recovered.events[0].txId).toBe("tx-b-7-0");
      expect(await take(loop)).toEqual({
        blockHash: hash(10, "b"),
        events: [],
      });
      expect(
        provider.getLogs.mock.calls.map(([filter]) => filter.fromBlock)
      ).toEqual([1, 3]);
    } finally {
      await loop.return?.(undefined as never);
    }
  });

  it("does not skip a coalesced range after its checkpoint write fails and the monitor restarts", async () => {
    const { provider, monitor } = fixture(1000, [], 0);
    const persisted: TransactionLocation = { blockHash: hash(0), txId: null };
    const persist = jest
      .fn()
      .mockRejectedValueOnce(new Error("checkpoint write failed"));
    const firstLoop = monitor().loop();
    const checkpoint = await take(firstLoop);
    expect(checkpoint).toEqual({ blockHash: hash(1000), events: [] });
    await expect(
      persist({ blockHash: checkpoint.blockHash, txId: null })
    ).rejects.toThrow("checkpoint write failed");
    // A failed consumer does not resume the generator. A restart must rely on
    // the unchanged persisted checkpoint, not the yielded range endpoint.
    await firstLoop.return?.(undefined as never);
    provider.getLogs.mockClear();
    const restarted = monitor(persisted).loop();
    try {
      expect(await take(restarted)).toEqual({ blockHash: hash(0), events: [] });
      expect(await take(restarted)).toEqual({
        blockHash: hash(1000),
        events: [],
      });
      expect(
        provider.getLogs.mock.calls.map(([filter]) => [
          filter.fromBlock,
          filter.toBlock,
        ])
      ).toEqual([
        [0, 0],
        [1, 1000],
      ]);
    } finally {
      await restarted.return?.(undefined as never);
    }
  });

  it.each([0, 10])(
    "restarts after an empty checkpoint with %s confirmations",
    async (confirmations) => {
      const { provider, monitor } = fixture(
        1020,
        [burn(1001), burn(1021)],
        confirmations
      );
      provider.getBlockNumber
        .mockReset()
        .mockResolvedValue(1020 + confirmations);
      const loop = monitor({ blockHash: hash(1000), txId: null }).loop();
      try {
        expect(await take(loop)).toEqual({ blockHash: hash(1000), events: [] });
        const first = await take(loop);
        expect(first.blockHash).toBe(hash(1001));
        expect(first.events[0].txId).toBe("tx-a-1001-0");
        expect(await take(loop)).toEqual({ blockHash: hash(1020), events: [] });
        expect(
          provider.getLogs.mock.calls.map(([filter]) => [
            filter.fromBlock,
            filter.toBlock,
          ])
        ).toEqual([
          [1000, 1000],
          [1001, 1020],
        ]);
      } finally {
        await loop.return?.(undefined as never);
      }
    }
  );
});
