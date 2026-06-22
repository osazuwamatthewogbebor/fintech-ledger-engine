import { Money } from "../value-objects/money.vo.js";

export interface LedgerEntryProps {
    accountId: string;
    money: Money;
    direction: 'DEBIT' | 'CREDIT';
}

export class Transaction {
    public readonly id?: string;
    public readonly entries: LedgerEntryProps[] = [];

    constructor(
        public readonly reference: string,
        public readonly description: string,
    ) {}

    public addEntry(accountId: string, money: Money, direction: 'DEBIT' | 'CREDIT'): void {
        this.entries.push({ accountId, money, direction});
    }

    public isBalanced(): boolean {
        if (this.entries.length < 2) return false;

        let totalDebits = 0n;
        let totalCredits = 0n;

        const baselineCurrency = this.entries[0]?.money.currency;

        for (const entry of this.entries) {
            if (entry.money.currency !== baselineCurrency) return false;

            if (entry.direction === 'DEBIT') {
                totalDebits += entry.money.minorUnits;
            } else if (entry.direction === 'CREDIT') {
                totalCredits += entry.money.minorUnits;
            }
        };

        return totalDebits === totalCredits;
    }
}