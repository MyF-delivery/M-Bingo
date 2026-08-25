// cron/scheduler.js
const cron = require('node-cron');
const { startGame } = require('../services/game');
const { insertNotification } = require('../services/notification');
const { pool } = require('../app');
const config = require('../config/env');

// Example: start a new game every 30 minutes with a fixed stake of 20 Birr
function scheduleGames() {
  cron.schedule('*/30 * * * *', async () => {
    console.log('⏰ Starting scheduled game...');
    try {
      // Create a new room with default stake (20)
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const room = await client.query(
          `INSERT INTO rooms (stake, max_players, min_players, status, state,
                             countdown_seconds, calling_interval_ms, winning_pattern,
                             prize_pool, game_number, number_sequence, called_numbers, current_call_index)
           VALUES ($1,100,$2,'WAITING','SELECTING',$3,$4,'ANY',0,0,'[]'::jsonb,'[]'::jsonb,0)
           RETURNING id`,
          [20, config.BINGO_MIN_PLAYERS, config.BINGO_SELECTION_SECONDS, config.BINGO_CALL_INTERVAL_MS]
        );
        const roomId = room.rows[0].id;
        await client.query('COMMIT');

        // Notify all online users about the new room
        const users = await pool.query(`SELECT id FROM users WHERE status='ONLINE'`);
        for (const u of users.rows) {
          await insertNotification(
            u.id,
            'game_scheduled',
            `🎮 A new Bingo game with 20 Birr stake has been scheduled! Use /play to join.`,
            { roomId }
          );
        }
        console.log(`✅ Scheduled room created: ${roomId}`);
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('Scheduled game error:', e);
      } finally {
        client.release();
      }
    } catch (e) {
      console.error('Scheduler error:', e);
    }
  });
}

module.exports = { scheduleGames };