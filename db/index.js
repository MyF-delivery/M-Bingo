// db/index.js
const { Pool } = require('pg');
const config = require('../config/env');

const pool = new Pool({
  host: config.DB_HOST,
  port: config.DB_PORT,
  database: config.DB_NAME,
  user: config.DB_USER,
  password: config.DB_PASSWORD,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  ssl: { rejectUnauthorized: false }   // REQUIRED for Render PostgreSQL
});

module.exports = pool;
