CREATE EXTENSION IF NOT EXISTS "uuid-ossp";


-- Accounts Registry
CREATE TABLE IF NOT EXISTS accounts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL,
    user_id VARCHAR(255) NOT NULL,
    currency VARCHAR(10) NOT NULL DEFAULT 'NGN',
    type VARCHAR(50) NOT NULL,
    created_At TIMESTAMP NOT NULL DEFAULT NOW()
);


-- Idempotency and Audit Master Record
CREATE TABLE IF NOT EXISTS transactions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    reference VARCHAR(255) UNIQUE NOT NULL,
    description TEXT,
    posted_At TIMESTAMP NOT NULL DEFAULT NOW()
);


-- Immutable Double-Entry Lines
CREATE TABLE IF NOT EXISTS ledger_entries (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    transaction_id UUID  NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    amount BIGINT NOT NULL,
    direction VARCHAR(10) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);


-- Optimization Indexing
CREATE INDEX IF NOT EXISTS idx_entries_balance_calc ON ledger_entries(account_id, direction, amount);
CREATE INDEX IF NOT EXISTS idx_accounts_lookup ON accounts(tenant_id, user_id);


-- Seed Initial Mock Master Escrow & User Accounts with Strict RFC-Compliant v4 UUIDs
-- Seed Production System Accounts for Multiple Channels
INSERT INTO accounts (id, tenant_id, user_id, currency, type) VALUES 
('98db7a14-7221-4b10-859a-1150fc90a381', '00000000-0000-0000-0000-000000000001', 'SYSTEM_TREASURY_MINT', 'NGN', 'LIABILITY'),
('4be84742-02fa-4cb5-a128-971c26f000a1', '00000000-0000-0000-0000-000000000001', 'PAYSTACK_CLEARING_CHANNEL', 'NGN', 'ASSET'),
('7b3c2e11-14fa-4db4-912a-832c16f000b2', '00000000-0000-0000-0000-000000000001', 'FLUTTERWAVE_CLEARING_CHANNEL', 'NGN', 'ASSET'),
('1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d', '00000000-0000-0000-0000-000000000001', 'PLATFORM_CORPORATE_BANK_VAULT', 'NGN', 'ASSET'),
('2a8b9f1d-b541-477c-bc92-416b2cf000b2', '98db7a14-7221-4b10-859a-1150fc90a381', 'user_matthew_wallet', 'NGN', 'ASSET')
ON CONFLICT DO NOTHING;