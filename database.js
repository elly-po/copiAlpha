//database.js
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

// Ensure the data folder exists
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);

class DB {
    constructor() {
        const dbPath = path.join(dataDir, 'bot.db');
        try {
            this.db = new Database(dbPath);
            console.log("✅ Database opened successfully at:", dbPath);
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
                FOREIGN KEY (user_id) REFERENCES users(id)
            )`,
            `CREATE TABLE IF NOT EXISTS trades (
                id INTEGER PRIMARY KEY,
                user_id INTEGER,
                alpha_wallet TEXT,
                token_address TEXT,
                token_symbol TEXT,
                token_name TEXT,
                side TEXT,
                amount REAL,
                price REAL,
                signature TEXT,
                jupiterQuote TEXT,
                status TEXT DEFAULT 'pending',
                profit_loss REAL DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id)
            )`,
            `CREATE TABLE IF NOT EXISTS webhooks (
                id INTEGER PRIMARY KEY,
                webhook_id TEXT UNIQUE,
                user_id INTEGER,
                active INTEGER DEFAULT 1,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id)
            )`,
            `CREATE TABLE IF NOT EXISTS positions (
                id INTEGER PRIMARY KEY,
                user_id INTEGER,
                token_address TEXT,
                token_symbol TEXT,
                total_amount REAL DEFAULT 0,
                average_price REAL DEFAULT 0,
                is_open INTEGER DEFAULT 1,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME,
                closed_at DATETIME
            )`,
            `CREATE TABLE IF NOT EXISTS blacklisted_tokens (
                id INTEGER PRIMARY KEY,
                token_address TEXT UNIQUE,
                reason TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
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

    // ---------------- User Methods ----------------
    getUser(telegramId) {
        try {
            return this.db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(telegramId);
        } catch (err) {
            console.error("❌ getUser failed:", err);
            return null;
        }
    }

    createUser(telegramId) {
        try {
            return this.db.prepare('INSERT INTO users (telegram_id) VALUES (?)').run(telegramId).lastInsertRowid;
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

    // ---------------- Alpha Wallet Methods ----------------
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
            return this.db.prepare('SELECT * FROM alpha_wallets WHERE user_id = ? AND active = 1').all(userId);
        } catch (err) {
            console.error("❌ getAlphaWallets failed:", err);
            return [];
        }
    }

    getAllActiveAlphaWallets() {
        try {
            return this.db.prepare('SELECT wallet_address FROM alpha_wallets WHERE active = 1').all()
                      .map(r => r.wallet_address);
        } catch (err) {
            console.error("❌ getAllActiveAlphaWallets failed:", err);
            return [];
        }
    }

    deleteAlphaWallet(id) {
        try {
            this.db.prepare('UPDATE alpha_wallets SET active = 0 WHERE id = ?').run(id);
        } catch (err) {
            console.error("❌ deleteAlphaWallet failed:", err);
            throw err;
        }
    }

    // ---------------- Trade Methods ----------------
    addTrade({ userId, alphaWallet, tokenAddress, tokenSymbol, tokenName, side, amount, price, signature, jupiterQuote, status = 'pending', profit_loss = 0 }) {
        try {
            return this.db.prepare(
                `INSERT INTO trades 
                 (user_id, alpha_wallet, token_address, token_symbol, token_name, side, amount, price, signature, jupiterQuote, status, profit_loss) 
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            ).run(userId, alphaWallet, tokenAddress, tokenSymbol, tokenName, side, amount, price, signature, jupiterQuote, status, profit_loss).lastInsertRowid;
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

    getUserBuyTrades(userId, tokenAddress, alphaWallet) {
        try {
            return this.db.prepare(
                `SELECT * FROM trades
                 WHERE user_id = ?
                 AND token_address = ?
                 AND alpha_wallet = ?
                 AND side = 'buy'
                 AND status = 'completed'
                 ORDER BY created_at ASC`
            ).all(userId, tokenAddress, alphaWallet);
        } catch (err) {
            console.error("❌ getUserBuyTrades failed:", err);
            return [];
        }
    }

    getTotalTrades(userId) {
        try {
            const row = this.db.prepare('SELECT COUNT(*) AS count FROM trades WHERE user_id = ?').get(userId);
            return row?.count || 0;
        } catch (err) {
            console.error("❌ getTotalTrades failed:", err);
            return 0;
        }
    }

    getWinRate(userId) {
        try {
            const winsRow = this.db.prepare('SELECT COUNT(*) AS count FROM trades WHERE user_id = ? AND profit_loss > 0').get(userId);
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
            const row = this.db.prepare('SELECT SUM(profit_loss) AS total FROM trades WHERE user_id = ?').get(userId);
            return row?.total || 0;
        } catch (err) {
            console.error("❌ getTotalPnL failed:", err);
            return 0;
        }
    }

    getUserPosition(userId, tokenAddress) {
        try {
            return this.db.prepare(
                'SELECT * FROM positions WHERE user_id = ? AND token_address = ? LIMIT 1'
            ).get(userId, tokenAddress);
        } catch (err) {
            console.error('❌ getUserPosition failed:', err);
            return null;
        }
    }

    createPosition(position) {
        return this.db.prepare(`
            INSERT INTO positions 
            (user_id, token_address, token_symbol, total_amount, average_price, is_open, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
            position.userId,
            position.tokenAddress,
            position.tokenSymbol,
            position.totalAmount,
            position.averagePrice,
            position.isOpen ? 1 : 0,
            position.createdAt
        ).lastInsertRowid;
    }

    updatePosition(userId, tokenAddress, updates) {
        const fields = Object.keys(updates).map(k => `${k} = ?`).join(', ');
        const values = [...Object.values(updates), userId, tokenAddress];
        this.db.prepare(`UPDATE positions SET ${fields} WHERE user_id = ? AND token_address = ?`).run(values);
    }

    getUserOpenPositions(userId) {
        return this.db.prepare('SELECT * FROM positions WHERE user_id = ? AND is_open = 1').all(userId);
    }

    getBlacklistedTokens() {
        try {
            return this.db.prepare('SELECT token_address FROM blacklisted_tokens').all().map(r => r.token_address);
        } catch (err) {
            console.error('❌ getBlacklistedTokens failed:', err);
            return [];
        }
    }
}

module.exports = new DB();