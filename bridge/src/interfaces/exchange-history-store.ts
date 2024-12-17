import { TransactionStatus } from "../types/transaction-status";

export interface ExchangeHistory {
  network: string;
  tx_id: string;
  sender: string;
  recipient: string;
  timestamp: string;
  amount: number;
  status: TransactionStatus;
}

export interface IExchangeHistoryStore {
  put(history: ExchangeHistory): Promise<void>;
  exist(tx_id: string): Promise<boolean>;
  updateStatus(
    tx_id: string,
    status: TransactionStatus.COMPLETED | TransactionStatus.FAILED
  ): Promise<void>;

  transferredAmountInLast24Hours(
    network: string,
    sender: string
  ): Promise<number>;

  getPendingTransactions(): Promise<ExchangeHistory[]>;
}
