// tradingEngine.js
const SolanaService = require('./solanaService');
const database = require('./database');
const Bottleneck = require('bottleneck');
const { PublicKey } = require('@solana/web3.js');

class TradingEngine {
    constructor(bot) {
        this.bot = bot;
        this.solanaService = new SolanaService();
        this.activeUsers = new Map();
        this.positions = new Map();

        // ⏱️ rate limiter for trade execution
        this.tradeLimiter = new Bottleneck({
            maxConcurrent: 3,
            minTime: 1000
        });

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

            if (side === 'sell' && user.auto_sell_enabled) {
                const shouldFollowSell = await this.checkAlphaWalletSell(user, tokenIn, alphaWallet);
                if (!shouldFollowSell) {
                    this.logWithTimestamp('Skip: user has no position to sell or not following alpha sell');
                    return;
                }
            }

            if (!await this.validateTrade(user, { side, tokenIn, tokenOut, amountIn, amountOut }, alphaWallet)) {
                return;
            }

            let existingPosition = await this.getUserTokenPosition(user.id, tokenOut);
            let userTradeAmount = await this.calculateTradeAmount(user, { side, tokenIn, tokenOut, amountIn, amountOut }, alphaWallet);

            if (side === 'buy' && existingPosition && existingPosition.isOpen) {
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

            const tokenInfo = await this.getTokenInfo(side === 'buy' ? tokenOut : tokenIn);

            // === AXIOM-SPECIFIC SWAP ===
            const sim = await this.simulateAxiomSwap(tokenIn, tokenOut, userTradeAmount, Math.floor((user.slippage || 3) * 100));
            if (!sim || !sim.outAmount || sim.outAmount <= 0) {
                await this.notifyUser(user.telegram_id, '❌ No viable Axiom route found for this trade.');
                return;
            }

            const exec = await this.executeAxiomSwap(user.private_key, sim);

            const tradeResult = {
                success: !!exec?.signature,
                signature: exec?.signature || null,
                inputAmount: userTradeAmount,
                outputAmount: sim.outAmount,
                priceImpact: sim.priceImpactPct || 0
            };

            const tradeData = {
                userId: user.id,
                alphaWallet,
                tokenAddress: side === 'buy' ? tokenOut : tokenIn,
                tokenSymbol: tokenInfo?.symbol || 'UNKNOWN',
                tokenName: tokenInfo?.name || 'Unknown Token',
                side,
                amount: userTradeAmount,
                price: sim.price || 0,
                signature: tradeResult.signature,
                routeInfo: JSON.stringify(sim.routeInfo || {}),
                status: tradeResult.success ? 'completed' : 'failed'
            };

            await database.addTrade(tradeData);

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

    // === AXIOM HELPERS ===
    async simulateAxiomSwap(tokenIn, tokenOut, amountIn, slippageBps = 300) {
        try {
            const sim = await this.solanaService.simulateAxiom({
                tokenIn,
                tokenOut,
                amountIn,
                slippageBps
            });
            if (!sim || !sim.outAmount || sim.outAmount <= 0) return null;
            return sim;
        } catch (error) {
            this.logWithTimestamp('❌ Error simulating Axiom swap:', error);
            return null;
        }
    }

    async executeAxiomSwap(userPrivateKeyEncrypted, sim) {
        try {
            const exec = await this.solanaService.executeAxiom({
                userPrivateKeyEncrypted,
                tokenIn: sim.tokenIn,
                tokenOut: sim.tokenOut,
                amountIn: sim.amountIn,
                minOut: sim.minOut,
                routeInfo: sim.routeInfo,
                axiomAccounts: sim.axiomAccounts,
                axiomData: sim.axiomData
            });
            return exec;
        } catch (error) {
            this.logWithTimestamp('❌ Error executing Axiom swap:', error);
            return null;
        }
    }

    // === TOKEN INFO (NO Jupiter) ===
    async getTokenInfo(tokenAddress) {
        try {
            const wsol = "So11111111111111111111111111111111111111112";
            const mint = tokenAddress === "SOL" ? wsol : tokenAddress;

            if (!this.tokenInfoCache) this.tokenInfoCache = new Map();
            if (this.tokenInfoCache.has(mint)) return this.tokenInfoCache.get(mint);

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
                        tokenSymbol,totalAmount: amount,
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
                const proportionalAmount = amountIn * 0.1;
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

    async validateTrade(user, swap, alphaWallet) {
        try {
            const userTradeAmount = await this.calculateTradeAmount(user, swap, alphaWallet);

            if (userTradeAmount < 0.001) return false;
            if (userTradeAmount > (user.max_trade_amount || 0.1)) return false;

            if (swap.side === 'buy') {
                const balance = await this.solanaService.getWalletBalance(user.wallet_address);
                if (balance < userTradeAmount + 0.01) return false;
            }

            const tokenAddress = swap.side === 'buy' ? swap.tokenOut : swap.tokenIn;
            if (await this.isTokenBlacklisted(tokenAddress)) return false;

            if (swap.side === 'sell') {
                const cacheKey = `${user.id}_${swap.tokenIn}`;
                let position = this.positions.get(cacheKey) || await this.getUserTokenPosition(user.id, swap.tokenIn);
                if (!position || !position.isOpen || position.totalAmount <= 0) return false;
            }

            const sim = await this.solanaService.simulateSwap({
                tokenIn: swap.tokenIn,
                tokenOut: swap.tokenOut,
                amountIn: userTradeAmount,
                slippageBps: Math.floor((user.slippage || 3) * 100)
            });

            return sim && sim.outAmount > 0;
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

    startPositionMonitoring() {
        if (this.positionMonitorInterval) clearInterval(this.positionMonitorInterval);
        this.positionMonitorInterval = setInterval(() => this.monitorPositions(), 30000);
        this.logWithTimestamp('Position monitoring started');
    }

    async monitorPositions() {
        try {
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

            const currentPrice = await this.solanaService.getIndicativePriceUSD(position.tokenAddress);
            if (!currentPrice || currentPrice <= 0) return;

            const entryPrice = position.averagePrice;
            const currentProfitPercent = ((currentPrice - entryPrice) / entryPrice) * 100;

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
            const tokenInfo = await this.getTokenInfo(position.tokenAddress);
            if (!tokenInfo) return;

            const wsol = 'So11111111111111111111111111111111111111112';
            const sim = await this.solanaService.simulateSwap({
                tokenIn: position.tokenAddress,
                tokenOut: wsol,
                amountIn: position.totalAmount,
                slippageBps: Math.floor((user.slippage || 3) * 100)
            });
            if (!sim || !sim.outAmount || sim.outAmount <= 0) return;

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
            }
        } catch (error) {
            this.logWithTimestamp('❌ Error executing auto-sell:', error);
        }
    }

    async getUserOpenPositions(userId) {
        try {
            return await database.getUserOpenPositions(userId);
        } catch (error) {
            return [];
        }
    }

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
            return [];
        }
    }

    async notifyTradeSuccess(telegramId, tradeData, tradeResult, tokenInfo) {
        const message = `🟢 Trade executed for ${tradeData.tokenSymbol}, signature: ${tradeResult.signature}`;
        await this.notifyUser(telegramId, message);
    }

    async notifyTradeFailed(telegramId, tradeData, error) {
        const message = `🔴 Trade failed for ${tradeData.tokenSymbol}, error: ${error}`;
        await this.notifyUser(telegramId, message);
    }

    async notifyUser(telegramId, message) {
        try {
            await this.bot.api.sendMessage(telegramId, message, { parse_mode: 'HTML' });
        } catch (error) { }
    }

    async cleanupOldTrades() {
        try {
            const thirtyDaysAgo = new Date(Date.now() - 30*24*60*60*1000).toISOString();
            await database.db.prepare('DELETE FROM trades WHERE created_at < ? AND status != "pending"').run(thirtyDaysAgo);
        } catch (err) {}
    }

    destroy() {
        if (this.positionMonitorInterval) clearInterval(this.positionMonitorInterval);
        if (this.tradeLimiter) this.tradeLimiter.stop();
        this.positions.clear();
        this.activeUsers.clear();
    }
}

module.exports = TradingEngine;
