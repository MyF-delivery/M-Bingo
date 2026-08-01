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
//  GAME STATE (Shared across ALL players)
// ============================================================

let gameState = {
    status: 'waiting', // 'waiting' | 'selecting' | 'playing' | 'ended'
    players: [],
    selectionTimeLeft: 60,
    selectionTimer: null,
    selectedCards: [],
    stake: 0,
    gameNumber: 0,
    calledNumbers: [],
    totalCardsInPlay: 0,
    gameCards: [],
    winners: [],
    isGameActive: false,
};

// Generate BINGO boards (200 cards)
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

function broadcastGameState() {
    broadcast({
        type: 'gameStateUpdate',
        data: {
            status: gameState.status,
            players: gameState.players.map(p => ({ 
                id: p.id, 
                name: p.name, 
                cards: p.cards || [],
                isReady: p.isReady || false,
                balance: p.balance
            })),
            selectionTimeLeft: gameState.selectionTimeLeft,
            selectedCards: gameState.selectedCards,
            stake: gameState.stake,
            gameNumber: gameState.gameNumber,
            calledNumbers: gameState.calledNumbers,
            totalCardsInPlay: gameState.totalCardsInPlay
        }
    });
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
//  CARD SELECTION PHASE
// ============================================================

function startSelectionPhase(stake) {
    gameState.status = 'selecting';
    gameState.stake = stake;
    gameState.selectionTimeLeft = 60;
    gameState.selectedCards = [];
    gameState.gameNumber++;
    
    gameState.players.forEach(p => {
        p.cards = [];
        p.isReady = false;
    });
    
    broadcastGameState();
    
    if (gameState.selectionTimer) {
        clearInterval(gameState.selectionTimer);
    }
    
    gameState.selectionTimer = setInterval(() => {
        gameState.selectionTimeLeft--;
        
        broadcast({
            type: 'selectionTimer',
            data: { timeLeft: gameState.selectionTimeLeft }
        });
        
        if (gameState.selectionTimeLeft <= 0) {
            clearInterval(gameState.selectionTimer);
            startGame();
        }
    }, 1000);
}

// ============================================================
//  CARD SELECTION LOGIC
// ============================================================

function selectCard(playerId, cardNumber) {
    const player = gameState.players.find(p => p.id === playerId);
    if (!player) return { success: false, message: 'Player not found' };
    
    if (gameState.status !== 'selecting') {
        return { success: false, message: 'Card selection is not active' };
    }
    
    if (gameState.selectedCards.includes(cardNumber)) {
        return { success: false, message: 'Card already taken by another player' };
    }
    
    if (player.cards.length >= 5) {
        return { success: false, message: 'You already have 5 cards' };
    }
    
    const cost = gameState.stake * (player.cards.length + 1);
    if (cost > player.balance) {
        return { success: false, message: 'Insufficient balance' };
    }
    
    player.cards.push(cardNumber);
    gameState.selectedCards.push(cardNumber);
    player.balance -= gameState.stake;
    player.isReady = true;
    
    broadcastGameState();
    
    return { success: true, message: 'Card selected successfully' };
}

function unselectCard(playerId, cardNumber) {
    const player = gameState.players.find(p => p.id === playerId);
    if (!player) return { success: false, message: 'Player not found' };
    
    if (gameState.status !== 'selecting') {
        return { success: false, message: 'Card selection is not active' };
    }
    
    const index = player.cards.indexOf(cardNumber);
    if (index === -1) {
        return { success: false, message: 'Card not selected by you' };
    }
    
    player.cards.splice(index, 1);
    const selectedIndex = gameState.selectedCards.indexOf(cardNumber);
    if (selectedIndex > -1) {
        gameState.selectedCards.splice(selectedIndex, 1);
    }
    
    player.balance += gameState.stake;
    
    if (player.cards.length === 0) {
        player.isReady = false;
    }
    
    broadcastGameState();
    
    return { success: true, message: 'Card unselected' };
}

// ============================================================
//  GAME ENGINE
// ============================================================

function startGame() {
    const readyPlayers = gameState.players.filter(p => p.cards && p.cards.length > 0);
    
    if (readyPlayers.length < 2) {
        broadcast({
            type: 'gameError',
            data: { message: 'Need at least 2 players with cards to start' }
        });
        gameState.status = 'waiting';
        broadcastGameState();
        return;
    }
    
    gameState.status = 'playing';
    gameState.isGameActive = true;
    gameState.calledNumbers = [];
    gameState.totalCardsInPlay = readyPlayers.reduce((sum, p) => sum + p.cards.length, 0);
    
    gameState.gameCards = [];
    readyPlayers.forEach(player => {
        player.cards.forEach(cardNum => {
            gameState.gameCards.push({
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
    
    gameState.gameCards.forEach(c => c.marked[2][2] = true);
    
    broadcast({
        type: 'gameStart',
        data: {
            gameNumber: gameState.gameNumber,
            stake: gameState.stake,
            totalCards: gameState.totalCardsInPlay,
            cards: gameState.gameCards,
            players: readyPlayers.map(p => ({ id: p.id, name: p.name, cards: p.cards }))
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
        if (!gameState.isGameActive) {
            clearInterval(interval);
            return;
        }
        
        if (callIndex >= allNumbers.length) {
            clearInterval(interval);
            endGame('No winner - all numbers called');
            return;
        }
        
        const number = allNumbers[callIndex];
        callIndex++;
        gameState.calledNumbers.push(number);
        
        gameState.gameCards.forEach(card => {
            for (let r = 0; r < 5; r++) {
                for (let c = 0; c < 5; c++) {
                    if (card.board[r][c] === number) {
                        card.marked[r][c] = true;
                    }
                }
            }
        });
        
        let gameWinners = [];
        gameState.gameCards.forEach(card => {
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
            const totalPrize = gameState.stake * gameState.totalCardsInPlay * 0.7;
            const prizePerWinner = Math.round(totalPrize / gameWinners.length);
            
            gameWinners.forEach(w => {
                w.prize = prizePerWinner;
                const player = gameState.players.find(p => p.id === w.playerId);
                if (player) {
                    player.balance += prizePerWinner;
                }
                gameState.winners.push({
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
            
            gameState.isGameActive = false;
            gameState.status = 'ended';
            
            setTimeout(() => {
                gameState.status = 'waiting';
                gameState.players.forEach(p => {
                    p.cards = [];
                    p.isReady = false;
                });
                broadcastGameState();
            }, 10000);
            
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

function endGame(message) {
    gameState.isGameActive = false;
    gameState.status = 'ended';
    
    broadcast({
        type: 'gameEnd',
        data: {
            winners: [],
            prizePerWinner: 0,
            calledNumbers: gameState.calledNumbers,
            message: message || 'Game ended'
        }
    });
    
    setTimeout(() => {
        gameState.status = 'waiting';
        gameState.players.forEach(p => {
            p.cards = [];
            p.isReady = false;
        });
        broadcastGameState();
    }, 5000);
}

// ============================================================
//  TELEGRAM BOT API ENDPOINTS
// ============================================================

app.get('/api/balance/:telegramId', (req, res) => {
    const player = gameState.players.find(p => p.telegramId == req.params.telegramId);
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

app.get('/api/players', (req, res) => {
    res.json(gameState.players.map(p => ({ 
        name: p.name, 
        balance: p.balance,
        cards: p.cards ? p.cards.length : 0,
        telegramId: p.telegramId,
        isReady: p.isReady || false
    })));
});

app.get('/api/recent-winners', (req, res) => {
    res.json(gameState.winners.slice(-10));
});

app.get('/api/game-state', (req, res) => {
    res.json({
        status: gameState.status,
        players: gameState.players.length,
        selectionTimeLeft: gameState.selectionTimeLeft,
        selectedCards: gameState.selectedCards || [],
        calledNumbers: gameState.calledNumbers || []
    });
});

app.post('/api/add-balance', (req, res) => {
    const { telegramId, amount } = req.body;
    const player = gameState.players.find(p => p.telegramId == telegramId);
    if (player) {
        player.balance += amount;
        res.json({ success: true, newBalance: player.balance });
    } else {
        res.status(404).json({ error: 'Player not found' });
    }
});

app.post('/api/remove-balance', (req, res) => {
    const { telegramId, amount } = req.body;
    const player = gameState.players.find(p => p.telegramId == telegramId);
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

app.post('/api/force-start', (req, res) => {
    if (gameState.status === 'selecting') {
        clearInterval(gameState.selectionTimer);
        startGame();
        res.json({ success: true, message: 'Game started' });
    } else if (gameState.status === 'waiting') {
        res.status(400).json({ error: 'No game in selection phase' });
    } else {
        res.status(400).json({ error: 'Game already in progress' });
    }
});

// ============================================================
//  WEBSOCKET CONNECTION
// ============================================================

wss.on('connection', (ws) => {
    console.log('New player connected via WebSocket');
    
    const playerId = Date.now() + Math.floor(Math.random() * 1000);
    
    const player = {
        id: playerId,
        telegramId: null,
        name: `Player ${gameState.players.length + 1}`,
        balance: 500,
        cards: [],
        ws: ws,
        isWinner: false,
        gamesPlayed: 0,
        wins: 0,
        isReady: false
    };
    
    gameState.players.push(player);
    
    ws.send(JSON.stringify({
        type: 'init',
        data: {
            playerId: playerId,
            players: gameState.players.map(p => ({ 
                id: p.id, 
                name: p.name, 
                balance: p.balance, 
                cards: p.cards,
                isReady: p.isReady || false
            })),
            gameState: {
                status: gameState.status,
                gameNumber: gameState.gameNumber,
                stake: gameState.stake,
                calledNumbers: gameState.calledNumbers,
                selectionTimeLeft: gameState.selectionTimeLeft,
                selectedCards: gameState.selectedCards || [],
                isPlaying: gameState.isGameActive
            }
        }
    }));
    
    broadcastGameState();
    
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            
            switch (data.type) {
                case 'register':
                    player.name = data.data.name || `Player ${gameState.players.length}`;
                    player.telegramId = data.data.telegramId || null;
                    
                    if (player.telegramId) {
                        const existing = gameState.players.find(p => 
                            p.telegramId === player.telegramId && p.id !== player.id
                        );
                        if (existing) {
                            player.balance = existing.balance;
                            player.cards = existing.cards;
                            player.gamesPlayed = existing.gamesPlayed;
                            player.wins = existing.wins;
                            gameState.players = gameState.players.filter(p => p.id !== existing.id);
                        }
                    }
                    
                    broadcastGameState();
                    break;
                    
                case 'selectCard':
                    const result = selectCard(player.id, data.data.cardNumber);
                    ws.send(JSON.stringify({
                        type: 'cardSelectionResult',
                        data: result
                    }));
                    break;
                    
                case 'unselectCard':
                    const unselectResult = unselectCard(player.id, data.data.cardNumber);
                    ws.send(JSON.stringify({
                        type: 'cardSelectionResult',
                        data: unselectResult
                    }));
                    break;
                    
                case 'startSelection':
                    if (gameState.status === 'waiting') {
                        const stake = data.data.stake || 10;
                        startSelectionPhase(stake);
                    } else {
                        ws.send(JSON.stringify({
                            type: 'gameError',
                            data: { message: 'Game already in progress' }
                        }));
                    }
                    break;
                    
                case 'startGame':
                    if (gameState.status === 'selecting') {
                        clearInterval(gameState.selectionTimer);
                        startGame();
                    } else {
                        ws.send(JSON.stringify({
                            type: 'gameError',
                            data: { message: 'Game not in selection phase' }
                        }));
                    }
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
                    const targetPlayer = gameState.players.find(p => p.id === data.data.playerId);
                    if (targetPlayer) {
                        if (data.data.action === 'deposit') {
                            targetPlayer.balance += data.data.amount;
                        } else if (data.data.action === 'withdraw') {
                            targetPlayer.balance -= data.data.amount;
                        }
                        broadcastGameState();
                    }
                    break;
                    
                case 'getAdminData':
                    ws.send(JSON.stringify({
                        type: 'adminData',
                        data: {
                            players: gameState.players.map(p => ({ 
                                id: p.id, 
                                name: p.name, 
                                balance: p.balance, 
                                cards: p.cards,
                                telegramId: p.telegramId,
                                isReady: p.isReady || false
                            }))
                        }
                    }));
                    break;
                    
                case 'getGameState':
                    ws.send(JSON.stringify({
                        type: 'gameStateUpdate',
                        data: {
                            status: gameState.status,
                            players: gameState.players.map(p => ({ 
                                id: p.id, 
                                name: p.name, 
                                cards: p.cards || [],
                                isReady: p.isReady || false,
                                balance: p.balance
                            })),
                            selectionTimeLeft: gameState.selectionTimeLeft,
                            selectedCards: gameState.selectedCards || [],
                            stake: gameState.stake,
                            gameNumber: gameState.gameNumber,
                            calledNumbers: gameState.calledNumbers,
                            totalCardsInPlay: gameState.totalCardsInPlay
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
        gameState.players = gameState.players.filter(p => p.id !== player.id);
        broadcastGameState();
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 BINGO Server running on port ${PORT}`);
    console.log('📊 Game state initialized for multiplayer');
});