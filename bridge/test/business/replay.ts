import { promises as fs } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Database } from "sqlite3";
import { ethers } from "ethers";
import { BscBurnEventMonitor } from "../../src/monitors/bsc-burn-event-monitor";
import { BscBurnEventObserver } from "../../src/observers/burn-event-observer";
import { MultiPlanetary } from "../../src/multi-planetary";
import { BscBurnEventMonitor as OldMonitor } from "../fixtures/pre-pr10/monitors/bsc-burn-event-monitor";
import { BscBurnEventObserver as OldObserver } from "../fixtures/pre-pr10/observers/burn-event-observer";
import { MultiPlanetary as OldPlanets } from "../fixtures/pre-pr10/multi-planetary";
import { Sqlite3MonitorStateStore } from "../../src/sqlite3-monitor-state-store";
import { Sqlite3ExchangeHistoryStore } from "../../src/sqlite3-exchange-history-store";
import { TransactionLocation } from "../../src/types/transaction-location";
import { TransactionStatus } from "../../src/types/transaction-status";
import { OpenSearchClient } from "../../src/opensearch-client";
import { SpreadsheetClient } from "../../src/spreadsheet-client";
import { ExchangeHistory } from "../../src/interfaces/exchange-history-store";

export interface ReplayFixture {
  provenance: { kind: "synthetic" | "captured"; description: string };
  contractAddress: string;
  planetIds: { odin: string; heimdall: string };
  heimdallVault: string;
  confirmations: number;
  tip: number;
  checkpoint: TransactionLocation;
  headers: { number: number; hash: string; parentHash: string }[];
  logs: ethers.providers.Log[];
  initialHistory?: ExchangeHistory[];
}

export interface Payout {
  sourceTx: string;
  recipient: string;
  amount: string;
  memo: string;
}

const abi = [
  "event SentToLibPlanet(address indexed _user, uint256 _amount, bytes32 _to)",
];

// Independent business oracle: decode fixed ABI words directly, use integer
// arithmetic, and do not call the production parser, Decimal or MultiPlanetary.
export function expectedPayouts(fixture: ReplayFixture): Payout[] {
  const checkpoint = fixture.headers.find(
    (h) => h.hash === fixture.checkpoint.blockHash
  );
  if (!checkpoint) throw new Error("Checkpoint header missing from fixture");
  const ordered = [...fixture.logs].sort(
    (a, b) =>
      a.blockNumber - b.blockNumber ||
      a.transactionIndex - b.transactionIndex ||
      a.logIndex - b.logIndex
  );
  let passedCursor = fixture.checkpoint.txId === null;
  const seen = new Set((fixture.initialHistory ?? []).map((row) => row.tx_id));
  const result: Payout[] = [];
  for (const log of ordered) {
    if (
      log.blockNumber < checkpoint.number ||
      log.blockNumber > fixture.tip - fixture.confirmations
    )
      continue;
    if (!passedCursor) {
      if (log.transactionHash === fixture.checkpoint.txId) passedCursor = true;
      continue;
    }
    if (seen.has(log.transactionHash)) continue;
    seen.add(log.transactionHash);
    const cents = BigInt("0x" + log.data.slice(2, 66)) / 10000000000000000n;
    const destination = log.data.slice(66, 130).toLowerCase();
    const prefix = "0x" + destination.slice(0, 12);
    const multi = /^\d0{10}\d$/.test(destination.slice(0, 12));
    const user =
      "0x" + (multi ? destination.slice(12, 52) : destination.slice(0, 40));
    const heimdall =
      multi && prefix === fixture.planetIds.heimdall.toLowerCase();
    result.push({
      sourceTx: log.transactionHash,
      recipient: heimdall ? fixture.heimdallVault : user,
      amount: `${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`,
      memo: heimdall ? user : log.transactionHash,
    });
  }
  if (!passedCursor)
    throw new Error("Checkpoint transaction missing from fixture");
  return result;
}

export function validateFixture(fixture: ReplayFixture): void {
  if (!["synthetic", "captured"].includes(fixture.provenance?.kind))
    throw new Error("Fixture provenance is required");
  const checkpoint = fixture.headers.find(
    (h) => h.hash === fixture.checkpoint.blockHash
  );
  if (
    !checkpoint ||
    !Number.isSafeInteger(fixture.tip) ||
    fixture.confirmations !== 10
  )
    throw new Error("Invalid checkpoint, tip or confirmation policy");
  const headers = new Map(fixture.headers.map((h) => [h.number, h]));
  if (headers.size !== fixture.headers.length)
    throw new Error("Duplicate header heights");
  for (let n = checkpoint.number; n <= fixture.tip; n++) {
    const h = headers.get(n);
    if (
      !h ||
      !/^0x[0-9a-fA-F]{64}$/.test(h.hash) ||
      (n > checkpoint.number && h.parentHash !== headers.get(n - 1)!.hash)
    )
      throw new Error(`Missing or inconsistent canonical header ${n}`);
  }
  const identities = new Set<string>();
  for (const log of fixture.logs) {
    const identity = `${log.transactionHash}:${log.logIndex}`;
    if (identities.has(identity)) throw new Error("Duplicate log in capture");
    identities.add(identity);
    if (
      log.removed ||
      log.address.toLowerCase() !== fixture.contractAddress.toLowerCase() ||
      log.blockHash !== headers.get(log.blockNumber)?.hash ||
      log.topics[0] !==
        ethers.utils.id("SentToLibPlanet(address,uint256,bytes32)") ||
      log.topics.length !== 2 ||
      !/^0x[0-9a-fA-F]{128}$/.test(log.data)
    )
      throw new Error("Invalid burn log in fixture");
  }
  expectedPayouts(fixture);
}

async function readHistory(path: string): Promise<Record<string, unknown>[]> {
  const db = new Database(path);
  try {
    return await new Promise((resolve, reject) =>
      db.all(
        "SELECT network, tx_id, sender, recipient, amount, status FROM exchange_histories ORDER BY tx_id",
        (error, rows) =>
          error ? reject(error) : resolve(rows as Record<string, unknown>[])
      )
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      db.close((error) => (error ? reject(error) : resolve()))
    );
  }
}

// Deliberately offline: no RPC URL, signer, key, real transfer or notification
// client can be supplied. Both versions use fresh, file-backed SQLite stores.
export async function replay(
  fixture: ReplayFixture,
  version: "baseline" | "patched",
  restartAfterBlocks: number[] = []
) {
  validateFixture(fixture);
  const directory = await fs.mkdtemp(join(tmpdir(), "bsc-business-replay-"));
  const payouts: Payout[] = [];
  const notifications: string[] = [];
  let state: Sqlite3MonitorStateStore | undefined;
  let history: Sqlite3ExchangeHistoryStore | undefined;
  let loop: ReturnType<BscBurnEventMonitor["loop"]> | undefined;
  let reads = 0;
  let sourceTx: string | undefined;
  const provider = {
    _isProvider: true,
    getBlockNumber: async () => fixture.tip,
    getBlock: async (id: number | string) => {
      if (++reads > 100000) throw new Error("Replay RPC budget exhausted");
      const header = fixture.headers.find((h) =>
        typeof id === "number" ? h.number === id : h.hash === id
      );
      if (!header) throw new Error(`Header not captured: ${id}`);
      return header;
    },
    getLogs: async ({
      fromBlock,
      toBlock,
    }: {
      fromBlock: number;
      toBlock: number;
    }) =>
      fixture.logs
        .filter(
          (log) => log.blockNumber >= fromBlock && log.blockNumber <= toBlock
        )
        .sort(
          (a, b) =>
            a.blockNumber - b.blockNumber ||
            a.transactionIndex - b.transactionIndex ||
            a.logIndex - b.logIndex
        ),
  } as unknown as ethers.providers.JsonRpcProvider;
  const MonitorClass =
    version === "baseline" ? OldMonitor : BscBurnEventMonitor;
  const ObserverClass =
    version === "baseline" ? OldObserver : BscBurnEventObserver;
  const PlanetClass = version === "baseline" ? OldPlanets : MultiPlanetary;
  const transfer = {
    transfer: async (
      recipient: string,
      amount: string,
      memo: string | null
    ) => {
      if (!sourceTx || memo === null)
        throw new Error("Payout without recorded intent");
      payouts.push({ sourceTx, recipient, amount, memo });
      return `offline-destination-${sourceTx}`;
    },
  };
  try {
    const targets = [
      ...restartAfterBlocks,
      fixture.tip - fixture.confirmations,
    ];
    for (let phase = 0; phase < targets.length; phase++) {
      state = await Sqlite3MonitorStateStore.open(join(directory, "state.db"));
      history = await Sqlite3ExchangeHistoryStore.open(
        join(directory, "history.db")
      );
      if (phase === 0) {
        await state.store("bsc", fixture.checkpoint);
        for (const row of fixture.initialHistory ?? []) await history.put(row);
      }
      const currentHistory = history;
      const recordingHistory = {
        exist: currentHistory.exist.bind(currentHistory),
        put: async (row: Parameters<typeof currentHistory.put>[0]) => {
          await currentHistory.put(row);
          sourceTx = row.tx_id;
        },
        updateStatus: currentHistory.updateStatus.bind(currentHistory),
        getPendingTransactions:
          currentHistory.getPendingTransactions.bind(currentHistory),
        transferredAmountInLast24Hours:
          currentHistory.transferredAmountInLast24Hours.bind(currentHistory),
      };
      const observer = new ObserverClass(
        transfer,
        {
          sendMessage: async (message) => {
            notifications.push(message.constructor.name);
            return { ok: true };
          },
        },
        { to_opensearch: async () => undefined } as unknown as OpenSearchClient,
        {
          to_spreadsheet_burn: async () => undefined,
        } as unknown as SpreadsheetClient,
        state,
        recordingHistory,
        "https://offline.invalid/9c",
        undefined,
        false,
        "https://offline.invalid/bsc",
        { error: async () => undefined },
        // Both constructors above are selected by the same version. Their
        // frozen/current private fields have distinct TypeScript identities.
        new PlanetClass(fixture.planetIds, {
          heimdall: fixture.heimdallVault,
        }) as never,
        ""
      );
      loop = new MonitorClass(
        provider,
        { address: fixture.contractAddress, abi },
        await state.load("bsc"),
        fixture.confirmations
      ).loop();
      let reached = false;
      for (
        let delivery = 0;
        delivery <= fixture.headers.length + 5;
        delivery++
      ) {
        const item = await loop.next();
        if (item.done) throw new Error("Replay ended before target");
        await observer.notify(item.value);
        const height = fixture.headers.find(
          (h) => h.hash === item.value.blockHash
        )!.number;
        if (height === targets[phase]) {
          reached = true;
          break;
        }
        if (height > targets[phase])
          throw new Error("Restart target must be a delivered event block");
      }
      if (!reached) throw new Error("Replay did not reach target");
      await loop.return?.(undefined as never);
      loop = undefined;
      if (phase === targets.length - 1) {
        return {
          payouts,
          notifications,
          checkpoint: await state.load("bsc"),
          history: await readHistory(join(directory, "history.db")),
        };
      }
      state.close();
      history.close();
      state = undefined;
      history = undefined;
    }
    throw new Error("No replay phases");
  } finally {
    await loop?.return?.(undefined as never);
    state?.close();
    history?.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
}

export function assertBusinessResult(
  result: Awaited<ReturnType<typeof replay>>,
  expected: Payout[],
  fixture: ReplayFixture
) {
  expect(result.payouts).toEqual(expected);
  expect(result.history).toHaveLength(
    expected.length + (fixture.initialHistory?.length ?? 0)
  );
  for (const payout of expected) {
    const log = fixture.logs.find(
      (item) => item.transactionHash === payout.sourceTx
    )!;
    const destination = log.data.slice(66, 130).toLowerCase();
    const user =
      "0x" +
      (/^\d0{10}\d$/.test(destination.slice(0, 12))
        ? destination.slice(12, 52)
        : destination.slice(0, 40));
    expect(
      result.history.find((row) => row.tx_id === payout.sourceTx)
    ).toMatchObject({
      network: "bsc",
      recipient: user,
      amount: String(Number(payout.amount)),
      status: TransactionStatus.COMPLETED,
    });
    expect(
      String(
        result.history.find((row) => row.tx_id === payout.sourceTx)!.sender
      ).toLowerCase()
    ).toBe("0x" + log.topics[1].slice(-40).toLowerCase());
  }
  expect(
    result.notifications.filter((name) => name === "UnwrappedEvent")
  ).toHaveLength(expected.length);
  expect(
    result.notifications.every((name) =>
      ["UnwrappedEvent", "UnwrappingRetryIgnoreEvent"].includes(name)
    )
  ).toBe(true);
  for (const row of fixture.initialHistory ?? []) {
    const { timestamp: _timestamp, ...persisted } = row;
    expect(result.history.find((item) => item.tx_id === row.tx_id)).toEqual({
      ...persisted,
      amount: String(row.amount),
    });
  }
  expect(result.checkpoint?.blockHash).toBe(
    fixture.headers.find(
      (h) => h.number === fixture.tip - fixture.confirmations
    )!.hash
  );
}
