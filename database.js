const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

// Ensure the data folder exists
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir);
    console.log('📁 Created data directory at:', dataDir);
}

class DB {
    constructor() {
        const dbPath = path.join(dataDir, 'bot.db');
        console.log('🗄  Using database file at:', dbPath);

        try {
            this.db = new Database(dbPath);
            console.log("✅ Database opened successfully at:", dbPath);
            console.log("✅ Database initialized and ready for queries");
        } catch (err) {
            console.error("❌ Failed to open database:", err);
            throw err;
        }

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

        for (const sql of tables) {
            try {
                this.db.prepare(sql).run();
            } catch (err) {
                console.error("❌ Error creating table:", err);
            }
        }
    }

    // User methods
    getUser(telegramId) {
        try {
            return this.db.prepare(
                'SELECT * FROM users WHERE telegram_id = ?'
            ).get(telegramId);
        } catch (err) {
            console.error("❌ getUser failed:", err);
            return null;
        }
    }

    createUser(telegramId) {
        try {
            const stmt = this.db.prepare(
                'INSERT INTO users (telegram_id) VALUES (?)'
            );
            return stmt.run(telegramId).lastInsertRowid;
        } catch (err) {
            console.error("❌ createUser failed:", err);
            throw err;
        }
    }

    updateUser(telegramId, updates) {
        try {
            const fields = Object.keys(updates).map(k => `${k} = ?`).join(', ');
            const values = [...Object.values(updates), telegramId];
            this.db.prepare(`UPDATE users SET ${fields} WHERE telegram_id = ?`).run(values);
        } catch (err) {
            console.error("❌ updateUser failed:", err);
            throw err;
        }
    }

    // Alpha Wallet methods
    addAlphaWallet(userId, walletAddress, nickname) {
        try {
            return this.db.prepare(
                'INSERT INTO alpha_wallets (user_id, wallet_address, nickname) VALUES (?, ?, ?)'
            ).run(userId, walletAddress, nickname).lastInsertRowid;
        } catch (err) {
            console.error("❌ addAlphaWallet failed:", err);
            throw err;
        }
    }

    getAlphaWallets(userId) {
        try {
            return this.db.prepare(
                'SELECT * FROM alpha_wallets WHERE user_id = ? AND active = 1'
            ).all(userId);
        } catch (err) {
            console.error("❌ getAlphaWallets failed:", err);
            return [];
        }
    }

    getAllActiveAlphaWallets() {
        try {
            const rows = this.db.prepare(
                'SELECT wallet_address FROM alpha_wallets WHERE active = 1'
            ).all();
            return rows.map(r => r.wallet_address);
        } catch (err) {
            console.error("❌ getAllActiveAlphaWallets failed:", err);
            return [];
        }
    }

    deleteAlphaWallet(id) {
        try {
            this.db.prepare(
                'UPDATE alpha_wallets SET active = 0 WHERE id = ?'
            ).run(id);
        } catch (err) {
            console.error("❌ deleteAlphaWallet failed:", err);
            throw err;
        }
    }

    // Trade methods
    addTrade({ userId, alphaWallet, tokenAddress, tokenSymbol, side, amount, price, signature }) {
        try {
            return this.db.prepare(
                `INSERT INTO trades 
                (user_id, alpha_wallet, token_address, token_symbol, side, amount, price, signature) 
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
            ).run(userId, alphaWallet, tokenAddress, tokenSymbol, side, amount, price, signature).lastInsertRowid;
        } catch (err) {
            console.error("❌ addTrade failed:", err);
            throw err;
        }
    }

    getUserTrades(userId, limit = 10) {
        try {
            return this.db.prepare(
                'SELECT * FROM trades WHERE user_id = ? ORDER BY created_at DESC LIMIT ?'
            ).all(userId, limit);
        } catch (err) {
            console.error("❌ getUserTrades failed:", err);
            return [];
        }
    }

    // Aggregates
    getTotalTrades(userId) {
        try {
            const row = this.db.prepare(
                'SELECT COUNT(*) AS count FROM trades WHERE user_id = ?'
            ).get(userId);
            return row?.count || 0;
        } catch (err) {
            console.error("❌ getTotalTrades failed:", err);
            return 0;
        }
    }

    getWinRate(userId) {
        try {
            const winsRow = this.db.prepare(
                'SELECT COUNT(*) AS count FROM trades WHERE user_id = ? AND profit_loss > 0'
            ).get(userId);
            const wins = winsRow?.count || 0;
            const total = this.getTotalTrades(userId);
            return total > 0 ? Math.round((wins / total) * 100) : 0;
        } catch (err) {
            console.error("❌ getWinRate failed:", err);
            return 0;
        }
    }

    getTotalPnL(userId) {
        try {
            const row = this.db.prepare(
                'SELECT SUM(profit_loss) AS total FROM trades WHERE user_id = ?'
            ).get(userId);
            return row?.total || 0;
        } catch (err) {
            console.error("❌ getTotalPnL failed:", err);
            return 0;
        }
    }
}

module.exports = new DB();
