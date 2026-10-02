import { promises as fs } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ethers } from "ethers";
import { PrimaryRpcProvider } from "../../src/primary-rpc-provider";
import { BscBurnEventMonitor } from "../../src/monitors/bsc-burn-event-monitor";
import { BscBurnEventObserver } from "../../src/observers/burn-event-observer";
import { Sqlite3MonitorStateStore } from "../../src/sqlite3-monitor-state-store";
import { Sqlite3ExchangeHistoryStore } from "../../src/sqlite3-exchange-history-store";
import { MultiPlanetary } from "../../src/multi-planetary";
import { PendingTransactionHandler } from "../../src/pending-transactions";
import { TransactionStatus } from "../../src/types/transaction-status";
import { OpenSearchClient } from "../../src/opensearch-client";
import { SpreadsheetClient } from "../../src/spreadsheet-client";

// Exercise real parsing, monitor, observer and file-backed SQLite stores.
// Only RPC, external payout and notifications are fakes. No keys or live funds.
const contract = {
  address: "0x1111111111111111111111111111111111111111",
  abi: [
    "event SentToLibPlanet(address indexed _user, uint256 _amount, bytes32 _to)",
  ],
};
const recipient = "0x2222222222222222222222222222222222222222";
const planets = new MultiPlanetary(
  { odin: "0x100000000000", heimdall: "0x100000000001" },
  { heimdall: "0x3333333333333333333333333333333333333333" }
);
const hash = (n: number) =>
  ethers.utils.hexZeroPad(ethers.utils.hexlify(n), 32);

function burn(blockNumber: number, id = blockNumber, logIndex = 0) {
  const encoded = new ethers.utils.Interface(contract.abi).encodeEventLog(
    "SentToLibPlanet",
    [
      contract.address,
      ethers.utils.parseEther("1"),
      recipient + "00".repeat(12),
    ]
  );
  return {
    ...encoded,
    address: contract.address,
    blockNumber,
    blockHash: hash(blockNumber),
    transactionHash: hash(10000 + id),
    transactionIndex: logIndex,
    logIndex,
    removed: false,
  };
}

type Loop = ReturnType<BscBurnEventMonitor["loop"]>;

describe("duplicate payout protection", () => {
  let directory: string;
  let state: Sqlite3MonitorStateStore;
  let history: Sqlite3ExchangeHistoryStore;
  let loops: Loop[];
  let openStores: { close(): void }[];
  let logs: ethers.providers.Log[];
  let payouts: string[];
  let provider: {
    _isProvider: boolean;
    getBlockNumber: jest.Mock;
    getBlock: jest.Mock;
    getLogs: jest.Mock;
  };
  let transfer: { transfer: jest.Mock };
  let slack: { sendMessage: jest.Mock };
  let observer: BscBurnEventObserver;

  const open = async () => {
    state = await Sqlite3MonitorStateStore.open(join(directory, "state.db"));
    history = await Sqlite3ExchangeHistoryStore.open(
      join(directory, "history.db")
    );
    openStores.push(state, history);
  };

  const makeObserver = (payoutHistory = history) =>
    new BscBurnEventObserver(
      transfer,
      slack,
      {
        to_opensearch: jest.fn().mockResolvedValue(undefined),
      } as unknown as OpenSearchClient,
      {
        to_spreadsheet_burn: jest.fn().mockResolvedValue(undefined),
      } as unknown as SpreadsheetClient,
      state,
      payoutHistory,
      "https://example.test/9c",
      undefined,
      false,
      "https://example.test/bsc",
      { error: jest.fn() },
      planets,
      ""
    );

  const start = async (
    rpcProvider: ethers.providers.BaseProvider = provider as unknown as ethers.providers.BaseProvider
  ) => {
    const loop = new BscBurnEventMonitor(
      rpcProvider,
      contract,
      await state.load("bsc"),
      10
    ).loop();
    loops.push(loop);
    return loop;
  };

  // Match Monitor.startMonitoring: do not request the next block until notify
  // resolves. Bound all test loops so a broken recovery cannot spin forever.
  const consumeThrough = async (loop: Loop, last: number) => {
    for (let i = 0; i < last + 10; i++) {
      const item = await loop.next();
      if (item.done) throw new Error("monitor ended before target block");
      await observer.notify(item.value);
      if (item.value.blockHash === hash(last)) return;
    }
    throw new Error("monitor did not reach target block");
  };

  const restart = async (rpcProvider?: ethers.providers.BaseProvider) => {
    for (const loop of loops.splice(0)) await loop.return?.(undefined as never);
    // A fresh connection and fresh observer must rely on committed rows, not
    // an in-memory dedup set. Closing SQLite drains its already queued work.
    for (const store of openStores.splice(0)) store.close();
    await open();
    observer = makeObserver();
    await new PendingTransactionHandler(
      history,
      transfer,
      planets,
      slack
    ).messagePendingTransactions();
    return start(rpcProvider);
  };

  const expectPaidOnce = (ids: number[]) => {
    const expected = ids.map((id) => hash(10000 + id));
    expect(payouts.slice().sort()).toEqual(expected.slice().sort());
    expect(transfer.transfer).toHaveBeenCalledTimes(expected.length);
    for (const memo of expected) {
      expect(transfer.transfer).toHaveBeenCalledWith(recipient, "1.00", memo);
    }
  };

  beforeEach(async () => {
    directory = await fs.mkdtemp(join(tmpdir(), "bsc-payout-"));
    loops = [];
    openStores = [];
    logs = [];
    payouts = [];
    await open();
    await state.store("bsc", { blockHash: hash(0), txId: null });
    let reads = 0;
    const guard = () => {
      if (++reads > 10000) throw new Error("test RPC budget exhausted");
    };
    provider = {
      _isProvider: true,
      getBlockNumber: jest.fn(async () => {
        guard();
        return 60;
      }),
      getBlock: jest.fn(async (id: number | string) => {
        guard();
        const number = typeof id === "number" ? id : Number(BigInt(id));
        return { number, hash: hash(number) };
      }),
      getLogs: jest.fn(async ({ fromBlock, toBlock }) => {
        guard();
        return logs.filter(
          (log) => log.blockNumber >= fromBlock && log.blockNumber <= toBlock
        );
      }),
    };
    transfer = {
      transfer: jest.fn(async (_recipient, _amount, memo: string) => {
        // Represents the irreversible side effect, even if the reply is lost.
        payouts.push(memo);
        return `destination-${memo}`;
      }),
    };
    slack = { sendMessage: jest.fn().mockResolvedValue(undefined) };
    observer = makeObserver();
    jest.spyOn(console, "log").mockImplementation(() => undefined);
    jest.spyOn(console, "debug").mockImplementation(() => undefined);
    jest.spyOn(console, "error").mockImplementation(() => undefined);
    let delays = 0;
    const realSetTimeout = global.setTimeout;
    jest.spyOn(global, "setTimeout").mockImplementation(((fn, ms, ...args) => {
      // Yield to SQLite I/O rather than use fake timers or a busy microtask loop.
      if ((ms ?? 0) >= 15000) {
        if (++delays > 30) throw new Error("test recovery budget exhausted");
        return realSetTimeout(fn, 0, ...args);
      }
      return realSetTimeout(fn, ms, ...args);
    }) as typeof setTimeout);
  });

  afterEach(async () => {
    for (const loop of loops) await loop.return?.(undefined as never);
    for (const store of openStores) store.close();
    jest.restoreAllMocks();
    await fs.rm(directory, { recursive: true, force: true });
  });

  // Keep the full ethers network selection and response formatting pipeline.
  // Only the final JSON-RPC transport is replaced; neither provider.perform
  // nor monitor/observer/SQLite methods are stubbed by these integration cases.
  function dualRpc(
    beforeRead: (
      endpoint: "primary" | "secondary",
      method: string,
      params: any[]
    ) => void,
    secondaryLogs?: ethers.providers.Log[],
    secondaryBranch = false,
    tipIndex = 60
  ) {
    const calls: {
      endpoint: "primary" | "secondary";
      method: string;
      params: any[];
    }[] = [];
    jest
      .spyOn(ethers.providers.JsonRpcProvider.prototype, "send")
      .mockImplementation(async function (
        this: ethers.providers.JsonRpcProvider,
        method: string,
        params: any[]
      ) {
        const endpoint = this.connection.url.includes("primary")
          ? "primary"
          : "secondary";
        calls.push({ endpoint, method, params });
        if (calls.length > 1000)
          throw new Error("dual RPC test budget exhausted");
        beforeRead(endpoint, method, params);
        if (method === "eth_chainId") return "0x38";
        if (method === "net_version") return "56";
        if (method === "eth_blockNumber")
          return ethers.utils.hexValue(tipIndex);
        if (method === "eth_getLogs") {
          const filter = params[0];
          const from = Number(BigInt(filter.fromBlock));
          const to = Number(BigInt(filter.toBlock));
          const source =
            endpoint === "secondary" && secondaryLogs ? secondaryLogs : logs;
          return source
            .filter((log) => log.blockNumber >= from && log.blockNumber <= to)
            .map((log) => ({
              ...log,
              blockNumber: ethers.utils.hexValue(log.blockNumber),
              transactionIndex: ethers.utils.hexValue(log.transactionIndex),
              logIndex: ethers.utils.hexValue(log.logIndex),
            }));
        }
        if (
          method === "eth_getBlockByNumber" ||
          method === "eth_getBlockByHash"
        ) {
          let number = Number(BigInt(params[0]));
          if (method === "eth_getBlockByHash" && number >= 20000)
            number -= 20000;
          const branchOffset =
            endpoint === "secondary" && secondaryBranch && number >= 1
              ? 20000
              : 0;
          return {
            number: ethers.utils.hexValue(number),
            hash: hash(number + branchOffset),
            parentHash: hash(
              Math.max(0, number - 1) +
                (endpoint === "secondary" && secondaryBranch && number > 1
                  ? 20000
                  : 0)
            ),
            timestamp: "0x1",
            nonce: "0x0000000000000000",
            difficulty: "0x0",
            gasLimit: "0x1c9c380",
            gasUsed: "0x0",
            miner: contract.address,
            extraData: "0x",
            transactions: [],
          };
        }
        throw new Error(`unexpected RPC method: ${method}`);
      });
    return {
      calls,
      rpc: new PrimaryRpcProvider(
        "https://primary.invalid",
        "https://secondary.invalid",
        {
          expectedChainId: 56,
          cooldownMs: 60000,
        }
      ),
    };
  }

  it.each([
    { status: 429, message: "request quota exhausted" },
    { code: "TIMEOUT", message: "getLogs response timed out" },
  ])(
    "dual RPC: primary getLogs failure %j falls back without repeating payouts across a stale restart",
    async (failure) => {
      logs = [burn(1), burn(1), burn(2), burn(50)];
      let failed = false;
      const { rpc, calls } = dualRpc((endpoint, method, params) => {
        if (
          endpoint === "primary" &&
          method === "eth_getLogs" &&
          Number(BigInt(params[0].fromBlock)) > 0
        ) {
          failed = true;
          throw failure;
        }
      });
      await consumeThrough(await start(rpc), 50);
      expect(failed).toBe(true);
      expectPaidOnce([1, 2, 50]);
      expect(await state.load("bsc")).toEqual({
        blockHash: hash(50),
        txId: hash(10050),
      });
      await state.store("bsc", { blockHash: hash(0), txId: null });
      await consumeThrough(await restart(rpc), 50);
      expectPaidOnce([1, 2, 50]);
      expect(
        calls.filter(
          (call) =>
            call.endpoint === "primary" &&
            call.method === "eth_getLogs" &&
            Number(BigInt(call.params[0].fromBlock)) > 0
        )
      ).toHaveLength(1);
      // The failed primary session is retried on the secondary; the stale
      // restart performs the second secondary range read.
      expect(
        calls.filter(
          (call) =>
            call.endpoint === "secondary" &&
            call.method === "eth_getLogs" &&
            Number(BigInt(call.params[0].fromBlock)) === 1
        )
      ).toHaveLength(2);
    }
  );

  it("dual RPC: 10,000 empty blocks use range-sized RPC traffic including chain probes", async () => {
    const { rpc, calls } = dualRpc(() => undefined, undefined, false, 10010);
    const loop = await start(rpc);
    const checkpoint = await loop.next();
    if (checkpoint.done) throw new Error("monitor ended at its checkpoint");
    await observer.notify(checkpoint.value);
    const scanStart = calls.length;
    const persist = jest.spyOn(state, "store");
    for (let range = 1; range <= 10; range++) {
      const item = await loop.next();
      if (item.done)
        throw new Error("monitor ended before the range checkpoint");
      expect(item.value).toEqual({ blockHash: hash(range * 1000), events: [] });
      await observer.notify(item.value);
    }
    const scanCalls = calls.slice(scanStart);
    const counts: Record<string, number> = {};
    for (const call of scanCalls)
      counts[call.method] = (counts[call.method] ?? 0) + 1;
    expect(counts.eth_getLogs).toBe(10);
    expect(counts.eth_getBlockByNumber).toBe(30);
    expect(scanCalls.every((call) => call.endpoint === "primary")).toBe(true);
    expect(persist).toHaveBeenCalledTimes(10);
    expect(await state.load("bsc")).toEqual({
      blockHash: hash(10000),
      txId: null,
    });
    expectPaidOnce([]);
    // Include chain probes and nine new sessions (the first lease was acquired
    // before scanStart while resuming the persisted checkpoint).
    expect(counts).toEqual({
      eth_chainId: 99,
      eth_blockNumber: 10,
      eth_getLogs: 10,
      eth_getBlockByNumber: 30,
    });
    expect(scanCalls).toHaveLength(149);
  });

  it("dual RPC: an anchor failure after a payout rejects stale cached logs from the other branch", async () => {
    logs = [burn(1), burn(2), burn(50)];
    const secondaryLogs = [burn(2, 1), burn(3), burn(50)].map((log) => ({
      ...log,
      blockHash: hash(20000 + log.blockNumber),
    }));
    let failed = false;
    const { rpc, calls } = dualRpc(
      (endpoint, method, params) => {
        if (
          endpoint === "primary" &&
          method === "eth_getBlockByNumber" &&
          Number(BigInt(params[0])) === 50 &&
          payouts.length === 1 &&
          !failed
        ) {
          failed = true;
          throw { code: "TIMEOUT", message: "primary anchor read failed" };
        }
      },
      secondaryLogs,
      true
    );
    const loop = await start(rpc);
    await consumeThrough(loop, 1);
    for (const block of [2, 3, 50]) {
      const item = await loop.next();
      if (item.done) throw new Error("monitor ended before branch recovery");
      expect(item.value.blockHash).toBe(hash(20000 + block));
      expect(
        item.value.events.every(
          (event) => event.blockHash === item.value.blockHash
        )
      ).toBe(true);
      await observer.notify(item.value);
    }
    expect(failed).toBe(true);
    expectPaidOnce([1, 3, 50]);
    expect(
      calls.some(
        (call) =>
          call.endpoint === "secondary" &&
          call.method === "eth_getLogs" &&
          Number(BigInt(call.params[0].fromBlock)) === 2
      )
    ).toBe(true);
    // Even an old persisted cursor on the secondary branch must consult the
    // reopened payout DB before re-included transactions reach transfer().
    await state.store("bsc", { blockHash: hash(0), txId: null });
    const resumed = await restart(rpc);
    await resumed.next(); // empty persisted checkpoint
    for (const block of [2, 3, 50]) {
      const item = await resumed.next();
      if (item.done) throw new Error("monitor ended before stale restart");
      expect(item.value.blockHash).toBe(hash(20000 + block));
      await observer.notify(item.value);
    }
    expectPaidOnce([1, 3, 50]);
  });

  it("shared: pays each source transaction once across empty and occupied blocks", async () => {
    logs = [burn(1), burn(37), burn(50)];
    await consumeThrough(await start(), 50);
    expectPaidOnce([1, 37, 50]);
    expect(await state.load("bsc")).toEqual({
      blockHash: hash(50),
      txId: hash(10050),
    });
  });

  it("shared: a later block RPC failure cannot repay an already consumed prefix", async () => {
    logs = [burn(1), burn(36), burn(37), burn(50)];
    const getBlock = provider.getBlock.getMockImplementation()!;
    let failed = false;
    provider.getBlock.mockImplementation(async (index) => {
      if (index === 37 && !failed) {
        failed = true;
        throw new Error("RPC timeout after earlier payouts");
      }
      return getBlock(index);
    });
    await consumeThrough(await start(), 50);
    expect(failed).toBe(true);
    expectPaidOnce([1, 36, 37, 50]);
  });

  it("shared: duplicate RPC logs and repeated deliveries cannot pay twice", async () => {
    logs = [burn(1), burn(1), burn(2)];
    await consumeThrough(await start(), 2);
    // Force a stale scan checkpoint while keeping the independent payout DB.
    await state.store("bsc", { blockHash: hash(0), txId: null });
    await consumeThrough(await restart(), 2);
    expectPaidOnce([1, 2]);
  });

  it.each([
    TransactionStatus.PENDING,
    TransactionStatus.FAILED,
    TransactionStatus.COMPLETED,
  ])(
    "shared: reopening with an existing %s payout record never submits again",
    async (status) => {
      logs = [burn(1)];
      await history.put({
        network: "bsc",
        tx_id: hash(10001),
        sender: contract.address,
        recipient,
        amount: 1,
        timestamp: new Date().toISOString(),
        status,
      });
      await consumeThrough(await restart(), 1);
      expectPaidOnce([]);
    }
  );

  it.each([
    "checkpoint",
    "notification",
    "completed-status",
    "lost-payout-reply",
  ])(
    "shared: failure at %s after payment cannot pay again on restart",
    async (failure) => {
      logs = [burn(1), burn(2)];
      if (failure === "checkpoint") {
        jest
          .spyOn(state, "store")
          .mockRejectedValueOnce(new Error("disk error"));
      } else if (failure === "notification") {
        slack.sendMessage.mockRejectedValueOnce(new Error("Slack unavailable"));
      } else if (failure === "completed-status") {
        jest
          .spyOn(history, "updateStatus")
          .mockRejectedValueOnce(new Error("disk error"));
      } else {
        transfer.transfer.mockImplementationOnce(async (_to, _amount, memo) => {
          payouts.push(memo);
          throw new Error("timeout after destination accepted transaction");
        });
      }
      const loop = await start();
      // A persisted empty block is yielded by processRemains before block 1.
      const remains = await loop.next();
      expect(remains.value.events).toEqual([]);
      // Do not notify the empty resume item: reserve the injected fault for
      // the paid event, and keep the checkpoint at the preceding block.
      await consumeThrough(loop, 1);
      expectPaidOnce([1]);
      await state.store("bsc", { blockHash: hash(0), txId: null });
      await consumeThrough(await restart(), 2);
      expectPaidOnce([1, 2]);
    }
  );

  it("shared: failure to persist PENDING prevents the payout entirely", async () => {
    logs = [burn(1), burn(2)];
    jest.spyOn(history, "put").mockRejectedValueOnce(new Error("disk full"));
    await expect(consumeThrough(await start(), 1)).rejects.toThrow("disk full");
    expectPaidOnce([]);
    await consumeThrough(await restart(), 2);
    expectPaidOnce([1, 2]);
  });

  it("shared: restart between two transactions in one block pays only the remainder", async () => {
    logs = [burn(1, 1, 0), burn(1, 2, 1), burn(2, 3)];
    const put = history.put.bind(history);
    jest.spyOn(history, "put").mockImplementation(async (row) => {
      if (row.tx_id === hash(10002)) throw new Error("process interrupted");
      return put(row);
    });
    await expect(consumeThrough(await start(), 1)).rejects.toThrow(
      "process interrupted"
    );
    expectPaidOnce([1]);
    expect(await state.load("bsc")).toEqual({
      blockHash: hash(1),
      txId: hash(10001),
    });
    await consumeThrough(await restart(), 2);
    expectPaidOnce([1, 2, 3]);
  });

  it("shared: losing both the payout reply and error notification leaves a durable guard", async () => {
    logs = [burn(1), burn(2)];
    transfer.transfer.mockImplementationOnce(async (_to, _amount, memo) => {
      payouts.push(memo);
      throw new Error("lost reply");
    });
    slack.sendMessage.mockRejectedValueOnce(new Error("process interrupted"));
    await expect(consumeThrough(await start(), 1)).rejects.toThrow(
      "process interrupted"
    );
    expect(
      (await history.getPendingTransactions()).map((row) => row.tx_id)
    ).toEqual([hash(10001)]);
    await consumeThrough(await restart(), 2);
    expectPaidOnce([1, 2]);
  });

  it("batch: partial range splitting followed by timeout never duplicates payouts", async () => {
    logs = [burn(1), burn(25), burn(26), burn(50)];
    const getLogs = provider.getLogs.getMockImplementation()!;
    let failed = false;
    provider.getLogs.mockImplementation(async (filter) => {
      if (filter.toBlock - filter.fromBlock + 1 > 25) {
        throw { code: -32005, message: "block range limit exceeded" };
      }
      if (filter.fromBlock === 26 && !failed) {
        failed = true;
        expectPaidOnce([]);
        throw new Error("right half timed out after left half succeeded");
      }
      return getLogs(filter);
    });
    await consumeThrough(await start(), 50);
    expect(failed).toBe(true);
    expectPaidOnce([1, 25, 26, 50]);
  });

  it("batch: an anchor timeout after payment resumes without paying its prefix again", async () => {
    logs = [burn(1), burn(2), burn(50)];
    const getBlock = provider.getBlock.getMockImplementation()!;
    let failed = false;
    provider.getBlock.mockImplementation(async (index) => {
      if (index === 50 && payouts.length === 1 && !failed) {
        failed = true;
        throw new Error("anchor read failed after block 1 payment");
      }
      return getBlock(index);
    });
    await consumeThrough(await start(), 50);
    expect(failed).toBe(true);
    expectPaidOnce([1, 2, 50]);
  });

  it("batch: crossing the 1000-block boundary and restarting preserves single payouts", async () => {
    logs = [burn(999), burn(1000), burn(1001), burn(1010)];
    provider.getBlockNumber.mockResolvedValue(1030);
    const loop = await start();
    await consumeThrough(loop, 1001);
    expectPaidOnce([999, 1000, 1001]);
    expect(provider.getLogs).toHaveBeenCalledWith(
      expect.objectContaining({ fromBlock: 1, toBlock: 1000 })
    );
    expect(provider.getLogs).toHaveBeenCalledWith(
      expect.objectContaining({ fromBlock: 1001, toBlock: 1020 })
    );
    await consumeThrough(await restart(), 1010);
    expectPaidOnce([999, 1000, 1001, 1010]);
  });

  it("batch: re-included source transaction under a changed anchor is paid at most once", async () => {
    logs = [burn(1), burn(2), burn(50)];
    const loop = await start();
    await consumeThrough(loop, 1);
    // A coherent branch change moves an already paid transaction to block 2.
    // Existing history must still suppress it when the cached range is refetched.
    logs = [burn(2, 1), burn(3, 3), burn(50)].map((log) => ({
      ...log,
      blockHash: hash(20000 + log.blockNumber),
    }));
    const getBlock = provider.getBlock.getMockImplementation()!;
    provider.getBlock.mockImplementation(async (index) => {
      if (typeof index === "number" && index >= 2)
        return { number: index, hash: hash(20000 + index) };
      return getBlock(index);
    });
    for (const index of [2, 3]) {
      const item = await loop.next();
      expect(item.value.blockHash).toBe(hash(20000 + index));
      await observer.notify(item.value);
    }
    expect(
      provider.getLogs.mock.calls.some(([filter]) => filter.fromBlock === 2)
    ).toBe(true);
    expectPaidOnce([1, 3]);
  });

  it("shared: concurrent observers sharing SQLite can only insert one payout intent", async () => {
    logs = [burn(1)];
    const loop = await start();
    await loop.next(); // empty checkpoint block
    const item = await loop.next();
    const secondHistory = await Sqlite3ExchangeHistoryStore.open(
      join(directory, "history.db")
    );
    openStores.push(secondHistory);
    const secondObserver = makeObserver(secondHistory);
    let checked = 0;
    let release: () => void = () => undefined;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    for (const db of [history, secondHistory]) {
      const exists = db.exist.bind(db);
      jest.spyOn(db, "exist").mockImplementation(async (txId) => {
        const result = await exists(txId);
        expect(result).toBe(false);
        if (++checked === 2) release();
        await barrier;
        return result;
      });
    }
    const results = await Promise.allSettled([
      observer.notify(item.value),
      secondObserver.notify(item.value),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find(
      (r) => r.status === "rejected"
    ) as PromiseRejectedResult;
    expect(rejected.reason.code).toBe("SQLITE_CONSTRAINT");
    expectPaidOnce([1]);
  });

  it("shared limitation: independent history databases cannot prevent duplicate payouts", async () => {
    logs = [burn(1)];
    const loop = await start();
    await loop.next();
    const item = await loop.next();
    await observer.notify(item.value);
    const independentHistory = await Sqlite3ExchangeHistoryStore.open(
      join(directory, "independent-history.db")
    );
    openStores.push(independentHistory);
    await makeObserver(independentHistory).notify(item.value);
    // Characterize an existing deployment limitation, not an acceptable
    // exactly-once guarantee. This control also proves the fixture can detect
    // a second irreversible payout when the persistent guard is absent.
    expect(payouts).toEqual([hash(10001), hash(10001)]);
    expect(transfer.transfer).toHaveBeenCalledTimes(2);
  });
});
