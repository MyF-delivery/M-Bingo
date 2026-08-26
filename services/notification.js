// services/notification.js
const pool = require('../db');  // <-- this line replaces any local pool creation
const config = require('../config/env');

async function sendAdminNotification(text) {
  const adminId = config.ADMIN_TELEGRAM_ID;
  const botToken = config.BOT_TOKEN;
  if (!adminId || !botToken) return;
  try {
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: adminId, text })
    });
  } catch (e) {
    console.error('Failed to send Admin Notification:', e);
  }
}

async function insertNotification(userId, type, message, data = null) {
  await pool.query(
    `INSERT INTO notifications (user_id, type, message, data)
     VALUES ($1, $2, $3, $4)`,
    [userId, type, message, data ? JSON.stringify(data) : null]
  );
}

async function getUnreadNotifications(limit = 50) {
  const result = await pool.query(
    `SELECT * FROM notifications WHERE read = FALSE ORDER BY created_at ASC LIMIT $1`,
    [limit]
  );
  return result.rows;
}

async function markNotificationRead(id) {
  await pool.query(`UPDATE notifications SET read = TRUE WHERE id = $1`, [id]);
}

// This poller is meant to be run inside the bot process
function startNotificationPoller(bot) {
  setInterval(async () => {
    try {
      const notifs = await getUnreadNotifications(50);
      for (const n of notifs) {
        try {
          await bot.sendMessage(n.user_id, n.message, { parse_mode: 'Markdown' });
          await markNotificationRead(n.id);
        } catch (e) {
          console.error(`Failed to send notification to ${n.user_id}:`, e.message);
        }
      }
    } catch (e) {
      console.error('Notification Poller Error:', e.message);
    }
  }, 5000); // every 5 seconds
}

module.exports = {
  sendAdminNotification,
  insertNotification,
  getUnreadNotifications,
  markNotificationRead,
  startNotificationPoller,
};
