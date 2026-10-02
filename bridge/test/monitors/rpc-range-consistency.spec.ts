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
import { OpenSearchClient } from "../../src/opensearch-client";
import { SpreadsheetClient } from "../../src/spreadsheet-client";

const contract = {
  address: "0x1111111111111111111111111111111111111111",
  abi: [
    "event SentToLibPlanet(address indexed _user, uint256 _amount, bytes32 _to)",
  ],
};
const recipient = "0x2222222222222222222222222222222222222222";
const hash = (n: number) =>
  ethers.utils.hexZeroPad(ethers.utils.hexlify(n), 32);
const planets = new MultiPlanetary(
  { odin: "0x100000000000", heimdall: "0x100000000001" },
  { heimdall: "0x3333333333333333333333333333333333333333" }
);
function burn(blockNumber: number): ethers.providers.Log {
  return {
    ...new ethers.utils.Interface(contract.abi).encodeEventLog(
      "SentToLibPlanet",
      [
        contract.address,
        ethers.utils.parseEther("1"),
        recipient + "00".repeat(12),
      ]
    ),
    address: contract.address,
    blockNumber,
    blockHash: hash(blockNumber),
    transactionHash: hash(10000 + blockNumber),
    transactionIndex: 0,
    logIndex: 0,
    removed: false,
  };
}
type Endpoint = "primary" | "secondary";
type Call = { endpoint: Endpoint; method: string; params: any[] };
type Loop = ReturnType<BscBurnEventMonitor["loop"]>;

// Real public monitor loop, ethers formatting/routing, observer, and reopened
// file-backed SQLite. Only the raw RPC transport and external effects are fake.
describe("RPC range consistency across endpoint recovery", () => {
  let directory: string;
  let state: Sqlite3MonitorStateStore;
  let history: Sqlite3ExchangeHistoryStore;
  let observer: BscBurnEventObserver;
  let loops: Loop[];
  let now: number;
  let payouts: string[];
  let transfer: { transfer: jest.Mock };

  const open = async () => {
    state = await Sqlite3MonitorStateStore.open(join(directory, "state.db"));
    history = await Sqlite3ExchangeHistoryStore.open(
      join(directory, "history.db")
    );
    observer = new BscBurnEventObserver(
      transfer,
      { sendMessage: jest.fn().mockResolvedValue(undefined) },
      {
        to_opensearch: jest.fn().mockResolvedValue(undefined),
      } as unknown as OpenSearchClient,
      {
        to_spreadsheet_burn: jest.fn().mockResolvedValue(undefined),
      } as unknown as SpreadsheetClient,
      state,
      history,
      "https://example.test/9c",
      undefined,
      false,
      "https://example.test/bsc",
      { error: jest.fn() },
      planets,
      ""
    );
  };
  const start = async (rpc: PrimaryRpcProvider) => {
    const loop = new BscBurnEventMonitor(
      rpc,
      contract,
      await state.load("bsc"),
      10
    ).loop();
    loops.push(loop);
    return loop;
  };
  const consume = async (loop: Loop) => {
    const item = await loop.next();
    if (item.done) throw new Error("monitor ended unexpectedly");
    await observer.notify(item.value);
    return item.value;
  };
  const restart = async (rpc: PrimaryRpcProvider) => {
    for (const loop of loops.splice(0)) await loop.return?.(undefined as never);
    state.close();
    history.close();
    await open();
    return start(rpc);
  };

  beforeEach(async () => {
    directory = await fs.mkdtemp(join(tmpdir(), "bsc-rpc-consistency-"));
    loops = [];
    now = 100000;
    payouts = [];
    transfer = {
      transfer: jest.fn(async (_to, _amount, memo: string) => {
        payouts.push(memo);
        return `destination-${memo}`;
      }),
    };
    jest.spyOn(Date, "now").mockImplementation(() => now);
    for (const method of ["log", "debug", "error"] as const)
      jest.spyOn(console, method).mockImplementation(() => undefined);
    const realSetTimeout = global.setTimeout;
    let delays = 0;
    jest.spyOn(global, "setTimeout").mockImplementation(((fn, ms, ...args) => {
      if ((ms ?? 0) >= 15000) {
        if (++delays > 20) throw new Error("test recovery budget exhausted");
        return realSetTimeout(fn, 0, ...args);
      }
      return realSetTimeout(fn, ms, ...args);
    }) as typeof setTimeout);
    await open();
    await state.store("bsc", { blockHash: hash(0), txId: null });
  });
  afterEach(async () => {
    for (const loop of loops) await loop.return?.(undefined as never);
    state.close();
    history.close();
    jest.restoreAllMocks();
    await fs.rm(directory, { recursive: true, force: true });
  });

  function routing(
    options: {
      beforeRead?: (call: Call) => void;
      primaryLogs?: ethers.providers.Log[];
      secondaryLogs?: ethers.providers.Log[];
      splitSecondary?: boolean;
      forkSecondary?: boolean;
      tip?: (endpoint: Endpoint) => number;
    } = {}
  ) {
    const calls: Call[] = [];
    jest
      .spyOn(ethers.providers.JsonRpcProvider.prototype, "send")
      .mockImplementation(async function (
        this: ethers.providers.JsonRpcProvider,
        method,
        params
      ) {
        const endpoint: Endpoint = this.connection.url.includes("primary")
          ? "primary"
          : "secondary";
        const call = { endpoint, method, params };
        calls.push(call);
        if (calls.length > 1000) throw new Error("test RPC budget exhausted");
        options.beforeRead?.(call);
        if (method === "eth_chainId") return "0x38";
        if (method === "net_version") return "56";
        if (method === "eth_blockNumber")
          return ethers.utils.hexValue(
            options.tip?.(endpoint) ?? (endpoint === "primary" ? 1010 : 1000)
          );
        if (method === "eth_getLogs") {
          const from = Number(BigInt(params[0].fromBlock));
          const to = Number(BigInt(params[0].toBlock));
          if (endpoint === "secondary" && options.splitSecondary) {
            if (to - from + 1 > 250)
              throw { code: -32005, message: "block range limit exceeded" };
            // Four successful sequential 8-second calls exhaust the real
            // provider's 30-second cooldown without fake timers hiding I/O.
            now += 8000;
          }
          return (
            endpoint === "primary"
              ? options.primaryLogs ?? [burn(999)]
              : options.secondaryLogs ?? []
          )
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
          const fork = endpoint === "secondary" && options.forkSecondary;
          return {
            number: ethers.utils.hexValue(number),
            hash: hash(number + (fork && number >= 999 ? 20000 : 0)),
            parentHash: hash(
              Math.max(0, number - 1) + (fork && number > 999 ? 20000 : 0)
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
        { expectedChainId: 56 }
      ),
    };
  }

  it("pins slow secondary split reads until checkpoint 990, then pays burn 999 after primary recovery and stale restart", async () => {
    let failed = false;
    const { rpc, calls } = routing({
      splitSecondary: true,
      forkSecondary: true,
      beforeRead: ({ endpoint, method, params }) => {
        if (
          !failed &&
          endpoint === "primary" &&
          method === "eth_getLogs" &&
          Number(BigInt(params[0].fromBlock)) === 1
        ) {
          failed = true;
          throw { code: "TIMEOUT", message: "primary log read timed out" };
        }
      },
    });
    const loop = await start(rpc);
    expect((await consume(loop)).blockHash).toBe(hash(0));
    const epoch = rpc.readEpoch;
    // Retry leases the lagging secondary for its whole slow range. Its real
    // height permits only blocks through 990 with ten confirmations.
    expect((await consume(loop)).blockHash).toBe(hash(990));
    expect(await state.load("bsc")).toEqual({
      blockHash: hash(990),
      txId: null,
    });
    expect(payouts).toEqual([]);
    expect(rpc.readEpoch).toBe(epoch + 1);
    const first = await consume(loop);
    expect(first.blockHash).toBe(hash(999));
    expect(first.events.map((event) => event.txId)).toEqual([hash(10999)]);
    expect(payouts).toEqual([hash(10999)]);
    expect(rpc.readEpoch).toBe(epoch + 2);
    expect(now).toBe(132000);
    expect(
      calls.filter(
        (call) =>
          call.endpoint === "secondary" &&
          call.method === "eth_getLogs" &&
          Number(BigInt(call.params[0].toBlock)) -
            Number(BigInt(call.params[0].fromBlock)) +
            1 <=
            250
      )
    ).toHaveLength(4);
    expect(
      calls.filter(
        (call) =>
          call.endpoint === "primary" &&
          call.method === "eth_getLogs" &&
          Number(BigInt(call.params[0].fromBlock)) === 1
      )
    ).toHaveLength(1);
    expect(
      calls.some(
        (call) =>
          call.endpoint === "primary" &&
          call.method === "eth_getLogs" &&
          Number(BigInt(call.params[0].fromBlock)) === 991
      )
    ).toBe(true);
    expect((await consume(loop)).blockHash).toBe(hash(1000));
    expect(await state.load("bsc")).toEqual({
      blockHash: hash(1000),
      txId: null,
    });
    await state.store("bsc", { blockHash: hash(0), txId: null });
    const resumed = await restart(rpc);
    await consume(resumed);
    expect((await consume(resumed)).blockHash).toBe(hash(999));
    expect((await consume(resumed)).blockHash).toBe(hash(1000));
    expect(payouts).toEqual([hash(10999)]);
    expect(transfer.transfer).toHaveBeenCalledTimes(1);
  });

  it("retries an empty range on the secondary after the final primary anchor check fails", async () => {
    let anchorReads = 0;
    let failed = false;
    const { rpc, calls } = routing({
      primaryLogs: [],
      secondaryLogs: [],
      beforeRead: ({ endpoint, method, params }) => {
        if (
          endpoint === "primary" &&
          method === "eth_getBlockByNumber" &&
          Number(BigInt(params[0])) === 1000 &&
          ++anchorReads === 3
        ) {
          failed = true;
          throw { code: "TIMEOUT", message: "final anchor read failed" };
        }
      },
    });
    const loop = await start(rpc);
    await consume(loop);
    // The failed primary session cannot commit its cached empty range.
    // Retry uses the secondary's own height and ten confirmations.
    expect((await consume(loop)).blockHash).toBe(hash(990));
    expect(failed).toBe(true);
    expect(rpc.readEpoch).toBe(1);
    expect(
      calls
        .filter(
          (call) =>
            call.endpoint === "secondary" && call.method === "eth_getLogs"
        )
        .map((call) => [
          Number(BigInt(call.params[0].fromBlock)),
          Number(BigInt(call.params[0].toBlock)),
        ])
    ).toEqual([[1, 990]]);
    expect(payouts).toEqual([]);
  });

  it("keeps the paid prefix while discarding secondary cached events on primary recovery", async () => {
    let failed = false;
    let anchorFailed = false;
    const { rpc, calls } = routing({
      primaryLogs: [burn(1), burn(999)],
      secondaryLogs: [burn(1), burn(20)],
      beforeRead: ({ endpoint, method, params }) => {
        if (
          !anchorFailed &&
          endpoint === "secondary" &&
          method === "eth_getBlockByNumber" &&
          Number(BigInt(params[0])) === 990 &&
          payouts.length === 1
        ) {
          anchorFailed = true;
          throw {
            code: "TIMEOUT",
            message: "secondary anchor failed after prefix payout",
          };
        }
        if (!failed && endpoint === "primary" && method === "eth_blockNumber") {
          failed = true;
          throw { code: "TIMEOUT", message: "primary tip read failed" };
        }
      },
    });
    const loop = await start(rpc);
    await consume(loop);
    expect((await consume(loop)).blockHash).toBe(hash(1));
    expect(payouts).toEqual([hash(10001)]);
    now += 31000;
    expect((await consume(loop)).blockHash).toBe(hash(999));
    expect(payouts).toEqual([hash(10001), hash(10999)]);
    expect(
      calls
        .filter(
          (call) => call.endpoint === "primary" && call.method === "eth_getLogs"
        )
        .map((call) => Number(BigInt(call.params[0].fromBlock)))
    ).toContain(2);
    expect(transfer.transfer).toHaveBeenCalledTimes(2);
    expect(anchorFailed).toBe(true);
  });

  it("makes progress on a healthy slow secondary even while primary log reads keep failing", async () => {
    let primaryFailures = 0;
    const { rpc, calls } = routing({
      secondaryLogs: [burn(500)],
      splitSecondary: true,
      beforeRead: ({ endpoint, method, params }) => {
        if (
          endpoint === "primary" &&
          method === "eth_getLogs" &&
          Number(BigInt(params[0].fromBlock)) > 0
        ) {
          primaryFailures++;
          throw { code: "TIMEOUT", message: "primary logs remain unavailable" };
        }
      },
    });
    const loop = await start(rpc);
    await consume(loop);
    expect((await consume(loop)).blockHash).toBe(hash(500));
    expect(now).toBe(132000);
    const secondaryStart = calls.findIndex(
      (call) => call.endpoint === "secondary" && call.method === "eth_getLogs"
    );
    expect((await consume(loop)).blockHash).toBe(hash(990));
    expect(
      calls.slice(secondaryStart).every((call) => call.endpoint === "secondary")
    ).toBe(true);
    expect(primaryFailures).toBe(1);
    expect(payouts).toEqual([hash(10500)]);
    expect(await state.load("bsc")).toEqual({
      blockHash: hash(990),
      txId: null,
    });
  });

  it("waits for ten confirmations on the selected secondary instead of reusing the higher primary height", async () => {
    let secondaryTip = 1000;
    const { rpc, calls } = routing({
      primaryLogs: [burn(995)],
      secondaryLogs: [burn(995)],
      tip: (endpoint) => (endpoint === "primary" ? 1010 : secondaryTip),
      beforeRead: ({ endpoint, method, params }) => {
        if (
          endpoint === "primary" &&
          method === "eth_getLogs" &&
          Number(BigInt(params[0].fromBlock)) > 0
        )
          throw { code: "TIMEOUT", message: "primary logs remain unavailable" };
      },
    });
    const loop = await start(rpc);
    await consume(loop);
    expect((await consume(loop)).blockHash).toBe(hash(990));
    expect(payouts).toEqual([]);
    const secondaryRanges = calls.filter(
      (call) => call.endpoint === "secondary" && call.method === "eth_getLogs"
    );
    expect(
      secondaryRanges.map((call) => Number(BigInt(call.params[0].toBlock)))
    ).toEqual([990]);
    expect(
      calls.some(
        (call) =>
          call.endpoint === "secondary" &&
          call.method === "eth_getBlockByNumber" &&
          Number(BigInt(call.params[0])) > 990
      )
    ).toBe(false);
    secondaryTip = 1010;
    now += 1000; // Expire ethers' short block-number cache without ending cooldown.
    expect((await consume(loop)).blockHash).toBe(hash(995));
    expect((await consume(loop)).blockHash).toBe(hash(1000));
    expect(payouts).toEqual([hash(10995)]);
    expect(transfer.transfer).toHaveBeenCalledTimes(1);
  });

  it("keeps one epoch and one range read while a healthy endpoint serves all checks", async () => {
    const { rpc, calls } = routing();
    const loop = await start(rpc);
    await consume(loop);
    const epoch = rpc.readEpoch;
    expect((await consume(loop)).blockHash).toBe(hash(999));
    expect((await consume(loop)).blockHash).toBe(hash(1000));
    expect(rpc.readEpoch).toBe(epoch);
    expect(calls.every((call) => call.endpoint === "primary")).toBe(true);
    expect(
      calls.filter(
        (call) =>
          call.method === "eth_getLogs" &&
          Number(BigInt(call.params[0].fromBlock)) === 1
      )
    ).toHaveLength(1);
    expect(payouts).toEqual([hash(10999)]);
  });
});
