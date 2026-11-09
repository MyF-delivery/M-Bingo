// ============================================================
// M-BINGO Telegram User Inviter (GramJS)
// Requires TELEGRAM_API_ID, TELEGRAM_API_HASH and TELEGRAM_SESSION.
// TELEGRAM_SESSION must belong to an authorized personal Telegram account.
// ============================================================

const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');

const API_ID = Number(process.env.TELEGRAM_API_ID || 0);
const API_HASH = String(process.env.TELEGRAM_API_HASH || '').trim();
const SESSION = String(process.env.TELEGRAM_SESSION || '').trim();

let client = null;
let ready = false;
let lastError = 'Not initialized';

function log(...args) { console.log('[INVITER]', ...args); }
function logError(...args) { console.error('[INVITER][ERROR]', ...args); }

async function init() {
    if (ready && client) return true;

    if (!Number.isInteger(API_ID) || API_ID <= 0 || !API_HASH || !SESSION) {
        ready = false;
        lastError = 'Missing or invalid TELEGRAM_API_ID, TELEGRAM_API_HASH, or TELEGRAM_SESSION';
        logError(lastError);
        return false;
    }

    try {
        client = new TelegramClient(new StringSession(SESSION), API_ID, API_HASH, {
            connectionRetries: 5,
            useWSS: true,
        });

        await client.connect();

        // connect() alone does not prove that the session is logged in.
        const me = await client.getMe();
        if (!me || me.deleted) {
            throw new Error('Telegram session is not authorized. Create and set a valid user session.');
        }

        ready = true;
        lastError = '';
        log(`User client authenticated as ${me.username ? '@' + me.username : (me.firstName || 'Telegram user')}`);
        return true;
    } catch (error) {
        ready = false;
        lastError = error?.message || String(error);
        logError('Initialization/authentication failed:', lastError);
        try { if (client) await client.disconnect(); } catch (_) {}
        client = null;
        return false;
    }
}

function isReady() {
    return Boolean(ready && client);
}

function getStatus() {
    return { ready: isReady(), reason: lastError };
}

async function inviteToGroup(groupId, userId) {
    if (!isReady()) return false;
    try {
        await client.invoke(new Api.channels.InviteToChannel({
            channel: groupId,
            users: [userId],
        }));
        return true;
    } catch (error) {
        logError(`Group invite failed for ${userId}:`, error?.message || error);
        return false;
    }
}

async function sendDM(userId, message) {
    if (!isReady()) return false;
    try {
        await client.sendMessage(userId, { message });
        return true;
    } catch (error) {
        logError(`DM failed for ${userId}:`, error?.message || error);
        return false;
    }
}

async function sendManyDMs(ids, message, delayMs = 2500) {
    let sent = 0;
    let failed = 0;
    for (const id of ids) {
        const ok = await sendDM(id, message);
        if (ok) sent++;
        else failed++;
        await new Promise(resolve => setTimeout(resolve, Math.max(1000, delayMs)));
    }
    return { sent, failed };
}

async function getContacts() {
    if (!isReady()) {
        lastError = lastError || 'Telegram user client is not authenticated/online';
        logError('Cannot fetch contacts:', lastError);
        return [];
    }

    try {
        const contacts = await client.getContacts();
        const validUsers = (contacts || []).filter(user =>
            user &&
            user.className === 'User' &&
            !user.bot &&
            !user.deleted &&
            user.firstName
        );
        lastError = '';
        log(`Telegram returned ${contacts.length} contacts; ${validUsers.length} are valid human users.`);
        return validUsers;
    } catch (error) {
        lastError = error?.message || String(error);
        logError('Contact fetch failed:', lastError);
        return [];
    }
}

module.exports = {
    init,
    isReady,
    getStatus,
    inviteToGroup,
    sendDM,
    sendManyDMs,
    getContacts,
};
