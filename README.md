# 🎯 ማታኒ ቢንጎ · M-BINGO Pro

Professional real-time multiplayer BINGO platform for mobile and Telegram Web Apps.

## Production endpoints
- Web app: https://myf-delivery.github.io/M-Bingo/
- API: https://m-bingo-server.onrender.com (GET `/` status, GET `/health` database health)
- Telegram bot: @M_bingo_bot

## Included
- `index.html` — premium mobile-first Amharic frontend
- `app.js` — Express + PostgreSQL + WebSocket game server
- `bot.js` — Telegram bot with player/admin menus
- `schema.sql` — PostgreSQL schema plus 200 Bingo cards
- `package.json` — backend + bot dependencies and scripts
- `README.md` — deployment and configuration guide

## Game rules implemented by the source
- Stakes: 10, 20, 30, 40, 50 and 100 Birr
- Maximum 5 cards per player
- Minimum 2 players by default
- Automatic number calling (10 seconds by default)
- Prize pool: 70% of total stakes
- Server-side Bingo validation
- PostgreSQL wallet ledger
- Telegram WebApp registration with server-side initData verification
- Secure server-to-server Telegram bot registration using `x-bot-token`

## Environment variables
Create `.env` on the server/bot host. Never commit secrets.

### Backend
```env
PORT=3000
DB_HOST=...
DB_PORT=5432
DB_NAME=...
DB_USER=...
DB_PASSWORD=...
BOT_TOKEN=...
CORS_ORIGIN=https://myf-delivery.github.io
TRUST_PROXY=true
ALLOW_BROWSER_TESTING=false
TELEGRAM_AUTH_MAX_AGE=86400
BINGO_CALL_INTERVAL_MS=10000
BINGO_SELECTION_SECONDS=60
BINGO_MIN_PLAYERS=2
ADMIN_USERNAME=...
ADMIN_PASSWORD_HASH=...
ADMIN_TELEGRAM_ID=...
```

Generate an admin password hash with:
```bash
node -e "console.log(require('bcryptjs').hashSync(process.argv[1], 12))" "YOUR_PASSWORD"
```

### Telegram bot
```env
BOT_TOKEN=...
API_URL=https://m-bingo-server.onrender.com
GAME_URL=https://myf-delivery.github.io/M-Bingo/
ADMIN_IDS=555508978
API_TIMEOUT_MS=8000
```

## Install and run
```bash
npm install
npm run check
npm start
```
In a second process for the Telegram bot:
```bash
npm run start:bot
```

## Database
Run `schema.sql` against PostgreSQL. It contains the 200 Bingo cards and compatibility migrations for existing installations.

## Deployment
### Render backend
- Build command: `npm install`
- Start command: `npm start`
- Add all backend environment variables in the Render dashboard.

### Telegram bot
Run the same project with `npm run start:bot` on a worker/service that supports long polling.

### GitHub Pages
Publish `index.html` as the site entry file. Keep the backend URL and WebSocket URL configured in the frontend.

## Connection architecture
- Telegram WebApp supplies `Telegram.WebApp.initData` to the frontend.
- The frontend sends that signed initData to `/api/users/register`.
- The backend verifies the signature using `BOT_TOKEN` before accepting Telegram users.
- The Telegram bot uses the same registration API with a private `x-bot-token` header; this secret is never exposed to the frontend.
- WebSocket authentication occurs only after successful registration.

## Security notes
- Telegram Web App init data is verified server-side when browser testing is disabled.
- Admin WebSocket login now requires configured username + bcrypt password hash + an admin Telegram account.
- Wallet changes are recorded in the immutable ledger.
- Withdrawal requests reserve funds to prevent double-spending through multiple pending withdrawals.
- Game cards are selected under a database transaction and server-side winning validation is used.
- Never place BOT_TOKEN, database passwords or admin password hashes in frontend files.

## Project status
This package is a consolidated professional upgrade of the six source files supplied for M-BINGO. The original 200-card dataset and existing game behavior are preserved while security, configuration, wallet reservation, UI polish and deployment documentation are strengthened.
