// tradingEngine.js
const SolanaService = require('./solanaService');
const database = require('./database');
const Bottleneck = require('bottleneck');
const { PublicKey } = require('@solana/web3.js');
const crypto = require('crypto');

class TradingEngine {
    constructor(bot) {
        this.bot = bot;
        this.solanaService = new SolanaService();
        this.activeUsers = new Map();
        this.positions = new Map();
        this.config = {
            ENCRYPTION: {
                ALGORITHM: 'aes-256-gcm',
                KEY_LENGTH: 32,
                IV_LENGTH: 16,
                TAG_LENGTH: 16,
                SALT: 'solana-bot-salt'
            }
        }

        // Enhanced caching
        this.tokenInfoCache = new Map();
        this.priceCache = new Map();
        this.autoSellUsersCache = null;
        this.autoSellUsersCacheTime = 0;

        // Cache expiry times (in milliseconds)
        this.cacheConfig = {
            tokenInfo: 5 * 60 * 1000, // 5 minutes
            price: 30 * 1000, // 30 seconds
            users: 30 * 1000, // 30 seconds
            positions: 60 * 1000 // 1 minute
        };

        // ⏱️ rate limiter for trade execution
        this.tradeLimiter = new Bottleneck({
            maxConcurrent: 3,
            minTime: 1000
        });

        // Separate limiter for price checks to prevent spam
        this.priceLimiter = new Bottleneck({
            maxConcurrent: 5,
            minTime: 200
        });

        this.positionMonitorInterval = null;
        this.cacheCleanupInterval = null;
        this.startPositionMonitoring();
        this.startCacheCleanup();

        // Trade statistics
        this.stats = {
            tradesProcessed: 0,
            tradesSuccessful: 0,
            tradesFailed: 0,
            lastReset: Date.now()
        };
    }

    logWithTimestamp(...args) {
        console.log(new Date().toISOString(), ...args);
    }

    // === ENHANCED CACHING SYSTEM ===
    setCacheWithExpiry(cache, key, value, expiry) {
        cache.set(key, {
            value,
            expiry: Date.now() + expiry
        });
    }

    getCacheValue(cache, key) {
        const cached = cache.get(key);
        if (!cached) return null;

        if (Date.now() > cached.expiry) {
            cache.delete(key);
            return null;
        }

        return cached.value;
    }

    startCacheCleanup() {
        // Clean up expired cache entries every 5 minutes
        this.cacheCleanupInterval = setInterval(() => {
            this.cleanupExpiredCache();
        }, 5 * 60 * 1000);
    }

    cleanupExpiredCache() {
        const now = Date.now();
        const caches = [this.tokenInfoCache, this.priceCache];

        caches.forEach(cache => {
            for (const [key, item] of cache.entries()) {
                if (item.expiry && now > item.expiry) {
                    cache.delete(key);
                }
            }
        });
    }

    // === ENTRYPOINT FROM WEBHOOK ===
    async processSwapSignal(swapDetails, alphaWallet) {
        try {
            this.stats.tradesProcessed++;

            this.logWithTimestamp(
                'Processing swap signal',
                JSON.stringify({
                    alphaWallet,
                    signature: swapDetails.signature,
                    side: swapDetails?.perspective?.side,
                    tokenIn: swapDetails?.perspective?.tokenIn,
                    tokenOut: swapDetails?.perspective?.tokenOut,
                    amountIn: swapDetails?.perspective?.amountIn,
                    amountOut: swapDetails?.perspective?.amountOut,
                    pair: swapDetails?.perspective?.poolPDA
                })
            );

            const users = await this.getUsersTrackingWallet(alphaWallet);

            if (users.length === 0) {
                this.logWithTimestamp(`No users tracking wallet ${alphaWallet}`);
                return;
            }

            this.logWithTimestamp(`Found ${users.length} users tracking ${alphaWallet}`);

            for (const user of users) {
                await this.tradeLimiter.schedule(() =>
                    this.executeCopyTrade(user, swapDetails, alphaWallet)
                );
            }
        } catch (error) {
            this.logWithTimestamp('❌ Error processing swap signal:', error);
            this.stats.tradesFailed++;
        }
    }

    async getUsersTrackingWallet(alphaWallet) {
        try {
            // Cache key for users tracking specific wallet
            const cacheKey = `tracking_${alphaWallet}`;
            const cached = this.getCacheValue(this.positions, cacheKey);
            if (cached) return cached;

            const query = `
                SELECT u.*, aw.wallet_address as alpha_wallet, aw.nickname as alpha_nickname
                FROM users u
                JOIN alpha_wallets aw ON u.id = aw.user_id
                WHERE aw.wallet_address = ? AND aw.active = 1 AND u.wallet_address IS NOT NULL
            `;
            const users = database.db.prepare(query).all(alphaWallet);

            // Cache for 30 seconds
            this.setCacheWithExpiry(this.positions, cacheKey, users, this.cacheConfig.users);

            return users;
        } catch (err) {
            this.logWithTimestamp('❌ DB error fetching users tracking wallet:', err);
            return [];
        }
    }

    decryptPrivateKey(encryptedKey) {
        try {
            if (!encryptedKey || typeof encryptedKey !== 'string') {
                throw new Error('Invalid encrypted key format');
            }

            const parts = encryptedKey.split(':');
            if (parts.length !== 3) {
                throw new Error('Invalid encrypted key format');
            }

            const [ivHex, tagHex, encryptedData] = parts;
            const key = this.getEncryptionKey();
            const iv = Buffer.from(ivHex, 'hex');
            const tag = Buffer.from(tagHex, 'hex');

            const decipher = crypto.createDecipheriv(this.config.ENCRYPTION.ALGORITHM, key, iv);
            decipher.setAuthTag(tag);

            let decrypted = decipher.update(encryptedData, 'hex', 'utf8');
            decrypted += decipher.final('utf8');

            return decrypted;
        } catch (error) {
            console.error('Decryption error:', this.sanitizeError(error));
            return null;
        }
    }

    getEncryptionKey() {
        const key = process.env.ENCRYPTION_KEY;
        if (!key || key === 'default-key') {
            throw new Error('ENCRYPTION_KEY environment variable must be set and cannot be "default-key"');
        }
        return crypto.scryptSync(key, this.config.ENCRYPTION.SALT, this.config.ENCRYPTION.KEY_LENGTH);
    }

    sanitizeError(error) {
        if (!error) return 'Unknown error';
        const errorStr = error.toString();
        // Remove potential sensitive information
        return errorStr.replace(/private_key|secret|token|key/gi, '[REDACTED]');
    }

    // === MAIN COPY-TRADE EXECUTION ===
    async executeCopyTrade(user, swapDetails, alphaWallet) {
        try {
            const p = swapDetails.perspective || {};
            const { side, tokenIn, tokenOut, amountIn, amountOut, poolPDA } = p;

            this.logWithTimestamp('Executing copy trade for user', user.telegram_id, {
                side, tokenIn: tokenIn?.slice(0, 8), tokenOut: tokenOut?.slice(0, 8), 
                amountIn, amountOut
            });

            // Enhanced sell validation
            if (side === 'sell' && user.auto_sell_enabled) {
                const shouldFollowSell = await this.checkAlphaWalletSell(user, tokenIn, alphaWallet);
                if (!shouldFollowSell) {
                    this.logWithTimestamp('Skip: user has no position to sell or not following alpha sell');
                    return;
                }
            }

            // Pre-validate before expensive operations
            if (!await this.preValidateTrade(user, { side, tokenIn, tokenOut, amountIn, amountOut })) {
                return;
            }

            let existingPosition = await this.getUserTokenPosition(user.id, tokenOut);
            let userTradeAmount = await this.calculateTradeAmount(user, { side, tokenIn, tokenOut, amountIn, amountOut }, alphaWallet);

            // Enhanced position scaling logic
            if (side === 'buy' && existingPosition && existingPosition.isOpen) {
                const scaleFactor = this.calculateScaleFactor(existingPosition, userTradeAmount, user);
                userTradeAmount = userTradeAmount * scaleFactor;

                if (userTradeAmount <= 0.001) {
                    this.logWithTimestamp(`Position scaling resulted in minimal trade amount, skipping`);
                    return;
                }
                this.logWithTimestamp(`Scaling existing position in ${tokenOut?.slice(0, 8)} by factor ${scaleFactor}`);
            }

            if (userTradeAmount <= 0 || userTradeAmount > (user.max_trade_amount || Number.MAX_VALUE)) {
                this.logWithTimestamp('Trade amount outside limits, skipping');
                return;
            }

            // Get token info with caching
            const tokenInfo = await this.getTokenInfo(side === 'buy' ? tokenOut : tokenIn);

            // === PUMPSWAP-SPECIFIC SWAP ===
            const decryptedKey = this.decryptPrivateKey(user.private_key);

            this.logWithTimestamp("PumpSwap params:", {
                tokenIn,
                tokenOut,
                amountIn: userTradeAmount,
                slippageBps: Math.floor((user.slippage || 3) * 100),
                poolPDA
            });

            const exec = await this.executePumpSwapWithRetry(
                decryptedKey,
                {
                    tokenIn,
                    tokenOut,
                    amountIn: userTradeAmount,
                    slippageBps: Math.floor((user.slippage || 3) * 100),
                    poolPDA
                },
                3
            );

            if (!exec?.signature) {
                await this.notifyUser(user.telegram_id, 
                    `❌ Trade execution failed for ${tokenInfo?.symbol || 'token'}.`
                );
                return;
            }

            const tradeResult = {
                success: !!exec?.signature,
                signature: exec?.signature || null,
                inputAmount: exec.inputAmount || userTradeAmount,
                outputAmount: exec.outputAmount || 0,
                priceImpact: exec.priceImpact || 0,
                gasUsed: exec?.gasUsed || 0
            };

            const tradeData = {
                userId: user.id,
                alphaWallet,
                tokenAddress: side === 'buy' ? tokenOut : tokenIn,
                tokenSymbol: tokenInfo?.symbol || 'UNKNOWN',
                tokenName: tokenInfo?.name || 'Unknown Token',
                side,
                amount: userTradeAmount,
                price: exec.price || 0,
                signature: tradeResult.signature,
                routeInfo: JSON.stringify(exec.routeInfo || {}),
                status: tradeResult.success ? 'completed' : 'failed',
                priceImpact: tradeResult.priceImpact,
                gasUsed: tradeResult.gasUsed
            };

            await database.addTrade(tradeData);

            if (tradeResult.success) {
                this.stats.tradesSuccessful++;
                await this.updateUserPosition(user.id, tradeData);
                await this.notifyTradeSuccess(user.telegram_id, tradeData, tradeResult, tokenInfo);

                // Invalidate user position cache
                const cacheKey = `${user.id}_${tradeData.tokenAddress}`;
                this.positions.delete(cacheKey);
            } else {
                this.stats.tradesFailed++;
                await this.notifyTradeFailed(user.telegram_id, tradeData, 'Execution failed');
            }

        } catch (error) {
            this.logWithTimestamp('❌ Error executing copy trade:', error);
            this.stats.tradesFailed++;
            await this.notifyUser(user.telegram_id, `❌ Trade execution failed: ${error.message}`);
        }
    }

    // === ENHANCED VALIDATION ===
    async preValidateTrade(user, swap) {
        const { side, tokenIn, tokenOut } = swap;

        // Quick checks first
        if (!tokenIn || !tokenOut || tokenIn === tokenOut) return false;

        // Check blacklist (cached)
        const tokenToCheck = side === 'buy' ? tokenOut : tokenIn;
        if (await this.isTokenBlacklisted(tokenToCheck)) {
            this.logWithTimestamp(`Token ${tokenToCheck?.slice(0, 8)} is blacklisted`);
            return false;
        }

        // Check user wallet balance for buys
        if (side === 'buy') {
            const balance = await this.solanaService.getWalletBalance(user.wallet_address);
            if (balance < 0.02) { // Need minimum for trade + fees
                this.logWithTimestamp(`Insufficient balance: ${balance} SOL`);
                return false;
            }
        }

        return true;
    }

    calculateScaleFactor(existingPosition, newTradeAmount, user) {
        // More sophisticated scaling based on position size and user preferences
        const positionValue = existingPosition.totalAmount * existingPosition.averagePrice;
        const newTradeValue = newTradeAmount;
        const maxPositionSize = (user.max_trade_amount || 0.1) * 3; // Allow 3x max trade as total position

        if (positionValue + newTradeValue > maxPositionSize) {
            // Reduce trade size to stay within limits
            const allowedAddition = Math.max(0, maxPositionSize - positionValue);
            return Math.min(0.5, allowedAddition / newTradeValue);
        }

        return 0.5; // Default 50% scaling for existing positions
    }

    // === PUMPSWAP HELPERS WITH RETRY LOGIC ===
    async executePumpSwapWithRetry(decryptedKey, swapParams, maxRetries = 3) {
        let lastError;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                const exec = await this.solanaService.executePumpSwap({
                    decryptedKey,
                    tokenIn: swapParams.tokenIn,
                    tokenOut: swapParams.tokenOut,
                    amountIn: swapParams.amountIn,
                    slippageBps: swapParams.slippageBps,
                    poolPDA: swapParams.poolPDA
                });

                if (exec?.signature) {
                    this.logWithTimestamp(`✅ PumpSwap successful on attempt ${attempt}`);
                    return exec;
                }
            } catch (error) {
                lastError = error;
                this.logWithTimestamp(`❌ PumpSwap attempt ${attempt} failed:`, error.message);
                if (attempt < maxRetries) await new Promise(res => setTimeout(res, Math.pow(2, attempt) * 1000));
            }
        }
        this.logWithTimestamp(`❌ All ${maxRetries} PumpSwap attempts failed`);
        return null;
    }

    // === ENHANCED TOKEN INFO WITH CACHING ===
    async getTokenInfo(tokenAddress) {
        try {
            const wsol = "So11111111111111111111111111111111111111112";
            const mint = tokenAddress === "SOL" ? wsol : tokenAddress;

            // Check cache first
            const cached = this.getCacheValue(this.tokenInfoCache, mint);
            if (cached) return cached;

            const meta = await this.solanaService.getTokenMetadata(mint);
            if (meta) {
                // Cache token info for 5 minutes
                this.setCacheWithExpiry(this.tokenInfoCache, mint, meta, this.cacheConfig.tokenInfo);
            }
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

            // Cache key for decimals
            const cacheKey = `decimals_${tokenAddress}`;
            const cached = this.getCacheValue(this.tokenInfoCache, cacheKey);
            if (cached) return cached;

            try {
                const pubkey = new PublicKey(tokenAddress === 'SOL'
                    ? 'So11111111111111111111111111111111111111112'
                    : tokenAddress);
                const accountInfo = await this.solanaService.connection.getParsedAccountInfo(pubkey);
                const decimals = accountInfo.value?.data?.parsed?.info?.decimals;

                if (decimals !== undefined) {
                    this.setCacheWithExpiry(this.tokenInfoCache, cacheKey, decimals, this.cacheConfig.tokenInfo);
                    return decimals;
                }
            } catch (innerErr) {
                this.logWithTimestamp(`Not a valid public key, using default: ${tokenAddress?.slice(0, 8)}`);
            }

            // Cache default value
            this.setCacheWithExpiry(this.tokenInfoCache, cacheKey, 9, this.cacheConfig.tokenInfo);
            return 9;
        } catch (err) {
            this.logWithTimestamp(`Could not fetch decimals for token ${tokenAddress?.slice(0, 8)}: ${err.message}`);
            return 9;
        }
    }

    // === ENHANCED POSITIONS WITH BETTER CACHING ===
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
                    const isOpen = remainingAmount > 0.000001; // Account for floating point precision

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

            // Update cache
            if (updatedPosition) {
                const cacheKey = `${userId}_${tokenAddress}`;
                this.setCacheWithExpiry(this.positions, cacheKey, updatedPosition, this.cacheConfig.positions);
            }
        } catch (error) {
            this.logWithTimestamp('❌ Error updating user position:', error);
        }
    }

    async getUserTokenPosition(userId, tokenAddress) {
        try {
            const cacheKey = `${userId}_${tokenAddress}`;

            // Check cache first
            const cached = this.getCacheValue(this.positions, cacheKey);
            if (cached) return cached;

            const position = await database.getUserPosition(userId, tokenAddress);
            if (position) {
                this.setCacheWithExpiry(this.positions, cacheKey, position, this.cacheConfig.positions);
            }
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

            // Cache buy trades lookup
            const cacheKey = `buytrades_${user.id}_${tokenAddress}_${alphaWallet}`;
            let buyTrades = this.getCacheValue(this.positions, cacheKey);

            if (!buyTrades) {
                buyTrades = await database.getUserBuyTrades(user.id, tokenAddress, alphaWallet);
                this.setCacheWithExpiry(this.positions, cacheKey, buyTrades, this.cacheConfig.users);
            }

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
                const existingPosition = await this.getUserTokenPosition(user.id, tokenOut);

                // Check if user already has position from this alpha wallet
                if (existingPosition && existingPosition.isOpen) {
                    const buyTrades = await database.getUserBuyTrades(user.id, tokenOut, alphaWallet);
                    if (buyTrades.length > 0) {
                        this.logWithTimestamp(`Already holding ${tokenOut?.slice(0, 8)} from this alpha; allowing scaled buy.`);
                    }
                }

                const maxAmount = user.max_trade_amount || 0.1;
                const proportionalAmount = Math.min(amountIn * 0.1, maxAmount * 0.5); // Cap at 50% of max
                return Math.min(maxAmount, proportionalAmount, 1.0);
            } else {
                const position = await this.getUserTokenPosition(user.id, tokenIn);
                if (!position || !position.isOpen || position.totalAmount <= 0) return 0;

                // Enhanced sell calculation - sell percentage based on alpha trade size
                const alphaPercentage = Math.min(amountIn / (amountIn + 1), 0.8); // Max 80% sell
                return Math.min(position.totalAmount, position.totalAmount * alphaPercentage);
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
                if (balance < userTradeAmount + 0.015) return false; // Higher fee buffer
            }

            const tokenAddress = swap.side === 'buy' ? swap.tokenOut : swap.tokenIn;
            if (await this.isTokenBlacklisted(tokenAddress)) return false;

            if (swap.side === 'sell') {
                const position = await this.getUserTokenPosition(user.id, swap.tokenIn);
                if (!position || !position.isOpen || position.totalAmount <= 0) return false;
            }

            return true;
        } catch (error) {
            this.logWithTimestamp('❌ Error validating trade:', error);
            return false;
        }
    }

    async isTokenBlacklisted(tokenAddress) {
        try {
            // Cache blacklist check
            const cacheKey = 'blacklist_tokens';
            let blacklistedTokens = this.getCacheValue(this.tokenInfoCache, cacheKey);

            if (!blacklistedTokens) {
                blacklistedTokens = await database.getBlacklistedTokens();
                this.setCacheWithExpiry(this.tokenInfoCache, cacheKey, blacklistedTokens, this.cacheConfig.tokenInfo);
            }

            return blacklistedTokens.includes(tokenAddress);
        } catch (error) {
            this.logWithTimestamp('❌ Error checking token blacklist:', error);
            return false;
        }
    }

    // === ENHANCED MONITORING ===
    startPositionMonitoring() {
        if (this.positionMonitorInterval) clearInterval(this.positionMonitorInterval);

        // Stagger monitoring intervals to reduce load
        this.positionMonitorInterval = setInterval(() => {
            this.monitorPositions();
        }, 30000);

        this.logWithTimestamp('Position monitoring started with 30s interval');
    }

    async monitorPositions() {
        try {
            const startTime = Date.now();
            const users = await this.getUsersWithAutoSell();
            let positionsChecked = 0;

            for (const user of users) {
                const positions = await this.getUserOpenPositions(user.id);
                for (const position of positions) {
                    await this.checkAutoSellConditions(user, position);
                    positionsChecked++;
                }
            }

            const duration = Date.now() - startTime;
            this.logWithTimestamp(`Position monitoring completed: ${positionsChecked} positions in ${duration}ms`);
        } catch (error) {
            this.logWithTimestamp('❌ Error monitoring positions:', error);
        }
    }

    async checkAutoSellConditions(user, position) {
        try {
            const isOpen = position.isOpen || position.is_open === 1;
            if (!user.auto_sell_enabled || !isOpen || position.totalAmount <= 0) return;

            // Use price limiter to prevent spam
            const currentPrice = await this.priceLimiter.schedule(() => 
                this.getCachedTokenPrice(position.tokenAddress)
            );

            if (!currentPrice || currentPrice <= 0) return;

            const entryPrice = position.averagePrice;
            const currentProfitPercent = ((currentPrice - entryPrice) / entryPrice) * 100;

            const takeProfitThreshold = user.take_profit || 100;
            const stopLossThreshold = user.stop_loss || 20;

            if (currentProfitPercent >= takeProfitThreshold) {
                this.logWithTimestamp(`Take profit triggered: ${position.tokenSymbol} at ${currentProfitPercent.toFixed(2)}%`);
                await this.executeAutoSell(user, position, 'take_profit', currentPrice);
                return;
            }

            if (currentProfitPercent <= -stopLossThreshold) {
                this.logWithTimestamp(`Stop loss triggered: ${position.tokenSymbol} at ${currentProfitPercent.toFixed(2)}%`);
                await this.executeAutoSell(user, position, 'stop_loss', currentPrice);
                return;
            }
        } catch (error) {
            this.logWithTimestamp('❌ Error checking auto-sell conditions:', error);
        }
    }

    async getCachedTokenPrice(tokenAddress) {
        // Check price cache first
        const cached = this.getCacheValue(this.priceCache, tokenAddress);
        if (cached) return cached;

        try {
            const price = await this.solanaService.getIndicativePriceUSD(tokenAddress);
            if (price > 0) {
                this.setCacheWithExpiry(this.priceCache, tokenAddress, price, this.cacheConfig.price);
            }
            return price;
        } catch (error) {
            this.logWithTimestamp('❌ Error fetching token price:', error);
            return 0;
        }
    }

    async executeAutoSell(user, position, reason, currentPrice) {
        try {
            this.logWithTimestamp(`Executing auto-sell for ${position.tokenSymbol}: ${reason}`);

            const tokenInfo = await this.getTokenInfo(position.tokenAddress);
            if (!tokenInfo) {
                this.logWithTimestamp('❌ Could not get token info for auto-sell');
                return;
            }

            const wsol = 'So11111111111111111111111111111111111111112';
            const decryptedKey = this.decryptPrivateKey(user.private_key);
            const exec = await this.executePumpSwapWithRetry(
                decryptedKey,
                {
                    tokenIn: position.tokenAddress,
                    tokenOut: wsol,
                    amountIn: position.totalAmount,
                    slippageBps: Math.floor((user.slippage || 5) * 100)
                },
                2
            );

            if (exec?.signature) {
                const profitLoss = ((currentPrice - position.averagePrice) / position.averagePrice) * 100;

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
                    routeInfo: JSON.stringify(exec.routeInfo || {}),
                    status: 'completed',
                    autoSellReason: reason,
                    profitLoss: profitLoss
                };

                await database.addTrade(tradeData);
                await this.updateUserPosition(user.id, tradeData);

                // Enhanced notification
                const message = `
🔔 <b>Auto-Sell Executed!</b>

🏷️ <b>Token:</b> ${position.tokenSymbol}
🎯 <b>Trigger:</b> ${reason === 'take_profit' ? '🟢 Take Profit' : '🔴 Stop Loss'}
💰 <b>Amount:</b> ${position.totalAmount.toFixed(6)}
💵 <b>Entry:</b> $${position.averagePrice.toFixed(8)}
💵 <b>Exit:</b> $${currentPrice.toFixed(8)}
📈 <b>P&L:</b> ${profitLoss >= 0 ? '🟢' : '🔴'} ${profitLoss.toFixed(2)}%
💎 <b>SOL Received:</b> ~${(exec.outputAmount || 0).toFixed(4)}
🔗 <b>Tx:</b> <code>${exec.signature}</code>

⏰ <i>${new Date().toLocaleString()}</i>
                `;

                await this.notifyUser(user.telegram_id, message);
                this.logWithTimestamp(`Auto-sell completed for user ${user.telegram_id}: ${reason}, P&L: ${profitLoss.toFixed(2)}%`);
            } else {
                this.logWithTimestamp('❌ Auto-sell execution failed');
                await this.notifyUser(user.telegram_id, 
                    `⚠️ Auto-sell failed for ${position.tokenSymbol}. Please check manually.`
                );
            }
        } catch (error) {
            this.logWithTimestamp('❌ Error executing auto-sell:', error);
            await this.notifyUser(user.telegram_id, 
                `❌ Auto-sell error for ${position.tokenSymbol}: ${error.message}`
            );
        }
    }

    async getUserOpenPositions(userId) {
        try {
            // Cache user positions
            const cacheKey = `open_positions_${userId}`;
            const cached = this.getCacheValue(this.positions, cacheKey);
            if (cached) return cached;

            const positions = await database.getUserOpenPositions(userId);
            this.setCacheWithExpiry(this.positions, cacheKey, positions, this.cacheConfig.positions);
            return positions;
        } catch (error) {
            this.logWithTimestamp('❌ Error getting user open positions:', error);
            return [];
        }
    }

    async getUsersWithAutoSell() {
        try {
            if (!this.autoSellUsersCache || (Date.now() - this.autoSellUsersCacheTime) > this.cacheConfig.users) {
                const users = database.db
                    .prepare('SELECT * FROM users WHERE auto_sell_enabled = 1 AND wallet_address IS NOT NULL')
                    .all();
                this.autoSellUsersCache = users;
                this.autoSellUsersCacheTime = Date.now();
            }
            return this.autoSellUsersCache || [];
        } catch (err) {
            this.logWithTimestamp('❌ Error getting users with auto-sell:', err);
            return [];
        }
    }

    // === ENHANCED NOTIFICATIONS ===
    async notifyTradeSuccess(telegramId, tradeData, tradeResult, tokenInfo) {
        try {
            const priceImpactDisplay = tradeResult.priceImpact > 0 
                ? `📊 <b>Price Impact:</b> ${(tradeResult.priceImpact * 100).toFixed(2)}%\n` 
                : '';

            const gasDisplay = tradeResult.gasUsed > 0 
                ? `⛽ <b>Gas Used:</b> ${(tradeResult.gasUsed / 1000000).toFixed(2)}M\n`
                : '';

            const tokenEmoji = this.getTokenEmoji(tradeData.side, tradeData.tokenSymbol);
            const profitEmoji = tradeData.side === 'buy' ? '📈' : '💰';

            const message = `
${tokenEmoji} <b>Trade Executed Successfully!</b>

💼 <b>Alpha:</b> <code>${tradeData.alphaWallet.slice(0, 8)}...${tradeData.alphaWallet.slice(-8)}</code>
🏷️ <b>Token:</b> ${tokenInfo?.name || tradeData.tokenSymbol} (${tradeData.tokenSymbol})
📊 <b>Action:</b> ${tradeData.side.toUpperCase()}
💰 <b>Amount:</b> ${tradeData.amount.toFixed(6)} ${tradeData.side === 'buy' ? 'SOL' : tradeData.tokenSymbol}
💲 <b>Price:</b> $${tradeData.price.toFixed(8)}
${priceImpactDisplay}${gasDisplay}🔗 <b>Signature:</b> <code>${tradeResult.signature}</code>

⏰ <i>${new Date().toLocaleString()}</i>
            `;

            const keyboard = {
                inline_keyboard: [
                    [
                        {
                            text: '🔍 Solscan',
                            url: `https://solscan.io/tx/${tradeResult.signature}`
                        },
                        {
                            text: '📊 DEXScreener',
                            url: `https://dexscreener.com/solana/${tradeData.tokenAddress}`
                        }
                    ]
                ]
            };

            await this.bot.api.sendMessage(telegramId, message, { 
                parse_mode: 'HTML',
                reply_markup: keyboard
            });
        } catch (error) {
            this.logWithTimestamp('❌ Error sending trade success notification:', error);
        }
    }

    async notifyTradeFailed(telegramId, tradeData, error) {
        try {
            const message = `
🔴 <b>Trade Failed</b>

💼 <b>Alpha:</b> <code>${tradeData.alphaWallet.slice(0, 8)}...${tradeData.alphaWallet.slice(-8)}</code>
🏷️ <b>Token:</b> ${tradeData.tokenName || tradeData.tokenSymbol} (${tradeData.tokenSymbol})
📊 <b>Action:</b> ${tradeData.side.toUpperCase()}
💰 <b>Amount:</b> ${tradeData.amount.toFixed(6)} ${tradeData.side === 'buy' ? 'SOL' : tradeData.tokenSymbol}
❌ <b>Reason:</b> ${error}

🔧 <b>Suggestion:</b> Check your balance and slippage settings.

⏰ <i>${new Date().toLocaleString()}</i>
            `;

            await this.bot.api.sendMessage(telegramId, message, { parse_mode: 'HTML' });
        } catch (error) {
            this.logWithTimestamp('❌ Error sending trade failed notification:', error);
        }
    }

    getTokenEmoji(side, tokenSymbol) {
        if (side === 'buy') return '🟢';
        if (side === 'sell') return '🔴';
        return '💱';
    }

    async notifyUser(telegramId, message) {
        try {
            await this.bot.api.sendMessage(telegramId, message, { parse_mode: 'HTML' });
        } catch (error) {
            this.logWithTimestamp('❌ Error sending user notification:', error);
        }
    }

    // === STATISTICS AND MONITORING ===
    getEngineStats() {
        const uptime = Date.now() - this.stats.lastReset;
        const successRate = this.stats.tradesProcessed > 0 
            ? (this.stats.tradesSuccessful / this.stats.tradesProcessed * 100).toFixed(2)
            : 0;

        return {
            uptime: Math.floor(uptime / 1000), // seconds
            tradesProcessed: this.stats.tradesProcessed,
            tradesSuccessful: this.stats.tradesSuccessful,
            tradesFailed: this.stats.tradesFailed,
            successRate: `${successRate}%`,
            cacheStats: {
                tokenInfoCache: this.tokenInfoCache.size,
                priceCache: this.priceCache.size,
                positionsCache: this.positions.size
            },
            activeUsers: this.autoSellUsersCache?.length || 0,
            lastStatsReset: new Date(this.stats.lastReset).toISOString()
        };
    }

    resetStats() {
        this.stats = {
            tradesProcessed: 0,
            tradesSuccessful: 0,
            tradesFailed: 0,
            lastReset: Date.now()
        };
        this.logWithTimestamp('Engine statistics reset');
    }

    // === MAINTENANCE AND CLEANUP ===
    async performMaintenance() {
        try {
            this.logWithTimestamp('Starting engine maintenance...');

            // Clean up expired caches
            this.cleanupExpiredCache();

            // Clean up old trades
            await this.cleanupOldTrades();

            // Update position cache
            await this.refreshPositionCache();

            // Log statistics
            const stats = this.getEngineStats();
            this.logWithTimestamp('Engine stats:', JSON.stringify(stats, null, 2));

            this.logWithTimestamp('Engine maintenance completed');
        } catch (error) {
            this.logWithTimestamp('❌ Error during maintenance:', error);
        }
    }

    async refreshPositionCache() {
        try {
            // Clear position caches to force refresh
            this.positions.clear();
            this.autoSellUsersCache = null;
            this.autoSellUsersCacheTime = 0;

            // Pre-warm cache with active users
            await this.getUsersWithAutoSell();

            this.logWithTimestamp('Position cache refreshed');
        } catch (error) {
            this.logWithTimestamp('❌ Error refreshing position cache:', error);
        }
    }

    async cleanupOldTrades() {
        try {
            const thirtyDaysAgo = new Date(Date.now() - 30*24*60*60*1000).toISOString();
            const result = await database.db
                .prepare('DELETE FROM trades WHERE created_at < ? AND status != "pending"')
                .run(thirtyDaysAgo);

            if (result.changes > 0) {
                this.logWithTimestamp(`Cleaned up ${result.changes} old trades`);
            }
        } catch (err) {
            this.logWithTimestamp('❌ Error cleaning up old trades:', err);
        }
    }

    // === EMERGENCY CONTROLS ===
    async emergencyStopAllTrading(reason = 'Emergency stop activated') {
        try {
            this.logWithTimestamp(`🚨 Emergency stop triggered: ${reason}`);

            // Disable all trading
            await database.db
                .prepare('UPDATE users SET auto_sell_enabled = 0, max_trade_amount = 0')
                .run();

            // Clear caches
            this.autoSellUsersCache = null;
            this.positions.clear();

            // Notify all active users
            const users = await database.db
                .prepare('SELECT telegram_id FROM users WHERE wallet_address IS NOT NULL')
                .all();

            for (const user of users) {
                await this.notifyUser(user.telegram_id, 
                    `🚨 <b>EMERGENCY STOP ACTIVATED</b>\n\n` +
                    `All trading has been disabled.\n` +
                    `Reason: ${reason}\n\n` +
                    `Please contact support if you need assistance.`
                );
            }

            this.logWithTimestamp(`Emergency stop completed - notified ${users.length} users`);
        } catch (error) {
            this.logWithTimestamp('❌ Error during emergency stop:', error);
        }
    }

    async pauseUserTrading(userId, reason = 'Manual pause') {
        try {
            await database.updateUser(userId, { 
                auto_sell_enabled: 0,
                max_trade_amount: 0 
            });

            const user = await database.getUser(userId);
            if (user) {
                await this.notifyUser(user.telegram_id, 
                    `⏸️ <b>Trading Paused</b>\n\n` +
                    `Reason: ${reason}\n` +
                    `All trading has been temporarily disabled.\n\n` +
                    `You can re-enable trading in your settings.`
                );
            }

            // Clear user from cache
            this.autoSellUsersCache = null;

            this.logWithTimestamp(`Trading paused for user ${userId}: ${reason}`);
        } catch (error) {
            this.logWithTimestamp('❌ Error pausing user trading:', error);
        }
    }

    // === CLEANUP AND SHUTDOWN ===
    async gracefulShutdown() {
        this.logWithTimestamp('🔄 Starting graceful shutdown...');

        try {
            // Stop intervals
            if (this.positionMonitorInterval) {
                clearInterval(this.positionMonitorInterval);
                this.positionMonitorInterval = null;
            }

            if (this.cacheCleanupInterval) {
                clearInterval(this.cacheCleanupInterval);
                this.cacheCleanupInterval = null;
            }

            // Stop rate limiters
            if (this.tradeLimiter) {
                await this.tradeLimiter.stop();
            }

            if (this.priceLimiter) {
                await this.priceLimiter.stop();
            }

            // Perform final maintenance
            await this.performMaintenance();

            // Clear all caches
            this.positions.clear();
            this.tokenInfoCache.clear();
            this.priceCache.clear();
            this.activeUsers.clear();
            this.autoSellUsersCache = null;

            this.logWithTimestamp('✅ Graceful shutdown completed');
        } catch (error) {
            this.logWithTimestamp('❌ Error during graceful shutdown:', error);
        }
    }

    destroy() {
        this.gracefulShutdown();
    }
}

module.exports = TradingEngine;
