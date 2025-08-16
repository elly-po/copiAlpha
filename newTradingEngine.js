const SolanaService = require('./solanaService');
const database = require('./database');
const Bottleneck = require('bottleneck');

class TradingEngine {
    constructor(bot) {
        this.bot = bot;
        this.solanaService = new SolanaService();
        this.activeUsers = new Map(); // Cache active users

        // Rate limiter for trade execution
        this.tradeLimiter = new Bottleneck({ maxConcurrent: 3, minTime: 1000 });

        // Rate limiter for Telegram notifications
        this.notifyLimiter = new Bottleneck({ maxConcurrent: 1, minTime: 500 });
    }

    async processSwapSignal(swapDetails, alphaWallet) {
        try {
            console.log('Processing swap signal:', { swapDetails, alphaWallet });

            const users = await this.getUsersTrackingWallet(alphaWallet);

            for (const user of users) {
                await this.tradeLimiter.schedule(() => 
                    this.executeCopyTrade(user, swapDetails, alphaWallet)
                );
            }
        } catch (error) {
            console.error('Error processing swap signal:', error);
        }
    }

    async getUsersTrackingWallet(alphaWallet) {
        return new Promise((resolve, reject) => {
            const query = `
                SELECT u.*, aw.wallet_address as alpha_wallet
                FROM users u
                JOIN alpha_wallets aw ON u.id = aw.user_id
                WHERE aw.wallet_address = ? AND aw.active = 1 AND u.wallet_address IS NOT NULL
            `;
            database.db.all(query, [alphaWallet], (err, rows) => {
                if (err) reject(err);
                else resolve(rows);
            });
        });
    }

    async executeCopyTrade(user, swapDetails, alphaWallet, retries = 2) {
        try {
            const { side, tokenIn, tokenOut, amountIn, amountOut } = swapDetails;

            const userTradeAmount = this.calculateTradeAmount(user, amountIn);

            if (userTradeAmount <= 0 || userTradeAmount > user.max_trade_amount) return;

            const balance = await this.solanaService.getWalletBalance(user.wallet_address);
            if (balance < userTradeAmount + 0.01) { // Fee buffer
                await this.notifyUser(user.telegram_id, '❌ Insufficient balance for copy trade');
                return;
            }

            const simulation = await this.solanaService.simulateSwap(tokenIn, tokenOut, userTradeAmount, user.slippage);
            if (!simulation) throw new Error('Simulation failed');

            const tradeResult = await this.solanaService.executeSwap(
                user.private_key,
                tokenIn,
                tokenOut,
                userTradeAmount,
                user.slippage,
                simulation.minAmountOut
            );

            const tokenMetadata = await this.solanaService.getTokenMetadata(tokenOut);

            const tradeData = {
                userId: user.id,
                alphaWallet,
                tokenAddress: side === 'buy' ? tokenOut : tokenIn,
                tokenSymbol: tokenMetadata?.symbol || 'TOKEN',
                side,
                amount: userTradeAmount,
                price: amountOut / amountIn,
                signature: tradeResult.signature
            };

            await database.addTrade(tradeData);

            if (tradeResult.success) {
                await this.notifyTradeSuccess(user.telegram_id, tradeData, tradeResult);
            } else {
                await this.notifyTradeFailed(user.telegram_id, tradeData, tradeResult.error);
            }

        } catch (error) {
            if (retries > 0) {
                console.warn(`Retrying trade for ${user.telegram_id}, attempts left: ${retries}`);
                return this.executeCopyTrade(user, swapDetails, alphaWallet, retries - 1);
            }
            console.error('Error executing copy trade:', error);
            await this.notifyUser(user.telegram_id, `❌ Trade execution failed: ${error.message}`);
        }
    }

    calculateTradeAmount(user, alphaAmount) {
        const factor = user.trade_factor || 0.1; // configurable per user
        const proportionalAmount = alphaAmount * factor;
        return Math.min(proportionalAmount, user.max_trade_amount, 1.0);
    }

    async notifyTradeSuccess(telegramId, tradeData, tradeResult) {
        const message = `
🟢 <b>Trade Executed Successfully!</b>

💼 <b>Alpha Wallet:</b> <code>${tradeData.alphaWallet.slice(0, 8)}...${tradeData.alphaWallet.slice(-8)}</code>
📊 <b>Action:</b> ${tradeData.side.toUpperCase()} ${tradeData.tokenSymbol}
💰 <b>Amount:</b> ${tradeData.amount.toFixed(4)} SOL
💲 <b>Price:</b> $${tradeData.price.toFixed(8)}
🔗 <b>Signature:</b> <code>${tradeResult.signature}</code>

⏰ <i>${new Date().toLocaleString()}</i>
        `;
        await this.notifyLimiter.schedule(() => this.bot.api.sendMessage(telegramId, message, {
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: [[{ text: '🔍 View on Explorer', url: `https://solscan.io/tx/${tradeResult.signature}` }]] }
        }));
    }

    async notifyTradeFailed(telegramId, tradeData, error) {
        const message = `
🔴 <b>Trade Failed</b>

💼 <b>Alpha Wallet:</b> <code>${tradeData.alphaWallet.slice(0, 8)}...${tradeData.alphaWallet.slice(-8)}</code>
📊 <b>Attempted Action:</b> ${tradeData.side.toUpperCase()} ${tradeData.tokenSymbol}
💰 <b>Amount:</b> ${tradeData.amount.toFixed(4)} SOL
❌ <b>Error:</b> ${error}

⏰ <i>${new Date().toLocaleString()}</i>
        `;
        await this.notifyLimiter.schedule(() => this.bot.api.sendMessage(telegramId, message, { parse_mode: 'HTML' }));
    }

    async notifyUser(telegramId, message) {
        try {
            await this.notifyLimiter.schedule(() => this.bot.api.sendMessage(telegramId, message, { parse_mode: 'HTML' }));
        } catch (error) {
            console.error('Error sending notification:', error);
        }
    }

    // P&L and auto-sell
    async monitorPositions() {
        try {
            const users = await this.getUsersWithAutoSell();
            for (const user of users) {
                const positions = await this.getUserPositions(user.id);
                for (const position of positions) {
                    // Fetch current token price
                    position.currentValue = position.amount * (await this.getCurrentTokenPrice(position.tokenAddress));
                    await this.checkAutoSell(user, position);
                }
            }
        } catch (error) {
            console.error('Error monitoring positions:', error);
        }
    }

    async getCurrentTokenPrice(tokenAddress) {
        try {
            return await this.solanaService.getTokenPrice(tokenAddress);
        } catch (error) {
            console.error('Error fetching token price:', error);
            return 0;
        }
    }

    async checkAutoSell(user, position) {
        if (!user.auto_sell_enabled) return;
        const currentProfitPercent = ((position.currentValue - position.entryValue) / position.entryValue) * 100;

        if (currentProfitPercent >= user.take_profit) await this.executeSellOrder(user, position, 'take_profit');
        else if (currentProfitPercent <= -user.stop_loss) await this.executeSellOrder(user, position, 'stop_loss');
    }

    async executeSellOrder(user, position, reason) {
        try {
            const sellResult = await this.solanaService.executeSwap(
                user.private_key,
                position.tokenAddress,
                'So11111111111111111111111111111111111111112',
                position.amount,
                user.slippage,
                position.minSellAmount
            );
            const message = `
🔔 <b>Auto-Sell Executed!</b>
🎯 <b>Trigger:</b> ${reason === 'take_profit' ? '🟢 Take Profit' : '🔴 Stop Loss'}
💰 <b>Token:</b> ${position.tokenSymbol}
📈 <b>P&L:</b> ${currentProfitPercent.toFixed(2)}%
🔗 <b>Tx:</b> <code>${sellResult.signature}</code>
            `;
            await this.notifyUser(user.telegram_id, message);
        } catch (error) {
            console.error('Error executing auto-sell:', error);
        }
    }

    async getUsersWithAutoSell() {
        return new Promise((resolve, reject) => {
            database.db.all(
                'SELECT * FROM users WHERE auto_sell_enabled = 1 AND wallet_address IS NOT NULL',
                (err, rows) => err ? reject(err) : resolve(rows)
            );
        });
    }

    async getUserPositions(userId) {
        return new Promise((resolve, reject) => {
            const query = `
                SELECT 
                    token_address,
                    token_symbol,
                    SUM(CASE WHEN side = 'buy' THEN amount ELSE -amount END) as net_amount,
                    AVG(CASE WHEN side = 'buy' THEN price END) as avg_entry_price
                FROM trades
                WHERE user_id = ? AND status = 'completed'
                GROUP BY token_address
                HAVING net_amount > 0
            `;
            database.db.all(query, [userId], (err, rows) => {
                if (err) reject(err);
                else resolve(rows.map(r => ({
                    tokenAddress: r.token_address,
                    tokenSymbol: r.token_symbol,
                    amount: r.net_amount,
                    entryPrice: r.avg_entry_price,
                    currentValue: 0,
                    entryValue: r.net_amount * r.avg_entry_price
                })));
            });
        });
    }

    async startMonitoring() { console.log('Trading engine monitoring started'); }
    async stopMonitoring() { console.log('Trading engine monitoring stopped'); }
    async emergencyStopUser(userId, reason = 'Manual stop') {
        try {
            await database.updateUser(userId, { auto_sell_enabled: 0, max_trade_amount: 0 });
            const user = await database.getUser(userId);
            if (user) await this.notifyUser(user.telegram_id, `🚨 <b>Emergency Stop Activated!</b>\nReason: ${reason}`);
            console.log(`Emergency stop activated for user ${userId}: ${reason}`);
        } catch (error) { console.error('Error during emergency stop:', error); }
    }
}

module.exports = TradingEngine;