const WebSocket = require('ws');
const http = require('http');
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// ============================================================
//  GAME STATE
// ============================================================

let players = [];
let winners = [];
let gameState = {
    isPlaying: false,
    stake: 0,
    gameNumber: 0,
    calledNumbers: [],
    totalCardsInPlay: 0
};

// ============================================================
//  BINGO BOARD GENERATION
// ============================================================

function generateBoards() {
    const boards = [];
    for (let b = 1; b <= 200; b++) {
        const board = [];
        for (let row = 0; row < 5; row++) {
            const rowData = [];
            for (let col = 0; col < 5; col++) {
                let num;
                if (col === 2 && row === 2) { 
                    num = '★'; 
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
        boards.push(board);
    }
    return boards;
}

const BOARDS = generateBoards();

// ============================================================
//  BROADCAST HELPERS
// ============================================================

function broadcast(message) {
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(message));
        }
    });
}

function sendToPlayer(playerId, message) {
    const player = players.find(p => p.id === playerId);
    if (player && player.ws.readyState === WebSocket.OPEN) {
        player.ws.send(JSON.stringify(message));
    }
}

// ============================================================
//  BINGO PATTERN CHECKER
// ============================================================

function checkBingoPatterns(marked) {
    const patterns = [];
    const size = 5;
    
    for (let r = 0; r < size; r++) {
        let win = true;
        for (let c = 0; c < size; c++) { 
            if (!marked[r][c]) { win = false; break; } 
        }
        if (win) patterns.push({ type: 'row', index: r, label: `ረድፍ ${r+1}` });
    }
    
    for (let c = 0; c < size; c++) {
        let win = true;
        for (let r = 0; r < size; r++) { 
            if (!marked[r][c]) { win = false; break; } 
        }
        if (win) patterns.push({ type: 'column', index: c, label: `ዓምድ ${c+1}` });
    }
    
    let win = true;
    for (let i = 0; i < size; i++) { 
        if (!marked[i][i]) { win = false; break; } 
    }
    if (win) patterns.push({ type: 'diagonal', index: 0, label: 'ሰያፍ 1' });
    
    win = true;
    for (let i = 0; i < size; i++) { 
        if (!marked[i][size - 1 - i]) { win = false; break; } 
    }
    if (win) patterns.push({ type: 'diagonal', index: 1, label: 'ሰያፍ 2' });
    
    return patterns;
}

// ============================================================
//  GAME ENGINE
// ============================================================

function startGame(stake, playerCards) {
    gameState.isPlaying = true;
    gameState.stake = stake;
    gameState.gameNumber++;
    gameState.calledNumbers = [];
    gameState.totalCardsInPlay = playerCards.reduce((sum, p) => sum + p.cards.length, 0);
    
    const allCards = [];
    playerCards.forEach(player => {
        player.cards.forEach(cardNum => {
            allCards.push({
                playerId: player.id,
                playerName: player.name,
                cardNumber: cardNum,
                board: BOARDS[cardNum - 1],
                marked: Array(5).fill(null).map(() => Array(5).fill(false)),
                bingo: false,
                winningPatterns: []
            });
        });
    });
    
    allCards.forEach(c => c.marked[2][2] = true);
    
    broadcast({
        type: 'gameStart',
        data: {
            gameNumber: gameState.gameNumber,
            stake: stake,
            totalCards: gameState.totalCardsInPlay,
            cards: allCards,
            players: playerCards.map(p => ({ id: p.id, name: p.name, cards: p.cards }))
        }
    });
    
    let callIndex = 0;
    const allNumbers = [];
    for (let i = 1; i <= 75; i++) allNumbers.push(i);
    for (let i = allNumbers.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [allNumbers[i], allNumbers[j]] = [allNumbers[j], allNumbers[i]];
    }
    
    const interval = setInterval(() => {
        if (!gameState.isPlaying) {
            clearInterval(interval);
            return;
        }
        
        if (callIndex >= allNumbers.length) {
            clearInterval(interval);
            endGame();
            return;
        }
        
        const number = allNumbers[callIndex];
        callIndex++;
        gameState.calledNumbers.push(number);
        
        allCards.forEach(card => {
            for (let r = 0; r < 5; r++) {
                for (let c = 0; c < 5; c++) {
                    if (card.board[r][c] === number) {
                        card.marked[r][c] = true;
                    }
                }
            }
        });
        
        let gameWinners = [];
        allCards.forEach(card => {
            if (card.bingo) return;
            const patterns = checkBingoPatterns(card.marked);
            if (patterns.length > 0) {
                card.bingo = true;
                card.winningPatterns = patterns;
                gameWinners.push({
                    playerId: card.playerId,
                    playerName: card.playerName,
                    cardNumber: card.cardNumber,
                    patterns: patterns,
                    board: card.board,
                    marked: card.marked,
                    prize: 0
                });
            }
        });
        
        if (gameWinners.length > 0) {
            clearInterval(interval);
            const totalPrize = stake * gameState.totalCardsInPlay * 0.7;
            const prizePerWinner = Math.round(totalPrize / gameWinners.length);
            
            gameWinners.forEach(w => {
                w.prize = prizePerWinner;
                const player = players.find(p => p.id === w.playerId);
                if (player) {
                    player.balance += prizePerWinner;
                }
                // Store winners for API
                winners.push({
                    name: w.playerName,
                    prize: prizePerWinner,
                    cardNumber: w.cardNumber,
                    timestamp: new Date().toISOString()
                });
            });
            
            broadcast({
                type: 'gameEnd',
                data: {
                    winners: gameWinners,
                    prizePerWinner: prizePerWinner,
                    calledNumbers: gameState.calledNumbers,
                    totalPrize: totalPrize
                }
            });
            
            gameState.isPlaying = false;
            players.forEach(p => p.cards = []);
            return;
        }
        
        broadcast({
            type: 'numberCalled',
            data: {
                number: number,
                calledCount: callIndex,
                totalNumbers: 75,
                calledNumbers: gameState.calledNumbers
            }
        });
        
    }, 1500);
}

function endGame() {
    gameState.isPlaying = false;
    broadcast({
        type: 'gameEnd',
        data: {
            winners: [],
            prizePerWinner: 0,
            calledNumbers: gameState.calledNumbers,
            message: 'Game ended without winner'
        }
    });
    players.forEach(p => p.cards = []);
}

// ============================================================
//  TELEGRAM BOT API ENDPOINTS
// ============================================================

// Get player balance by Telegram ID
app.get('/api/balance/:telegramId', (req, res) => {
    const player = players.find(p => p.telegramId == req.params.telegramId);
    if (player) {
        res.json({ 
            balance: player.balance, 
            games: player.gamesPlayed || 0,
            wins: player.wins || 0
        });
    } else {
        res.status(404).json({ error: 'Player not found' });
    }
});

// Get all players (for admin)
app.get('/api/players', (req, res) => {
    res.json(players.map(p => ({ 
        name: p.name, 
        balance: p.balance,
        cards: p.cards ? p.cards.length : 0,
        telegramId: p.telegramId
    })));
});

// Get recent winners
app.get('/api/recent-winners', (req, res) => {
    res.json(winners.slice(-10));
});

// Add balance via API (for Telegram bot)
app.post('/api/add-balance', (req, res) => {
    const { telegramId, amount } = req.body;
    const player = players.find(p => p.telegramId == telegramId);
    if (player) {
        player.balance += amount;
        res.json({ success: true, newBalance: player.balance });
    } else {
        res.status(404).json({ error: 'Player not found' });
    }
});

// Remove balance via API
app.post('/api/remove-balance', (req, res) => {
    const { telegramId, amount } = req.body;
    const player = players.find(p => p.telegramId == telegramId);
    if (player) {
        if (player.balance >= amount) {
            player.balance -= amount;
            res.json({ success: true, newBalance: player.balance });
        } else {
            res.status(400).json({ error: 'Insufficient balance' });
        }
    } else {
        res.status(404).json({ error: 'Player not found' });
    }
});

// ============================================================
//  WEBSOCKET CONNECTION
// ============================================================

wss.on('connection', (ws) => {
    console.log('New player connected');
    
    const playerId = Date.now() + Math.floor(Math.random() * 1000);
    
    const player = {
        id: playerId,
        telegramId: null, // Will be set when user registers
        name: `Player ${players.length + 1}`,
        balance: 500,
        cards: [],
        ws: ws,
        isWinner: false,
        gamesPlayed: 0,
        wins: 0
    };
    
    players.push(player);
    
    ws.send(JSON.stringify({
        type: 'init',
        data: {
            playerId: playerId,
            players: players.map(p => ({ id: p.id, name: p.name, balance: p.balance, cards: p.cards })),
            gameState: {
                isPlaying: gameState.isPlaying,
                gameNumber: gameState.gameNumber,
                stake: gameState.stake,
                calledNumbers: gameState.calledNumbers
            }
        }
    }));
    
    broadcast({
        type: 'playersUpdate',
        data: players.map(p => ({ id: p.id, name: p.name, balance: p.balance, cards: p.cards }))
    });
    
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            
            switch (data.type) {
                case 'register':
                    player.name = data.data.name;
                    player.telegramId = data.data.telegramId || null;
                    broadcast({
                        type: 'playersUpdate',
                        data: players.map(p => ({ id: p.id, name: p.name, balance: p.balance, cards: p.cards }))
                    });
                    break;
                    
                case 'selectCards':
                    player.cards = data.data.cards;
                    const cost = gameState.stake * player.cards.length;
                    if (cost > player.balance) {
                        ws.send(JSON.stringify({
                            type: 'error',
                            data: { message: 'Insufficient balance' }
                        }));
                        player.cards = [];
                        return;
                    }
                    player.balance -= cost;
                    
                    broadcast({
                        type: 'playersUpdate',
                        data: players.map(p => ({ id: p.id, name: p.name, balance: p.balance, cards: p.cards }))
                    });
                    break;
                    
                case 'startGame':
                    if (gameState.isPlaying) {
                        ws.send(JSON.stringify({
                            type: 'error',
                            data: { message: 'Game already in progress' }
                        }));
                        return;
                    }
                    
                    const playersWithCards = players.filter(p => p.cards.length > 0);
                    if (playersWithCards.length < 2) {
                        ws.send(JSON.stringify({
                            type: 'error',
                            data: { message: 'Need at least 2 players with cards to start' }
                        }));
                        return;
                    }
                    
                    startGame(data.data.stake, playersWithCards);
                    break;
                    
                case 'adminLogin':
                    if (data.data.username === 'matany' && data.data.password === 'Fr843534#') {
                        ws.send(JSON.stringify({
                            type: 'adminAuth',
                            data: { success: true }
                        }));
                    } else {
                        ws.send(JSON.stringify({
                            type: 'adminAuth',
                            data: { success: false }
                        }));
                    }
                    break;
                    
                case 'adminAction':
                    const targetPlayer = players.find(p => p.id === data.data.playerId);
                    if (targetPlayer) {
                        if (data.data.action === 'deposit') {
                            targetPlayer.balance += data.data.amount;
                        } else if (data.data.action === 'withdraw') {
                            targetPlayer.balance -= data.data.amount;
                        }
                        broadcast({
                            type: 'playersUpdate',
                            data: players.map(p => ({ id: p.id, name: p.name, balance: p.balance, cards: p.cards }))
                        });
                    }
                    break;
                    
                case 'getAdminData':
                    ws.send(JSON.stringify({
                        type: 'adminData',
                        data: {
                            players: players.map(p => ({ 
                                id: p.id, 
                                name: p.name, 
                                balance: p.balance, 
                                cards: p.cards,
                                telegramId: p.telegramId
                            }))
                        }
                    }));
                    break;
            }
        } catch (e) {
            console.error('Error processing message:', e);
        }
    });
    
    ws.on('close', () => {
        console.log('Player disconnected');
        players = players.filter(p => p.id !== playerId);
        broadcast({
            type: 'playersUpdate',
            data: players.map(p => ({ id: p.id, name: p.name, balance: p.balance, cards: p.cards }))
        });
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 BINGO Server running on port ${PORT}`);
});