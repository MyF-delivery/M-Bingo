// ============================================================
// M-BINGO PRODUCTION SERVER
// ============================================================

require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const { Pool } = require('pg');
const WebSocket = require('ws');

// ============================================================
// DATABASE CONNECTION
// ============================================================

const pool = new Pool({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT || 5432,
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
});

// ============================================================
// EXPRESS APP
// ============================================================

const app = express();
const server = http.createServer(app);

app.use(helmet());
app.use(compression());
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
});
app.use('/api/', limiter);

// ============================================================
// WEBSOCKET SERVER
// ============================================================

const wss = new WebSocket.Server({ server });
const clients = new Map();

wss.on('connection', (ws) => {
    console.log('🔗 New WebSocket connection');
    
    ws.send(JSON.stringify({
        type: 'connected',
        data: { message: 'Connected to M-BINGO server' }
    }));
    
    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);
            console.log('📩 Received:', data.type);
            
            if (data.type === 'auth') {
                clients.set(data.data.userId, ws);
                ws.userId = data.data.userId;
                ws.send(JSON.stringify({
                    type: 'authSuccess',
                    data: { message: 'Authenticated' }
                }));
            }
        } catch (error) {
            ws.send(JSON.stringify({
                type: 'error',
                data: { message: error.message }
            }));
        }
    });
    
    ws.on('close', () => {
        if (ws.userId) clients.delete(ws.userId);
    });
});
// ============================================================
// WEBSOCKET KEEP-ALIVE
// ============================================================

// Prevent WebSocket from disconnecting on Render free tier
setInterval(() => {
    wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
            client.ping();
        }
    });
}, 25000); // Ping every 25 seconds
// ============================================================
// HEALTH CHECK
// ============================================================

app.get('/health', (req, res) => {
    res.json({
        status: 'OK',
        time: new Date().toISOString(),
        clients: clients.size,
        uptime: process.uptime()
    });
});

app.get('/health/db', async (req, res) => {
    try {
        const result = await pool.query('SELECT NOW() as time');
        res.json({ status: 'connected', time: result.rows[0].time });
    } catch (error) {
        res.status(500).json({ status: 'error', error: error.message });
    }
});

// ============================================================
// API ROUTES
// ============================================================

// User Registration
app.post('/api/users/register', async (req, res) => {
    try {
        const { telegramId, username, firstName, lastName } = req.body;
        
        const checkResult = await pool.query(
            'SELECT * FROM users WHERE telegram_id = $1',
            [telegramId]
        );
        
        if (checkResult.rows.length > 0) {
            return res.json({
                success: true,
                user: checkResult.rows[0],
                message: 'User already exists'
            });
        }
        
        const result = await pool.query(
            `INSERT INTO users (telegram_id, username, first_name, last_name, balance)
             VALUES ($1, $2, $3, $4, 500)
             RETURNING *`,
            [telegramId, username || '', firstName, lastName || '']
        );
        
        res.json({
            success: true,
            user: result.rows[0],
            message: 'User registered with 500 Birr bonus!'
        });
        
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get User Balance
app.get('/api/wallet/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        
        const result = await pool.query(
            `SELECT id, first_name, balance, total_wins, total_games_played
             FROM users WHERE telegram_id = $1 OR id = $1`,
            [userId]
        );
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        res.json(result.rows[0]);
        
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get BINGO Cards
app.get('/api/cards', async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT card_number, board FROM bingo_cards ORDER BY card_number LIMIT 200'
        );
        res.json(result.rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Deposit Request
app.post('/api/deposits', async (req, res) => {
    try {
        const { userId, amount, method, reference } = req.body;
        
        const result = await pool.query(
            `INSERT INTO deposits (user_id, amount, method, reference, status)
             VALUES ($1, $2, $3, $4, 'PENDING')
             RETURNING *`,
            [userId, amount, method, reference]
        );
        
        res.json({
            success: true,
            deposit: result.rows[0],
            message: 'Deposit request submitted'
        });
        
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Withdrawal Request
app.post('/api/withdrawals', async (req, res) => {
    try {
        const { userId, amount, method, destination } = req.body;
        
        const balanceResult = await pool.query(
            'SELECT balance FROM users WHERE id = $1',
            [userId]
        );
        
        if (balanceResult.rows[0].balance < amount) {
            return res.status(400).json({ error: 'Insufficient balance' });
        }
        
        const result = await pool.query(
            `INSERT INTO withdrawals (user_id, amount, method, destination, status)
             VALUES ($1, $2, $3, $4, 'PENDING')
             RETURNING *`,
            [userId, amount, method, destination]
        );
        
        res.json({
            success: true,
            withdrawal: result.rows[0],
            message: 'Withdrawal request submitted'
        });
        
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Admin - Get players
app.get('/api/admin/players', async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT id, first_name, username, balance, total_wins, total_games_played
             FROM users ORDER BY balance DESC`
        );
        res.json(result.rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Admin - Approve deposit
app.post('/api/admin/deposits/approve', async (req, res) => {
    const client = await pool.connect();
    try {
        const { depositId } = req.body;
        await client.query('BEGIN');
        
        const depositResult = await client.query(
            'SELECT * FROM deposits WHERE id = $1 AND status = $2',
            [depositId, 'PENDING']
        );
        
        if (depositResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Deposit not found' });
        }
        
        const deposit = depositResult.rows[0];
        
        await client.query(
            'UPDATE users SET balance = balance + $1 WHERE id = $2',
            [deposit.amount, deposit.user_id]
        );
        
        await client.query(
            `UPDATE deposits SET status = 'APPROVED', approved_at = CURRENT_TIMESTAMP 
             WHERE id = $1`,
            [depositId]
        );
        
        await client.query('COMMIT');
        res.json({ success: true, message: 'Deposit approved' });
        
    } catch (error) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: error.message });
    } finally {
        client.release();
    }
});

// Admin - Get stats
app.get('/api/admin/stats', async (req, res) => {
    try {
        const [players, games, withdrawals] = await Promise.all([
            pool.query('SELECT COUNT(*) as count FROM users'),
            pool.query('SELECT COUNT(*) as count FROM rooms WHERE status = $1', ['PLAYING']),
            pool.query('SELECT COUNT(*) as count FROM withdrawals WHERE status = $1', ['PENDING'])
        ]);
        
        res.json({
            onlinePlayers: clients.size || 0,
            activeGames: parseInt(games.rows[0].count) || 0,
            pendingWithdrawals: parseInt(withdrawals.rows[0].count) || 0,
            totalPlayers: parseInt(players.rows[0].count) || 0
        });
        
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============================================================
// START SERVER
// ============================================================

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
    console.log(`
╔═══════════════════════════════════════════════════════════╗
║                                                          ║
║  🎯 M-BINGO SERVER RUNNING                               ║
║  🌐 https://m-bingo-server.onrender.com                 ║
║  👥 Clients: ${clients.size}                            ║
║                                                          ║
╚═══════════════════════════════════════════════════════════╝
    `);
});

process.on('SIGTERM', () => {
    console.log('🛑 Shutting down...');
    server.close(() => pool.end());
});

module.exports = { app, server, wss, pool };
