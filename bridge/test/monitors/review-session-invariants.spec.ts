import { ethers } from "ethers";
import { BscBurnEventMonitor } from "../../src/monitors/bsc-burn-event-monitor";
import { TriggerableMonitor } from "../../src/monitors/triggerable-monitor";

const contract = {
  address: "0x1111111111111111111111111111111111111111",
  abi: [
    "event SentToLibPlanet(address indexed _user, uint256 _amount, bytes32 _to)",
  ],
};

// Regression cases from the independent read-session audit.
describe("independent read-session lifecycle audit", () => {
  afterEach(() => jest.restoreAllMocks());

  it("waits for the selected endpoint confirmation height before emitting checkpoint burns", async () => {
    const log = {
      ...new ethers.utils.Interface(contract.abi).encodeEventLog(
        "SentToLibPlanet",
        [contract.address, 1, ethers.constants.HashZero]
      ),
      address: contract.address,
      blockNumber: 100,
      blockHash: "hash-100",
      transactionHash: "unprocessed-tx",
      transactionIndex: 0,
      logIndex: 0,
      removed: false,
    };
    const provider = {
      _isProvider: true,
      getBlockNumber: jest
        .fn()
        .mockResolvedValueOnce(105)
        .mockResolvedValue(110),
      getBlock: jest.fn(async () => ({ number: 100, hash: "hash-100" })),
      getLogs: jest.fn(async () => [log]),
    };
    jest.spyOn(console, "error").mockImplementation(() => undefined);
    const waits: number[] = [];
    jest.spyOn(global, "setTimeout").mockImplementation(((
      fn: () => void,
      ms: number
    ) => {
      expect(provider.getLogs).not.toHaveBeenCalled();
      waits.push(ms);
      fn();
      return 0;
    }) as unknown as typeof setTimeout);
    const loop = new BscBurnEventMonitor(
      provider as unknown as ethers.providers.BaseProvider,
      contract,
      { blockHash: "hash-100", txId: null },
      10
    ).loop();
    try {
      const first = await loop.next();
      expect(first.value.events.map((event: any) => event.txId)).toEqual([
        "unprocessed-tx",
      ]);
      expect(provider.getBlockNumber).toHaveBeenCalledTimes(2);
      expect(waits).toEqual([15000]);
    } finally {
      await loop.return?.(undefined as never);
    }
  });

  it("releases its idle session immediately on stop and never notifies an observer", async () => {
    let wake: (() => void) | undefined;
    jest.spyOn(console, "debug").mockImplementation(() => undefined);
    jest.spyOn(global, "setTimeout").mockImplementation(((fn: () => void) => {
      wake = fn;
      return 0;
    }) as unknown as typeof setTimeout);
    class IdleMonitor extends TriggerableMonitor<never> {
      tip = 10;
      sessions = 0;
      releases = 0;
      constructor() {
        super(null, 1);
      }
      protected async beginReadSession() {
        this.sessions++;
        return () => {
          this.releases++;
        };
      }
      protected async processRemains(): Promise<never> {
        throw new Error("unused");
      }
      protected triggerredBlocks(n: number) {
        return [n];
      }
      protected async getBlockIndex() {
        return 0;
      }
      protected async getBlockHash(n: number) {
        return `hash-${n}`;
      }
      protected async getTipIndex() {
        return this.tip;
      }
      protected async getEvents() {
        return [];
      }
      consume() {
        (this as any).running = true;
        return (this as any).startMonitoring() as Promise<void>;
      }
    }
    const flush = async () => {
      for (let i = 0; i < 30; i++) await Promise.resolve();
    };
    const monitor = new IdleMonitor();
    const notify = jest.fn(async () => undefined);
    monitor.attach({ notify });
    const done = monitor.consume();
    await flush();
    expect(wake).toBeDefined();
    monitor.stop();
    await done;
    expect(monitor.sessions).toBe(1);
    expect(monitor.releases).toBe(1);
    expect(notify).not.toHaveBeenCalled();
  });

  it.each(["session", "tip", "resume", "range"] as const)(
    "does not notify and releases the lease when stop arrives during pending %s work",
    async (stage) => {
      jest.spyOn(console, "debug").mockImplementation(() => undefined);
      let resume!: () => void;
      let reached!: () => void;
      const gate = new Promise<void>((resolve) => {
        resume = resolve;
      });
      const pending = new Promise<void>((resolve) => {
        reached = resolve;
      });
      const pause = async (at: typeof stage) => {
        if (at === stage) {
          reached();
          await gate;
        }
      };
      class PendingMonitor extends TriggerableMonitor<never> {
        sessions = 0;
        releases = 0;
        tips = 0;
        constructor() {
          super(
            stage === "resume" ? { blockHash: "hash-0", txId: null } : null,
            1,
            1,
            0
          );
        }
        protected async beginReadSession() {
          this.sessions++;
          await pause("session");
          return () => {
            this.releases++;
          };
        }
        protected async processRemains() {
          await pause("resume");
          return {
            nextBlockIndex: 0,
            remainedEvents: [{ blockHash: "hash-0", events: [] }],
          };
        }
        protected triggerredBlocks(n: number) {
          return [n];
        }
        protected async getBlockIndex() {
          return 0;
        }
        protected async getBlockHash(n: number) {
          return `hash-${n}`;
        }
        protected async getTipIndex() {
          await pause("tip");
          return this.tips++ === 0 ? 0 : 2;
        }
        protected async getEvents() {
          return [];
        }
        protected async getEventsInRange() {
          await pause("range");
          return new Map<number, never[]>();
        }
        consume() {
          (this as any).running = true;
          return (this as any).startMonitoring() as Promise<void>;
        }
      }
      const monitor = new PendingMonitor();
      const notify = jest.fn(async () => undefined);
      monitor.attach({ notify });
      const done = monitor.consume();
      await pending;
      monitor.stop();
      resume();
      await done;
      expect(monitor.sessions).toBe(1);
      expect(monitor.releases).toBe(1);
      expect(notify).not.toHaveBeenCalled();
    }
  );
});
