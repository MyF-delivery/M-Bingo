const { query, setCache, deleteCache } = require('../database');
const { v4: uuidv4 } = require('uuid');

class WalletService {
    /**
     * Get user's wallet balance
     */
    async getBalance(userId) {
        const result = await query(
            'SELECT balance FROM users WHERE id = $1',
            [userId]
        );
        
        if (result.rows.length === 0) {
            throw new Error('User not found');
        }
        
        return parseFloat(result.rows[0].balance);
    }

    /**
     * Credit a user's wallet with transaction record
     */
    async credit(userId, amount, type, reference, description, metadata = {}) {
        if (amount <= 0) {
            throw new Error('Amount must be greater than 0');
        }

        const client = await pool.connect();
        
        try {
            await client.query('BEGIN');

            // Get current balance
            const balanceResult = await client.query(
                'SELECT balance FROM users WHERE id = $1 FOR UPDATE',
                [userId]
            );
            
            if (balanceResult.rows.length === 0) {
                throw new Error('User not found');
            }
            
            const currentBalance = parseFloat(balanceResult.rows[0].balance);
            const newBalance = currentBalance + amount;

            // Update balance
            await client.query(
                'UPDATE users SET balance = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
                [newBalance, userId]
            );

            // Create transaction record
            const txnRef = reference || uuidv4();
            const transactionResult = await client.query(
                `INSERT INTO transactions 
                (id, user_id, type, amount, balance_before, balance_after, reference, description, metadata)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                RETURNING *`,
                [uuidv4(), userId, type, amount, currentBalance, newBalance, txnRef, description, metadata]
            );

            await client.query('COMMIT');

            // Clear cache
            await deleteCache(`wallet:${userId}`);
            await deleteCache(`transactions:${userId}:*`);

            return {
                transaction: transactionResult.rows[0],
                newBalance,
            };
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    }

    /**
     * Debit a user's wallet with transaction record
     */
    async debit(userId, amount, type, reference, description, metadata = {}) {
        if (amount <= 0) {
            throw new Error('Amount must be greater than 0');
        }

        const client = await pool.connect();
        
        try {
            await client.query('BEGIN');

            // Get current balance
            const balanceResult = await client.query(
                'SELECT balance FROM users WHERE id = $1 FOR UPDATE',
                [userId]
            );
            
            if (balanceResult.rows.length === 0) {
                throw new Error('User not found');
            }
            
            const currentBalance = parseFloat(balanceResult.rows[0].balance);
            
            if (currentBalance < amount) {
                throw new Error('Insufficient balance');
            }
            
            const newBalance = currentBalance - amount;

            // Update balance
            await client.query(
                'UPDATE users SET balance = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
                [newBalance, userId]
            );

            // Create transaction record
            const txnRef = reference || uuidv4();
            const transactionResult = await client.query(
                `INSERT INTO transactions 
                (id, user_id, type, amount, balance_before, balance_after, reference, description, metadata)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                RETURNING *`,
                [uuidv4(), userId, type, -amount, currentBalance, newBalance, txnRef, description, metadata]
            );

            await client.query('COMMIT');

            // Clear cache
            await deleteCache(`wallet:${userId}`);
            await deleteCache(`transactions:${userId}:*`);

            return {
                transaction: transactionResult.rows[0],
                newBalance,
            };
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    }

    /**
     * Get transaction history for a user
     */
    async getTransactions(userId, limit = 50, offset = 0) {
        const result = await query(
            `SELECT * FROM transactions 
            WHERE user_id = $1 
            ORDER BY created_at DESC 
            LIMIT $2 OFFSET $3`,
            [userId, limit, offset]
        );
        
        return result.rows;
    }

    /**
     * Get user's full wallet info with stats
     */
    async getWalletInfo(userId) {
        const cached = await getCache(`wallet:${userId}`);
        if (cached) return cached;

        const result = await query(
            `SELECT 
                u.balance,
                u.total_games_played,
                u.total_wins,
                u.total_winnings,
                COUNT(DISTINCT t.id) as transaction_count,
                COALESCE(SUM(CASE WHEN t.type IN ('DEPOSIT', 'BONUS', 'WIN') THEN t.amount ELSE 0 END), 0) as total_credits,
                COALESCE(SUM(CASE WHEN t.type IN ('WITHDRAWAL', 'STAKE') THEN t.amount ELSE 0 END), 0) as total_debits
            FROM users u
            LEFT JOIN transactions t ON u.id = t.user_id
            WHERE u.id = $1
            GROUP BY u.id`,
            [userId]
        );
        
        if (result.rows.length === 0) {
            throw new Error('User not found');
        }
        
        const data = result.rows[0];
        await setCache(`wallet:${userId}`, data, 60); // Cache for 1 minute
        
        return data;
    }
}

module.exports = new WalletService();
