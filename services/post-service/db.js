const dns = require('node:dns');
const net = require('node:net');
const { Pool } = require('pg');

const dnsResultOrder = String(process.env.DNS_RESULT_ORDER || 'ipv4first').toLowerCase();
if (typeof dns.setDefaultResultOrder === 'function' && ['ipv4first', 'verbatim'].includes(dnsResultOrder)) {
    dns.setDefaultResultOrder(dnsResultOrder);
}

const connectionString = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL || '';
const shouldUseSsl =
    process.env.PG_SSL === 'true'
    || /sslmode=require/i.test(connectionString)
    || /supabase\.com/i.test(connectionString);
const shouldForceIpv4 = String(process.env.PG_FORCE_IPV4 || 'true').toLowerCase() !== 'false';

let poolPromise = null;

function createDbConfigError() {
    const error = new Error('Post service search database is not configured. Set SUPABASE_DB_URL.');
    error.status = 503;
    error.expose = true;
    error.code = 'DB_NOT_CONFIGURED';
    return error;
}

function shouldAttemptIpv4Override(hostname) {
    return Boolean(
        shouldForceIpv4
        && hostname
        && !net.isIP(hostname)
        && hostname !== 'localhost'
    );
}

function stripSslParamsFromUrl(urlValue) {
    return String(urlValue || '')
        .replace(/[?&](sslmode|ssl|sslrootcert|sslcert|sslkey|sslcrl)=[^&]*/gi, '')
        .replace(/\?&/, '?')
        .replace(/[?&]$/, '');
}

async function buildPoolConfig() {
    let effectiveConnectionString = stripSslParamsFromUrl(connectionString);
    let servername = null;

    try {
        const parsed = new URL(effectiveConnectionString);
        const originalHostname = parsed.hostname;
        servername = originalHostname && !net.isIP(originalHostname) ? originalHostname : null;

        if (shouldAttemptIpv4Override(originalHostname)) {
            const ipv4Lookup = await dns.promises.lookup(originalHostname, { family: 4 });
            if (ipv4Lookup?.address) {
                parsed.hostname = ipv4Lookup.address;
                console.log(`[post-service] Using IPv4 ${ipv4Lookup.address} for ${originalHostname}`);
            }
        }

        effectiveConnectionString = parsed.toString();
    } catch (error) {
        // Keep original connection string if parsing/lookup fails.
        console.warn('[post-service] Could not apply IPv4 DB host override:', error.message);
    }

    const sslConfig = shouldUseSsl
        ? {
            rejectUnauthorized: false,
            ...(servername ? { servername } : {}),
        }
        : false;

    return {
        connectionString: effectiveConnectionString,
        ssl: sslConfig,
    };
}

async function getPool() {
    if (!connectionString) {
        throw createDbConfigError();
    }

    if (!poolPromise) {
        poolPromise = buildPoolConfig().then((config) => new Pool(config));
    }

    return poolPromise;
}

async function query(text, params = []) {
    const pool = await getPool();
    return pool.query(text, params);
}

function isDbConfigured() {
    return Boolean(connectionString);
}

async function closePool() {
    if (poolPromise) {
        const pool = await poolPromise;
        await pool.end();
        poolPromise = null;
    }
}

module.exports = {
    query,
    isDbConfigured,
    closePool,
};
