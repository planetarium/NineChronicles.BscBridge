import { readFileSync } from "fs";
import { ethers } from "ethers";
import { TransactionStatus } from "../../src/types/transaction-status";
import {
  ReplayFixture,
  expectedPayouts,
  replay,
  assertBusinessResult,
  validateFixture,
} from "./replay";

const hash = (n: number) =>
  ethers.utils.hexZeroPad(ethers.utils.hexlify(n), 32);
const address = (n: number) =>
  ethers.utils.hexZeroPad(ethers.utils.hexlify(n), 20);
const user = "0x" + "22".repeat(20);
const vault = "0x" + "33".repeat(20);
const contractAddress = address(0x1111);
const abi = new ethers.utils.Interface([
  "event SentToLibPlanet(address indexed _user, uint256 _amount, bytes32 _to)",
]);

function fixture(end = 1030): ReplayFixture {
  const definitions = [
    [1, "1239999999999999999", "legacy"],
    [2, "10000000000000000", "odin"],
    [3, "123456789123456789000000", "heimdall"],
    [49, "1999999999999999999", "legacy"],
    [50, "2500000000000000000", "odin"],
    [50, "3500000000000000000", "heimdall"],
    [999, "4000000000000000000", "legacy"],
    [1000, "5000000000000000000", "heimdall"],
    [1001, "6000000000000000000", "odin"],
    [1025, "7000000000000000000", "legacy"],
    [end + 1, "8000000000000000000", "legacy"],
    [end + 10, "9000000000000000000", "heimdall"],
  ] as const;
  const logs = definitions
    .filter(([height]) => height <= end + 10)
    .map(([height, amount, route], i) => {
      const to =
        route === "legacy"
          ? user + "00".repeat(12)
          : (route === "odin" ? "0x100000000000" : "0x100000000001") +
            user.slice(2) +
            "00".repeat(6);
      return {
        ...abi.encodeEventLog("SentToLibPlanet", [address(0x4444), amount, to]),
        address: contractAddress,
        blockNumber: height,
        blockHash: hash(height),
        transactionHash: hash(100000 + i),
        transactionIndex: i,
        logIndex: i,
        removed: false,
      };
    });
  return {
    provenance: {
      kind: "synthetic",
      description:
        "Explicit business cases; NOT historical production transactions",
    },
    contractAddress,
    planetIds: { odin: "0x100000000000", heimdall: "0x100000000001" },
    heimdallVault: vault,
    confirmations: 10,
    tip: end + 10,
    checkpoint: { blockHash: hash(0), txId: null },
    headers: Array.from({ length: end + 11 }, (_, number) => ({
      number,
      hash: hash(number),
      parentHash: hash(Math.max(0, number - 1)),
    })),
    logs,
  };
}

describe("offline business equivalence against deployed f352576", () => {
  beforeEach(() => {
    for (const method of ["log", "debug", "error"] as const)
      jest.spyOn(console, method).mockImplementation(() => undefined);
    // A broken monitor must fail, not retry forever. These canonical finite
    // traces should never need idle/backoff waits before their target delivery.
    const realTimeout = global.setTimeout;
    jest.spyOn(global, "setTimeout").mockImplementation(((fn, ms, ...args) => {
      if ((ms ?? 0) >= 15000)
        throw new Error("Unexpected idle/retry before replay target");
      return realTimeout(fn, ms, ...args);
    }) as typeof setTimeout);
  });
  afterEach(() => jest.restoreAllMocks());

  it.each([7, 1030])(
    "preserves the full payout ledger through confirmed block %i",
    async (end) => {
      const capture = fixture(end);
      const expected = expectedPayouts(capture);
      // Literal business examples also check the independent integer/ABI oracle.
      expect(expected.slice(0, 3)).toEqual([
        {
          sourceTx: hash(100000),
          recipient: user,
          amount: "1.23",
          memo: hash(100000),
        },
        {
          sourceTx: hash(100001),
          recipient: user,
          amount: "0.01",
          memo: hash(100001),
        },
        {
          sourceTx: hash(100002),
          recipient: vault,
          amount: "123456.78",
          memo: user,
        },
      ]);
      const old = await replay(capture, "baseline");
      const patched = await replay(capture, "patched");
      assertBusinessResult(old, expected, capture);
      assertBusinessResult(patched, expected, capture);
      expect(patched).toEqual(old);
      expect(
        expected.some(
          (p) =>
            p.sourceTx === capture.logs[capture.logs.length - 1].transactionHash
        )
      ).toBe(false);
    }
  );

  it("preserves routing, amounts, order and durable history across two process restarts", async () => {
    const capture = fixture();
    const expected = expectedPayouts(capture);
    const continuous = await replay(capture, "baseline");
    const old = await replay(capture, "baseline", [50, 1000]);
    const patched = await replay(capture, "patched", [50, 1000]);
    assertBusinessResult(patched, expected, capture);
    expect(old).toEqual(continuous);
    expect(patched).toEqual(continuous);
  });

  it("detects wrong recipient, amount, memo, missing payout and duplicate payout", async () => {
    const capture = fixture(7);
    const expected = expectedPayouts(capture);
    const result = await replay(capture, "patched");
    assertBusinessResult(result, expected, capture);
    for (const change of [
      { recipient: vault },
      { amount: "1.24" },
      { memo: "incorrect" },
    ]) {
      const corrupted = {
        ...result,
        payouts: result.payouts.map((p, i) =>
          i === 0 ? { ...p, ...change } : p
        ),
      };
      expect(() =>
        assertBusinessResult(corrupted, expected, capture)
      ).toThrow();
    }
    expect(() =>
      assertBusinessResult(
        { ...result, payouts: result.payouts.slice(1) },
        expected,
        capture
      )
    ).toThrow();
    expect(() =>
      assertBusinessResult(
        { ...result, payouts: [...result.payouts, result.payouts[0]] },
        expected,
        capture
      )
    ).toThrow();
  });

  it.each([
    TransactionStatus.COMPLETED,
    TransactionStatus.PENDING,
    TransactionStatus.FAILED,
  ])(
    "preserves existing %s history without resubmitting and still pays subsequent burns",
    async (status) => {
      const capture = fixture(7);
      capture.initialHistory = [
        {
          network: "bsc",
          tx_id: capture.logs[1].transactionHash,
          sender: address(0x4444),
          recipient: user,
          amount: 0.01,
          timestamp: "2026-01-01T00:00:00.000Z",
          status,
        },
      ];
      const expected = expectedPayouts(capture);
      expect(expected.map((row) => row.sourceTx)).toEqual([
        hash(100000),
        hash(100002),
      ]);
      const old = await replay(capture, "baseline");
      const patched = await replay(capture, "patched");
      assertBusinessResult(old, expected, capture);
      assertBusinessResult(patched, expected, capture);
      expect(patched).toEqual(old);
    }
  );

  it("rejects inconsistent headers and log captures before running either version", () => {
    const capture = fixture(7);
    const badHeader = JSON.parse(JSON.stringify(capture)) as ReplayFixture;
    badHeader.headers[3].parentHash = hash(999);
    expect(() => validateFixture(badHeader)).toThrow(
      "inconsistent canonical header"
    );
    const badLog = JSON.parse(JSON.stringify(capture)) as ReplayFixture;
    badLog.logs[0].blockHash = hash(999);
    expect(() => validateFixture(badLog)).toThrow("Invalid burn log");
  });

  it("uses the independent oracle instead of preserving the baseline null-cursor omission", async () => {
    const capture = fixture(7);
    capture.checkpoint = { blockHash: hash(1), txId: null };
    const expected = expectedPayouts(capture);
    const old = await replay(capture, "baseline");
    const patched = await replay(capture, "patched");
    expect(old.payouts).toEqual(expected.slice(1));
    expect(() => assertBusinessResult(old, expected, capture)).toThrow();
    assertBusinessResult(patched, expected, capture);
  });

  // Local files only. The harness never fetches an endpoint or sends a payout.
  const capturePath = process.env.BSC_REPLAY_FIXTURE;
  (capturePath ? it : it.skip)(
    "replays an explicitly supplied historical capture",
    async () => {
      const capture = JSON.parse(
        readFileSync(capturePath!, "utf8")
      ) as ReplayFixture;
      expect(capture.provenance.kind).toBe("captured");
      const expected = expectedPayouts(capture);
      expect(expected.length).toBeGreaterThan(0);
      const old = await replay(capture, "baseline");
      const patched = await replay(capture, "patched");
      assertBusinessResult(old, expected, capture);
      assertBusinessResult(patched, expected, capture);
      expect(patched).toEqual(old);
    }
  );
});
