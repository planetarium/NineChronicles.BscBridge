import { Monitor } from "../../src/monitors";

class SessionMonitor extends Monitor<never> {
  release = jest.fn();
  constructor() {
    super();
  }
  async *loop() {
    try {
      yield { blockHash: "checkpoint", events: [] };
    } finally {
      this.release();
    }
  }
  async consume() {
    // Exercise the actual consumer loop and await its result without starting
    // an unobserved promise via run().
    (this as any).running = true;
    await (this as any).startMonitoring();
  }
}

describe("monitor RPC session cleanup", () => {
  it("closes the suspended generator after stop", async () => {
    const monitor = new SessionMonitor();
    monitor.attach({ notify: async () => monitor.stop() });
    await monitor.consume();
    expect(monitor.release).toHaveBeenCalledTimes(1);
  });
  it("releases the session without repeating an observer after its failure", async () => {
    const monitor = new SessionMonitor();
    const notify = jest.fn(async () => {
      throw new Error("ambiguous payment response");
    });
    monitor.attach({ notify });
    await expect(monitor.consume()).rejects.toThrow(
      "ambiguous payment response"
    );
    expect(notify).toHaveBeenCalledTimes(1);
    expect(monitor.release).toHaveBeenCalledTimes(1);
  });
  it("closes cleanly when the generator ends", async () => {
    const monitor = new SessionMonitor();
    const notify = jest.fn(async () => undefined);
    monitor.attach({ notify });
    await monitor.consume();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(monitor.release).toHaveBeenCalledTimes(1);
  });
});
