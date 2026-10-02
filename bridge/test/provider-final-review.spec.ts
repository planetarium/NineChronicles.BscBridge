import { ethers } from "ethers";
import { PrimaryRpcProvider } from "../src/primary-rpc-provider";

describe("independent provider final review", () => {
  afterEach(() => jest.restoreAllMocks());

  it.each([
    { code: "TIMEOUT", message: "request timed out" },
    { code: "SERVER_ERROR", status: 429, message: "bad response" },
    {
      code: "SERVER_ERROR",
      message: "processing response error",
      error: { code: -32005, message: "limit exceeded" },
    },
  ])(
    "fails over eth_call when ethers wraps transport failure %j",
    async (failure) => {
      const calls: string[] = [];
      jest
        .spyOn(ethers.providers.JsonRpcProvider.prototype, "send")
        .mockImplementation(async function (
          this: ethers.providers.JsonRpcProvider,
          method: string
        ) {
          const primary = this.connection.url.includes("primary");
          calls.push(`${primary ? "A" : "B"}:${method}`);
          if (method === "eth_chainId") return "0x1";
          if (primary && method === "eth_call") throw failure;
          return "0x1234";
        });
      const provider = new PrimaryRpcProvider(
        "http://primary.invalid",
        "http://secondary.invalid",
        { expectedChainId: 1 }
      );
      await expect(
        provider.perform("call", {
          transaction: { to: "0x0000000000000000000000000000000000000001" },
          blockTag: "latest",
        })
      ).resolves.toBe("0x1234");
      expect(calls).toEqual([
        "A:eth_chainId",
        "A:eth_call",
        "B:eth_chainId",
        "B:eth_call",
      ]);
    }
  );
});
