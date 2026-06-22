import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PostgresLedgerRepository } from "../adapters/repositories/postgres-ledger.repository.js";
import { Transaction } from "../domain/aggregates/transaction.aggregate.js";
import { Money } from "../domain/value-objects/money.vo.js";
import { dbPool } from "../../../shared/infrastructure/database/pg-pool.js";

describe("PostgresLedgerRepository (Integration Tests)", () => {
    let repository: PostgresLedgerRepository;
    
    const accountA = "33333333-3333-3333-3333-333333333333";
    const accountB = "44444444-4444-4444-4444-444444444444";

    beforeAll(async () => {
        repository = new PostgresLedgerRepository();
    });

    afterAll(async () => {
        // Clean up data connections gracefully
        await dbPool.end();
    });

    it("should reject saveTransaction and roll back completely if a standard account drops into a negative balance", async () => {
        // 1. Prepare clean test accounts inside your test environment database
        await dbPool.query("DELETE FROM ledger_entries;");
        await dbPool.query("DELETE FROM transactions;");
        await dbPool.query("DELETE FROM accounts WHERE id IN ($1, $2);", [accountA, accountB]);

        await dbPool.query(`
            INSERT INTO accounts (id, tenant_id, user_id, currency, type) VALUES 
            ($1, '00000000-0000-0000-0000-000000000001', 'integration_user_a', 'NGN', 'ASSET'),
            ($2, '00000000-0000-0000-0000-000000000001', 'integration_user_b', 'NGN', 'ASSET')
            ON CONFLICT (id) DO NOTHING;
        `, [accountA, accountB]);

        const tx = new Transaction("INTEG_TX_001", "Unauthorized Overdraft Transfer");
        const amount = Money.fromDecimal(5000.00, "NGN");

        // Credit Account A (Attempts to take money out, pushing an empty account to -5000)
        tx.addEntry(accountA, amount, 'CREDIT');
        tx.addEntry(accountB, amount, 'DEBIT');

        // ASSERTION FIX: The liquidity check inside saveTransaction will catch the negative drift and reject the promise
        await expect(repository.saveTransaction(tx)).rejects.toThrowError(
            /Transaction Aborted: Insufficient liquidity/
        );

        // ATOMIC SAFETY CHECK: Since the database transaction rolled back perfectly, 
        // fetching details succeeds safely because the balance remains at exactly 0n!
        const detailsA = await repository.getAccountDetails(accountA);
        const detailsB = await repository.getAccountDetails(accountB);

        expect(detailsA.balance.minorUnits).toBe(0n); 
        expect(detailsB.balance.minorUnits).toBe(0n);
    });

    it("should prevent database deadlocks when executing high-concurrency cross-transfers simultaneously", async () => {
        // Reset state for isolation control
        await dbPool.query("DELETE FROM ledger_entries;");
        await dbPool.query("DELETE FROM transactions;");
        await dbPool.query("DELETE FROM accounts WHERE id IN ($1, $2);", [accountA, accountB]);

        // Re-insert pristine accounts
        await dbPool.query(`
            INSERT INTO accounts (id, tenant_id, user_id, currency, type) VALUES 
            ($1, '00000000-0000-0000-0000-000000000001', 'integration_user_a', 'NGN', 'ASSET'),
            ($2, '00000000-0000-0000-0000-000000000001', 'integration_user_b', 'NGN', 'ASSET');
        `, [accountA, accountB]);

        // CONCURRENCY FIX: Seed both accounts with an opening balance (50,000 NGN) 
        // to bypass liquidity checks so we can isolate the row-level deadlock lock mechanics perfectly!
        await dbPool.query(`
            INSERT INTO transactions (id, reference, description) 
            VALUES ('00000000-0000-0000-0000-000000000002', 'SEED_BAL', 'Initial Funding');
        `);

        await dbPool.query(`
            INSERT INTO ledger_entries (transaction_id, account_id, amount, direction) VALUES 
            ('00000000-0000-0000-0000-000000000002', $1, 5000000, 'DEBIT'),
            ('00000000-0000-0000-0000-000000000002', $2, 5000000, 'DEBIT');
        `, [accountA, accountB]);

        const transferAmount = Money.fromDecimal(10.00, "NGN");

        // Construct Request 1: A -> B
        const tx1 = new Transaction("CONCURRENCY_REF_1", "A to B");
        tx1.addEntry(accountA, transferAmount, 'CREDIT');
        tx1.addEntry(accountB, transferAmount, 'DEBIT');

        // Construct Request 2: B -> A (Fired simultaneously)
        const tx2 = new Transaction("CONCURRENCY_REF_2", "B to A");
        tx2.addEntry(accountB, transferAmount, 'CREDIT');
        tx2.addEntry(accountA, transferAmount, 'DEBIT');

        // Fire both requests concurrently over the network pool wire
        const executionPromises = await Promise.allSettled([
            repository.saveTransaction(tx1),
            repository.saveTransaction(tx2)
        ]);

        // Assert that neither request failed due to a database deadlock condition
        for (const out of executionPromises) {
            expect(out.status).toBe("fulfilled");
        }
    });

    it("should successfully calculate negative balances for permissive clearing accounts without crashing", async () => {
        const clearingAccountId = "55555555-5555-5555-5555-555555555555";
        const consumerAccountId = "66666666-6666-6666-6666-666666666666";

        // Seed a permissive system clearing channel account in the database
        await dbPool.query(`
            INSERT INTO accounts (id, tenant_id, user_id, currency, type) VALUES 
            ($1, '00000000-0000-0000-0000-000000000001', 'PAYSTACK_CLEARING_CHANNEL', 'NGN', 'ASSET'),
            ($2, '00000000-0000-0000-0000-000000000001', 'standard_consumer_user', 'NGN', 'ASSET')
            ON CONFLICT DO NOTHING;
        `, [clearingAccountId, consumerAccountId]);

        const tx = new Transaction("INTEG_SYS_002", "Paystack Deposit Settlement Webhook");
        const amount = Money.fromDecimal(2500.00, "NGN");

        // Credit the clearing channel (Advanced early token release, pushing it to -2500)
        tx.addEntry(clearingAccountId, amount, 'CREDIT');
        tx.addEntry(consumerAccountId, amount, 'DEBIT');

        await repository.saveTransaction(tx);

        // Run the raw database check directly to verify the SQL balance view 
        // calculates -2500 NGN in minor units without throwing an app-level value object error
        const balanceQuery = `
            SELECT COALESCE(SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE -amount END), 0) as balance
            FROM ledger_entries WHERE account_id = $1;
        `;
        const result = await dbPool.query(balanceQuery, [clearingAccountId]);
        const rawBalance = BigInt(result.rows[0].balance);

        expect(rawBalance).toBe(-250000n); // Perfectly registers as negative debt owed by Paystack
    });
});