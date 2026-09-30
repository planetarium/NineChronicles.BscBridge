import { ethers } from "ethers";
import { BscBurnEventMonitor } from "../../src/monitors/bsc-burn-event-monitor";
import { bscBridgeContractAbi } from "../../src/bsc-bridge-contract-abi";
import { ContractDescription } from "../../src/types/contract-description";

const CONTRACT_ADDRESS = "0x9093dd96c4bb6b44A9E0A522e2DE49641F14622";
const SENDER_ADDRESS = "0x47D082a115c63E7b58B1532d20E631538eaFADd";
const RECIPIENT_BYTES32 =
  "0x0000000000000000000000000000000000000000000000000000000000000001";

const contractDescription: ContractDescription = {
  abi: bscBridgeContractAbi,
  address: CONTRACT_ADDRESS,
};

const SENT_EVENT_TOPIC = ethers.utils.id(
  "SentToLibPlanet(address,uint256,bytes32)"
);

function makeSentLog(
  blockNumber: number,
  amount: number
): ethers.providers.Log {
  return {
    blockNumber,
    blockHash: `0xblock${blockNumber}`,
    transactionIndex: 0,
    removed: false,
    address: CONTRACT_ADDRESS,
    data: ethers.utils.defaultAbiCoder.encode(
      ["uint256", "bytes32"],
      [amount, RECIPIENT_BYTES32]
    ),
    topics: [SENT_EVENT_TOPIC, ethers.utils.hexZeroPad(SENDER_ADDRESS, 32)],
    transactionHash: `0xtx${blockNumber}`,
    logIndex: 0,
  };
}

function makeMockProvider(logs: ethers.providers.Log[]) {
  const getLogs = jest.fn(
    async (filter: { fromBlock: number; toBlock: number }) =>
      logs.filter(
        (log) =>
          log.blockNumber >= filter.fromBlock &&
          log.blockNumber <= filter.toBlock
      )
  );

  return {
    _isProvider: true,
    getLogs,
  } as unknown as ethers.providers.JsonRpcProvider;
}

describe(BscBurnEventMonitor.name, () => {
  describe("getEvents", () => {
    it("fetches a single block with a single-block getLogs range", async () => {
      const logs = [makeSentLog(89, 1), makeSentLog(90, 2)];
      const provider = makeMockProvider(logs);
      const monitor = new BscBurnEventMonitor(
        provider,
        contractDescription,
        null,
        0
      );

      const events = await (monitor as any).getEvents(90);

      expect(events.map((e: any) => e.returnValues.amount)).toEqual(["2"]);
      expect((provider.getLogs as jest.Mock).mock.calls).toHaveLength(1);
      expect((provider.getLogs as jest.Mock).mock.calls[0][0]).toEqual(
        expect.objectContaining({ fromBlock: 90, toBlock: 90 })
      );
    });
  });

  describe("getEventsInRange", () => {
    it("fetches the whole range with a single getLogs call when it fits in one chunk", async () => {
      const logs = [makeSentLog(10, 1), makeSentLog(15, 2)];
      const provider = makeMockProvider(logs);
      const monitor = new BscBurnEventMonitor(
        provider,
        contractDescription,
        null,
        0
      );

      const eventsByBlockIndex = await (monitor as any).getEventsInRange(1, 20);

      expect((provider.getLogs as jest.Mock).mock.calls).toHaveLength(1);
      expect((provider.getLogs as jest.Mock).mock.calls[0][0]).toEqual(
        expect.objectContaining({ fromBlock: 1, toBlock: 20 })
      );

      // Every block in the requested range is present, even ones with no
      // events, so callers never need to fall back to an extra RPC call.
      expect(eventsByBlockIndex.size).toBe(20);
      expect(eventsByBlockIndex.get(5)).toEqual([]);
      expect(
        eventsByBlockIndex.get(10).map((e: any) => e.returnValues.amount)
      ).toEqual(["1"]);
      expect(
        eventsByBlockIndex.get(15).map((e: any) => e.returnValues.amount)
      ).toEqual(["2"]);
    });

    it("chunks a range wider than the max getLogs range size into multiple calls", async () => {
      const logs = [
        makeSentLog(1, 1),
        makeSentLog(1000, 2),
        makeSentLog(1001, 3),
        makeSentLog(2500, 4),
      ];
      const provider = makeMockProvider(logs);
      const monitor = new BscBurnEventMonitor(
        provider,
        contractDescription,
        null,
        0
      );

      const eventsByBlockIndex = await (monitor as any).getEventsInRange(
        1,
        2500
      );

      const calls = (provider.getLogs as jest.Mock).mock.calls;
      // A 2500-block range with a 1000-block max chunk size must be split
      // into 3 calls (1-1000, 1001-2000, 2001-2500), never one call per
      // block, so catch-up after a long gap stays cheap.
      expect(calls).toHaveLength(3);
      expect(calls[0][0]).toEqual(
        expect.objectContaining({ fromBlock: 1, toBlock: 1000 })
      );
      expect(calls[1][0]).toEqual(
        expect.objectContaining({ fromBlock: 1001, toBlock: 2000 })
      );
      expect(calls[2][0]).toEqual(
        expect.objectContaining({ fromBlock: 2001, toBlock: 2500 })
      );

      expect(eventsByBlockIndex.size).toBe(2500);
      expect(
        eventsByBlockIndex.get(1).map((e: any) => e.returnValues.amount)
      ).toEqual(["1"]);
      expect(
        eventsByBlockIndex.get(1000).map((e: any) => e.returnValues.amount)
      ).toEqual(["2"]);
      expect(
        eventsByBlockIndex.get(1001).map((e: any) => e.returnValues.amount)
      ).toEqual(["3"]);
      expect(
        eventsByBlockIndex.get(2500).map((e: any) => e.returnValues.amount)
      ).toEqual(["4"]);
      expect(eventsByBlockIndex.get(2).length).toBe(0);
    });
  });
});
