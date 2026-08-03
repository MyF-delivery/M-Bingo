require('dotenv').config();

module.exports = {
    env: process.env.NODE_ENV || 'development',
    port: parseInt(process.env.PORT) || 3000,
    frontendUrl: process.env.FRONTEND_URL || 'https://myf-delivery.github.io/M-Bingo/',
    
    bot: {
        token: process.env.BOT_TOKEN || '8312462723:AAHVyOGm7vDKJD7M_8ZceQzgvwLkMGc6dEU',
        adminIds: (process.env.ADMIN_IDS || '555508978').split(',').map(id => parseInt(id.trim()))
    },
    
    security: {
        jwtSecret: process.env.JWT_SECRET || 'your_jwt_secret_here',
        rateLimitWindow: parseInt(process.env.RATE_LIMIT_WINDOW) || 15,
        rateLimitMax: parseInt(process.env.RATE_LIMIT_MAX) || 100
    },
    
    db: {
        host: process.env.DB_HOST || 'localhost',
        port: parseInt(process.env.DB_PORT) || 5432,
        name: process.env.DB_NAME || 'mbingo',
        user: process.env.DB_USER || 'mbingo_admin',
        password: process.env.DB_PASSWORD || 'password'
    },
    
    redis: {
        host: process.env.REDIS_HOST || 'localhost',
        port: parseInt(process.env.REDIS_PORT) || 6379
    },
    
    allowedOrigins: [
        'https://myf-delivery.github.io',
        'https://my-bingo-server-vakj.onrender.com',
        'http://localhost:3000',
        'http://localhost:5500',
        'https://m-bingo-production.vercel.app'
    ]
};