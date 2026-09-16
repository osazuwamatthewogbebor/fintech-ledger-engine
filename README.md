# Double-Entry Ledger Engine

A ledger service for moving money between accounts. Balances aren't stored
as a column that gets updated — they're derived by summing an append-only
list of ledger entries, so the history is the source of truth and nothing
can change a balance without leaving a record.

TypeScript, PostgreSQL, Zod, Vitest, Docker.

## The core idea

Every transfer writes at least two ledger entries: a debit on one account
and a credit on another, always summing to zero. Entries are never updated
or deleted. An account's balance is whatever its entries add up to.

This is the standard double-entry model, and the reason to use it here is
that a wrong balance becomes impossible to hide. If a balance is a mutable
column, a bug or a race or someone running a manual `UPDATE` can put it out
of sync with reality and there's no trail. If the balance is derived, the
only way to change it is to write an entry, and the entry stays there.

## Where correctness is enforced

Three checks, at three different points:

**1. The transfer must balance (application layer).** Before touching the
database, the transaction object checks that debits and credits sum to the
same amount in minor units. Unbalanced transfers are rejected outright.

**2. Rows are locked in a fixed order (database layer).** The engine takes
`SELECT ... FOR UPDATE` locks on the accounts involved, sorted by account
ID before locking. The sorting is the point: if two concurrent transfers
touch the same pair of accounts in opposite directions, and each grabs one
lock then waits for the other, they deadlock. Sorting the IDs means every
transaction acquires locks in the same order, so one simply waits for the
other instead of deadlocking.

**3. The balance is checked while the lock is held (state layer).** With the
rows locked, the engine sums the account's entries and checks the result.
Normal accounts can't go negative — if they would, the whole transaction
rolls back. Accounts configured as clearing accounts are allowed to.

Doing the balance check *inside* the lock is what makes it meaningful. Check
it before locking and another transaction can spend the same funds in the
gap.

## Flow

```
REST controller
   │
   ▼
Zod validation of the request body
   │
   ▼
TransferFunds use case
   │
   ├──► Transaction aggregate — check Σ debits === Σ credits
   │
   └──► Postgres ledger repository
            │
            ├─ sort account IDs, SELECT ... FOR UPDATE
            ├─ sum entries, apply balance rules
            └─ COMMIT or ROLLBACK
```

## Schema

```sql
CREATE TABLE accounts (
    id UUID PRIMARY KEY,
    tenant_id UUID NOT NULL,
    user_id VARCHAR(255) NOT NULL,
    currency VARCHAR(3) NOT NULL,
    type VARCHAR(50) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    reference VARCHAR(255) UNIQUE NOT NULL,
    description TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE ledger_entries (
    id BIGSERIAL PRIMARY KEY,
    transaction_id UUID NOT NULL REFERENCES transactions(id),
    account_id UUID NOT NULL REFERENCES accounts(id),
    amount NUMERIC(20, 0) NOT NULL,
    direction VARCHAR(6) NOT NULL CHECK (direction IN ('DEBIT', 'CREDIT')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_ledger_entries_account_id ON ledger_entries(account_id);
CREATE INDEX idx_accounts_tenant_id ON accounts(tenant_id);
```

`reference` is unique, which is what stops the same transfer being recorded
twice if a client retries.

## Decisions, and what they cost

### Deriving balances instead of caching them

A `balance` column on `accounts` would be faster — one row update instead of
an aggregate over history. I went with derivation because a cached balance
can silently drift from the entries that are supposed to produce it, and
once it has, you can't tell which one is wrong.

The cost is real and I'm not going to pretend otherwise: every balance check
scans that account's entries, and that gets slower as history grows. The
usual fix is periodic balance snapshots, so a read only sums entries since
the last snapshot rather than since the beginning. **I haven't built that
here** — at the volumes this has actually been tested at it doesn't matter,
but it would matter in production.

### Pessimistic locking instead of optimistic

Optimistic locking (a version column, retry on conflict) avoids holding
locks, and does better when contention is rare. Under contention it gets
worse — conflicting transactions burn work, fail, and retry.

A ledger's hot accounts are a contended case by nature: a merchant account
or a clearing account has many transfers hitting it at once. So I took locks
directly. The cost is that transactions serialize on those accounts, and a
slow transaction holds up everything else touching the same rows.

### Integer minor units instead of decimals

Money is stored as integers in the currency's smallest unit — ₦1,500.50 is
stored as `150050`, in a `NUMERIC(20,0)` column and handled as `BigInt` in
the domain. Floating point can't represent base-10 fractions exactly
(`0.1 + 0.2` is `0.30000000000000004`), and in a ledger those errors
accumulate into real discrepancies.

The cost is that conversion has to happen at the edges — the API accepts and
returns major units, and the boundary between the two is a place bugs can
hide. It needs to be one clearly-marked conversion in one place, not
scattered.

## Running it

```bash
docker compose up -d
npm run test
```

Tests cover the domain models, rollback on failed transactions, and
concurrent transfers against the same accounts.

### Trying a transfer

Seed two accounts:

```bash
docker compose exec -T ledger_postgres psql -U ledger_admin -d fintech_ledger_db -c "
INSERT INTO accounts (id, tenant_id, user_id, currency, type) VALUES
('7c9e6b1a-5d3c-4a2f-9b1e-8d7c6b5a4d3c', '4a7f34c2-901d-4b88-8fad-c2a4901df4b8', 'sender', 'NGN', 'ASSET'),
('3f2a1b0c-4d5e-4f6a-8b9c-0d1e2f3a4b5c', '4a7f34c2-901d-4b88-8fad-c2a4901df4b8', 'receiver', 'NGN', 'ASSET')
ON CONFLICT (id) DO NOTHING;
"
```

Then attempt a transfer from an account with no funds:

```bash
curl -X POST http://localhost:5000/api/v1/ledger/transfer \
  -H "Content-Type: application/json" \
  -d '{
    "tenantId": "4a7f34c2-901d-4b88-8fad-c2a4901df4b8",
    "senderAccountId": "7c9e6b1a-5d3c-4a2f-9b1e-8d7c6b5a4d3c",
    "receiverAccountId": "3f2a1b0c-4d5e-4f6a-8b9c-0d1e2f3a4b5c",
    "amount": 1500.50,
    "currency": "NGN",
    "reference": "TX-REF-001",
    "description": "Test transfer"
  }'
```

The balance check rejects it:

```json
{
  "success": false,
  "error": "Transaction Denied: Insufficient capital. Available: NGN 0"
}
```

## Known gaps

- **No balance snapshots**, so balance reads scan full entry history per
  account. This is the first thing that would need fixing at volume.
- **No currency validation on transfer** — nothing currently stops a
  transfer between accounts denominated in different currencies.
- **Multi-tenancy is enforced in application code**, not by row-level
  security or a database constraint. A query that forgets the `tenant_id`
  filter would cross the boundary.
- **No reversal or correction flow.** Since entries are immutable, fixing a
  mistake should mean writing a compensating transaction — that isn't
  implemented.
- **No pagination** on account history.
- Clearing accounts can go negative without limit; there's no configured
  floor.

## Stack

TypeScript · PostgreSQL · Zod · Vitest · Docker Compose

## Author

Osazuwa Matthew Ogbebor — [@osazuwamatthewogbebor](https://github.com/osazuwamatthewogbebor)

Backend engineer, mostly working on APIs, databases, and systems
programming in Go and TypeScript.

## License

MIT
