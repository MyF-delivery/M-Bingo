require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const WebSocket = require('ws');
const { redisClient, pool } = require('./database');
const RoomManager = require('./game/room-manager');
const WalletService = require('./services/wallet');
const config = require('./config');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// ============================================================
// MIDDLEWARE
// ============================================================

app.use(helmet());
app.use(compression());
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Rate limiting
const limiter = rateLimit({
    windowMs: config.rateLimit.window * 60 * 1000,
    max: config.rateLimit.max,
    message: { error: 'Too many requests, please try again later.' },
});
app.use('/api/', limiter);

// ============================================================
// API ROUTES
// ============================================================

// Health check
app.get('/health', (req, res) => {
    res.json({ 
        status: 'OK', 
        time: new Date().toISOString(),
        rooms: RoomManager.rooms.size,
        players: Array.from(RoomManager.rooms.values())
            .reduce((sum, r) => sum + r.players.size, 0)
    });
});

// Wallet endpoints
app.get('/api/wallet/:userId', async (req, res) => {
    try {
        const info = await WalletService.getWalletInfo(req.params.userId);
        res.json(info);
    } catch (error) {
        res.status(404).json({ error: error.message });
    }
});

app.get('/api/wallet/:userId/transactions', async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 50;
        const offset = parseInt(req.query.offset) || 0;
        const transactions = await WalletService.getTransactions(
            req.params.userId, limit, offset
        );
        res.json(transactions);
    } catch (error) {
        res.status(404).json({ error: error.message });
    }
});

// Room endpoints
app.get('/api/rooms', async (req, res) => {
    try {
        const rooms = await RoomManager.getActiveRooms();
        res.json(rooms);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/rooms/:roomId', async (req, res) => {
    try {
        const room = await RoomManager.getRoomWithPlayers(req.params.roomId);
        if (!room) {
            return res.status(404).json({ error: 'Room not found' });
        }
        res.json(room);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/rooms', async (req, res) => {
    try {
        const room = await RoomManager.createRoom(req.body);
        res.json(room);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/rooms/:roomId/join', async (req, res) => {
    try {
        const { userId, userName } = req.body;
        const result = await RoomManager.joinRoom(req.params.roomId, userId, userName);
        res.json(result);
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

app.post('/api/rooms/:roomId/leave', async (req, res) => {
    try {
        const { userId } = req.body;
        const result = await RoomManager.leaveRoom(req.params.roomId, userId);
        res.json(result);
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// Card endpoints
app.get('/api/cards', async (req, res) => {
    try {
        const cards = await CardManager.getAllCards();
        res.json(cards);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/cards/:number', async (req, res) => {
    try {
        const card = await CardManager.getCard(parseInt(req.params.number));
        if (!card) {
            return res.status(404).json({ error: 'Card not found' });
        }
        res.json(card);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Deposit endpoints
app.post('/api/deposits', async (req, res) => {
    try {
        const { userId, amount, method, reference } = req.body;
        
        // Create deposit record
        const result = await query(
            `INSERT INTO deposits (user_id, amount, method, reference, status)
            VALUES ($1, $2, $3, $4, 'PENDING')
            RETURNING *`,
            [userId, amount, method, reference]
        );
        
        res.json({ 
            deposit: result.rows[0],
            message: 'Deposit request submitted for approval'
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Withdrawal endpoints
app.post('/api/withdrawals', async (req, res) => {
    try {
        const { userId, amount, method, destination } = req.body;
        
        // Check balance
        const balance = await WalletService.getBalance(userId);
        if (balance < amount) {
            return res.status(400).json({ error: 'Insufficient balance' });
        }
        
        // Create withdrawal record
        const result = await query(
            `INSERT INTO withdrawals (user_id, amount, method, destination, status)
            VALUES ($1, $2, $3, $4, 'PENDING')
            RETURNING *`,
            [userId, amount, method, destination]
        );
        
        res.json({ 
            withdrawal: result.rows[0],
            message: 'Withdrawal request submitted for approval'
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Admin endpoints
app.post('/api/admin/deposit/approve', async (req, res) => {
    try {
        const { depositId, adminId } = req.body;
        
        // Get deposit
        const depositResult = await query(
            'SELECT * FROM deposits WHERE id = $1 AND status = $2',
            [depositId, 'PENDING']
        );
        
        if (depositResult.rows.length === 0) {
            return res.status(404).json({ error: 'Deposit not found' });
        }
        
        const deposit = depositResult.rows[0];
        
        // Credit wallet
        await WalletService.credit(
            deposit.user_id,
            deposit.amount,
            'DEPOSIT',
            deposit.reference,
            `Deposit via ${deposit.method}`,
            { depositId }
        );
        
        // Update deposit status
        await query(
            `UPDATE deposits 
            SET status = 'APPROVED', admin_id = $1, approved_at = CURRENT_TIMESTAMP 
            WHERE id = $2`,
            [adminId, depositId]
        );
        
        res.json({ success: true, message: 'Deposit approved' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/admin/withdrawal/approve', async (req, res) => {
    try {
        const { withdrawalId, adminId } = req.body;
        
        // Get withdrawal
        const withdrawalResult = await query(
            'SELECT * FROM withdrawals WHERE id = $1 AND status = $2',
            [withdrawalId, 'PENDING']
        );
        
        if (withdrawalResult.rows.length === 0) {
            return res.status(404).json({ error: 'Withdrawal not found' });
        }
        
        const withdrawal = withdrawalResult.rows[0];
        
        // Check balance again
        const balance = await WalletService.getBalance(withdrawal.user_id);
        if (balance < withdrawal.amount) {
            return res.status(400).json({ error: 'Insufficient balance' });
        }
        
        // Debit wallet
        await WalletService.debit(
            withdrawal.user_id,
            withdrawal.amount,
            'WITHDRAWAL',
            withdrawal.reference,
            `Withdrawal via ${withdrawal.method}`,
            { withdrawalId }
        );
        
        // Update withdrawal status
        await query(
            `UPDATE withdrawals 
            SET status = 'APPROVED', admin_id = $1, approved_at = CURRENT_TIMESTAMP 
            WHERE id = $2`,
            [adminId, withdrawalId]
        );
        
        res.json({ success: true, message: 'Withdrawal approved' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============================================================
// WEBSOCKET SERVER
// ============================================================

const clients = new Map(); // userId -> ws

wss.on('connection', async (ws, req) => {
    const userId = req.url.split('?userId=')[1] || null;
    
    if (userId) {
        clients.set(userId, ws);
        console.log(`User ${userId} connected via WebSocket`);
    }
    
    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);
            
            // Handle room messages
            if (data.type === 'joinRoom') {
                const { roomId, userId, userName } = data.data;
                const result = await RoomManager.joinRoom(roomId, userId, userName);
                
                // Store user's room
                ws.roomId = roomId;
                ws.userId = userId;
                
                // Broadcast updated room state
                broadcastToRoom(roomId, {
                    type: 'roomUpdate',
                    data: result
                });
            }
            
            if (data.type === 'leaveRoom') {
                const { roomId, userId } = data.data;
                const result = await RoomManager.leaveRoom(roomId, userId);
                
                broadcastToRoom(roomId, {
                    type: 'roomUpdate',
                    data: result
                });
            }
            
            if (data.type === 'selectCards') {
                const { roomId, userId, cards } = data.data;
                
                // Validate cards
                const room = RoomManager.getRoom(roomId);
                if (!room) {
                    ws.send(JSON.stringify({
                        type: 'error',
                        data: { message: 'Room not found' }
                    }));
                    return;
                }
                
                // Check if cards are available
                for (const cardNum of cards) {
                    const available = await CardManager.isCardAvailable(roomId, cardNum);
                    if (!available) {
                        ws.send(JSON.stringify({
                            type: 'error',
                            data: { message: `Card ${cardNum} is already taken` }
                        }));
                        return;
                    }
                }
                
                // Update player cards
                const player = room.players.get(userId);
                if (player) {
                    player.cards = cards;
                    player.isReady = true;
                    
                    // Save to database
                    await query(
                        `UPDATE room_players 
                        SET cards = $1, is_ready = true 
                        WHERE room_id = $2 AND user_id = $3`,
                        [JSON.stringify(cards), roomId, userId]
                    );
                    
                    // Update room selected cards
                    room.selectedCards = room.selectedCards.filter(
                        c => c.playerId !== userId
                    );
                    cards.forEach(cardNum => {
                        room.selectedCards.push({
                            playerId: userId,
                            cardNumber: cardNum
                        });
                    });
                    
                    const result = await RoomManager.getRoomWithPlayers(roomId);
                    broadcastToRoom(roomId, {
                        type: 'roomUpdate',
                        data: result
                    });
                }
            }
            
            if (data.type === 'claimBingo') {
                const { roomId, userId, cardNumber } = data.data;
                
                // Validate claim
                const room = RoomManager.getRoom(roomId);
                if (!room) {
                    ws.send(JSON.stringify({
                        type: 'error',
                        data: { message: 'Room not found' }
                    }));
                    return;
                }
                
                // Check if user owns the card
                const ownsCard = await CardManager.validateCardOwnership(roomId, userId, cardNumber);
                if (!ownsCard) {
                    ws.send(JSON.stringify({
                        type: 'error',
                        data: { message: 'You do not own this card' }
                    }));
                    return;
                }
                
                // Check if card has BINGO
                const gameCard = room.gameCards.find(c => 
                    c.playerId === userId && c.cardNumber === cardNumber
                );
                if (!gameCard) {
                    ws.send(JSON.stringify({
                        type: 'error',
                        data: { message: 'Card not found in this game' }
                    }));
                    return;
                }
                
                const patterns = RoomManager.checkCardPatterns(
                    gameCard.marked,
                    room.winning_pattern
                );
                
                if (patterns.length === 0) {
                    ws.send(JSON.stringify({
                        type: 'error',
                        data: { message: 'No BINGO pattern found' }
                    }));
                    return;
                }
                
                // Validate that all marked numbers were actually called
                for (let r = 0; r < 5; r++) {
                    for (let c = 0; c < 5; c++) {
                        if (gameCard.marked[r][c] && gameCard.board[r][c] !== 0) {
                            const num = gameCard.board[r][c];
                            if (!room.calledNumbers.includes(num)) {
                                ws.send(JSON.stringify({
                                    type: 'error',
                                    data: { message: 'Invalid BINGO claim - marked numbers not called' }
                                }));
                                return;
                            }
                        }
                    }
                }
                
                // Claim verified - handle win
                const winner = {
                    playerId: userId,
                    playerName: room.players.get(userId)?.name || 'Player',
                    cardNumber: cardNumber,
                    patterns: patterns,
                    board: gameCard.board,
                    marked: gameCard.marked,
                };
                
                await RoomManager.handleWinners(roomId, [winner]);
            }
            
        } catch (error) {
            console.error('WebSocket message error:', error);
            ws.send(JSON.stringify({
                type: 'error',
                data: { message: error.message }
            }));
        }
    });
    
    ws.on('close', () => {
        if (userId) {
            clients.delete(userId);
            console.log(`User ${userId} disconnected`);
        }
    });
});

// Broadcast helper
function broadcastToRoom(roomId, message) {
    for (const [userId, ws] of clients) {
        if (ws.roomId === roomId && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(message));
        }
    }
}

// ============================================================
// START SERVER
// ============================================================

const PORT = process.env.PORT || 3000;

server.listen(PORT, async () => {
    console.log(`
╔═══════════════════════════════════════════════════════════╗
║                                                          ║
║  🎯 M-BINGO PRODUCTION SERVER                            ║
║                                                          ║
║  📡 WebSocket: ws://localhost:${PORT}                   ║
║  🌐 HTTP API: http://localhost:${PORT}/api              ║
║  🗄️  Database: PostgreSQL connected                     ║
║  🚀 Redis: connected                                   ║
║                                                          ║
║  👥 Rooms: ${RoomManager.rooms.size}                    ║
║  👤 Players: ${Array.from(RoomManager.rooms.values())
    .reduce((sum, r) => sum + r.players.size, 0)}          ║
║                                                          ║
╚═══════════════════════════════════════════════════════════╝
    `);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
    console.log('🛑 Shutting down gracefully...');
    wss.close();
    await pool.end();
    await redisClient.quit();
    process.exit(0);
});

module.exports = { app, server, wss };
