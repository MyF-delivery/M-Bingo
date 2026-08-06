// backend/src/app.js - MINIMAL WORKING VERSION
require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const WebSocket = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });

// ============================================================
// MIDDLEWARE
// ============================================================

app.use(cors({
    origin: '*', // Allow all origins for testing
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ============================================================
// IN-MEMORY DATABASE (No PostgreSQL needed for now)
// ============================================================

const db = {
    users: [],
    rooms: [],
    transactions: [],
    cards: generateBingoCards(),
};

function generateBingoCards() {
    const cards = [];
    for (let b = 1; b <= 200; b++) {
        const board = [];
        for (let row = 0; row < 5; row++) {
            const rowData = [];
            for (let col = 0; col < 5; col++) {
                let num;
                if (col === 2 && row === 2) {
                    num = 0; // FREE space
                } else {
                    const min = col * 15 + 1;
                    const max = (col + 1) * 15;
                    const seed = (b * 7 + row * 13 + col * 31) % 15;
                    num = min + seed;
                }
                rowData.push(num);
            }
            board.push(rowData);
        }
        cards.push({ id: b, cardNumber: b, board: board });
    }
    return cards;
}

// ============================================================
// API ROUTES
// ============================================================

// Health check - CRITICAL for Render
app.get('/health', (req, res) => {
    res.json({ 
        status: 'OK', 
        time: new Date().toISOString(),
        version: '2.0.0',
        users: db.users.length,
        rooms: db.rooms.length
    });
});

// Root endpoint
app.get('/', (req, res) => {
    res.json({
        name: 'M-BINGO API',
        version: '2.0.0',
        status: 'running',
        endpoints: {
            health: '/health',
            api: '/api/',
            ws: '/ws'
        }
    });
});

// ============================================================
// USER ENDPOINTS
// ============================================================

// Register user
app.post('/api/users/register', (req, res) => {
    try {
        const { telegramId, username, firstName, lastName } = req.body;
        
        let user = db.users.find(u => u.telegramId == telegramId);
        
        if (!user) {
            user = {
                id: Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
                telegramId: telegramId || null,
                username: username || '',
                firstName: firstName || 'Player',
                lastName: lastName || '',
                balance: 500,
                status: 'ACTIVE',
                totalGames: 0,
                totalWins: 0,
                totalWinnings: 0,
                createdAt: new Date(),
                lastLogin: new Date()
            };
            db.users.push(user);
            console.log(`✅ New user: ${firstName} (${telegramId})`);
        } else {
            user.lastLogin = new Date();
        }
        
        res.json({
            success: true,
            user: {
                id: user.id,
                telegramId: user.telegramId,
                username: user.username,
                firstName: user.firstName,
                balance: user.balance
            }
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get user
app.get('/api/users/:userId', (req, res) => {
    const user = db.users.find(u => u.id === req.params.userId || u.telegramId == req.params.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
});

// ============================================================
// WALLET ENDPOINTS
// ============================================================

app.get('/api/wallet/:userId', (req, res) => {
    const user = db.users.find(u => u.id === req.params.userId || u.telegramId == req.params.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    
    res.json({
        userId: user.id,
        balance: user.balance,
        totalWinnings: user.totalWinnings || 0,
        gamesPlayed: user.totalGames || 0,
        wins: user.totalWins || 0
    });
});

// ============================================================
// ROOM ENDPOINTS
// ============================================================

app.get('/api/rooms', (req, res) => {
    const activeRooms = db.rooms.filter(r => r.status !== 'ENDED');
    res.json(activeRooms.map(r => ({
        id: r.id,
        stake: r.stake,
        status: r.status,
        playerCount: r.players ? r.players.length : 0,
        prizePool: r.prizePool || 0
    })));
});

app.post('/api/rooms', (req, res) => {
    const { stake } = req.body;
    const room = {
        id: Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
        stake: stake || 10,
        status: 'WAITING',
        players: [],
        selectedCards: [],
        calledNumbers: [],
        prizePool: 0,
        gameNumber: db.rooms.length + 1,
        createdAt: new Date()
    };
    db.rooms.push(room);
    res.json(room);
});

// ============================================================
// CARDS ENDPOINTS
// ============================================================

app.get('/api/cards', (req, res) => {
    res.json(db.cards);
});

app.get('/api/cards/:number', (req, res) => {
    const card = db.cards.find(c => c.cardNumber == req.params.number);
    if (!card) return res.status(404).json({ error: 'Card not found' });
    res.json(card);
});

// ============================================================
// ADMIN ENDPOINTS
// ============================================================

app.get('/api/admin/players', (req, res) => {
    const { adminId } = req.query;
    // Simple admin check - in production use proper auth
    if (adminId !== '555508978') {
        return res.status(403).json({ error: 'Unauthorized' });
    }
    res.json(db.users.map(u => ({
        id: u.id,
        name: u.firstName || u.username || 'Player',
        balance: u.balance,
        total_games_played: u.totalGames || 0,
        total_wins: u.totalWins || 0
    })));
});

app.get('/api/admin/stats', (req, res) => {
    const { adminId } = req.query;
    if (adminId !== '555508978') {
        return res.status(403).json({ error: 'Unauthorized' });
    }
    const activeRooms = db.rooms.filter(r => r.status === 'PLAYING');
    res.json({
        onlinePlayers: db.users.filter(u => u.status === 'ONLINE').length || 0,
        activeGames: activeRooms.length,
        totalUsers: db.users.length,
        totalRooms: db.rooms.length
    });
});

// ============================================================
// WEBSOCKET SERVER
// ============================================================

const clients = new Map();

wss.on('connection', (ws, req) => {
    const clientId = Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
    clients.set(clientId, { ws, userId: null });
    console.log(`🟢 WebSocket client ${clientId} connected`);
    
    ws.send(JSON.stringify({
        type: 'connected',
        data: { 
            clientId: clientId, 
            message: 'Connected to M-BINGO server',
            timestamp: new Date().toISOString()
        }
    }));
    
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            console.log(`📩 WebSocket message: ${data.type}`);
            
            // Handle basic messages
            if (data.type === 'auth') {
                const { userId } = data.data;
                const user = db.users.find(u => u.id === userId || u.telegramId == userId);
                if (user) {
                    clients.get(clientId).userId = user.id;
                    ws.send(JSON.stringify({
                        type: 'authSuccess',
                        data: { userId: user.id, balance: user.balance }
                    }));
                } else {
                    ws.send(JSON.stringify({
                        type: 'authError',
                        data: { message: 'User not found' }
                    }));
                }
            }
            
            if (data.type === 'register') {
                const { name, telegramId } = data.data;
                let user = db.users.find(u => u.telegramId == telegramId);
                if (!user) {
                    user = {
                        id: Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
                        telegramId: telegramId || null,
                        username: '',
                        firstName: name || 'Player',
                        lastName: '',
                        balance: 500,
                        status: 'ACTIVE',
                        totalGames: 0,
                        totalWins: 0,
                        totalWinnings: 0,
                        createdAt: new Date(),
                        lastLogin: new Date()
                    };
                    db.users.push(user);
                }
                ws.send(JSON.stringify({
                    type: 'registerSuccess',
                    data: { userId: user.id, name: user.firstName, balance: user.balance }
                }));
            }
            
            // Echo back for testing
            ws.send(JSON.stringify({
                type: 'echo',
                data: { received: data.type }
            }));
            
        } catch (error) {
            console.error('WebSocket error:', error);
        }
    });
    
    ws.on('close', () => {
        clients.delete(clientId);
        console.log(`🔴 WebSocket client ${clientId} disconnected`);
    });
});

// Broadcast to all clients
function broadcastToAll(message) {
    for (const [id, client] of clients) {
        if (client.ws.readyState === WebSocket.OPEN) {
            client.ws.send(JSON.stringify(message));
        }
    }
}

// ============================================================
// START SERVER
// ============================================================

const PORT = process.env.PORT || 3000;

server.listen(PORT, '0.0.0.0', () => {
    console.log(`
╔═══════════════════════════════════════════════════════════╗
║                                                          ║
║  🎯 M-BINGO PRODUCTION SERVER v2.0 (MINIMAL)            ║
║                                                          ║
║  📡 WebSocket: ws://localhost:${PORT}/ws                ║
║  🌐 HTTP API: http://localhost:${PORT}/api              ║
║                                                          ║
║  👥 Users: ${db.users.length}                           ║
║  🏠 Rooms: ${db.rooms.length}                           ║
║  🃏 Cards: ${db.cards.length}                           ║
║                                                          ║
╚═══════════════════════════════════════════════════════════╝
    `);
});

module.exports = { app, server, wss };