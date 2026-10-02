import { TriggerableMonitor } from "../../src/monitors/triggerable-monitor";
import { TransactionLocation } from "../../src/types/transaction-location";

class StartupMonitor extends TriggerableMonitor<{ marker: string }> {
  getTipIndex = jest.fn<Promise<number>, []>();
  processRemains = jest.fn();
  constructor(location: TransactionLocation | null) {
    super(location, 100, 800);
  }
  protected triggerredBlocks(index: number): number[] {
    return [index];
  }
  protected async getBlockIndex(): Promise<number> {
    return 10;
  }
  protected async getBlockHash(index: number): Promise<string> {
    return `hash-${index}`;
  }
  protected async getEvents() {
    return [];
  }
}

describe("monitor startup retry", () => {
  let delays: number[];
  beforeEach(() => {
    delays = [];
    jest.spyOn(console, "debug").mockImplementation(() => undefined);
    jest.spyOn(console, "error").mockImplementation(() => undefined);
    jest.spyOn(global, "setTimeout").mockImplementation(((
      callback: () => void,
      ms?: number
    ) => {
      delays.push(ms ?? 0);
      if (delays.length > 10) throw new Error("test retry budget exceeded");
      callback();
      return 0 as unknown as NodeJS.Timeout;
    }) as typeof setTimeout);
  });
  afterEach(() => jest.restoreAllMocks());

  it("retries an initial tip outage before choosing a starting cursor", async () => {
    const monitor = new StartupMonitor(null);
    monitor.getTipIndex
      .mockRejectedValueOnce(new Error("tip timeout"))
      .mockRejectedValueOnce(new Error("tip timeout"))
      .mockResolvedValueOnce(10)
      .mockResolvedValueOnce(11);
    const loop = monitor.loop();
    expect((await loop.next()).value).toEqual({
      blockHash: "hash-11",
      events: [],
    });
    expect(delays).toEqual([100, 200]);
    expect(monitor.processRemains).not.toHaveBeenCalled();
    await loop.return?.(undefined as never);
  });

  it("keeps a saved checkpoint until resume reads recover and resets backoff after acknowledgement", async () => {
    const location = { blockHash: "hash-10", txId: "already-paid" };
    const monitor = new StartupMonitor(location);
    const item = {
      blockHash: "hash-10",
      events: [{ ...location, txId: "next-tx", marker: "remaining" }],
    };
    monitor.processRemains
      .mockRejectedValueOnce(new Error("checkpoint timeout"))
      .mockRejectedValueOnce(new Error("temporary missing checkpoint"))
      .mockResolvedValueOnce({ nextBlockIndex: 10, remainedEvents: [item] });
    monitor.getTipIndex
      .mockRejectedValueOnce(new Error("tip unavailable after resume"))
      .mockResolvedValueOnce(11);
    const loop = monitor.loop();
    expect((await loop.next()).value).toEqual(item);
    expect(delays).toEqual([100, 200]);
    expect(monitor.processRemains.mock.calls).toEqual([
      [location],
      [location],
      [location],
    ]);
    expect((await loop.next()).value).toEqual({
      blockHash: "hash-11",
      events: [],
    });
    expect(delays).toEqual([100, 200, 100]);
    expect(monitor.processRemains).toHaveBeenCalledTimes(3);
    await loop.return?.(undefined as never);
  });
});
