import { Transaction } from "../domain/aggregates/transaction.aggregate.js";
import { Money } from "../domain/value-objects/money.vo.js";

export interface AccountDetails {
    balance: Money;
    userId: string;
}

export interface ILedgerRepository {
    getAccountDetails(accountId: string): Promise<AccountDetails | null>;
    saveTransaction(transaction: Transaction): Promise<void>;
};