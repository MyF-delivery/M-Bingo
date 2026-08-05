const { query, getCache, setCache, deleteCache } = require('../database');
const { v4: uuidv4 } = require('uuid');
const CardManager = require('./card-manager');
const WalletService = require('../services/wallet');
const NotificationService = require('../services/notification');

class RoomManager {
    constructor() {
        this.rooms = new Map(); // roomId -> room object
        this.roomTimers = new Map(); // roomId -> timer
    }

    /**
     * Create a new game room
     */
    async createRoom(settings) {
        const roomId = uuidv4();
        
        const result = await query(
            `INSERT INTO rooms (
                id, stake, max_players, min_players, status,
                countdown_seconds, calling_interval_ms, house_commission,
                winning_pattern
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            RETURNING *`,
            [
                roomId,
                settings.stake || 10,
                settings.maxPlayers || 100,
                settings.minPlayers || 2,
                'WAITING',
                settings.countdownSeconds || 30,
                settings.callingIntervalMs || 5000,
                settings.houseCommission || 30,
                settings.winningPattern || 'ANY'
            ]
        );
        
        const room = result.rows[0];
        
        // Store in memory
        this.rooms.set(roomId, {
            ...room,
            players: new Map(),
            selectedCards: [],
            calledNumbers: [],
            gameCards: [],
            isGameActive: false,
            gameState: 'WAITING',
            winner: null,
        });
        
        return room;
    }

    /**
     * Get room by ID
     */
    getRoom(roomId) {
        return this.rooms.get(roomId);
    }

    /**
     * Get room with players
     */
    async getRoomWithPlayers(roomId) {
        const room = this.getRoom(roomId);
        if (!room) return null;

        const players = Array.from(room.players.values()).map(p => ({
            id: p.id,
            name: p.name,
            cards: p.cards || [],
            isReady: p.isReady || false,
            joinedAt: p.joinedAt,
            isWinner: p.isWinner || false,
        }));

        return {
            ...room,
            players,
            playerCount: players.length,
            selectedCards: room.selectedCards || [],
            calledNumbers: room.calledNumbers || [],
        };
    }

    /**
     * Get all active rooms
     */
    async getActiveRooms() {
        const rooms = [];
        for (const [id, room] of this.rooms) {
            if (room.status !== 'ENDED') {
                rooms.push({
                    id: room.id,
                    stake: room.stake,
                    status: room.status,
                    playerCount: room.players.size,
                    gameNumber: room.game_number || 0,
                    prizePool: room.prize_pool || 0,
                });
            }
        }
        return rooms;
    }

    /**
     * Add player to room
     */
    async joinRoom(roomId, userId, userName) {
        const room = this.getRoom(roomId);
        if (!room) {
            throw new Error('Room not found');
        }

        if (room.status !== 'WAITING' && room.status !== 'SELECTING') {
            throw new Error('Room is not accepting players');
        }

        if (room.players.size >= room.max_players) {
            throw new Error('Room is full');
        }

        // Check if player is already in the room
        if (room.players.has(userId)) {
            return this.getRoomWithPlayers(roomId);
        }

        // Check user balance
        const balance = await WalletService.getBalance(userId);
        if (balance < room.stake) {
            throw new Error(`Insufficient balance. Need ${room.stake} Birr`);
        }

        // Deduct stake
        await WalletService.debit(
            userId,
            room.stake,
            'STAKE',
            null,
            `Joined ${room.stake} Birr room`,
            { roomId }
        );

        // Add player to room
        room.players.set(userId, {
            id: userId,
            name: userName || 'Player',
            cards: [],
            isReady: false,
            joinedAt: new Date(),
            isWinner: false,
        });

        // Save to database
        await query(
            `INSERT INTO room_players (room_id, user_id, cards, is_ready)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (room_id, user_id) DO UPDATE 
            SET left_at = NULL, is_ready = false`,
            [roomId, userId, '[]', false]
        );

        // Check if we should start countdown
        if (room.players.size >= room.min_players && room.status === 'WAITING') {
            this.startCountdown(roomId);
        }

        return this.getRoomWithPlayers(roomId);
    }

    /**
     * Remove player from room
     */
    async leaveRoom(roomId, userId) {
        const room = this.getRoom(roomId);
        if (!room) {
            throw new Error('Room not found');
        }

        if (!room.players.has(userId)) {
            return;
        }

        // Refund stake if game hasn't started
        if (room.status === 'WAITING' || room.status === 'SELECTING') {
            await WalletService.credit(
                userId,
                room.stake,
                'REFUND',
                null,
                `Refund for leaving ${room.stake} Birr room`,
                { roomId }
            );
        }

        room.players.delete(userId);

        // Update database
        await query(
            `UPDATE room_players SET left_at = CURRENT_TIMESTAMP 
            WHERE room_id = $1 AND user_id = $2`,
            [roomId, userId]
        );

        // Clear their selected cards
        room.selectedCards = room.selectedCards.filter(
            card => !room.players.has(card.playerId)
        );

        // If room is empty, end it
        if (room.players.size === 0) {
            this.endRoom(roomId);
        }

        return this.getRoomWithPlayers(roomId);
    }

    /**
     * Start countdown for a room
     */
    startCountdown(roomId) {
        const room = this.getRoom(roomId);
        if (!room) return;

        if (room.status !== 'WAITING') return;

        room.status = 'SELECTING';
        room.countdown_seconds = 30;

        this.updateRoomStatus(roomId, 'SELECTING');

        // Clear any existing timer
        if (this.roomTimers.has(roomId)) {
            clearInterval(this.roomTimers.get(roomId));
        }

        const timer = setInterval(async () => {
            room.countdown_seconds--;
            
            // Broadcast countdown
            this.broadcastToRoom(roomId, {
                type: 'countdown',
                data: {
                    timeLeft: room.countdown_seconds,
                    status: room.status,
                }
            });

            if (room.countdown_seconds <= 0) {
                clearInterval(timer);
                this.roomTimers.delete(roomId);
                await this.startGame(roomId);
            }
        }, 1000);

        this.roomTimers.set(roomId, timer);
    }

    /**
     * Start the game
     */
    async startGame(roomId) {
        const room = this.getRoom(roomId);
        if (!room) return;

        // Check if enough players are ready
        const readyPlayers = Array.from(room.players.values())
            .filter(p => p.isReady && p.cards.length > 0);

        if (readyPlayers.length < room.min_players) {
            room.status = 'WAITING';
            this.updateRoomStatus(roomId, 'WAITING');
            this.broadcastToRoom(roomId, {
                type: 'gameError',
                data: { message: `Need at least ${room.min_players} players with cards` }
            });
            return;
        }

        room.status = 'PLAYING';
        room.isGameActive = true;
        room.game_number = (room.game_number || 0) + 1;
        room.calledNumbers = [];
        room.gameCards = [];

        // Generate game cards from player selections
        for (const [userId, player] of room.players) {
            if (player.isReady && player.cards.length > 0) {
                for (const cardNum of player.cards) {
                    const card = await CardManager.getCard(cardNum);
                    if (card) {
                        room.gameCards.push({
                            playerId: userId,
                            playerName: player.name,
                            cardNumber: cardNum,
                            board: CardManager.getBoardGrid(card),
                            marked: Array(5).fill(null).map(() => Array(5).fill(false)),
                            bingo: false,
                            winningPatterns: [],
                        });
                    }
                }
            }
        }

        // Mark FREE space
        room.gameCards.forEach(c => c.marked[2][2] = true);

        // Calculate prize pool
        const totalStake = room.players.size * room.stake;
        room.prize_pool = totalStake * (1 - room.house_commission / 100);

        // Update room in database
        await query(
            `UPDATE rooms SET 
                status = 'PLAYING',
                game_number = $1,
                prize_pool = $2,
                started_at = CURRENT_TIMESTAMP,
                called_numbers = '[]'
            WHERE id = $3`,
            [room.game_number, room.prize_pool, roomId]
        );

        // Broadcast game start
        this.broadcastToRoom(roomId, {
            type: 'gameStart',
            data: {
                gameNumber: room.game_number,
                stake: room.stake,
                totalPlayers: room.players.size,
                prizePool: room.prize_pool,
                cards: room.gameCards.map(c => ({
                    playerId: c.playerId,
                    cardNumber: c.cardNumber,
                    board: c.board,
                })),
            }
        });

        // Start number calling
        this.startNumberCalling(roomId);

        // Notify via Telegram
        await NotificationService.notifyRoomStart(roomId, room);
    }

    /**
     * Start number calling for a room
     */
    startNumberCalling(roomId) {
        const room = this.getRoom(roomId);
        if (!room) return;

        // Generate random numbers 1-75
        const numbers = [];
        for (let i = 1; i <= 75; i++) numbers.push(i);
        for (let i = numbers.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [numbers[i], numbers[j]] = [numbers[j], numbers[i]];
        }

        let callIndex = 0;

        const callTimer = setInterval(async () => {
            if (!room.isGameActive) {
                clearInterval(callTimer);
                return;
            }

            if (callIndex >= numbers.length) {
                clearInterval(callTimer);
                await this.endGame(roomId, 'No winner - all numbers called');
                return;
            }

            const number = numbers[callIndex];
            callIndex++;
            room.calledNumbers.push(number);

            // Mark cards
            room.gameCards.forEach(card => {
                for (let r = 0; r < 5; r++) {
                    for (let c = 0; c < 5; c++) {
                        if (card.board[r][c] === number) {
                            card.marked[r][c] = true;
                        }
                    }
                }
            });

            // Check for winners
            const winners = this.checkWinners(room);
            
            if (winners.length > 0) {
                clearInterval(callTimer);
                await this.handleWinners(roomId, winners);
                return;
            }

            // Broadcast the number
            this.broadcastToRoom(roomId, {
                type: 'numberCalled',
                data: {
                    number: number,
                    calledCount: callIndex,
                    totalNumbers: 75,
                    calledNumbers: room.calledNumbers.slice(-10), // Last 10 for UI
                }
            });

            // Save to database every 10 numbers
            if (callIndex % 10 === 0) {
                await query(
                    'UPDATE rooms SET called_numbers = $1 WHERE id = $2',
                    [JSON.stringify(room.calledNumbers), roomId]
                );
            }

        }, room.calling_interval_ms);

        this.roomTimers.set(`call_${roomId}`, callTimer);
    }

    /**
     * Check for winners in a room
     */
    checkWinners(room) {
        const winners = [];
        const patterns = [];

        for (const card of room.gameCards) {
            if (card.bingo) continue;

            const cardPatterns = this.checkCardPatterns(card.marked, room.winning_pattern);
            
            if (cardPatterns.length > 0) {
                card.bingo = true;
                card.winningPatterns = cardPatterns;
                winners.push({
                    playerId: card.playerId,
                    playerName: card.playerName,
                    cardNumber: card.cardNumber,
                    patterns: cardPatterns,
                    board: card.board,
                    marked: card.marked,
                });
            }
        }

        return winners;
    }

    /**
     * Check card for winning patterns
     */
    checkCardPatterns(marked, patternType) {
        const patterns = [];
        const size = 5;

        // Check rows
        for (let r = 0; r < size; r++) {
            let win = true;
            for (let c = 0; c < size; c++) {
                if (!marked[r][c]) { win = false; break; }
            }
            if (win) patterns.push({ type: 'row', index: r, label: `ረድፍ ${r+1}` });
        }

        // Check columns
        for (let c = 0; c < size; c++) {
            let win = true;
            for (let r = 0; r < size; r++) {
                if (!marked[r][c]) { win = false; break; }
            }
            if (win) patterns.push({ type: 'column', index: c, label: `ዓምድ ${c+1}` });
        }

        // Check diagonal (top-left to bottom-right)
        let win = true;
        for (let i = 0; i < size; i++) {
            if (!marked[i][i]) { win = false; break; }
        }
        if (win) patterns.push({ type: 'diagonal', index: 0, label: 'ሰያፍ 1' });

        // Check diagonal (top-right to bottom-left)
        win = true;
        for (let i = 0; i < size; i++) {
            if (!marked[i][size - 1 - i]) { win = false; break; }
        }
        if (win) patterns.push({ type: 'diagonal', index: 1, label: 'ሰያፍ 2' });

        // Check corners
        if (patternType === 'CORNERS' || patternType === 'ANY') {
            const corners = [
                [0, 0], [0, 4], [4, 0], [4, 4]
            ];
            let cornerWin = true;
            for (const [r, c] of corners) {
                if (!marked[r][c]) { cornerWin = false; break; }
            }
            if (cornerWin) patterns.push({ type: 'corner', label: 'ማእዘኖች' });
        }

        // Check full house
        if (patternType === 'FULL_HOUSE' || patternType === 'ANY') {
            let fullWin = true;
            for (let r = 0; r < size; r++) {
                for (let c = 0; c < size; c++) {
                    if (!marked[r][c]) { fullWin = false; break; }
                }
                if (!fullWin) break;
            }
            if (fullWin) patterns.push({ type: 'fullHouse', label: 'ሙሉ ቤት' });
        }

        return patterns;
    }

    /**
     * Handle winners
     */
    async handleWinners(roomId, winners) {
        const room = this.getRoom(roomId);
        if (!room) return;

        const prizePerWinner = Math.round(room.prize_pool / winners.length);

        // Credit winners
        for (const winner of winners) {
            const player = room.players.get(winner.playerId);
            if (player) {
                player.isWinner = true;
                player.winningAmount = prizePerWinner;

                await WalletService.credit(
                    winner.playerId,
                    prizePerWinner,
                    'WIN',
                    null,
                    `BINGO win in ${room.stake} Birr room`,
                    { roomId, cardNumber: winner.cardNumber, patterns: winner.patterns }
                );

                // Update user stats
                await query(
                    `UPDATE users SET 
                        total_wins = total_wins + 1,
                        total_winnings = total_winnings + $1
                    WHERE id = $2`,
                    [prizePerWinner, winner.playerId]
                );
            }
        }

        // Save to game history
        const winner = winners[0];
        await query(
            `INSERT INTO game_history (
                room_id, game_number, stake, total_players, total_cards,
                prize_pool, winner_id, winner_name, winner_card,
                winning_amount, winning_pattern, called_numbers,
                started_at, ended_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, CURRENT_TIMESTAMP)`,
            [
                roomId,
                room.game_number,
                room.stake,
                room.players.size,
                room.gameCards.length,
                room.prize_pool,
                winner.playerId,
                winner.playerName,
                winner.cardNumber,
                prizePerWinner,
                winner.patterns.map(p => p.label).join(', '),
                JSON.stringify(room.calledNumbers),
                room.started_at || new Date()
            ]
        );

        // Broadcast winners
        this.broadcastToRoom(roomId, {
            type: 'gameEnd',
            data: {
                winners: winners.map(w => ({
                    playerId: w.playerId,
                    playerName: w.playerName,
                    cardNumber: w.cardNumber,
                    patterns: w.patterns,
                    prize: prizePerWinner,
                })),
                prizePerWinner: prizePerWinner,
                totalPrize: room.prize_pool,
            }
        });

        // End the room
        this.endRoom(roomId);

        // Notify winners via Telegram
        for (const winner of winners) {
            await NotificationService.notifyWin(
                winner.playerId,
                prizePerWinner,
                room.stake,
                room.game_number
            );
        }
    }

    /**
     * End a room
     */
    endRoom(roomId) {
        const room = this.getRoom(roomId);
        if (!room) return;

        room.status = 'ENDED';
        room.isGameActive = false;

        // Clear all timers
        if (this.roomTimers.has(roomId)) {
            clearInterval(this.roomTimers.get(roomId));
            this.roomTimers.delete(roomId);
        }
        if (this.roomTimers.has(`call_${roomId}`)) {
            clearInterval(this.roomTimers.get(`call_${roomId}`));
            this.roomTimers.delete(`call_${roomId}`);
        }

        // Update database
        query(
            'UPDATE rooms SET status = $1, ended_at = CURRENT_TIMESTAMP WHERE id = $2',
            ['ENDED', roomId]
        );

        // Schedule room cleanup after 1 hour
        setTimeout(() => {
            if (this.rooms.has(roomId)) {
                // Remove all players from memory
                const room = this.rooms.get(roomId);
                room.players.clear();
                this.rooms.delete(roomId);
            }
        }, 3600000);
    }

    /**
     * Broadcast to all players in a room
     */
    broadcastToRoom(roomId, message) {
        // This will be implemented with WebSocket connections
        const room = this.getRoom(roomId);
        if (!room) return;

        // The WebSocket server will handle this
        // Store for later pickup
        room.lastBroadcast = message;
    }

    /**
     * Update room status in database
     */
    async updateRoomStatus(roomId, status) {
        await query(
            'UPDATE rooms SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
            [status, roomId]
        );
    }

    /**
     * Get room by ID with full state
     */
    async getRoomState(roomId) {
        const room = this.getRoom(roomId);
        if (!room) return null;

        const result = await query(
            `SELECT r.*, 
                COUNT(rp.id) as player_count,
                COALESCE(SUM(CASE WHEN rp.is_ready THEN 1 ELSE 0 END), 0) as ready_count
            FROM rooms r
            LEFT JOIN room_players rp ON r.id = rp.room_id AND rp.left_at IS NULL
            WHERE r.id = $1
            GROUP BY r.id`,
            [roomId]
        );

        return result.rows[0] || null;
    }
}

module.exports = new RoomManager();
