// tradingEngine.js
const SolanaService = require('./solanaService');
const database = require('./database');
const Bottleneck = require('bottleneck');
const { PublicKey } = require('@solana/web3.js');

class TradingEngine {
    constructor(bot) {
        this.bot = bot;
        this.solanaService = new SolanaService();
        this.activeUsers = new Map();  // cache active users
        this.positions = new Map();    // user positions cache

        // ⏱️ rate limiter for trade execution
        this.tradeLimiter = new Bottleneck({
            maxConcurrent: 3,
            minTime: 1000
        });

        // position monitoring
        this.positionMonitorInterval = null;
        this.startPositionMonitoring();
    }

    logWithTimestamp(...args) {
        console.log(new Date().toISOString(), ...args);
    }

    // === ENTRYPOINT FROM WEBHOOK ===
    async processSwapSignal(swapDetails, alphaWallet) {
        try {
            this.logWithTimestamp(
                'Processing swap signal',
                JSON.stringify({
                    alphaWallet,
                    signature: swapDetails.signature,
                    side: swapDetails?.perspective?.side,
                    tokenIn: swapDetails?.perspective?.tokenIn,
                    tokenOut: swapDetails?.perspective?.tokenOut,
                    amountIn: swapDetails?.perspective?.amountIn,
                    amountOut: swapDetails?.perspective?.amountOut
                })
            );

            const users = await this.getUsersTrackingWallet(alphaWallet);

            for (const user of users) {
                await this.tradeLimiter.schedule(() =>
                    this.executeCopyTrade(user, swapDetails, alphaWallet)
                );
            }
        } catch (error) {
            this.logWithTimestamp('❌ Error processing swap signal:', error);
        }
    }

    async getUsersTrackingWallet(alphaWallet) {
        try {
            const query = `
                SELECT u.*, aw.wallet_address as alpha_wallet
                FROM users u
                JOIN alpha_wallets aw ON u.id = aw.user_id
                WHERE aw.wallet_address = ? AND aw.active = 1 AND u.wallet_address IS NOT NULL
            `;
            return database.db.prepare(query).all(alphaWallet);
        } catch (err) {
            this.logWithTimestamp('❌ DB error fetching users tracking wallet:', err);
            return [];
        }
    }

    // === MAIN COPY-TRADE EXECUTION ===
    async executeCopyTrade(user, swapDetails, alphaWallet) {
        try {
            const p = swapDetails.perspective || {};
            const side = p.side;
            const tokenIn = p.tokenIn;
            const tokenOut = p.tokenOut;
            const amountIn = p.amountIn;
            const amountOut = p.amountOut;

            this.logWithTimestamp('Executing copy trade for user', user.telegram_id, {
                side, tokenIn, tokenOut, amountIn, amountOut
            });

            // Auto-sell follow filter
            if (side === 'sell' && user.auto_sell_enabled) {
                const shouldFollowSell = await this.checkAlphaWalletSell(user, tokenIn, alphaWallet);
                if (!shouldFollowSell) {
                    this.logWithTimestamp('Skip: user has no position to sell or not following alpha sell');
                    return;
                }
            }

            // Validate trade (no aggregator checks)
            if (!await this.validateTrade(user, { side, tokenIn, tokenOut, amountIn, amountOut }, alphaWallet)) {
                return;
            }

            // Existing position + amount sizing
            let existingPosition = await this.getUserTokenPosition(user.id, tokenOut);
            let userTradeAmount = await this.calculateTradeAmount(user, { side, tokenIn, tokenOut, amountIn, amountOut }, alphaWallet);

            if (side === 'buy' && existingPosition && existingPosition.isOpen) {
                // scale buys if already in position
                const scaleFactor = 0.5;
                userTradeAmount = userTradeAmount * scaleFactor;
                if (userTradeAmount <= 0) {
                    this.logWithTimestamp(`Existing position in ${tokenOut}, no scaling needed.`);
                    return;
                }
                this.logWithTimestamp(`Scaling existing position in ${tokenOut} by ${userTradeAmount}`);
            }

            if (userTradeAmount <= 0 || userTradeAmount > (user.max_trade_amount || Number.MAX_VALUE)) {
                this.logWithTimestamp('Trade amount outside limits, skipping');
                return;
            }

            // Token info (on-chain / local, NO Jupiter)
            const tokenInfo = await this.getTokenInfo(side === 'buy' ? tokenOut : tokenIn);

            // Simulate route on-chain (no aggregator): let SolanaService figure out best/native route it supports
            const sim = await this.solanaService.simulateSwap({
                tokenIn,
                tokenOut,
                amountIn: userTradeAmount,
                // user slippage in bps (e.g., 3% -> 300 bps)
                slippageBps: Math.floor((user.slippage || 3) * 100)
            });

            if (!sim || !sim.outAmount || sim.outAmount <= 0) {
                await this.notifyUser(user.telegram_id, '❌ No viable route found for this trade.');
                return;
            }

            // Build & send swap directly (no Jupiter)
            const exec = await this.solanaService.executeSwap({
                userPrivateKeyEncrypted: user.private_key,
                tokenIn,
                tokenOut,
                amountIn: userTradeAmount,
                minOut: sim.minOut,       // derived from slippage
                routeInfo: sim.routeInfo, // DEX/AMM-specific data from simulation
            });

            const tradeResult = {
                success: !!exec?.signature,
                signature: exec?.signature || null,
                inputAmount: userTradeAmount,
                outputAmount: sim.outAmount,
                priceImpact: sim.priceImpactPct || 0
            };

            // DB record
            const tradeData = {
                userId: user.id,
                alphaWallet,
                tokenAddress: side === 'buy' ? tokenOut : tokenIn,
                tokenSymbol: tokenInfo?.symbol || 'UNKNOWN',
                tokenName: tokenInfo?.name || 'Unknown Token',
                side,
                amount: userTradeAmount,
                price: sim.price || 0, // if your sim gives a per-unit price; else compute output/input
                signature: tradeResult.signature,
                routeInfo: JSON.stringify(sim.routeInfo || {}),
                status: tradeResult.success ? 'completed' : 'failed'
            };

            await database.addTrade(tradeData);

            // Update positions + notify
            if (tradeResult.success) {
                await this.updateUserPosition(user.id, tradeData);
                await this.notifyTradeSuccess(user.telegram_id, tradeData, tradeResult, tokenInfo);
            } else {
                await this.notifyTradeFailed(user.telegram_id, tradeData, 'Execution failed');
            }
        } catch (error) {
            this.logWithTimestamp('❌ Error executing copy trade:', error);
            await this.notifyUser(user.telegram_id, `❌ Trade execution failed: ${error.message}`);
        }
    }

    // === TOKEN INFO (NO Jupiter) ===
    async getTokenInfo(tokenAddress) {
        try {
            // Normalize SOL to WSOL for metadata purposes if your SolanaService expects WSOL mint
            const wsol = "So11111111111111111111111111111111111111112";
            const mint = tokenAddress === "SOL" ? wsol : tokenAddress;

            if (!this.tokenInfoCache) this.tokenInfoCache = new Map();
            if (this.tokenInfoCache.has(mint)) return this.tokenInfoCache.get(mint);

            // Delegate to SolanaService: on-chain metadata / local token list
            const meta = await this.solanaService.getTokenMetadata(mint);
            if (meta) this.tokenInfoCache.set(mint, meta);
            return meta;
        } catch (error) {
            this.logWithTimestamp('❌ Error getting token info:', error);
            return null;
        }
    }

    async getTokenDecimals(tokenAddress) {
        try {
            const info = await this.getTokenInfo(tokenAddress);
            if (info?.decimals !== undefined) return info.decimals;

            // fallback direct on-chain
            try {
                const pubkey = new PublicKey(tokenAddress === 'SOL'
                    ? 'So11111111111111111111111111111111111111112'
                    : tokenAddress);
                const accountInfo = await this.solanaService.connection.getParsedAccountInfo(pubkey);
                const decimals = accountInfo.value?.data?.parsed?.info?.decimals;
                if (decimals !== undefined) return decimals;
            } catch (innerErr) {
                this.logWithTimestamp(`Not a valid public key, skipping on-chain check: ${tokenAddress}`);
            }
        } catch (err) {
            this.logWithTimestamp(`Could not fetch decimals for token ${tokenAddress}: ${err.message}`);
        }
        this.logWithTimestamp(`Using default decimals=9 for ${tokenAddress}`);
        return 9;
    }

    // === POSITIONS ===
    async updateUserPosition(userId, tradeData) {
        try {
            const { tokenAddress, tokenSymbol, side, amount, price } = tradeData;
            let position = await this.getUserTokenPosition(userId, tokenAddress);
            let updatedPosition;

            if (!position) {
                if (side === 'buy') {
                    updatedPosition = {
                        userId,
                        tokenAddress,
                        tokenSymbol,
                        totalAmount: amount,
                        averagePrice: price,
                        isOpen: true,
                        createdAt: new Date().toISOString()
                    };
                    await database.createPosition(updatedPosition);
                }
            } else {
                if (side === 'buy') {
                    const newTotalAmount = position.totalAmount + amount;
                    const newAveragePrice =
                        (position.totalAmount * position.averagePrice + amount * price) / newTotalAmount;

                    updatedPosition = {
                        ...position,
                        totalAmount: newTotalAmount,
                        averagePrice: newAveragePrice,
                        updatedAt: new Date().toISOString()
                    };
                    await database.updatePosition(userId, tokenAddress, updatedPosition);
                } else if (side === 'sell') {
                    const remainingAmount = Math.max(0, position.totalAmount - amount);
                    const isOpen = remainingAmount > 0;

                    updatedPosition = {
                        ...position,
                        totalAmount: remainingAmount,
                        isOpen,
                        updatedAt: new Date().toISOString(),
                        closedAt: isOpen ? null : new Date().toISOString()
                    };
                    await database.updatePosition(userId, tokenAddress, updatedPosition);
                }
            }

            if (updatedPosition) {
                const cacheKey = `${userId}_${tokenAddress}`;
                this.positions.set(cacheKey, updatedPosition);
            }
        } catch (error) {
            this.logWithTimestamp('❌ Error updating user position:', error);
        }
    }

    async getUserTokenPosition(userId, tokenAddress) {
        try {
            const cacheKey = `${userId}_${tokenAddress}`;
            if (this.positions.has(cacheKey)) return this.positions.get(cacheKey);

            const position = await database.getUserPosition(userId, tokenAddress);
            if (position) this.positions.set(cacheKey, position);
            return position || null;
        } catch (error) {
            this.logWithTimestamp('❌ Error getting user token position:', error);
            return null;
        }
    }

    // === FOLLOW SELL FILTER ===
    async checkAlphaWalletSell(user, tokenAddress, alphaWallet) {
        try {
            const position = await this.getUserTokenPosition(user.id, tokenAddress);
            if (!position || !position.isOpen || position.totalAmount <= 0) return false;

            const buyTrades = await database.getUserBuyTrades(user.id, tokenAddress, alphaWallet);
            return buyTrades.length > 0;
        } catch (error) {
            this.logWithTimestamp('❌ Error checking alpha wallet sell:', error);
            return false;
        }
    }

    // === SIZING ===
    async calculateTradeAmount(user, swap, alphaWallet) {
        try {
            const { side, amountIn, tokenIn, tokenOut } = swap;

            if (side === 'buy') {
                const cacheKey = `${user.id}_${tokenOut}`;
                let existingPosition = this.positions.get(cacheKey) ||
                    await this.getUserTokenPosition(user.id, tokenOut);

                if (existingPosition) this.positions.set(cacheKey, existingPosition);

                const buyTrades = await database.getUserBuyTrades(user.id, tokenOut, alphaWallet);
                if (existingPosition && existingPosition.isOpen && buyTrades.length > 0) {
                    this.logWithTimestamp(`Already holding ${tokenOut} from this alpha; skipping duplicate buy.`);
                    return 0;
                }

                const maxAmount = user.max_trade_amount || 0.1;
                const proportionalAmount = amountIn * 0.1; // 10% of alpha trade
                return Math.min(maxAmount, proportionalAmount, 1.0);
            } else {
                const cacheKey = `${user.id}_${tokenIn}`;
                let position = this.positions.get(cacheKey) ||
                    await this.getUserTokenPosition(user.id, tokenIn);

                if (position) this.positions.set(cacheKey, position);
                if (!position || !position.isOpen || position.totalAmount <= 0) return 0;

                return Math.min(position.totalAmount, position.totalAmount * 0.5);
            }
        } catch (error) {
            this.logWithTimestamp('❌ Error calculating trade amount:', error);
            return 0;
        }
    }

    // === VALIDATION (NO Jupiter calls) ===
    async validateTrade(user, swap, alphaWallet) {
        try {
            const { side, tokenOut, tokenIn } = swap;
            const userTradeAmount = await this.calculateTradeAmount(user, swap, alphaWallet);

            if (userTradeAmount < 0.001) {
                this.logWithTimestamp('Trade amount too small, skipping');
                return false;
            }

            if (userTradeAmount > (user.max_trade_amount || 0.1)) {
                this.logWithTimestamp('Trade amount exceeds maximum, skipping');
                return false;
            }

            if (side === 'buy') {
                const balance = await this.solanaService.getWalletBalance(user.wallet_address);
                if (balance < userTradeAmount + 0.01) {
                    this.logWithTimestamp('Insufficient balance for trade');
                    return false;
                }
            }

            const tokenAddress = side === 'buy' ? tokenOut : tokenIn;
            if (await this.isTokenBlacklisted(tokenAddress)) {
                this.logWithTimestamp('Token is blacklisted, skipping');
                return false;
            }

            if (side === 'sell') {
                const cacheKey = `${user.id}_${tokenIn}`;
                let position = this.positions.get(cacheKey) ||
                    await this.getUserTokenPosition(user.id, tokenIn);

                if (position) this.positions.set(cacheKey, position);
                if (!position || !position.isOpen || position.totalAmount <= 0) {
                    this.logWithTimestamp('No open position to sell, skipping');
                    return false;
                }
            }

            // Try a lightweight simulation for route availability
            const sim = await this.solanaService.simulateSwap({
                tokenIn,
                tokenOut,
                amountIn: userTradeAmount,
                slippageBps: Math.floor((user.slippage || 3) * 100)
            });

            if (!sim || !sim.outAmount || sim.outAmount <= 0) {
                this.logWithTimestamp('No viable route in simulation, skipping');
                return false;
            }

            return true;
        } catch (error) {
            this.logWithTimestamp('❌ Error validating trade:', error);
            return false;
        }
    }

    async isTokenBlacklisted(tokenAddress) {
        try {
            const blacklistedTokens = await database.getBlacklistedTokens();
            return blacklistedTokens.includes(tokenAddress);
        } catch (error) {
            this.logWithTimestamp('❌ Error checking token blacklist:', error);
            return false;
        }
    }

    // === AUTO-SELL LOOP ===
    startPositionMonitoring() {
        if (this.positionMonitorInterval) clearInterval(this.positionMonitorInterval);
        this.positionMonitorInterval = setInterval(() => this.monitorPositions(), 30000);
        this.logWithTimestamp('Position monitoring started');
    }

    async monitorPositions() {
        try {
            this.logWithTimestamp('Monitoring positions for auto-sell...');
            const users = await this.getUsersWithAutoSell();

            for (const user of users) {
                const positions = await this.getUserOpenPositions(user.id);
                for (const position of positions) {
                    await this.checkAutoSellConditions(user, position);
                }
            }
        } catch (error) {
            this.logWithTimestamp('❌ Error monitoring positions:', error);
        }
    }

    async checkAutoSellConditions(user, position) {
        try {
            const isOpen = position.isOpen || position.is_open === 1;
            if (!user.auto_sell_enabled || !isOpen || position.totalAmount <= 0) return;

            // Price source: request from SolanaService (e.g., Pyth/Switchboard or micro-sim via a tiny swap)
            const currentPrice = await this.solanaService.getIndicativePriceUSD(position.tokenAddress);
            if (!currentPrice || currentPrice <= 0) return;

            const entryPrice = position.averagePrice;
            const currentProfitPercent = ((currentPrice - entryPrice) / entryPrice) * 100;

            this.logWithTimestamp(`Position check: ${position.tokenSymbol} P&L ${currentProfitPercent.toFixed(2)}%`);

            if (currentProfitPercent >= (user.take_profit || 100)) {
                await this.executeAutoSell(user, position, 'take_profit', currentPrice);
                return;
            }
            if (currentProfitPercent <= -(user.stop_loss || 20)) {
                await this.executeAutoSell(user, position, 'stop_loss', currentPrice);
                return;
            }
        } catch (error) {
            this.logWithTimestamp('❌ Error checking auto-sell conditions:', error);
        }
    }

    async executeAutoSell(user, position, reason, currentPrice) {
        try {
            this.logWithTimestamp(`Executing auto-sell for ${position.tokenSymbol}: ${reason}`);
            const tokenInfo = await this.getTokenInfo(position.tokenAddress);
            if (!tokenInfo) {
                this.logWithTimestamp('Failed to fetch token info for auto-sell');
                return;
            }

            // Simulate selling position.tokenAddress -> WSOL (or USDC) then execute
            const wsol = 'So11111111111111111111111111111111111111112';
            const sim = await this.solanaService.simulateSwap({
                tokenIn: position.tokenAddress,
                tokenOut: wsol,
                amountIn: position.totalAmount,
                slippageBps: Math.floor((user.slippage || 3) * 100)
            });
            if (!sim || !sim.outAmount || sim.outAmount <= 0) {
                this.logWithTimestamp('Failed to simulate auto-sell route');
                return;
            }

            const exec = await this.solanaService.executeSwap({
                userPrivateKeyEncrypted: user.private_key,
                tokenIn: position.tokenAddress,
                tokenOut: wsol,
                amountIn: position.totalAmount,
                minOut: sim.minOut,
                routeInfo: sim.routeInfo
            });

            if (exec?.signature) {
                const tradeData = {
                    userId: user.id,
                    alphaWallet: 'AUTO_SELL',
                    tokenAddress: position.tokenAddress,
                    tokenSymbol: position.tokenSymbol,
                    tokenName: position.tokenSymbol,
                    side: 'sell',
                    amount: position.totalAmount,
                    price: currentPrice,
                    signature: exec.signature,
                    routeInfo: JSON.stringify(sim.routeInfo || {}),
                    status: 'completed',
                    autoSellReason: reason
                };

                await database.addTrade(tradeData);
                await this.updateUserPosition(user.id, tradeData);

                const profitLoss = ((currentPrice - position.averagePrice) / position.averagePrice) * 100;
                const message = `
🔔 <b>Auto-Sell Executed!</b>
🏷️ <b>Token:</b> ${position.tokenSymbol}
🎯 <b>Trigger:</b> ${reason === 'take_profit' ? '🟢 Take Profit' : '🔴 Stop Loss'}
💰 <b>Amount:</b> ${position.totalAmount.toFixed(6)}
💵 <b>Entry Price:</b> $${position.averagePrice.toFixed(8)}
💵 <b>Sell Price:</b> $${currentPrice.toFixed(8)}
📈 <b>P&L:</b> ${profitLoss >= 0 ? '🟢' : '🔴'} ${profitLoss.toFixed(2)}%
🔗 <b>Signature:</b> <code>${exec.signature}</code>
⏰ <i>${new Date().toLocaleString()}</i>
                `;
                await this.notifyUser(user.telegram_id, message);
            } else {
                this.logWithTimestamp('Auto-sell execution failed');
                await this.notifyUser(
                    user.telegram_id,
                    `⚠️ Auto-sell failed for ${position.tokenSymbol}`
                );
            }
        } catch (error) {
            this.logWithTimestamp('❌ Error executing auto-sell:', error);
            await this.notifyUser(
                user.telegram_id,
                `❌ Auto-sell error for ${position.tokenSymbol}: ${error.message}`
            );
        }
    }

    async getUserOpenPositions(userId) {
        try {
            return await database.getUserOpenPositions(userId);
        } catch (error) {
            this.logWithTimestamp('❌ Error getting user open positions:', error);
            return [];
        }
    }

    // === NOTIFICATIONS ===
    async notifyTradeSuccess(telegramId, tradeData, tradeResult, tokenInfo) {
        const priceImpact = tradeResult.priceImpact
            ? `📊 <b>Price Impact:</b> ${(tradeResult.priceImpact * 100).toFixed(2)}%\n`
            : '';
        const tokenLogo = tokenInfo?.logoURI ? `🏷️` : '💰';

        const message = `
🟢 <b>Trade Executed Successfully!</b>

💼 <b>Alpha Wallet:</b> <code>${tradeData.alphaWallet.slice(0, 8)}...${tradeData.alphaWallet.slice(-8)}</code>
${tokenLogo} <b>Token:</b> ${tokenInfo?.name || tradeData.tokenSymbol} (${tradeData.tokenSymbol})
📊 <b>Action:</b> ${tradeData.side.toUpperCase()}
💰 <b>Amount:</b> ${tradeData.amount.toFixed(6)}
💲 <b>Ref. Price:</b> $${(tradeData.price || 0).toFixed(8)}
${priceImpact}🔗 <b>Signature:</b> <code>${tradeResult.signature}</code>

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
🏷️ <b>Token:</b> ${tradeData.tokenName || tradeData.tokenSymbol} (${tradeData.tokenSymbol})
📊 <b>Attempted Action:</b> ${tradeData.side.toUpperCase()}
💰 <b>Amount:</b> ${tradeData.amount.toFixed(6)}
❌ <b>Error:</b> ${error}

⏰ <i>${new Date().toLocaleString()}</i>
        `;
        await this.bot.api.sendMessage(telegramId, message, { parse_mode: 'HTML' });
    }

    async notifyUser(telegramId, message) {
        try {
            await this.bot.api.sendMessage(telegramId, message, { parse_mode: 'HTML' });
        } catch (error) {
            this.logWithTimestamp('❌ Error sending notification:', error);
        }
    }

    // === USERS & STATS ===
    async getUsersWithAutoSell() {
        try {
            if (!this.autoSellUsersCache || (Date.now() - this.autoSellUsersCacheTime) > 30000) {
                const users = database.db
                    .prepare('SELECT * FROM users WHERE auto_sell_enabled = 1 AND wallet_address IS NOT NULL')
                    .all();
                this.autoSellUsersCache = users;
                this.autoSellUsersCacheTime = Date.now();
            }
            return this.autoSellUsersCache || [];
        } catch (err) {
            this.logWithTimestamp('❌ DB error fetching users with auto-sell:', err);
            return [];
        }
    }

    async startMonitoring() {
        this.logWithTimestamp('Trading engine started monitoring...');
        this.startPositionMonitoring();
    }

    async stopMonitoring() {
        this.logWithTimestamp('Trading engine stopped monitoring...');
        if (this.positionMonitorInterval) {
            clearInterval(this.positionMonitorInterval);
            this.positionMonitorInterval = null;
        }
    }

    async calculateUserStats(userId) {
        try {
            const query = `
                SELECT 
                    COUNT(*) as total_trades,
                    SUM(CASE WHEN profit_loss > 0 THEN 1 ELSE 0 END) as winning_trades,
                    AVG(profit_loss) as avg_profit_loss,
                    SUM(profit_loss) as total_profit_loss,
                    MAX(profit_loss) as best_trade,
                    MIN(profit_loss) as worst_trade,
                    SUM(CASE WHEN side = 'buy' THEN amount ELSE 0 END) as total_volume_bought,
                    SUM(CASE WHEN side = 'sell' THEN amount ELSE 0 END) as total_volume_sold
                FROM trades 
                WHERE user_id = ? AND status = 'completed'
            `;
            const row = database.db.prepare(query).get(userId);
            return {
                totalTrades: row.total_trades || 0,
                winningTrades: row.winning_trades || 0,
                winRate: row.total_trades > 0 ? (row.winning_trades / row.total_trades * 100) : 0,
                avgProfitLoss: row.avg_profit_loss || 0,
                totalProfitLoss: row.total_profit_loss || 0,
                bestTrade: row.best_trade || 0,
                worstTrade: row.worst_trade || 0,
                totalVolumeBought: row.total_volume_bought || 0,
                totalVolumeSold: row.total_volume_sold || 0
            };
        } catch (err) {
            this.logWithTimestamp('❌ DB error calculating user stats:', err);
            return {};
        }
    }

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

            this.logWithTimestamp(`Emergency stop activated for user ${userId}: ${reason}`);
        } catch (error) {
            this.logWithTimestamp('❌ Error during emergency stop:', error);
        }
    }

    async cleanupOldTrades() {
        try {
            const thirtyDaysAgo = new Date(Date.now() - 30*24*60*60*1000).toISOString();
            const result = database.db
                .prepare('DELETE FROM trades WHERE created_at < ? AND status != "pending"')
                .run(thirtyDaysAgo);
            this.logWithTimestamp(`Cleaned up ${result.changes} old trades`);
        } catch (err) {
            this.logWithTimestamp('❌ Error cleaning up old trades:', err);
        }
    }

    destroy() {
        this.stopMonitoring();
        if (this.tradeLimiter) this.tradeLimiter.stop();
        this.positions.clear();
        this.activeUsers.clear();
    }
}

module.exports = TradingEngine;