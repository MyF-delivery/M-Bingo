# 🎯 ማታኒ ቢንጎ · M-BINGO Multiplayer V3

[![Live Demo](https://img.shields.io/badge/Live%20Demo-GitHub%20Pages-blue)](https://myf-delivery.github.io/M-Bingo/)
[![Backend Status](https://img.shields.io/badge/Backend-Render-green)](https://m-bingo-server.onrender.com)
[![Telegram Bot](https://img.shields.io/badge/Telegram-Bot-26A5E4)](https://t.me/M_bingo_bot)

**ማታኒ ቢንጎ (M-BINGO)** is a fully featured, real-time multiplayer BINGO game optimized for mobile. Players can register, select cards, place bets, and compete in real-time via WebSockets.

## 🚀 Live Links
| Component | Link |
| :--- | :--- |
| **🕹️ Web App** | [https://myf-delivery.github.io/M-Bingo/](https://myf-delivery.github.io/M-Bingo/) |
| **⚙️ Backend API** | [https://m-bingo-server.onrender.com](https://m-bingo-server.onrender.com) |
| **🤖 Telegram Bot** | [@M_bingo_bot](https://t.me/M_bingo_bot) |

## 🔧 V3 Deployment Guide

### Database
Use the `schema(2).sql` as the database schema. It contains:
- `users` with `balance` and `locked_balance`
- `wallet_transactions` (Immutable ledger)
- `bingo_cards`, `rooms`, `room_players`, `game_history`, `game_winners`
- 200 Pre-validated Bingo cards

### Backend Deployment
1. Replace the deployed backend `app.js` with `app_fixed_v3.js`.
2. Install dependencies (`npm install`).
3. Configure all `.env` values.
4. Set a **NEW Telegram BOT_TOKEN** (Revoke old one via @BotFather if exposed).
5. Set `ALLOW_BROWSER_TESTING=false` for production.
6. Set `CORS_ORIGIN=https://myf-delivery.github.io`.
7. Deploy/Restart the Render service. Check `/health`.

### Frontend Deployment
Replace the GitHub Pages `index.html` with `index_fixed_v3.html`.

### Bot Deployment
Use `bot_fixed_v3.js` and set `BOT_TOKEN` only in the environment.
