import pg from 'pg';

export const dbPool = new pg.Pool({
    user: process.env.DB_USER || 'ledger_admin',
    password: process.env.DB_PASSWORD || 'ledger_secure_pass',
    host: process.env.DB_HOST || '127.0.0.1',
    port: parseInt(process.env.DB_PORT || '5433'),
    database: process.env.DB_NAME || 'fintech_ledger_db',
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000
});