const { Pool } = require('pg');

const connectionString = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL || '';
const shouldUseSsl =
    process.env.PG_SSL === 'true'
    || /sslmode=require/i.test(connectionString)
    || /supabase\.com/i.test(connectionString);

const pool = connectionString
    ? new Pool({
        connectionString,
        ssl: shouldUseSsl ? { rejectUnauthorized: false } : false,
    })
    : null;

async function query(text, params = []) {
    if (!pool) {
        throw new Error('Chat service database is not configured. Set SUPABASE_DB_URL.');
    }

    return pool.query(text, params);
}

async function withTransaction(fn) {
    if (!pool) {
        throw new Error('Chat service database is not configured. Set SUPABASE_DB_URL.');
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

function isDbConfigured() {
    return Boolean(pool);
}

async function closePool() {
    if (pool) {
        await pool.end();
    }
}

module.exports = {
    pool,
    query,
    withTransaction,
    isDbConfigured,
    closePool,
};
