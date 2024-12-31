import { PendingTransactionMessage } from "../../src/messages/pending-transaction-message";
import { ExchangeHistory } from "../../src/interfaces/exchange-history-store";
import { MultiPlanetary } from "../../src/multi-planetary";
import { TransactionStatus } from "../../src/types/transaction-status";

describe("PendingTransactionMessage", () => {
  const mockMultiPlanetary = {
    getRequestPlanetName: jest.fn().mockReturnValue("Odin"),
  } as unknown as MultiPlanetary;

  it("should render pending transactions correctly for BSCereum", () => {
    const transactions: ExchangeHistory[] = [
      {
        network: "BSCereum",
        tx_id: "TX-123",
        sender: "0xSenderAddress",
        recipient: "0xRecipientAddress",
        timestamp: new Date().toISOString(),
        amount: 100,
        status: TransactionStatus.PENDING,
      },
    ];

    const message = new PendingTransactionMessage(
      transactions,
      mockMultiPlanetary
    );
    const result = message.render() as {
      text: string;
      attachments: {
        author_name: string;
        fields: { title: string; value: string }[];
      }[];
    };

    expect(result.text).toBe("1 Pending Transactions Found");
    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0].author_name).toBe(
      "[BSC] wNCG → NCG pending event"
    );
    expect(result.attachments[0].fields[0].title).toBe("BSC transaction");
    expect(result.attachments[0].fields[1].title).toBe("Planet Name");
    expect(result.attachments[0].fields[1].value).toBe("Odin");
    expect(result.attachments[0].fields[2].title).toBe("Sender(BSC)");
    expect(result.attachments[0].fields[2].value).toBe("0xSenderAddress");
    expect(result.attachments[0].fields[3].title).toBe("Recipient(9c)");
    expect(result.attachments[0].fields[3].value).toBe("0xRecipientAddress");
    expect(result.attachments[0].fields[4].title).toBe("Amount");
    expect(result.attachments[0].fields[4].value).toBe("100");
    expect(result.attachments[0].fields[5].title).toBe("Timestamp");
    expect(result.attachments[0].fields[5].value).toBe(
      transactions[0].timestamp
    );
  });

  it("should render no pending transactions message", () => {
    const message = new PendingTransactionMessage([], mockMultiPlanetary);
    const result = message.render() as {
      text: string;
      attachments: {
        author_name: string;
        fields: { title: string; value: string }[];
      }[];
    };

    expect(result.text).toBe("No pending transactions");
    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0].author_name).toBe("BSC Bridge Restarted");
  });
});
