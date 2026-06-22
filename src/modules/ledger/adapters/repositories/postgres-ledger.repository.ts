import type { AccountDetails, ILedgerRepository } from "../../ports/ledger-repository.port.js";
import { Transaction } from "../../domain/aggregates/transaction.aggregate.js";
import { Money } from "../../domain/value-objects/money.vo.js";
import { dbPool } from "../../../../shared/infrastructure/database/pg-pool.js";
import { PERMISSIVE_BALANCE_AGENTS } from "../../domain/constants/system-agents.js";

export class PostgresLedgerRepository implements ILedgerRepository {
    public async getAccountDetails(accountId: string): Promise<AccountDetails> {
        const balanceQuery = `
            SELECT
                a.user_id,
                a.currency, 
                COALESCE(SUM(CASE WHEN le.direction = 'DEBIT' THEN le.amount ELSE -le.amount END), 0) as balance
            FROM accounts a  
            LEFT JOIN ledger_entries le ON le.account_id = a.id
            WHERE a.id = $1
            GROUP BY a.id, a.user_id, a.currency;
        `;

        const result = await dbPool.query(balanceQuery, [accountId])

        if (result.rows.length === 0) {
            throw new Error(`Target account registry record not found: ${accountId}`);
        }

        const rawBalance = BigInt(result.rows[0].balance);
        const currency = result.rows[0].currency;
        const userId = result.rows[0].user_id;

        return { 
                balance: Money.fromMinor(rawBalance, currency),
                userId: userId,
            };
    };

    public async saveTransaction(transaction: Transaction): Promise<void> {
        if (!transaction.isBalanced()) {
            throw new Error("Transaction aborted: Inbound entries violate double-entry balancing symmetry.")
        } 

        const client = await dbPool.connect();

        try {
            await client.query('BEGIN');
            
            // Sorting strings alphabetically completely prevents cross-locking deadlocks!
            const targetedAccountIds = [
                ...new Set(transaction.entries.map(entry => entry.accountId))
            ].sort();

            // Lock rows sequentially using row-level isolation blocks and evaluate liquidity rules safely within the transaction context
            for (const accountId of targetedAccountIds) {
                // const accountLock = await client.query(
                //     'SELECT id, currency FROM accounts WHERE id = $1 FOR UPDATE', [accountId]
                // );
                // if (accountLock.rows.length === 0) {
                //     throw new Error(`Lock target failure: Account ${accountId} does not exist`)
                // }
                // We fetch the current user_id and calculate the live balance aggregate directly under the lock
                const accountLock = await client.query(`
                    SELECT 
                        a.user_id,
                        COALESCE(SUM(CASE WHEN le.direction = 'DEBIT' THEN le.amount ELSE -le.amount END), 0) as current_balance
                    FROM accounts a
                    LEFT JOIN ledger_entries le ON le.account_id = a.id
                    WHERE a.id = $1
                    GROUP BY a.id, a.user_id;
                `, [accountId]);

                if (accountLock.rows.length === 0) {
                    throw new Error(`Lock target failure: Account ${accountId} does not exist`);
                }
                const { user_id, current_balance } = accountLock.rows[0];
                const currentBalanceBigInt = BigInt(current_balance);

                // Compute the absolute impact this specific transaction aggregate will have on this account row
                const accountImpact = transaction.entries
                .filter(entry => entry.accountId === accountId)
                .reduce((sum, entry) => {
                    return entry.direction === 'DEBIT'
                        ? sum + entry.money.minorUnits
                        : sum - entry.money.minorUnits;
                    }, 0n);

                const anticipatedBalance = currentBalanceBigInt + accountImpact

                // If the math results in a negative balance and it's NOT a permissive provider channel, abort!
                const isPermissiveAccount = PERMISSIVE_BALANCE_AGENTS.includes(user_id);
                if (anticipatedBalance < 0n && !isPermissiveAccount) {
                    throw new Error(`Transaction Aborted: Insufficient liquidity for account ${accountId}.`);
                }

            }

            // Persist the parent master transaction wrapper (Fails automatically on duplicate idempotency keys)
            const insertTxQuery = `
                INSERT INTO transactions (reference, description)
                VALUES ($1, $2)
                RETURNING id;
            `;
            const txResult = await client.query(insertTxQuery, [
                transaction.reference,
                transaction.description
            ]);
            const persistedTxId = txResult.rows[0].id;

            // Batch serialize and emit balanced child journal lines
            const insertEntryQuery = `
                INSERT INTO ledger_entries (transaction_id, account_id, amount, direction)
                VALUES ($1, $2, $3, $4);
            `;

            for (const entry of transaction.entries) {
                await client.query(insertEntryQuery, [
                    persistedTxId, 
                    entry.accountId,
                    entry.money.minorUnits.toString(),
                    entry.direction
                ]);
            };
            
            await client.query('COMMIT');
        } catch (error: any) {
            await client.query('ROLLBACK');

            if (error.code === '23505') {
                throw new Error(`Idempotency conflict triggered: Transaction reference '${transaction.reference}' already executed.`)
            }
            throw error;
        } finally {
            client.release();
        }
    }
}