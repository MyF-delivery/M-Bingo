// ============================================================
// telegram-user-inviter.js
// ============================================================

const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { Api } = require('telegram');

const API_ID = Number(process.env.TELEGRAM_API_ID || 0);
const API_HASH = process.env.TELEGRAM_API_HASH || '';
const SESSION = process.env.TELEGRAM_SESSION || '';

let client = null;
let ready = false;

function log(...a) { console.log('[INVITER]', ...a); }
function logError(...a) { console.error('[INVITER][ERROR]', ...a); }

async function init() {
    if (!API_ID || !API_HASH || !SESSION) {
        logError('Missing TELEGRAM_API_ID / TELEGRAM_API_HASH / TELEGRAM_SESSION — inviter disabled');
        return;
    }
    try {
        client = new TelegramClient(new StringSession(SESSION), API_ID, API_HASH, {
            connectionRetries: 5,
            useWSS: true, // Required for Render
        });
        await client.connect();
        ready = true;
        log('✅ user client online');
    } catch (e) {
        logError('init:', e.message);
        ready = false;
    }
}

function isReady() { return ready; }

async function inviteToGroup(groupId, userId) {
    if (!ready) return false;
    try {
        await client.invoke(new Api.channels.InviteToChannel({
            channel: groupId,
            users: [userId],
        }));
        return true;
    } catch (e) {
        logError(`invite ${userId}:`, e.message);
        return false;
    }
}

async function sendDM(userId, message) {
    if (!ready) return false;
    try {
        await client.sendMessage(userId, { message });
        return true;
    } catch (e) {
        logError(`dm ${userId}:`, e.message);
        return false;
    }
}

async function sendManyDMs(ids, message, delayMs = 2500) {
    let sent = 0, failed = 0;
    for (const id of ids) {
        const ok = await sendDM(id, message);
        if (ok) sent++; else failed++;
        await new Promise(r => setTimeout(r, delayMs));
    }
    return { sent, failed };
}

// ⭐ IMPROVED FUNCTION: Fetch contacts
async function getContacts() {
    if (!ready) {
        logError('Client not ready to fetch contacts');
        return [];
    }
    try {
        // GramJS's built-in getContacts handles pagination perfectly
        const contacts = await client.getContacts();
        log(`✅ Fetched ${contacts.length} contacts from Telegram.`);
        
        // Filter to keep only real users (no bots, no deleted accounts, no groups)
        const validUsers = contacts.filter(user => 
            user.className === 'User' && 
            !user.bot && 
            !user.deleted && 
            user.firstName
        );
        
        log(`✅ Found ${validUsers.length} valid human contacts.`);
        return validUsers;
    } catch (e) {
        logError('getContacts failed:', e.message);
        return [];
    }
}

module.exports = { init, isReady, inviteToGroup, sendDM, sendManyDMs, getContacts };
