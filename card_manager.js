const { query, getCache, setCache } = require('../database');

class CardManager {
    /**
     * Get all Bingo cards from database
     */
    async getAllCards() {
        const cached = await getCache('bingo_cards:all');
        if (cached) return cached;

        const result = await query(
            'SELECT id, card_number, board FROM bingo_cards WHERE is_active = true ORDER BY card_number'
        );
        
        await setCache('bingo_cards:all', result.rows, 3600);
        return result.rows;
    }

    /**
     * Get a specific card by number
     */
    async getCard(cardNumber) {
        const result = await query(
            'SELECT id, card_number, board FROM bingo_cards WHERE card_number = $1 AND is_active = true',
            [cardNumber]
        );
        
        return result.rows[0] || null;
    }

    /**
     * Get card board as 2D array
     */
    getBoardGrid(card) {
        if (!card) return null;
        return typeof card.board === 'string' ? JSON.parse(card.board) : card.board;
    }

    /**
     * Check if a number exists on a card
     */
    numberExistsOnCard(cardBoard, number) {
        for (let row = 0; row < 5; row++) {
            for (let col = 0; col < 5; col++) {
                if (cardBoard[row][col] === number) {
                    return { row, col };
                }
            }
        }
        return null;
    }

    /**
     * Get all cards currently selected in a room
     */
    async getRoomCards(roomId) {
        const result = await query(
            `SELECT rp.user_id, rp.cards 
            FROM room_players rp 
            WHERE rp.room_id = $1 AND rp.is_ready = true`,
            [roomId]
        );
        
        return result.rows;
    }

    /**
     * Get a player's cards in a room
     */
    async getPlayerCards(roomId, userId) {
        const result = await query(
            'SELECT cards FROM room_players WHERE room_id = $1 AND user_id = $2',
            [roomId, userId]
        );
        
        return result.rows[0]?.cards || [];
    }

    /**
     * Check if a card is available in a room
     */
    async isCardAvailable(roomId, cardNumber) {
        const result = await query(
            `SELECT EXISTS (
                SELECT 1 FROM room_players 
                WHERE room_id = $1 AND $2 = ANY(cards)
            )`,
            [roomId, cardNumber]
        );
        
        return !result.rows[0].exists;
    }

    /**
     * Validate that a player owns a card
     */
    async validateCardOwnership(roomId, userId, cardNumber) {
        const result = await query(
            `SELECT EXISTS (
                SELECT 1 FROM room_players 
                WHERE room_id = $1 AND user_id = $2 AND $3 = ANY(cards)
            )`,
            [roomId, userId, cardNumber]
        );
        
        return result.rows[0].exists;
    }

    /**
     * Generate card display for client
     */
    formatCardForClient(card, markedNumbers = []) {
        const board = this.getBoardGrid(card);
        const marked = board.map(row => 
            row.map(num => {
                if (num === 0) return { value: 'FREE', marked: true };
                return {
                    value: num,
                    marked: markedNumbers.includes(num)
                };
            })
        );
        
        return {
            cardNumber: card.card_number,
            board: board,
            marked: marked,
            hasBingo: false,
            winningPatterns: []
        };
    }
}

module.exports = new CardManager();
