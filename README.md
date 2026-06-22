# Double-Entry Ledger Engine

A high-performance, distributed-systems-optimized immutable ledger engine engineered with strict financial invariants, deterministic deadlock mitigation, and explicit multi-tenant isolation boundaries. Designed for transaction-critical core banking, fintech platforms, and multi-currency clearing architectures.

---

## Architectural Design & Core Philosophy

This ledger engine enforces the absolute physical preservation of capital across distributed networks. Rather than storing mutable balance states in database columns, balance state is derived directly from an append-only transaction stream of balanced ledger entries.

### The Triple-Lock Invariant Framework

The engine guarantees system integrity by evaluating financial constraints at three distinct architectural boundaries:

1. **The Inbound Symmetry Guard (Application Layer):** Prior to database interaction, the domain aggregate validates that the absolute sum of credits matches the absolute sum of debits down to the lowest minor unit ($\sum \text{Debits} = \sum \text{Credits}$). Balanced entry symmetry must be met, or the transaction is rejected immediately.
2. **Pessimistic Concurrency Row Locking (Database Layer):** To prevent race conditions during high-concurrency wallet updates, the engine acquires explicit database row-level locks (`SELECT ... FOR UPDATE`) in a deterministic, sorted order.
3. **The Post-Lock Liquidity Evaluator (State Layer):** While holding the exclusive row lock, the engine calculates the real-time balance aggregate. It applies conditional liquidity rules, instantly rolling back the database transaction if a standard consumer account enters a negative balance, while permitting configured clearing nodes to carry short-term negative balances.

---

## System Architecture & Data Topology

```
                  [ API Boundary / REST Controllers ]
                                  │
                                  ▼
                     [ Zod Input Validation DTOs ]
                                  │
                                  ▼
                   [ Transfer Funds Use Case / App ]
                                  │
          ┌───────────────────────┴───────────────────────┐
          ▼                                               ▼
[ Transaction Aggregate ]                       [ Postgres Ledger Repository ]
  Validate Symmetry Guard Matrix                  Acquire Deterministic Locks
  (Σ Debits === Σ Credits)                        Execute Invariant Rules
                                                          │
                                                          ▼
                                                [ Raw PostgreSQL Cluster ]
                                                  Atomic COMMIT / ROLLBACK

```

### Core Schema Design

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

---

## Deep Architectural Tradeoffs & Engineering Decisions

### 1. Balance Derivation: Real-Time Aggregate Calculation vs. Cached State Columns

* **Approach A (Cached Balance Column):** Keeping a `balance` field directly inside the `accounts` table and updating it via `UPDATE accounts SET balance = balance + X`.
* **Approach B (Derived Stream - Selected):** Dynamically calculating the sum of the history stream via `SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE -amount END)` while isolated inside a pessimistic lock.

#### Engineering Tradeoffs:

* **Write Performance:** Approach A offers faster raw execution speeds under low concurrency because it mutates a single record rather than performing an aggregation scan over a history table. However, Approach B provides absolute structural truth. A cached column can become out of sync due to software bugs, race conditions, or manual database changes, leading to untraceable data state corruption.
* **Auditability & Compliance:** Approach B guarantees complete audit capability. Because the balance is a direct mathematical result of historical entries, it is impossible for an account balance to change without leaving a permanent journal trail.
* **Mitigation of Scan Overhead:** To avoid performance drops as transaction volume grows, the system is designed to allow read-side optimizations like automated nightly snapshot blocks or materialized balance views without compromising the strict append-only nature of the ledger write-path.

### 2. Concurrency Control: Pessimistic Row Locking vs. Optimistic Version Checks

* **Approach A (Optimistic Locking):** Using a version sequence counter (`WHERE version = current_version`). If a collision occurs, the system catches the error and retries the application logic.
* **Approach B (Pessimistic Deterministic Locking - Selected):** Using `SELECT ... FOR UPDATE` directly on target account IDs arranged in alphabetical order before writing journal lines.

#### Engineering Tradeoffs:

* **Contention Management:** Optimistic locking works well in low-contention environments but degrades quickly under heavy transaction traffic (e.g., flash sales, payroll distribution, or popular payment gateways). High collision rates cause excessive request retries, which spikes CPU usage and increases API latency.
* **Deadlock Elimination:** Mixing row-level locks without strict rules can cause cyclic deadlock conditions where Transaction 1 locks Account A and waits for Account B, while Transaction 2 locks Account B and waits for Account A. The engine eliminates this vulnerability by extracting unique account IDs from the payload and sorting them alphabetically before executing the SQL block. This guarantees all parallel operations acquire locks in the exact same physical order, shifting lock waits into a predictable sequential queue.

### 3. Precision Management: Minor Units (BigInt Strings) vs. IEEE 754 Floating Points

* **Approach A (Floating Point/Numeric Decimals):** Storing values as standard JavaScript `number` primitives or database `float` data types (e.g., `10.50`).
* **Approach B (Minor Units Pattern - Selected):** Scaling all monetary entries to integer strings representing their absolute minor unit value (e.g., saving `1,500.50 NGN` or `USD` as `150050` minor units).

#### Engineering Tradeoffs:

* **Mathematical Reliability:** Floating-point binary representations cannot accurately represent base-10 fractional numbers (e.g., `0.1 + 0.2` evaluates to `0.30000000000000004`). In high-volume financial contexts, these rounding micro-errors aggregate into significant capital leaks.
* **Storage and Mapping:** Using `BigInt` mappings at the domain level paired with `numeric(20,0)` string casting on the database wire ensures zero precision loss. This guarantees mathematical exactness across arbitrary scales while shifting currency-specific decimal positioning entirely to peripheral display layers.

---

## Local Verification & Development

### Infrastructure Initialization

The engine requires Docker Compose to orchestrate its persistent runtime storage environment. Spin up the dedicated PostgreSQL cluster using the following command:

```bash
docker compose up -d

```

### Test Suite Execution

Domain models, atomic transaction rollbacks, and concurrent deadlock elimination matrices are fully verified via Vitest. Run the automated test suite with:

```bash
npm run test

```

### Production Live Integration Check

To execute real-time validation against the live application port (`5000`), populate the database container with valid RFC 4122 compliant version 4 UUID entries:

```bash
docker compose exec -T ledger_postgres psql -U ledger_admin -d fintech_ledger_db -c "
INSERT INTO accounts (id, tenant_id, user_id, currency, type) VALUES 
('7c9e6b1a-5d3c-4a2f-9b1e-8d7c6b5a4d3c', '4a7f34c2-901d-4b88-8fad-c2a4901df4b8', 'live_sender_user', 'NGN', 'ASSET'),
('3f2a1b0c-4d5e-4f6a-8b9c-0d1e2f3a4b5c', '4a7f34c2-901d-4b88-8fad-c2a4901df4b8', 'live_receiver_user', 'NGN', 'ASSET')
ON CONFLICT (id) DO NOTHING;
"

```

Verify the liquidity validation engine by attempting an unauthorized overdraft transfer via `curl`:

```bash
curl -X POST http://localhost:5000/api/v1/ledger/transfer \
  -H "Content-Type: application/json" \
  -d '{
    "tenantId": "4a7f34c2-901d-4b88-8fad-c2a4901df4b8",
    "senderAccountId": "7c9e6b1a-5d3c-4a2f-9b1e-8d7c6b5a4d3c",
    "receiverAccountId": "3f2a1b0c-4d5e-4f6a-8b9c-0d1e2f3a4b5c",
    "amount": 1500.50,
    "currency": "NGN",
    "reference": "TX-REF-LIVE-001",
    "description": "Peer to Peer Wallet Transfer"
  }'

```

The system will intercept the request and securely return a domain validation rejection payload:

```json
{
  "success": false,
  "error": "Transaction Denied: Insufficient capital. Available: NGN 0"
}

```

Here is the updated **Author & Technical Attribution** section, now featuring clean, professional Markdown badges styled for high-visibility technical portfolios.

Append this section directly to the bottom of your `README.md` file:

---

## Author & Technical Attribution

### Osazuwa Matthew Ogbebor — Backend & Systems Engineer

<!-- [![LinkedIn](https://img.shields.io/badge/LinkedIn-0077B5?style=for-the-badge&logo=linkedin&logoColor=white)](https://linkedin.com/in/your-username) -->
<!-- [![Upwork](https://img.shields.io/badge/Upwork-14A800?style=for-the-badge&logo=upwork&logoColor=white)](https://www.upwork.com/freelancers/~your-profile-id) -->
[![Docker](https://img.shields.io/badge/Docker-2496ED?style=for-the-badge&logo=docker&logoColor=white)](https://hub.docker.com/r/your-dockerhub-username/fintech-ledger-engine)

A First-Class Honors Engineering graduate and specialized backend architect focused on designing high-throughput, secure financial infrastructure and low-latency microservices.

* **Core Competencies:** Distributed Systems Architecture, Double-Entry Financial Ledgers, Concurrency Control (Go/Node.js/Python), and Advanced Database Query Optimization.
* **Professional Philosophy:** Designing modular, deterministic codebases that prioritize strict separation of concerns, defensive domain invariants, and mathematical precision over temporary convenience.
* **Location Profile:** Open to high-impact technical roles globally, bringing deep experience in peer-led software fellowships, complex parallel kinematics simulation design, and enterprise-grade multi-tenant backend architecture.

---

### Technical Portfolio Ecosystem
This ledger engine serves as a key architectural component within a broader portfolio revamp project. It highlights production-ready implementations of complex web security layers, robust data validation boundaries, and highly resilient database connection lifecycles designed to survive extreme concurrent workloads without performance degradation.

* **[GitHub](https://github.com/osazuwamatthewogbebor)**

## Author & Technical Attribution

### Osazuwa Matthew Ogbebor — Backend & Systems Engineer

[![GitHub](https://img.shields.io/badge/GitHub-181717?style=for-the-badge&logo=github&logoColor=white)](https://github.com/osazuwamatthewogbebor/fintech-ledger-engine)
[![LinkedIn](https://img.shields.io/badge/LinkedIn-0077B5?style=for-the-badge&logo=linkedin&logoColor=white)](https://linkedin.com/in/your-username)
[![Upwork](https://img.shields.io/badge/Upwork-14A800?style=for-the-badge&logo=upwork&logoColor=white)](https://www.upwork.com/freelancers/~your-profile-id)
[![Docker](https://img.shields.io/badge/Docker-2496ED?style=for-the-badge&logo=docker&logoColor=white)](https://hub.docker.com/r/your-dockerhub-username/fintech-ledger-engine)

A First-Class Honors Engineering graduate and specialized backend architect focused on designing high-throughput, secure financial infrastructure and low-latency microservices.

* **Core Competencies:** Distributed Systems Architecture, Double-Entry Financial Ledgers, Concurrency Control (Go/Node.js/Python), and Advanced Database Query Optimization.
* **Professional Philosophy:** Designing modular, deterministic codebases that prioritize strict separation of concerns, defensive domain invariants, and mathematical precision over temporary convenience.
* **Location Profile:** Open to high-impact technical roles globally, bringing deep experience in peer-led software fellowships, complex parallel kinematics simulation design, and enterprise-grade multi-tenant backend architecture.

---

### Technical Portfolio Ecosystem
This ledger engine serves as a key architectural component within a broader portfolio revamp project. It highlights production-ready implementations of complex web security layers, robust data validation boundaries, and highly resilient database connection lifecycles designed to survive extreme concurrent workloads without performance degradation.