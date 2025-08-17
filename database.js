const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// Ensure the data folder exists once when this module is loaded
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir);
    console.log('📁 Created data directory at:', dataDir);
}

class Database {
    constructor() {
        const dbPath = path.join(dataDir, 'bot.db');
        console.log('🗄  Using database file at:', dbPath);

        this.db = new sqlite3.Database(dbPath, (err) => {
            if (err) {
                console.error("❌ Failed to open database:", err);
            } else {
                console.log("✅ Database opened successfully");
            }
        });

        this.initTables();
    }

    initTables() {
        const tables = [
            `CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY,
                telegram_id INTEGER UNIQUE,
                wallet_address TEXT,
                private_key TEXT,
                max_trade_amount REAL DEFAULT 0.1,
                slippage REAL DEFAULT 5.0,
                auto_sell_enabled INTEGER DEFAULT 0,
                take_profit REAL DEFAULT 100.0,
                stop_loss REAL DEFAULT 20.0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`,
            `CREATE TABLE IF NOT EXISTS alpha_wallets (
                id INTEGER PRIMARY KEY,
                user_id INTEGER,
                wallet_address TEXT,
                nickname TEXT,
                active INTEGER DEFAULT 1,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users (id)
            )`,
            `CREATE TABLE IF NOT EXISTS trades (
                id INTEGER PRIMARY KEY,
                user_id INTEGER,
                alpha_wallet TEXT,
                token_address TEXT,
                token_symbol TEXT,
                side TEXT,
                amount REAL,
                price REAL,
                signature TEXT,
                status TEXT DEFAULT 'pending',
                profit_loss REAL DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users (id)
            )`,
            `CREATE TABLE IF NOT EXISTS webhooks (
                id INTEGER PRIMARY KEY,
                webhook_id TEXT UNIQUE,
                user_id INTEGER,
                active INTEGER DEFAULT 1,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users (id)
            )`
        ];

        tables.forEach(sql => {
            this.db.run(sql, (err) => {
                if (err) console.error('Error creating table:', err);
            });
        });
    }

    getUser(telegramId) {
        return new Promise((resolve, reject) => {
            this.db.get(
                'SELECT * FROM users WHERE telegram_id = ?',
                [telegramId],
                (err, row) => {
                    if (err) reject(err);
                    else resolve(row);
                }
            );
        });
    }

    createUser(telegramId) {
        return new Promise((resolve, reject) => {
            this.db.run(
                'INSERT INTO users (telegram_id) VALUES (?)',
                [telegramId],
                function(err) {
                    if (err) reject(err);
                    else resolve(this.lastID);
                }
            );
        });
    }

    updateUser(telegramId, updates) {
        const fields = Object.keys(updates).map(key => `${key} = ?`).join(', ');
        const values = [...Object.values(updates), telegramId];

        return new Promise((resolve, reject) => {
            this.db.run(
                `UPDATE users SET ${fields} WHERE telegram_id = ?`,
                values,
                (err) => {
                    if (err) reject(err);
                    else resolve();
                }
            );
        });
    }

    addAlphaWallet(userId, walletAddress, nickname) {
        return new Promise((resolve, reject) => {
            this.db.run(
                'INSERT INTO alpha_wallets (user_id, wallet_address, nickname) VALUES (?, ?, ?)',
                [userId, walletAddress, nickname],
                function(err) {
                    if (err) reject(err);
                    else resolve(this.lastID);
                }
            );
        });
    }

    getAlphaWallets(userId) {
        return new Promise((resolve, reject) => {
            this.db.all(
                'SELECT * FROM alpha_wallets WHERE user_id = ? AND active = 1',
                [userId],
                (err, rows) => {
                    if (err) reject(err);
                    else resolve(rows);
                }
            );
        });
    }
    getAllActiveAlphaWallets() {
        return new Promise((resolve, reject) => {
            this.db.all(
                'SELECT wallet_address FROM alpha_wallets WHERE active = 1',
                [],
                (err, rows) => {
                    if (err) reject(err);
                    else resolve(rows.map(r => r.wallet_address));
                }
            );
        });
    }

    deleteAlphaWallet(id) {
        return new Promise((resolve, reject) => {
            this.db.run(
                'UPDATE alpha_wallets SET active = 0 WHERE id = ?',
                [id],
                (err) => {
                    if (err) reject(err);
                    else resolve();
                }
            );
        });
    }

    addTrade(tradeData) {
        return new Promise((resolve, reject) => {
            const { userId, alphaWallet, tokenAddress, tokenSymbol, side, amount, price, signature } = tradeData;
            this.db.run(
                'INSERT INTO trades (user_id, alpha_wallet, token_address, token_symbol, side, amount, price, signature) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                [userId, alphaWallet, tokenAddress, tokenSymbol, side, amount, price, signature],
                function(err) {
                    if (err) reject(err);
                    else resolve(this.lastID);
                }
            );
        });
    }

    getUserTrades(userId, limit = 10) {
        return new Promise((resolve, reject) => {
            this.db.all(
                'SELECT * FROM trades WHERE user_id = ? ORDER BY created_at DESC LIMIT ?',
                [userId, limit],
                (err, rows) => {
                    if (err) reject(err);
                    else resolve(rows);
                }
            );
        });
    }
}

module.exports = new Database();