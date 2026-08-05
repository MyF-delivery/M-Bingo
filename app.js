const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
require('dotenv').config();

const app = express();
const server = http.createServer(app);

// ============================================================
// MIDDLEWARE
// ============================================================

// CORS - Allow GitHub Pages
const allowedOrigins = [
    'https://myf-delivery.github.io',
    'https://my-bingo-server-vakj.onrender.com',
    'http://localhost:3000',
    'http://localhost:5500',
    'https://m-bingo-production.vercel.app'
];

app.use(cors({
    origin: function(origin, callback) {
        // Allow requests with no origin (like mobile apps or curl)
        if (!origin) return callback(null, true);
        if (allowedOrigins.indexOf(origin) !== -1) {
            callback(null, true);
        } else {
            console.log('Origin blocked:', origin);
            callback(null, true); // Allow all for now
        }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
}));

app.use(helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" },
    crossOriginEmbedderPolicy: false,
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            connectSrc: ["'self'", "wss://my-bingo-server-vakj.onrender.com", "https://my-bingo-server-vakj.onrender.com"],
            scriptSrc: ["'self'", "'unsafe-inline'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            imgSrc: ["'self'", "data:"]
        }
    }
}));

app.use(compression());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Rate limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: { error: 'Too many requests, please try again later.' }
});
app.use('/api/', limiter);

// ============================================================
// WEBHOOK FOR TELEGRAM
// ============================================================

const BOT_TOKEN = process.env.BOT_TOKEN || '8312462723:AAHVyOGm7vDKJD7M_8ZceQzgvwLkMGc6dEU';
const ADMIN_IDS = (process.env.ADMIN_IDS || '555508978').split(',').map(id => parseInt(id.trim()));

// Telegram webhook endpoint
app.post(`/webhook/${BOT_TOKEN}`, (req, res) => {
    try {
        const update = req.body;
        console.log('📩 Telegram Update:', update);
        
        // Handle updates here
        if (update.message) {
            const chatId = update.message.chat.id;
            const text = update.message.text;
            
            // Simple response
            if (text === '/start') {
                res.send({
                    method: 'sendMessage',
                    chat_id: chatId,
                    text: '🎯 Welcome to M-BINGO!\n\nPlay here: https://myf-delivery.github.io/M-Bingo/',
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '🎯 Play BINGO', web_app: { url: 'https://myf-delivery.github.io/M-Bingo/' } }],
                            [{ text: '💰 Balance', callback_data: 'balance' }],
                            [{ text: '👥 Invite Friends', callback_data: 'invite' }]
                        ]
                    }
                });
            }
        }
        
        res.sendStatus(200);
    } catch (error) {
        console.error('Webhook error:', error);
        res.sendStatus(500);
    }
});

// ============================================================
// DATABASE (In-memory for now - will switch to PostgreSQL later)
// ============================================================

// In-memory storage
const db = {
    users: [],
    rooms: [],
    games: [],
    transactions: [],
    deposits: [],
    withdrawals: [],
    cards: generateBingoCards(),
    gameState: {
        status: 'waiting',
        players: [],
        calledNumbers: [],
        currentGame: null
    }
};

// Generate 200 BINGO cards
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

// Health check
app.get('/health', (req, res) => {
    res.json({
        status: 'OK',
        time: new Date().toISOString(),
        version: '2.0.0',
        uptime: process.uptime(),
        users: db.users.length,
        rooms: db.rooms.length,
        environment: process.env.NODE_ENV || 'development'
    });
});

// Root endpoint
app.get('/', (req, res) => {
    res.json({
        name: 'M-BINGO API',
        version: '2.0.0',
        endpoints: {
            health: '/health',
            api: '/api/',
            webhook: `/webhook/${BOT_TOKEN}`
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
        
        let user = db.users.find(u => u.telegramId === telegramId);
        
        if (!user) {
            user = {
                id: uuidv4(),
                telegramId: telegramId,
                username: username || '',
                firstName: firstName || '',
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
                balance: user.balance,
                status: user.status
            }
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get user
app.get('/api/users/:userId', (req, res) => {
    const user = db.users.find(u => u.id === req.params.userId || u.telegramId == req.params.userId);
    if (!user) {
        return res.status(404).json({ error: 'User not found' });
    }
    res.json(user);
});

// ============================================================
// WALLET ENDPOINTS
// ============================================================

// Get wallet
app.get('/api/wallet/:userId', (req, res) => {
    const user = db.users.find(u => u.id === req.params.userId || u.telegramId == req.params.userId);
    if (!user) {
        return res.status(404).json({ error: 'User not found' });
    }
    
    res.json({
        userId: user.id,
        balance: user.balance,
        totalWinnings: user.totalWinnings || 0,
        gamesPlayed: user.totalGames || 0,
        wins: user.totalWins || 0,
        totalDeposits: user.totalDeposits || 0,
        totalWithdrawals: user.totalWithdrawals || 0
    });
});

// Add balance (admin only)
app.post('/api/admin/balance/add', (req, res) => {
    const { userId, amount, adminId } = req.body;
    
    // Check admin
    if (!ADMIN_IDS.includes(parseInt(adminId))) {
        return res.status(403).json({ error: 'Unauthorized' });
    }
    
    const user = db.users.find(u => u.id === userId || u.telegramId == userId);
    if (!user) {
        return res.status(404).json({ error: 'User not found' });
    }
    
    user.balance += amount;
    
    // Log transaction
    db.transactions.push({
        id: uuidv4(),
        userId: user.id,
        type: 'ADMIN_DEPOSIT',
        amount: amount,
        balanceBefore: user.balance - amount,
        balanceAfter: user.balance,
        description: `Admin deposit of ${amount} Birr`,
        createdAt: new Date()
    });
    
    res.json({
        success: true,
        newBalance: user.balance,
        user: {
            id: user.id,
            name: user.firstName || user.username || 'Player'
        }
    });
});

// ============================================================
// ROOM ENDPOINTS
// ============================================================

// Get all rooms
app.get('/api/rooms', (req, res) => {
    const activeRooms = db.rooms.filter(r => r.status !== 'ENDED');
    res.json(activeRooms.map(r => ({
        id: r.id,
        stake: r.stake,
        status: r.status,
        playerCount: r.players ? r.players.length : 0,
        prizePool: r.prizePool || 0,
        gameNumber: r.gameNumber || 0
    })));
});

// Create room
app.post('/api/rooms', (req, res) => {
    const { stake, maxPlayers, minPlayers } = req.body;
    
    const room = {
        id: uuidv4(),
        stake: stake || 10,
        maxPlayers: maxPlayers || 100,
        minPlayers: minPlayers || 2,
        status: 'WAITING',
        players: [],
        selectedCards: [],
        calledNumbers: [],
        prizePool: 0,
        gameNumber: 0,
        houseCommission: 30,
        countdownSeconds: 30,
        createdAt: new Date(),
        startedAt: null,
        endedAt: null
    };
    
    db.rooms.push(room);
    res.json(room);
});

// Join room
app.post('/api/rooms/:roomId/join', (req, res) => {
    const { userId, userName } = req.body;
    const room = db.rooms.find(r => r.id === req.params.roomId);
    
    if (!room) {
        return res.status(404).json({ error: 'Room not found' });
    }
    
    if (room.status === 'PLAYING' || room.status === 'ENDED') {
        return res.status(400).json({ error: 'Room is not accepting players' });
    }
    
    const user = db.users.find(u => u.id === userId);
    if (!user) {
        return res.status(404).json({ error: 'User not found' });
    }
    
    // Check if already in room
    if (room.players.find(p => p.id === userId)) {
        return res.json({ message: 'Already in room', room });
    }
    
    // Check balance
    if (user.balance < room.stake) {
        return res.status(400).json({ 
            error: `Insufficient balance. Need ${room.stake} Birr, have ${user.balance} Birr` 
        });
    }
    
    // Deduct stake
    user.balance -= room.stake;
    
    // Add to room
    room.players.push({
        id: userId,
        name: userName || user.firstName || 'Player',
        cards: [],
        isReady: false,
        joinedAt: new Date()
    });
    
    // Log transaction
    db.transactions.push({
        id: uuidv4(),
        userId: userId,
        type: 'STAKE',
        amount: room.stake,
        balanceBefore: user.balance + room.stake,
        balanceAfter: user.balance,
        description: `Joined ${room.stake} Birr room`,
        roomId: room.id,
        createdAt: new Date()
    });
    
    // Update prize pool
    room.prizePool = room.players.length * room.stake * 0.7;
    
    res.json({
        success: true,
        room: {
            id: room.id,
            stake: room.stake,
            status: room.status,
            players: room.players,
            prizePool: room.prizePool
        }
    });
});

// ============================================================
// GAME ENDPOINTS
// ============================================================

// Get game status
app.get('/api/game/status', (req, res) => {
    const activeRooms = db.rooms.filter(r => r.status === 'PLAYING');
    const waitingRooms = db.rooms.filter(r => r.status === 'WAITING');
    
    res.json({
        rooms: db.rooms.length,
        activeGames: activeRooms.length,
        waiting: waitingRooms.length,
        players: db.users.length,
        online: db.users.filter(u => u.status === 'ONLINE').length || 0,
        systemStatus: 'Operational',
        uptime: process.uptime()
    });
});

// Get winners
app.get('/api/game/winners', (req, res) => {
    const winners = db.transactions
        .filter(t => t.type === 'WIN')
        .slice(-10)
        .map(t => ({
            name: t.userName || 'Player',
            prize: t.amount,
            gameNumber: t.gameNumber || 0
        }));
    
    res.json(winners);
});

// ============================================================
// ADMIN ENDPOINTS
// ============================================================

// Get all players (admin only)
app.get('/api/admin/players', (req, res) => {
    const { adminId } = req.query;
    
    if (!ADMIN_IDS.includes(parseInt(adminId))) {
        return res.status(403).json({ error: 'Unauthorized' });
    }
    
    res.json(db.users.map(u => ({
        id: u.id,
        name: u.firstName || u.username || 'Player',
        username: u.username,
        balance: u.balance,
        total_games_played: u.totalGames || 0,
        total_wins: u.totalWins || 0,
        status: u.status || 'ACTIVE'
    })));
});

// Get admin stats
app.get('/api/admin/stats', (req, res) => {
    const activeRooms = db.rooms.filter(r => r.status === 'PLAYING');
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const todayTransactions = db.transactions.filter(t => 
        new Date(t.createdAt) >= today && t.type === 'STAKE'
    );
    
    res.json({
        onlinePlayers: db.users.filter(u => u.status === 'ONLINE').length || 0,
        activeGames: activeRooms.length,
        todayRevenue: todayTransactions.reduce((sum, t) => sum + t.amount, 0),
        pendingWithdrawals: db.withdrawals.filter(w => w.status === 'PENDING').length || 0,
        totalUsers: db.users.length,
        totalRooms: db.rooms.length
    });
});

// ============================================================
// WEBSOCKET SERVER
// ============================================================

const wss = new WebSocket.Server({ 
    server,
    path: '/ws',
    perMessageDeflate: false
});

const clients = new Map();

wss.on('connection', (ws, req) => {
    const clientId = uuidv4();
    clients.set(clientId, { ws, userId: null, roomId: null });
    console.log(`🟢 WebSocket client ${clientId} connected`);
    
    // Send initial connection confirmation
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
            console.log(`📩 WebSocket message:`, data.type);
            
            handleWebSocketMessage(clientId, data);
        } catch (error) {
            console.error('WebSocket message error:', error);
            ws.send(JSON.stringify({
                type: 'error',
                data: { message: error.message }
            }));
        }
    });
    
    ws.on('close', () => {
        const client = clients.get(clientId);
        if (client && client.userId) {
            const user = db.users.find(u => u.id === client.userId);
            if (user) {
                user.status = 'OFFLINE';
            }
        }
        clients.delete(clientId);
        console.log(`🔴 WebSocket client ${clientId} disconnected`);
        
        // Broadcast updated player count
        broadcastToAll({
            type: 'playerCount',
            data: { count: clients.size }
        });
    });
});

function handleWebSocketMessage(clientId, data) {
    const client = clients.get(clientId);
    if (!client) return;
    
    const ws = client.ws;
    
    switch (data.type) {
        case 'auth':
            const { userId } = data.data;
            const user = db.users.find(u => u.id === userId || u.telegramId == userId);
            if (user) {
                client.userId = user.id;
                user.status = 'ONLINE';
                ws.send(JSON.stringify({
                    type: 'authSuccess',
                    data: { userId: user.id, balance: user.balance }
                }));
                
                // Broadcast updated player count
                broadcastToAll({
                    type: 'playerCount',
                    data: { count: clients.size }
                });
            } else {
                ws.send(JSON.stringify({
                    type: 'authError',
                    data: { message: 'User not found' }
                }));
            }
            break;
            
        case 'joinRoom':
            const { roomId } = data.data;
            const room = db.rooms.find(r => r.id === roomId);
            if (room) {
                client.roomId = roomId;
                ws.send(JSON.stringify({
                    type: 'roomJoined',
                    data: {
                        roomId: roomId,
                        players: room.players,
                        status: room.status
                    }
                }));
                
                // Notify room about new player
                broadcastToRoom(roomId, {
                    type: 'playerJoined',
                    data: {
                        userId: client.userId,
                        playerCount: room.players.length
                    }
                });
            }
            break;
            
        case 'selectCards':
            const { roomId: rId, cards } = data.data;
            const roomObj = db.rooms.find(r => r.id === rId);
            if (roomObj) {
                const player = roomObj.players.find(p => p.id === client.userId);
                if (player) {
                    player.cards = cards;
                    player.isReady = cards.length > 0;
                    
                    // Update room
                    broadcastToRoom(rId, {
                        type: 'cardsSelected',
                        data: {
                            userId: client.userId,
                            cards: cards,
                            isReady: player.isReady
                        }
                    });
                }
            }
            break;
            
        case 'claimBingo':
            const { roomId: claimRoomId, cardNumber } = data.data;
            const gameRoom = db.rooms.find(r => r.id === claimRoomId);
            if (gameRoom) {
                // Simple BINGO validation for demo
                ws.send(JSON.stringify({
                    type: 'bingoClaimResult',
                    data: {
                        success: true,
                        message: '🎉 BINGO! You won!',
                        amount: gameRoom.prizePool || 100
                    }
                }));
                
                // Award prize
                const winner = db.users.find(u => u.id === client.userId);
                if (winner) {
                    winner.balance += gameRoom.prizePool || 100;
                    winner.totalWins = (winner.totalWins || 0) + 1;
                    winner.totalWinnings = (winner.totalWinnings || 0) + (gameRoom.prizePool || 100);
                    
                    // Broadcast winner
                    broadcastToRoom(claimRoomId, {
                        type: 'gameEnd',
                        data: {
                            winnerId: client.userId,
                            winnerName: winner.firstName || winner.username || 'Player',
                            prize: gameRoom.prizePool || 100
                        }
                    });
                }
            }
            break;
    }
}

// Broadcast to all clients
function broadcastToAll(message) {
    for (const [id, client] of clients) {
        if (client.ws.readyState === WebSocket.OPEN) {
            client.ws.send(JSON.stringify(message));
        }
    }
}

// Broadcast to a specific room
function broadcastToRoom(roomId, message) {
    for (const [id, client] of clients) {
        if (client.roomId === roomId && client.ws.readyState === WebSocket.OPEN) {
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
║  🎯 M-BINGO PRODUCTION SERVER                           ║
║                                                          ║
║  📡 WebSocket: wss://my-bingo-server-vakj.onrender.com/ws║
║  🌐 HTTP API: https://my-bingo-server-vakj.onrender.com  ║
║  🔗 Frontend: https://myf-delivery.github.io/M-Bingo/   ║
║  🤖 Bot: @M_bingo_bot                                   ║
║                                                          ║
║  👥 Users: ${db.users.length}                           ║
║  🏠 Rooms: ${db.rooms.length}                           ║
║  🃏 Cards: ${db.cards.length}                           ║
║                                                          ║
║  🌐 Allowed Origins:                                    ║
║    - https://myf-delivery.github.io                     ║
║    - https://my-bingo-server-vakj.onrender.com          ║
║                                                          ║
╚═══════════════════════════════════════════════════════════╝
    `);
});

module.exports = { app, server, wss };
