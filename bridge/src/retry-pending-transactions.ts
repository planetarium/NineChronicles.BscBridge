import { IExchangeHistoryStore } from "./interfaces/exchange-history-store";
import { INCGTransfer } from "./interfaces/ncg-transfer";
import { MultiPlanetary } from "./multi-planetary";
import { ISlackMessageSender } from "./interfaces/slack-message-sender";
import { PendingTransactionRetryMessage } from "./messages/pending-transaction-retry-message";
import { TransactionStatus } from "./types/transaction-status";

export class PendingTransactionRetryHandler {
  constructor(
    private readonly _exchangeHistoryStore: IExchangeHistoryStore,
    private readonly _ncgTransfer: INCGTransfer,
    private readonly _multiPlanetary: MultiPlanetary,
    private readonly _slackMessageSender: ISlackMessageSender
  ) {}

  async retryPendingTransactions(): Promise<void> {
    const pendingTransactions =
      await this._exchangeHistoryStore.getPendingTransactions();

    if (pendingTransactions.length > 0) {
      await this._slackMessageSender.sendMessage(
        new PendingTransactionRetryMessage(
          pendingTransactions,
          this._multiPlanetary
        )
      );

      for (const tx of pendingTransactions) {
        await this._exchangeHistoryStore.updateStatus(
          tx.tx_id,
          TransactionStatus.FAILED
        );
      }
    }
  }
}
