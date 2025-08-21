const SolanaService = require('./solanaService');
const database = require('./database');
const Bottleneck = require('bottleneck');
const axios = require('axios');
const { Connection, PublicKey, Transaction } = require('@solana/web3.js');

class TradingEngine {
    constructor(bot) {
        this.bot = bot;
        this.solanaService = new SolanaService();
        this.activeUsers = new Map(); // Cache active users
        this.positions = new Map(); // Track user positions for auto-sell
        
        // Jupiter API configuration
        this.jupiterConfig = {
            baseURL: 'https://quote-api.jup.ag/v6',
            swapURL: 'https://quote-api.jup.ag/v6/swap',
            timeout: 10000
        };

        // Rate limiter for trade execution
        this.tradeLimiter = new Bottleneck({
            maxConcurrent: 3,
            minTime: 1000 // 1 second between trades
        });

        // Position monitoring interval
        this.positionMonitorInterval = null;
        this.startPositionMonitoring();
    }

    async processSwapSignal(swapDetails, alphaWallet) {
        try {
            console.log('Processing swap signal |', 
                Object.entries({ swapDetails, alphaWallet })
                      .map(([k,v]) => `${k}:${JSON.stringify(v)}`)
                      .join(' | ')
            );

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
        try {
            const query = `
                SELECT u.*, aw.wallet_address as alpha_wallet
                FROM users u
                JOIN alpha_wallets aw ON u.id = aw.user_id
                WHERE aw.wallet_address = ? AND aw.active = 1 AND u.wallet_address IS NOT NULL
            `;
            return database.db.prepare(query).all(alphaWallet);
        } catch (err) {
            console.error('DB error fetching users tracking wallet:', err);
            return [];
        }
    }

    async executeCopyTrade(user, swapDetails, alphaWallet) {
        try {
            console.log('Executing copy trade for user:', user.telegram_id); 
            const { side, tokenIn, tokenOut, amountIn, amountOut } = swapDetails;
        
            // Handle auto-sell logic for sell orders
            if (side === 'sell' && user.auto_sell_enabled) {
                const shouldFollowSell = await this.checkAlphaWalletSell(user, tokenIn, alphaWallet);
                if (!shouldFollowSell) {
                    console.log('User has no position to sell or not following alpha sell, skipping');           
                    return;     
                }
            }

            // Validate trade before execution
            if (!await this.validateTrade(user, swapDetails)) return;

            // Check existing position for this token
            let existingPosition = await this.getUserTokenPosition(user.id, tokenOut);
            // Calculate base trade amount
            let userTradeAmount = await this.calculateTradeAmount(user, swapDetails, alphaWallet);

            if (side === 'buy' && existingPosition && existingPosition.isOpen) {
                // Scaling logic: add a fraction of alpha trade to existing position
                const scaleFactor = 0.5; // Scale by 50%, configurable
                userTradeAmount = userTradeAmount * scaleFactor;

                if (userTradeAmount <= 0) {
                    console.log(`Existing position in ${tokenOut}, no scaling needed.`);
                    return;
                }
                console.log(`Scaling existing position in ${tokenOut} by ${userTradeAmount}`);
            }

            if (userTradeAmount <= 0 || userTradeAmount > user.max_trade_amount) {
                console.log('Trade amount outside limits, skipping');
                return;
            }

            // Get token information
            const tokenInfo = await this.getTokenInfo(side === 'buy' ? tokenOut : tokenIn);

            // Get Jupiter quote
            const quote = await this.getJupiterQuote(
                tokenIn,
                tokenOut,
                userTradeAmount,
                user.slippage || 3
            );

        
            if (!quote) {
                await this.notifyUser(user.telegram_id, '❌ Failed to get quote for trade');
                return;
            }
            
            // Execute the actual trade
            const tradeResult = await this.executeJupiterSwap(
                user.private_key,
                quote
            );

            // Record the trade
        
            const tradeData = {
                userId: user.id,
                alphaWallet,
                tokenAddress: side === 'buy' ? tokenOut : tokenIn,
                tokenSymbol: tokenInfo?.symbol || 'UNKNOWN',
                tokenName: tokenInfo?.name || 'Unknown Token',
                side,
                amount: userTradeAmount,
                price: parseFloat(quote.outAmount) / parseFloat(quote.inAmount),
                signature: tradeResult.signature,
                jupiterQuote: JSON.stringify(quote),
                status: tradeResult.success ? 'completed' : 'failed'
            };

            await database.addTrade(tradeData);

            // Update positions tracking
            if (tradeResult.success) {
                await this.updateUserPosition(user.id, tradeData);
                await this.notifyTradeSuccess(user.telegram_id, tradeData, tradeResult, tokenInfo);
            } else {
                await this.notifyTradeFailed(user.telegram_id, tradeData, tradeResult.error);
            }
        } catch (error) {
            console.error('Error executing copy trade:', error);
            await this.notifyUser(user.telegram_id, `❌ Trade execution failed: ${error.message}`);
        }
    }

    async getJupiterQuote(tokenIn, tokenOut, amount, slippage = 3) {
        try {
            const inputDecimals = await this.getTokenDecimals(tokenIn);
            const outputDecimals = await this.getTokenDecimals(tokenOut);
            
            const amountInSmallestUnit = Math.floor(amount * Math.pow(10, inputDecimals));
            
            const params = new URLSearchParams({
                inputMint: tokenIn,
                outputMint: tokenOut,
                amount: amountInSmallestUnit.toString(),
                slippageBps: Math.floor(slippage * 100).toString(),
                onlyDirectRoutes: 'false',
                asLegacyTransaction: 'false'
            });
            
            const url = `${this.jupiterConfig.baseURL}/quote`;
            
            const response = await axios.get(url, {
                params,
                timeout: this.jupiterConfig.timeout
            });
            
            if (!response.data?.routePlan || response.data.routePlan.length === 0) {
                console.warn(`⚠️ Jupiter responded but no routePlan found for ${tokenIn} -> ${tokenOut}`, {
                    responseData: response.data,
                    requestUrl: url,
                    requestParams: params.toString()
                });
                return null;
            }
            
            // Normalize output using actual decimals
            response.data.outAmount = parseFloat(response.data.outAmount) / Math.pow(10, outputDecimals);
            console.log(`Jupiter quote obtained: ${amount} ${tokenIn} -> ${response.data.outAmount} ${tokenOut}`);
            return response.data;
        } catch (error) {
            const status = error?.response?.status;
            const statusText = error?.response?.statusText;
            const data = error?.response?.data;
            
            console.error('Error getting Jupiter quote', {
                message: error.message,
                status,
                statusText,
                data,
                tokenIn,
                tokenOut,
                amount,
                params: params?.toString(),
                url: `${this.jupiterConfig.baseURL}/quote`
            });
            return null;
        }
    }

    async getTokenDecimals(mintAddress) {
        try {
            const mintPubkey = new PublicKey(mintAddress);
            const mintAccountInfo = await this.solanaService.connection.getParsedAccountInfo(mintPubkey);
            
            const decimals = mintAccountInfo.value?.data?.parsed?.info?.decimals;
            if (decimals === undefined) {
                throw new Error(`Failed to fetch decimals for token: ${mintAddress}`);
            }
            return decimals;
        } catch (error) {
            console.error('Error fetching token decimals:', error.message);
            // Default fallback (optional)
            return 9;
        }
    }

    async executeJupiterSwap(privateKey, quote) {
        try {
            const decryptedPrivateKey = this.bot.decryptPrivateKey(privateKey);
            if (!decryptedPrivateKey) throw new Error('Failed to decrypt private key');

            const swapResponse = await axios.post(this.jupiterConfig.swapURL, {
                quoteResponse: quote,
                userPublicKey: quote.accounts?.tokenAccountIn || quote.inputMint,
                wrapAndUnwrapSol: true,
                useSharedAccounts: true,
                feeAccount: undefined,
                computeUnitPriceMicroLamports: 'auto'
            }, { timeout: this.jupiterConfig.timeout });

            if (!swapResponse.data?.swapTransaction) {
                throw new Error('Failed to get swap transaction from Jupiter');
            }

            const signature = await this.solanaService.executeTransaction(
                decryptedPrivateKey,
                swapResponse.data.swapTransaction
            );

            return {
                success: true,
                signature,
                inputAmount: quote.inAmount,
                outputAmount: quote.outAmount,
                priceImpact: quote.priceImpactPct
            };

        } catch (error) {
            console.error('Error executing Jupiter swap:', error.message);
            return { success: false, error: error.message, signature: null };
        }
    }

    //getTokenInfo with cache
    async getTokenInfo(tokenAddress) {
        try {
            if (!this.tokenInfoCache) this.tokenInfoCache = new Map();
            if (this.tokenInfoCache.has(tokenAddress)) return this.tokenInfoCache.get(tokenAddress);
            
            const response = await axios.get(`https://token.jup.ag/strict`, { timeout: 5000 });
            const tokenInfo = response.data.find(t => t.address === tokenAddress);
            
            const result = tokenInfo
                ? { symbol: tokenInfo.symbol, name: tokenInfo.name, decimals: tokenInfo.decimals, logoURI: tokenInfo.logoURI }
                : await this.solanaService.getTokenMetadata(tokenAddress);
            
            if (result) this.tokenInfoCache.set(tokenAddress, result);
            return result;
        
        } catch (error) {
            console.error('Error getting token info:', error);
            return null;
        }
    }

    async updateUserPosition(userId, tradeData) {
        try {
            const { tokenAddress, tokenSymbol, side, amount, price } = tradeData;
            let position = await this.getUserTokenPosition(userId, tokenAddress);
            
            let updatedPosition;
            
            if (!position) {
                // New buy position
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
                    const newAveragePrice = (position.totalAmount * position.averagePrice + amount * price) / newTotalAmount;
                    
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
            // Update cache
            if (updatedPosition) {
                const cacheKey = `${userId}_${tokenAddress}`;
                this.positions.set(cacheKey, updatedPosition);
            }
        } catch (error) {
            console.error('Error updating user position:', error);
        }
    }

    async getUserTokenPosition(userId, tokenAddress) {
        try {
            const cacheKey = `${userId}_${tokenAddress}`;
            // Return cached position if exists
            if (this.positions.has(cacheKey)) {
                return this.positions.get(cacheKey);
            }
            // Fetch from DB
            const position = await database.getUserPosition(userId, tokenAddress);
            // Cache the result
            if (position) {
                this.positions.set(cacheKey, position);
            }
            
            return position || null;
        } catch (error) {
            console.error('Error getting user token position:', error);
            return null;
        }
    }
                    
    
    // Check if user should follow an alpha wallet's sell
    async checkAlphaWalletSell(user, tokenAddress, alphaWallet) {
        try {
            // Get the user's open position for this token
            const position = await this.getUserTokenPosition(user.id, tokenAddress);
            
            if (!position || !position.isOpen || position.totalAmount <= 0) {
                return false; // No position to sell
            }
            
            // Ensure the user actually bought this token due to this alpha wallet
            const buyTrades = await database.getUserBuyTrades(user.id, tokenAddress, alphaWallet);
            // Only follow sell if user bought from this alpha wallet
            return buyTrades.length > 0;
        } catch (error) {
            console.error('Error checking alpha wallet sell:', error);
            return false;
        }
    }

    async calculateTradeAmount(user, swapDetails, alphaWallet) {
        try {
            const { side, amountIn, tokenIn, tokenOut } = swapDetails;
            
            if (side === 'buy') {
                // Try to get position from cache first
                const cacheKey = `${user.id}_${tokenOut}`;
                let existingPosition = this.positions.get(cacheKey);
                
                if (!existingPosition) {
                    // Fallback to DB if not in cache
                    existingPosition = await this.getUserTokenPosition(user.id, tokenOut);
                    if (existingPosition) this.positions.set(cacheKey, existingPosition);
                }
                
                // Check if user already bought this token from the alpha wallet
                const buyTrades = await database.getUserBuyTrades(user.id, tokenOut, alphaWallet);
                
                if (existingPosition && existingPosition.isOpen && buyTrades.length > 0) {
                    console.log(`User already has an open position in ${tokenOut} from this alpha wallet, skipping duplicate buy.`);
                    return 0;
                }
                
                // Determine amount to buy (10% of alpha trade, capped by user max)
                const maxAmount = user.max_trade_amount || 0.1;
                const proportionalAmount = amountIn * 0.1; // 10% of alpha trade
                return Math.min(maxAmount, proportionalAmount, 1.0);
            } else {
                // SELL: follow user's existing position
                const cacheKey = `${user.id}_${tokenIn}`;
                let position = this.positions.get(cacheKey);
                
                if (!position) {
                    position = await this.getUserTokenPosition(user.id, tokenIn);
                    if (position) this.positions.set(cacheKey, position);
                }
                
                if (!position || !position.isOpen || position.totalAmount <= 0) return 0;
                
                // Sell up to 50% of user's position by default
                return Math.min(position.totalAmount, position.totalAmount * 0.5);
            }
        } catch (error) {
            console.error('Error calculating trade amount:', error);
            return 0;
        }
    }

    // Enhanced auto-sell monitoring
    startPositionMonitoring() {
        if (this.positionMonitorInterval) {
            clearInterval(this.positionMonitorInterval);
        }
        
        // Check positions every 30 seconds
        this.positionMonitorInterval = setInterval(() => {
            this.monitorPositions();
        }, 30000);
        
        console.log('Position monitoring started');
    }

    async monitorPositions() {
        try {
            console.log('Monitoring positions for auto-sell...');

            // Get all users with auto-sell enabled and open positions
            const users = await this.getUsersWithAutoSell();

            for (const user of users) {
                const positions = await this.getUserOpenPositions(user.id);

                for (const position of positions) {
                    await this.checkAutoSellConditions(user, position);
                }
            }
        } catch (error) {
            console.error('Error monitoring positions:', error);
        }
    }

    async checkAutoSellConditions(user, position) {
        try {
            // Normalize position.isOpen in case this wasn't transformed earlier
            const isOpen = position.isOpen || position.is_open === 1;
            if (!user.auto_sell_enabled || !isOpen || position.totalAmount <= 0) return;
            
            // Get current token price
            const currentPrice = await this.getCurrentTokenPrice(position.tokenAddress);
            if (!currentPrice || currentPrice <= 0) return;
            
            const entryPrice = position.averagePrice;
            const currentProfitPercent = ((currentPrice - entryPrice) / entryPrice) * 100;
            
            console.log(`Position check: ${position.tokenSymbol} - Entry: ${entryPrice}, Current: ${currentPrice}, P&L: ${currentProfitPercent.toFixed(2)}%`);

            // Check for take profit
            if (currentProfitPercent >= (user.take_profit || 100)) {
                await this.executeAutoSell(user, position, 'take_profit', currentPrice);
                return;
            }
            // Check for stop loss
            if (currentProfitPercent <= -(user.stop_loss || 20)) {
                await this.executeAutoSell(user, position, 'stop_loss', currentPrice);
                return;
            }
        } catch (error) {
            console.error('Error checking auto-sell conditions:', error);
        }
    }

    async executeAutoSell(user, position, reason, currentPrice) {
        try {
            console.log(`Executing auto-sell for ${position.tokenSymbol}: ${reason}`);
            const tokenInfo = await this.getTokenInfo(position.tokenAddress);
            if (!tokenInfo) {
                console.error('Failed to fetch token info for auto-sell');
                return;
            }
            
            // Get Jupiter quote (no need to manually pass decimals)
            const quote = await this.getJupiterQuote(
                position.tokenAddress,
                'So11111111111111111111111111111111111111112', // WSOL
                position.totalAmount,
                user.slippage || 3
            );
            
            if (!quote) {
                console.error('Failed to get quote for auto-sell');
                return;
            }
            
            // Execute swap
            const sellResult = await this.executeJupiterSwap(user.private_key, quote);
            
            if (sellResult.success) {
                const tradeData = {
                    userId: user.id,
                    alphaWallet: 'AUTO_SELL',
                    tokenAddress: position.tokenAddress,
                    tokenSymbol: position.tokenSymbol,
                    tokenName: position.tokenSymbol,
                    side: 'sell',
                    amount: position.totalAmount,
                    price: currentPrice,
                    signature: sellResult.signature,
                    jupiterQuote: JSON.stringify(quote),
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
🔗 <b>Signature:</b> <code>${sellResult.signature}</code>
⏰ <i>${new Date().toLocaleString()}</i>
            `;
                await this.notifyUser(user.telegram_id, message);
            } else {
                console.error('Auto-sell execution failed:', sellResult.error);
                await this.notifyUser(
                    user.telegram_id,
                    `⚠️ Auto-sell failed for ${position.tokenSymbol}: ${sellResult.error}`
                );
            }
        } catch (error) {
            console.error('Error executing auto-sell:', error);
            await this.notifyUser(
                user.telegram_id,
                `❌ Auto-sell error for ${position.tokenSymbol}: ${error.message}`
            );
        }
    }

    async getCurrentTokenPrice(tokenAddress) {
        try {
            // Use Jupiter price API
            const response = await axios.get(`https://price.jup.ag/v4/price?ids=${tokenAddress}`, {
                timeout: 5000
            });

            if (response.data?.data?.[tokenAddress]?.price) {
                return parseFloat(response.data.data[tokenAddress].price);
            }

            // Fallback to getting price through a quote
            const quote = await this.getJupiterQuote(
                tokenAddress,
                'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
                1, // 1 token
                1 // 1% slippage
            );

            if (quote && quote.outAmount) {
                return parseFloat(quote.outAmount) / Math.pow(10, 6); // USDC has 6 decimals
            }

            return 0;
        } catch (error) {
            console.error('Error getting token price:', error);
            return 0;
        }
    }

    async getUserOpenPositions(userId) {
        try {
            return await database.getUserOpenPositions(userId);
        } catch (error) {
            console.error('Error getting user open positions:', error);
            return [];
        }
    }

    async notifyTradeSuccess(telegramId, tradeData, tradeResult, tokenInfo) {
        const priceImpact = tradeResult.priceImpact ? `📊 <b>Price Impact:</b> ${(tradeResult.priceImpact * 100).toFixed(2)}%\n` : '';
        const tokenLogo = tokenInfo?.logoURI ? `🏷️` : '💰';

        const message = `
🟢 <b>Trade Executed Successfully!</b>

💼 <b>Alpha Wallet:</b> <code>${tradeData.alphaWallet.slice(0, 8)}...${tradeData.alphaWallet.slice(-8)}</code>
${tokenLogo} <b>Token:</b> ${tokenInfo?.name || tradeData.tokenSymbol} (${tradeData.tokenSymbol})
📊 <b>Action:</b> ${tradeData.side.toUpperCase()}
💰 <b>Amount:</b> ${tradeData.amount.toFixed(6)} ${tradeData.side === 'buy' ? 'SOL' : tradeData.tokenSymbol}
💲 <b>Price:</b> $${tradeData.price.toFixed(8)}
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
                    },
                    {
                        text: '📊 Jupiter',
                        url: `https://jup.ag/swap/${tradeData.tokenAddress}`
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
💰 <b>Amount:</b> ${tradeData.amount.toFixed(6)} ${tradeData.side === 'buy' ? 'SOL' : tradeData.tokenSymbol}
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

    async validateTrade(user, swapDetails) {
        try {
            const { side, amountIn, tokenOut, tokenIn } = swapDetails;
            const userTradeAmount = await this.calculateTradeAmount(user, swapDetails);
            
            // Minimum trade check
            if (userTradeAmount < 0.001) {
                console.log('Trade amount too small, skipping');
                return false;
            }
            
            // Maximum trade check
            if (userTradeAmount > (user.max_trade_amount || 0.1)) {
                console.log('Trade amount exceeds maximum, skipping');
                return false;
            }
            
            // Buy order: check wallet balance
            if (side === 'buy') {
                const balance = await this.solanaService.getWalletBalance(user.wallet_address);
                if (balance < userTradeAmount + 0.01) {
                    console.log('Insufficient balance for trade');
                    return false;
                }
            }
            
            // Check blacklist
            const tokenAddress = side === 'buy' ? tokenOut : tokenIn;
            
            if (await this.isTokenBlacklisted(tokenAddress)) {
                console.log('Token is blacklisted, skipping');
                return false;
            }
            
            // SELL: check user position via cache first
            if (side === 'sell') {
                const cacheKey = `${user.id}_${tokenIn}`;
                let position = this.positions.get(cacheKey);
                
                if (!position) {
                    position = await this.getUserTokenPosition(user.id, tokenIn);
                    if (position) this.positions.set(cacheKey, position);
                }
                
                if (!position || !position.isOpen || position.totalAmount <= 0) {
                    console.log('No open position to sell, skipping');
                    return false;
                }
            }
            
            // Check Jupiter quote availability
            const quote = await this.getJupiterQuote(tokenIn, tokenOut, userTradeAmount, 1);
            if (!quote) {
                console.log('No Jupiter route available for this trade');
                return false;
            }
            return true;
        } catch (error) {
            console.error('Error validating trade:', error);
            return false;
        }
    }

    async isTokenBlacklisted(tokenAddress) {
        try {
            // Check against known scam tokens and rug pulls
            const blacklistedTokens = await database.getBlacklistedTokens();
            return blacklistedTokens.includes(tokenAddress);
        } catch (error) {
            console.error('Error checking token blacklist:', error);
            return false;
        }
    }

    async getUsersWithAutoSell() {
        try {
            if (!this.autoSellUsersCache || (Date.now() - this.autoSellUsersCacheTime) > 30000) {
                const users = database.db.prepare(
                    'SELECT * FROM users WHERE auto_sell_enabled = 1 AND wallet_address IS NOT NULL'
                ).all();
                
                this.autoSellUsersCache = users;
                this.autoSellUsersCacheTime = Date.now();
            }
            
            return this.autoSellUsersCache || [];
        } catch (err) {
            console.error('DB error fetching users with auto-sell:', err);
            return [];
        }
    }

    async startMonitoring() {
        console.log('Trading engine started monitoring...');
        this.startPositionMonitoring();
    }

    async stopMonitoring() {
        console.log('Trading engine stopped monitoring...');
        if (this.positionMonitorInterval) {
            clearInterval(this.positionMonitorInterval);
            this.positionMonitorInterval = null;
        }
    }

    // Enhanced statistics
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
            console.error('DB error calculating user stats:', err);
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

            console.log(`Emergency stop activated for user ${userId}: ${reason}`);
        } catch (error) {
            console.error('Error during emergency stop:', error);
        }
    }

    async cleanupOldTrades() {
        try {
            const thirtyDaysAgo = new Date(Date.now() - 30*24*60*60*1000).toISOString();
            const result = database.db.prepare(
                'DELETE FROM trades WHERE created_at < ? AND status != "pending"'
            ).run(thirtyDaysAgo);
            console.log(`Cleaned up ${result.changes} old trades`);
        } catch (err) {
            console.error('Error cleaning up old trades:', err);
        }
    }

    // Cleanup method
    destroy() {
        this.stopMonitoring();
        if (this.tradeLimiter) {
            this.tradeLimiter.stop();
        }
        this.positions.clear();
        this.activeUsers.clear();
    }
}

module.exports = TradingEngine;
