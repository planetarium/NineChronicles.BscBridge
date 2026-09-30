import { TriggerableMonitor } from "../../src/monitors/triggerable-monitor";
import { TransactionLocation } from "../../src/types/transaction-location";

type TestEvent = { marker: string };

/**
 * Minimal concrete TriggerableMonitor for exercising the base class' loop /
 * retry-backoff / catch-up-batching logic in isolation from any real RPC
 * provider. `confirmations` is always 0 here (`triggerredBlocks` is the
 * identity function), so a "chain tip index" and a "triggered block index"
 * are the same number, which keeps the test scenarios easy to reason about.
 */
class TestMonitor extends TriggerableMonitor<TestEvent> {
  getTipIndex = jest.fn<Promise<number>, []>();
  getBlockHashMock = jest.fn<Promise<string>, [number]>((blockIndex) =>
    Promise.resolve(`hash-${blockIndex}`)
  );
  getEventsMock = jest.fn<
    Promise<(TestEvent & TransactionLocation)[]>,
    [number]
  >(() => Promise.resolve([]));
  getEventsInRangeMock = jest.fn<
    Promise<Map<number, (TestEvent & TransactionLocation)[]>>,
    [number, number]
  >();

  constructor(
    delayMilliseconds?: number,
    maxDelayMilliseconds?: number,
    catchUpThresholdBlocks?: number,
    maxCatchUpBatchSize?: number
  ) {
    super(
      null,
      delayMilliseconds,
      maxDelayMilliseconds,
      catchUpThresholdBlocks,
      maxCatchUpBatchSize
    );
  }

  protected async processRemains(): Promise<never> {
    throw new Error("not used in these tests");
  }

  protected triggerredBlocks(blockIndex: number): number[] {
    return [blockIndex];
  }

  protected async getBlockIndex(): Promise<number> {
    throw new Error("not used in these tests");
  }

  protected getBlockHash(blockIndex: number): Promise<string> {
    return this.getBlockHashMock(blockIndex);
  }

  protected getEvents(
    blockIndex: number
  ): Promise<(TestEvent & TransactionLocation)[]> {
    return this.getEventsMock(blockIndex);
  }

  protected getEventsInRange(
    fromBlockIndex: number,
    toBlockIndex: number
  ): Promise<Map<number, (TestEvent & TransactionLocation)[]>> {
    return this.getEventsInRangeMock(fromBlockIndex, toBlockIndex);
  }
}

describe(TriggerableMonitor.name, () => {
  let recordedDelays: number[];
  let setTimeoutSpy: jest.SpyInstance;

  beforeEach(() => {
    recordedDelays = [];
    // Make `delay()` resolve immediately while recording the requested
    // backoff so tests run fast and deterministically without needing to
    // actually wait out any real (or fake) timers.
    setTimeoutSpy = jest.spyOn(global, "setTimeout").mockImplementation(((
      callback: () => void,
      ms?: number
    ) => {
      recordedDelays.push(ms ?? 0);
      callback();
      return 0 as unknown as NodeJS.Timeout;
    }) as unknown as typeof setTimeout);
  });

  afterEach(() => {
    setTimeoutSpy.mockRestore();
  });

  it("processes one block at a time and never batches when the backlog stays small", async () => {
    const monitor = new TestMonitor(100, 800, 10, 1000);

    monitor.getTipIndex
      .mockResolvedValueOnce(10) // initial tip
      .mockResolvedValueOnce(11); // one new block appears

    const loop = monitor.loop();
    const { value } = await loop.next();

    expect(value).toEqual({ blockHash: "hash-11", events: [] });
    expect(monitor.getEventsMock).toHaveBeenCalledWith(11);
    expect(monitor.getEventsInRangeMock).not.toHaveBeenCalled();
  });

  it("backs off exponentially on consecutive errors, capped at maxDelayMilliseconds, and resets after a success", async () => {
    const monitor = new TestMonitor(100, 800, 10, 1000);

    monitor.getTipIndex
      .mockResolvedValueOnce(10) // initial tip
      .mockRejectedValueOnce(new Error("rpc error 1"))
      .mockRejectedValueOnce(new Error("rpc error 2"))
      .mockRejectedValueOnce(new Error("rpc error 3"))
      .mockRejectedValueOnce(new Error("rpc error 4"))
      .mockRejectedValueOnce(new Error("rpc error 5"))
      .mockResolvedValueOnce(11); // recovers

    const loop = monitor.loop();
    const first = await loop.next();

    expect(first.value).toEqual({ blockHash: "hash-11", events: [] });
    // 100, 200, 400, 800, 800 (capped) - never unbounded, matching the
    // idle branch's existing fixed-delay behavior at minimum, and going
    // further with exponential growth capped at maxDelayMilliseconds.
    expect(recordedDelays).toEqual([100, 200, 400, 800, 800]);

    recordedDelays.length = 0;
    monitor.getTipIndex
      .mockRejectedValueOnce(new Error("rpc error 6"))
      .mockResolvedValueOnce(12);

    const second = await loop.next();

    expect(second.value).toEqual({ blockHash: "hash-12", events: [] });
    // Backoff restarts from the base delay after the previous success,
    // instead of continuing to climb (or staying capped) from before.
    expect(recordedDelays).toEqual([100]);
  });

  it("delays by the fixed idle delay (no backoff growth) when simply caught up", async () => {
    const monitor = new TestMonitor(100, 800, 10, 1000);

    monitor.getTipIndex
      .mockResolvedValueOnce(10) // initial tip
      .mockResolvedValueOnce(10) // still caught up: idle branch
      .mockResolvedValueOnce(11); // then a new block appears

    const loop = monitor.loop();
    const { value } = await loop.next();

    expect(value).toEqual({ blockHash: "hash-11", events: [] });
    expect(recordedDelays).toEqual([100]);
  });

  it("batches the event range query when the backlog exceeds the catch-up threshold", async () => {
    const monitor = new TestMonitor(100, 800, 5, 10);

    monitor.getTipIndex
      .mockResolvedValueOnce(0) // initial tip: nothing processed yet
      .mockResolvedValueOnce(50); // a big backlog appears (e.g. after an RPC switch)

    const eventsByBlockIndex = new Map<
      number,
      (TestEvent & TransactionLocation)[]
    >();
    for (let blockIndex = 1; blockIndex <= 10; blockIndex++) {
      eventsByBlockIndex.set(blockIndex, []);
    }
    monitor.getEventsInRangeMock.mockResolvedValueOnce(eventsByBlockIndex);

    const loop = monitor.loop();

    const results: { blockHash: string; events: TestEvent[] }[] = [];
    for (let i = 0; i < 10; i++) {
      const { value } = await loop.next();
      results.push(value);
    }

    // maxCatchUpBatchSize=10, so only the first 10 blocks of the 50-block
    // backlog are covered by this single batch (`getEventsInRange` called
    // exactly once, not once per block).
    expect(monitor.getEventsInRangeMock).toHaveBeenCalledTimes(1);
    expect(monitor.getEventsInRangeMock).toHaveBeenCalledWith(1, 10);
    expect(monitor.getEventsMock).not.toHaveBeenCalled();

    expect(results.map((r) => r.blockHash)).toEqual(
      Array.from({ length: 10 }, (_, i) => `hash-${i + 1}`)
    );
    expect(monitor.getBlockHashMock).toHaveBeenCalledTimes(10);
  });

  it("does not batch when the backlog is at or below the catch-up threshold", async () => {
    const monitor = new TestMonitor(100, 800, 5, 10);

    monitor.getTipIndex
      .mockResolvedValueOnce(0) // initial tip
      .mockResolvedValueOnce(5); // backlog of 5, equal to the threshold

    const loop = monitor.loop();
    const { value } = await loop.next();

    expect(value).toEqual({ blockHash: "hash-1", events: [] });
    expect(monitor.getEventsInRangeMock).not.toHaveBeenCalled();
    expect(monitor.getEventsMock).toHaveBeenCalledWith(1);
  });
});
