const { Pool } = require('pg');
const redis = require('redis');
const config = require('../config');

// PostgreSQL Connection
const pool = new Pool({
    host: config.db.host,
    port: config.db.port,
    database: config.db.name,
    user: config.db.user,
    password: config.db.password,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
});

pool.on('error', (err) => {
    console.error('Unexpected error on idle client', err);
    process.exit(-1);
});

// Redis Connection
const redisClient = redis.createClient({
    url: `redis://${config.redis.host}:${config.redis.port}`,
    password: config.redis.password || undefined,
});

redisClient.on('error', (err) => console.error('Redis Client Error', err));

redisClient.on('connect', () => console.log('✅ Redis connected'));

// Helper functions
const query = (text, params) => pool.query(text, params);

const getClient = () => pool.connect();

// Redis helpers
const setCache = async (key, value, ttl = 3600) => {
    await redisClient.set(key, JSON.stringify(value), { EX: ttl });
};

const getCache = async (key) => {
    const data = await redisClient.get(key);
    return data ? JSON.parse(data) : null;
};

const deleteCache = async (key) => {
    await redisClient.del(key);
};

const deleteCachePattern = async (pattern) => {
    const keys = await redisClient.keys(pattern);
    if (keys.length > 0) {
        await redisClient.del(keys);
    }
};

module.exports = {
    pool,
    redisClient,
    query,
    getClient,
    setCache,
    getCache,
    deleteCache,
    deleteCachePattern,
};
