import * as http from "http";
import { AddressInfo, Socket } from "net";
import { PrimaryRpcProvider } from "../src/primary-rpc-provider";

type Reply = {
  status?: number;
  result?: unknown;
  error?: { code: number; message: string };
  withholdResponse?: boolean;
};
type Endpoint = {
  url: string;
  calls: string[];
  respond: (method: string) => Reply;
  close: () => Promise<void>;
};

async function endpoint(): Promise<Endpoint> {
  const sockets = new Set<Socket>();
  const state: Endpoint = {
    url: "",
    calls: [],
    respond: (method) => ({
      result: method === "eth_chainId" ? "0x1" : "0x2a",
    }),
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      const rpc = JSON.parse(body);
      state.calls.push(rpc.method);
      const reply = state.respond(rpc.method);
      if (reply.withholdResponse) return;
      response.writeHead(reply.status ?? 200, {
        "Content-Type": "application/json",
      });
      response.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: rpc.id,
          result: reply.result,
          error: reply.error,
        })
      );
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  state.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return state;
}

describe("primary RPC provider over real HTTP", () => {
  let primary: Endpoint | undefined;
  let secondary: Endpoint | undefined;
  beforeEach(async () => {
    primary = await endpoint();
    secondary = await endpoint();
  });
  afterEach(async () => {
    await Promise.all([primary?.close(), secondary?.close()]);
    primary = secondary = undefined;
  });
  function create(requestTimeoutMs = 1000) {
    return new PrimaryRpcProvider(primary!.url, secondary!.url, {
      expectedChainId: 1,
      requestTimeoutMs,
    });
  }
  function primaryDataReply(reply: Reply) {
    primary!.respond = (method) =>
      method === "eth_chainId" ? { result: "0x1" } : reply;
  }

  // NodeReal's documented JSON-RPC quota replies (HTTP 200):
  // https://docs.nodereal.io/docs/support
  // https://docs.nodereal.io/reference/getting-started-with-your-api
  it.each([
    "limit exceeded",
    "You have reached the maximum API usage limit. If you need higher throughput, please check out https://meganode.nodereal.io/",
  ])("falls back for NodeReal's -32005 quota message: %s", async (message) => {
    primaryDataReply({ error: { code: -32005, message } });
    const provider = create();
    await expect(provider.send("eth_gasPrice", [])).resolves.toBe("0x2a");
    expect(primary!.calls).toEqual(["eth_chainId", "eth_gasPrice"]);
    expect(secondary!.calls).toEqual(["eth_chainId", "eth_gasPrice"]);
    expect(provider.readEpoch).toBe(1);
  });
  it.each([402, 429, 503])(
    "falls back for HTTP %s without replaying the primary read",
    async (status) => {
      primaryDataReply({ status });
      await expect(create().send("eth_gasPrice", [])).resolves.toBe("0x2a");
      expect(primary!.calls).toEqual(["eth_chainId", "eth_gasPrice"]);
      expect(secondary!.calls).toEqual(["eth_chainId", "eth_gasPrice"]);
    }
  );
  it.each([
    "query returned more than 10000 results",
    "request limit exceeded for block range",
    "response size limit exceeded",
  ])("preserves a -32005 log range or result limit: %s", async (message) => {
    primaryDataReply({ error: { code: -32005, message } });
    await expect(create().send("eth_getLogs", [{}])).rejects.toMatchObject({
      error: { code: -32005, message },
    });
    expect(primary!.calls).toEqual(["eth_chainId", "eth_getLogs"]);
    expect(secondary!.calls).toEqual([]);
  });
  it("preserves an execution revert encoded as -32603", async () => {
    primaryDataReply({
      error: { code: -32603, message: "execution reverted" },
    });
    await expect(
      create().perform("estimateGas", {
        transaction: { to: "0x0000000000000000000000000000000000000001" },
      })
    ).rejects.toMatchObject({
      code: "UNPREDICTABLE_GAS_LIMIT",
      error: { error: { code: -32603, message: "execution reverted" } },
    });
    expect(primary!.calls).toEqual(["eth_chainId", "eth_estimateGas"]);
    expect(secondary!.calls).toEqual([]);
  });
  it.each(["eth_sendRawTransaction", "eth_sendTransaction", "custom_write"])(
    "sends %s only once even on HTTP 429",
    async (method) => {
      primaryDataReply({ status: 429 });
      await expect(create().send(method, ["0x1234"])).rejects.toMatchObject({
        code: "SERVER_ERROR",
      });
      expect(primary!.calls).toEqual(["eth_chainId", method]);
      expect(secondary!.calls).toEqual([]);
    }
  );
  it("never replays a signed write whose response was lost", async () => {
    primaryDataReply({ withholdResponse: true });
    await expect(
      create(100).perform("sendTransaction", { signedTransaction: "0x1234" })
    ).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(primary!.calls).toEqual(["eth_chainId", "eth_sendRawTransaction"]);
    expect(secondary!.calls).toEqual([]);
  });
  it("rejects a wrong-chain secondary before sending data", async () => {
    primaryDataReply({ status: 503 });
    secondary!.respond = () => ({ result: "0x38" });
    const provider = create();
    await expect(provider.send("eth_gasPrice", [])).rejects.toMatchObject({
      code: "NETWORK_ERROR",
      event: "changed",
    });
    expect(primary!.calls).toEqual(["eth_chainId", "eth_gasPrice"]);
    expect(secondary!.calls).toEqual(["eth_chainId"]);
    expect(provider.readEpoch).toBe(0);
  });
  it("shares discovery across concurrent reads without changing the epoch", async () => {
    const provider = create();
    await Promise.all(
      Array.from({ length: 10 }, () => provider.send("eth_gasPrice", []))
    );
    expect(
      primary!.calls.filter((method) => method === "eth_chainId")
    ).toHaveLength(1);
    expect(
      primary!.calls.filter((method) => method === "eth_gasPrice")
    ).toHaveLength(10);
    expect(secondary!.calls).toEqual([]);
    expect(provider.readEpoch).toBe(0);
  });
});
