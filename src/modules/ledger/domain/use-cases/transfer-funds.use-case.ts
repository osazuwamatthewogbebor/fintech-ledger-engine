import type { ILedgerRepository } from "../../ports/ledger-repository.port.js";
import { Transaction } from "../aggregates/transaction.aggregate.js";
import { Money } from "../value-objects/money.vo.js";
import { PERMISSIVE_BALANCE_AGENTS } from "../constants/system-agents.js";


export interface TranserFundsCommand {
    tenantId: string;
    senderAccountId: string;
    receiverAccountId: string;
    amount: number;
    currency: string;
    reference: string;
    description: string;
}

export class TransferFundsUseCase {
    constructor (private readonly ledgerRepository: ILedgerRepository) {}

    public async execute(command: TranserFundsCommand): Promise<void> {
        if (command.senderAccountId === command.receiverAccountId) {
            throw new Error("Invalid Transaction: Sender and receiver accounts must be distinct.");
        };

        if (command.amount <= 0) {
            throw new Error("Invalid Ledger Entry: Line entries must represent positive financial values.");
        };

        // Inside TransferFundsUseCase.execute()
        const decimalStr = command.amount.toString();
        const decimalPlaces = decimalStr.includes('.') ? decimalStr.split('.')[1]?.length : 0;

        if ((decimalPlaces || 0) > 2) {
            throw new Error(`Invalid Precision: System limits currencies to exactly 2 decimal fractional units.`);
        };

        // 2. Fetch Sender Account Details & Validate Existence
        const senderDetails = await this.ledgerRepository.getAccountDetails(command.senderAccountId);
        if (!senderDetails) {
            throw new Error("Transaction Denied: Sender account does not exist.");
        };

        // 3. Fetch Receiver Account Details & Validate Existence
        const receiverDetails = await this.ledgerRepository.getAccountDetails(command.receiverAccountId);
        if (!receiverDetails) {
            throw new Error("Transaction Denied: Receiver account does not exist.");
        };

        // Inside TransferFundsUseCase.execute()
        if (senderDetails.balance.currency !== command.currency || receiverDetails.balance.currency !== command.currency) {
            throw new Error(`Currency Mismatch: Transaction currency '${command.currency}' does not match the participating accounts.`);
        };

        const transferAmount = Money.fromDecimal(command.amount, command.currency);

        // Check if the sender's user_id or identifier matches our clearing enum array
        const isPermissiveAccount = PERMISSIVE_BALANCE_AGENTS.includes(senderDetails.userId);

        if (!isPermissiveAccount) {
            // Strict balance check for standard consumers
            const senderBalance = senderDetails.balance;
            const holdsSufficientCapital = senderBalance.isGreaterThan(transferAmount) || senderBalance.minorUnits === transferAmount.minorUnits;
                                           
            if (!holdsSufficientCapital) {
                const readableBalance = Number(senderBalance.minorUnits) / 100;
                throw new Error(`Transaction Denied: Insufficient capital. Available: ${senderBalance.currency} ${readableBalance}`);
            }
        };

        const transactionAggregate = new Transaction(command.reference, command.description);
        
        transactionAggregate.addEntry(command.senderAccountId, transferAmount, 'CREDIT');
        transactionAggregate.addEntry(command.receiverAccountId, transferAmount, 'DEBIT');

        await this.ledgerRepository.saveTransaction(transactionAggregate);
    }
}