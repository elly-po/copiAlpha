const SolanaService = require('./solanaService');
const database = require('./database');
const Bottleneck = require('bottleneck');

class TradingEngine {
    constructor(bot) {
        this.bot = bot;
        this.solanaService = new SolanaService();
        this.activeUsers = new Map(); // Cache active users
        
        // Rate limiter for trade execution
        this.tradeLimiter = new Bottleneck({
            maxConcurrent: 3,
            minTime: 1000 // 1 second between trades
        });
    }

    async processSwapSignal(swapDetails, alphaWallet) {
        try {
            console.log('Processing swap signal:', { swapDetails, alphaWallet });

            // Get all users tracking this alpha wallet
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

    async executeCopyTrade(user, swapDetails, alphaWallet) {
        try {
            console.log('Executing copy trade for user:', user.telegram_id);

            const { side, tokenIn, tokenOut, amountIn, amountOut } = swapDetails;
            
            // Calculate trade amount based on user settings
            const userTradeAmount = this.calculateTradeAmount(user, amountIn);
            
            if (userTradeAmount <= 0 || userTradeAmount > user.max_trade_amount) {
                console.log('Trade amount outside limits, skipping');
                return;
            }

            // Check user's wallet balance
            const balance = await this.solanaService.getWalletBalance(user.wallet_address);
            if (balance < userTradeAmount) {
                await this.notifyUser(user.telegram_id, '❌ Insufficient balance for copy trade');
                return;
            }

            // Simulate the trade first
            const simulation = await this.solanaService.simulateSwap(
                tokenIn,
                tokenOut,
                userTradeAmount,
                user.slippage
            );

            if (!simulation) {
                await this.notifyUser(user.telegram_id, '❌ Failed to simulate trade');
                return;
            }

            // Execute the actual trade
            const tradeResult = await this.solanaService.executeSwap(
                user.private_key,
                tokenIn,
                tokenOut,
                userTradeAmount,
                user.slippage,
                simulation.minAmountOut
            );

            // Record the trade
            const tradeData = {
                userId: user.id,
                alphaWallet,
                tokenAddress: side === 'buy' ? tokenOut : tokenIn,
                tokenSymbol: 'TOKEN', // Would get from token metadata
                side,
                amount: userTradeAmount,
                price: amountOut / amountIn,
                signature: tradeResult.signature
            };

            await database.addTrade(tradeData);

            // Notify user
            if (tradeResult.success) {
                await this.notifyTradeSuccess(user.telegram_id, tradeData, tradeResult);
            } else {
                await this.notifyTradeFailed(user.telegram_id, tradeData, tradeResult.error);
            }

        } catch (error) {
            console.error('Error executing copy trade:', error);
            await this.notifyUser(user.telegram_id, `❌ Trade execution failed: ${error.message}`);
        }
    }

    calculateTradeAmount(user, alphaAmount) {
        // Simple proportional calculation
        // In a more sophisticated version, you might use percentage of portfolio
        const maxAmount = user.max_trade_amount;
        const proportionalAmount = alphaAmount * 0.1; // 10% of alpha trade
        
        return Math.min(maxAmount, proportionalAmount, 1.0); // Cap at 1 SOL max
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

        await this.bot.api.sendMessage(telegramId, message, { 
            parse_mode: 'HTML',
            reply_markup: {
                inline_keyboard: [[
                    {
                        text: '🔍 View on Explorer',
                        url: `https://solscan.io/tx/${tradeResult.signature}`
                    }
                ]]
            }
        });
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

        await this.bot.api.sendMessage(telegramId, message, { parse_mode: 'HTML' });
    }

    async notifyUser(telegramId, message) {
        try {
            await this.bot.api.sendMessage(telegramId, message, { parse_mode: 'HTML' });
        } catch (error) {
            console.error('Error sending notification:', error);
        }
    }

    async startMonitoring() {
        console.log('Trading engine started monitoring...');
        // The actual monitoring is handled by the webhook receiver
    }

    async stopMonitoring() {
        console.log('Trading engine stopped monitoring...');
    }

    // Profit/Loss calculation for completed trades
    async calculateProfitLoss(tradeId) {
        try {
            // Implementation for P&L calculation
            // This would involve checking current token prices vs entry prices
            return 0; // Placeholder
        } catch (error) {
            console.error('Error calculating P&L:', error);
            return 0;
        }
    }

    // Auto-sell functionality based on user settings
    async checkAutoSell(user, position) {
        try {
            if (!user.auto_sell_enabled) return;

            const currentProfitPercent = (position.currentValue - position.entryValue) / position.entryValue * 100;

            // Check for take profit
            if (currentProfitPercent >= user.take_profit) {
                await this.executeSellOrder(user, position, 'take_profit');
                return;
            }

            // Check for stop loss
            if (currentProfitPercent <= -user.stop_loss) {
                await this.executeSellOrder(user, position, 'stop_loss');
                return;
            }
        } catch (error) {
            console.error('Error checking auto-sell conditions:', error);
        }
    }

    async executeSellOrder(user, position, reason) {
        try {
            const sellResult = await this.solanaService.executeSwap(
                user.private_key,
                position.tokenAddress,
                'So11111111111111111111111111111111111111112', // WSOL
                position.amount,
                user.slippage,
                position.minSellAmount
            );

            const message = `
🔔 <b>Auto-Sell Executed!</b>

🎯 <b>Trigger:</b> ${reason === 'take_profit' ? '🟢 Take Profit' : '🔴 Stop Loss'}
💰 <b>Token:</b> ${position.tokenSymbol}
📈 <b>P&L:</b> ${((position.currentValue - position.entryValue) / position.entryValue * 100).toFixed(2)}%
🔗 <b>Tx:</b> <code>${sellResult.signature}</code>
            `;

            await this.notifyUser(user.telegram_id, message);
        } catch (error) {
            console.error('Error executing auto-sell:', error);
        }
    }

    // Position monitoring for auto-sell
    async monitorPositions() {
        try {
            console.log('Monitoring positions for auto-sell...');
            
            // Get all users with auto-sell enabled
            const users = await this.getUsersWithAutoSell();
            
            for (const user of users) {
                const positions = await this.getUserPositions(user.id);
                
                for (const position of positions) {
                    await this.checkAutoSell(user, position);
                }
            }
        } catch (error) {
            console.error('Error monitoring positions:', error);
        }
    }

    async getUsersWithAutoSell() {
        return new Promise((resolve, reject) => {
            database.db.all(
                'SELECT * FROM users WHERE auto_sell_enabled = 1 AND wallet_address IS NOT NULL',
                (err, rows) => {
                    if (err) reject(err);
                    else resolve(rows);
                }
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
                    AVG(CASE WHEN side = 'buy' THEN price END) as avg_entry_price,
                    COUNT(*) as trade_count
                FROM trades 
                WHERE user_id = ? AND status = 'completed'
                GROUP BY token_address
                HAVING net_amount > 0
            `;
            
            database.db.all(query, [userId], (err, rows) => {
                if (err) reject(err);
                else resolve(rows.map(row => ({
                    tokenAddress: row.token_address,
                    tokenSymbol: row.token_symbol,
                    amount: row.net_amount,
                    entryPrice: row.avg_entry_price,
                    currentValue: 0, // Would be calculated from current price
                    entryValue: row.net_amount * row.avg_entry_price
                })));
            });
        });
    }

    // Market data helpers
    async getCurrentTokenPrice(tokenAddress) {
        try {
            // Mock implementation - in real app, use Jupiter/DEX APIs
            return Math.random() * 0.01; // Random price for demo
        } catch (error) {
            console.error('Error getting token price:', error);
            return 0;
        }
    }

    // Trade validation
    async validateTrade(user, swapDetails) {
        try {
            const { side, amountIn } = swapDetails;
            const userTradeAmount = this.calculateTradeAmount(user, amountIn);

            // Check minimum trade amount
            if (userTradeAmount < 0.001) {
                console.log('Trade amount too small, skipping');
                return false;
            }

            // Check maximum trade amount
            if (userTradeAmount > user.max_trade_amount) {
                console.log('Trade amount exceeds maximum, skipping');
                return false;
            }

            // Check wallet balance
            const balance = await this.solanaService.getWalletBalance(user.wallet_address);
            if (balance < userTradeAmount + 0.01) { // Leave 0.01 SOL for fees
                console.log('Insufficient balance for trade');
                return false;
            }

            // Check if token is in blacklist (if implemented)
            if (await this.isTokenBlacklisted(swapDetails.tokenOut)) {
                console.log('Token is blacklisted, skipping');
                return false;
            }

            return true;
        } catch (error) {
            console.error('Error validating trade:', error);
            return false;
        }
    }

    async isTokenBlacklisted(tokenAddress) {
        // Mock implementation - in real app, maintain blacklist
        const blacklistedTokens = [
            // Add known scam/problematic tokens
        ];
        
        return blacklistedTokens.includes(tokenAddress);
    }

    // Performance metrics
    async calculateUserStats(userId) {
        return new Promise((resolve, reject) => {
            const query = `
                SELECT 
                    COUNT(*) as total_trades,
                    SUM(CASE WHEN profit_loss > 0 THEN 1 ELSE 0 END) as winning_trades,
                    AVG(profit_loss) as avg_profit_loss,
                    SUM(profit_loss) as total_profit_loss,
                    MAX(profit_loss) as best_trade,
                    MIN(profit_loss) as worst_trade
                FROM trades 
                WHERE user_id = ? AND status = 'completed'
            `;
            
            database.db.get(query, [userId], (err, row) => {
                if (err) {
                    reject(err);
                } else {
                    const stats = {
                        totalTrades: row.total_trades || 0,
                        winningTrades: row.winning_trades || 0,
                        winRate: row.total_trades > 0 ? (row.winning_trades / row.total_trades * 100) : 0,
                        avgProfitLoss: row.avg_profit_loss || 0,
                        totalProfitLoss: row.total_profit_loss || 0,
                        bestTrade: row.best_trade || 0,
                        worstTrade: row.worst_trade || 0
                    };
                    resolve(stats);
                }
            });
        });
    }

    // Emergency stop functionality
    async emergencyStopUser(userId, reason = 'Manual stop') {
        try {
            await database.updateUser(userId, { 
                auto_sell_enabled: 0,
                max_trade_amount: 0 
            });

            const user = await database.getUser(userId);
            if (user) {
                await this.notifyUser(user.telegram_id, 
                    `🚨 <b>Emergency Stop Activated!</b>\n\n` +
                    `Reason: ${reason}\n` +
                    `All trading has been paused.\n\n` +
                    `Please check your settings before resuming.`
                );
            }

            console.log(`Emergency stop activated for user ${userId}: ${reason}`);
        } catch (error) {
            console.error('Error during emergency stop:', error);
        }
    }

    // Cleanup old trades
    async cleanupOldTrades() {
        try {
            const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
            
            database.db.run(
                'DELETE FROM trades WHERE created_at < ? AND status != "pending"',
                [thirtyDaysAgo],
                function(err) {
                    if (err) {
                        console.error('Error cleaning up old trades:', err);
                    } else {
                        console.log(`Cleaned up ${this.changes} old trades`);
                    }
                }
            );
        } catch (error) {
            console.error('Error in cleanup:', error);
        }
    }
}

module.exports = TradingEngine;
