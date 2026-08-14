# 🎯 ማታኒ ቢንጎ · M-BINGO Multiplayer

[![Live Demo](https://img.shields.io/badge/Live%20Demo-GitHub%20Pages-blue)](https://myf-delivery.github.io/M-Bingo/)
[![Backend Status](https://img.shields.io/badge/Backend-Render-green)](https://m-bingo-server.onrender.com)
[![Telegram Bot](https://img.shields.io/badge/Telegram-Bot-26A5E4)](https://t.me/M_bingo_bot)

**ማታኒ ቢንጎ (M-BINGO)** is a fully featured, real-time multiplayer BINGO game optimized for mobile. Players can register, select cards, place bets, and compete in real-time via WebSockets. The project integrates a Telegram Bot, a secure PostgreSQL database, and a complete wallet system.

---

## 🚀 Live Links

| Component | Link |
| :--- | :--- |
| **🕹️ Web App (Frontend)** | [https://myf-delivery.github.io/M-Bingo/](https://myf-delivery.github.io/M-Bingo/) |
| **⚙️ Backend API** | [https://m-bingo-server.onrender.com](https://m-bingo-server.onrender.com) |
| **🤖 Telegram Bot** | [@M_bingo_bot](https://t.me/M_bingo_bot) |

---

## ✨ Core Features

*   **🎮 Real-Time Multiplayer:** Play with multiple players simultaneously using WebSockets.
*   **🎴 Pre-loaded Bingo Cards:** 200 pre-validated and shuffled BINGO cards stored in the database.
*   **💰 Wallet & Bonus System:** Users receive a 500 Birr sign-up bonus and can deposit/withdraw funds.
*   **👑 Secure Admin Panel:** Database-driven admin roles with wealth management tools.
*   **🤖 Full Telegram Integration:** Interactive menu, balance checks, and referral system via the bot.
*   **📱 Mobile-First UI:** Responsive Amharic interface tailored for mobile devices.
*   **🔐 Server-Side Validation:** Atomic card locking and server-side BINGO win validation.

---

## 📁 Project Structure

```text
M-Bingo/
├── backend/
│   ├── src/
│   │   ├── database/          # PostgreSQL schema (200 cards, users, wallet)
│   │   ├── app.js             # Main Express + WebSocket server
│   │   └── index.js           # Server entry point
│   ├── .env                   # Environment variables (DB, Tokens)
│   └── package.json           # Backend dependencies
├── bot/
│   └── bot.js                 # Telegram Bot logic (Node.js + telegraf)
├── database/
│   └── schema.sql             # Complete DB schema (Tables + 200 Bingo Cards)
├── README.md                  # Project documentation
└── index.html                 # Frontend Web App (Mobile UI)