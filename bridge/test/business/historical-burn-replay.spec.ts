import { readFileSync } from "fs";
import { join } from "path";
import {
  ReplayFixture,
  expectedPayouts,
  replay,
  assertBusinessResult,
  validateFixture,
} from "./replay";

const tx = "0x1a8a7e3abf55edfb9e71bc501059faafb37f8456339d5a0347eb62a8f507bba5";
const burnHeight = 124654860;
const expected = [
  {
    sourceTx: tx,
    recipient: "0x1c2ae97380CFB4F732049e454F6D9A25D4967c6f",
    amount: "1629.32",
    memo: "0xeee0f468d0214c389693b119cec2094af727574f",
  },
];
const load = (): ReplayFixture =>
  JSON.parse(
    readFileSync(
      join(__dirname, "../fixtures/captured/bsc-1a8a7e3.json"),
      "utf8"
    )
  );

describe("captured BSC mainnet transaction to Heimdall", () => {
  beforeEach(() => {
    for (const method of ["log", "debug", "error"] as const)
      jest.spyOn(console, method).mockImplementation(() => undefined);
    const realTimeout = global.setTimeout;
    jest.spyOn(global, "setTimeout").mockImplementation(((fn, ms, ...args) => {
      if ((ms ?? 0) >= 15000)
        throw new Error("Unexpected wait before historical replay target");
      return realTimeout(fn, ms, ...args);
    }) as typeof setTimeout);
  });
  afterEach(() => jest.restoreAllMocks());

  it("matches the original successful receipt and a literal mainnet payout manifest", () => {
    const fixture = load();
    const receipt = JSON.parse(
      readFileSync(
        join(__dirname, "../fixtures/captured/bsc-1a8a7e3-receipt.json"),
        "utf8"
      )
    );
    validateFixture(fixture);
    expect(receipt.transactionHash).toBe(tx);
    expect(receipt.status).toBe("0x1");
    expect(Number(BigInt(receipt.blockNumber))).toBe(burnHeight);
    expect(fixture.provenance.kind).toBe("captured");
    expect(fixture.headers).toHaveLength(13);
    expect(fixture.logs).toHaveLength(1);
    expect(fixture.planetIds).toEqual({
      odin: "0x000000000000",
      heimdall: "0x000000000001",
    });
    const log = fixture.logs[0];
    const raw = receipt.logs.find(
      (item: { address: string }) => item.address === fixture.contractAddress
    );
    expect(log).toEqual({
      address: raw.address,
      topics: raw.topics,
      data: raw.data,
      blockHash: receipt.blockHash,
      blockNumber: burnHeight,
      transactionHash: tx,
      transactionIndex: Number(BigInt(raw.transactionIndex)),
      logIndex: Number(BigInt(raw.logIndex)),
      removed: false,
    });
    expect(expectedPayouts(fixture)).toEqual(expected);
  });

  it.each([9, 10])(
    "pays only after ten confirmations (captured height + %i)",
    async (confirmations) => {
      const fixture = load();
      // Keep the original raw log present and vary only the historical tip view.
      fixture.tip = burnHeight + confirmations;
      const payouts = confirmations === 10 ? expected : [];
      expect(expectedPayouts(fixture)).toEqual(payouts);
      const old = await replay(fixture, "baseline");
      const patched = await replay(fixture, "patched");
      assertBusinessResult(old, payouts, fixture);
      assertBusinessResult(patched, payouts, fixture);
      expect(patched).toEqual(old);
    }
  );

  it("reopens SQLite after this burn without repeating its Heimdall payout", async () => {
    const fixture = load();
    const old = await replay(fixture, "baseline", [burnHeight]);
    const patched = await replay(fixture, "patched", [burnHeight]);
    assertBusinessResult(old, expected, fixture);
    assertBusinessResult(patched, expected, fixture);
    expect(patched).toEqual(old);
  });
});
