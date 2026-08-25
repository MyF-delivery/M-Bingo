const { Pool } = require('pg');
const config = require('../config/env');
const pool = new Pool({ ...config.db });
module.exports = pool;
