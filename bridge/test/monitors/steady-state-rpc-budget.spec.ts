import { ethers } from "ethers";
import { PrimaryRpcProvider } from "../../src/primary-rpc-provider";
import { BscBurnEventMonitor } from "../../src/monitors/bsc-burn-event-monitor";

const contract = {
  address: "0x1111111111111111111111111111111111111111",
  abi: [
    "event SentToLibPlanet(address indexed _user, uint256 _amount, bytes32 _to)",
  ],
};
const hash = (height: number) =>
  ethers.utils.hexZeroPad(ethers.utils.hexlify(height), 32);

describe("BSC steady-state RPC budget on a continuously advancing chain", () => {
  let now: number;
  let initialTip: number;
  let calls: { method: string; params: any[]; time: number }[];

  beforeEach(() => {
    now = 100000;
    initialTip = 120;
    calls = [];
    jest.spyOn(Date, "now").mockImplementation(() => now);
    jest.spyOn(console, "debug").mockImplementation(() => undefined);
    jest
      .spyOn(ethers.providers.JsonRpcProvider.prototype, "send")
      .mockImplementation(async function (method, params) {
        // Every RPC takes one block interval. Thus finishing the range always
        // leaves the monitor behind the live tip, even when it reached the
        // snapshot tip used to construct this batch.
        now += 450;
        calls.push({ method, params, time: now });
        if (calls.length > 500) throw new Error("audit RPC budget exhausted");
        if (method === "eth_chainId") return "0x38";
        if (method === "net_version") return "56";
        if (method === "eth_blockNumber")
          return ethers.utils.hexValue(
            initialTip + Math.floor((now - 100000) / 450)
          );
        if (method === "eth_getLogs") return [];
        if (
          method === "eth_getBlockByNumber" ||
          method === "eth_getBlockByHash"
        ) {
          const height = Number(BigInt(params[0]));
          return {
            number: ethers.utils.hexValue(height),
            hash: hash(height),
            parentHash: hash(Math.max(0, height - 1)),
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
        throw new Error(`unexpected RPC ${method}`);
      });
  });

  afterEach(() => jest.restoreAllMocks());

  class ClockedMonitor extends BscBurnEventMonitor {
    waits: number[] = [];
    onWait: (() => void) | undefined;
    wake: (() => void) | undefined;
    protected async wait(ms: number) {
      this.waits.push(ms);
      this.onWait?.();
      await new Promise<void>((resolve) => {
        this.wake = () => {
          now += ms;
          resolve();
        };
      });
    }
  }

  function fixture(checkpoint = 100) {
    const provider = new PrimaryRpcProvider(
      "https://primary.invalid",
      undefined,
      {
        expectedChainId: 56,
      }
    );
    const monitor = new ClockedMonitor(
      provider,
      contract,
      { blockHash: hash(checkpoint), txId: null },
      10
    );
    return { provider, monitor, loop: monitor.loop() };
  }

  const ranges = () =>
    calls.filter(
      ({ method, params }) =>
        method === "eth_getLogs" &&
        Number(BigInt(params[0].fromBlock)) !==
          Number(BigInt(params[0].toBlock))
    );

  it("waits 15 seconds without an RPC or pinned lease after each completed snapshot range", async () => {
    const { provider, monitor, loop } = fixture();
    let pending: ReturnType<typeof loop.next> | undefined;
    try {
      await loop.next(); // Resume the saved checkpoint.
      await loop.next(); // Consume the first fully verified empty range.
      expect(ranges()).toHaveLength(1);
      for (let cycle = 0; cycle < 3; cycle++) {
        let reachedWait!: () => void;
        const waiting = new Promise<"waiting">((resolve) => {
          reachedWait = () => resolve("waiting");
        });
        monitor.onWait = reachedWait;
        const before = calls.length;
        pending = loop.next(); // Acknowledge the checkpoint.
        expect(
          await Promise.race([waiting, pending.then(() => "unexpected-range")])
        ).toBe("waiting");
        expect(monitor.waits).toEqual(Array(cycle + 1).fill(15000));
        expect((provider as any).readSession).toBeUndefined();
        expect(calls).toHaveLength(before);
        // Let other promise work run: no transport may be started during wait.
        for (let i = 0; i < 30; i++) await Promise.resolve();
        expect(calls).toHaveLength(before);
        monitor.wake!();
        await pending;
        pending = undefined;
        expect(ranges()).toHaveLength(cycle + 2);
        expect(calls.length - before).toBeLessThanOrEqual(24);
      }
    } finally {
      monitor.stop();
      monitor.wake?.();
      await pending;
      await loop.return?.(undefined as never);
    }
  });

  it("does not throttle bounded 1000-block batches while the snapshot has remaining backlog", async () => {
    initialTip = 10000;
    const { monitor, loop } = fixture(0);
    try {
      await loop.next();
      expect((await loop.next()).value.blockHash).toBe(hash(1000));
      expect((await loop.next()).value.blockHash).toBe(hash(2000));
      expect(monitor.waits).toEqual([]);
      expect(
        ranges().map(({ params }) => [
          Number(BigInt(params[0].fromBlock)),
          Number(BigInt(params[0].toBlock)),
        ])
      ).toEqual([
        [1, 1000],
        [1001, 2000],
      ]);
    } finally {
      monitor.stop();
      await loop.return?.(undefined as never);
    }
  });
});
