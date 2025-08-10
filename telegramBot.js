const { Bot, InlineKeyboard, session } = require('grammy');
const { conversations, createConversation } = require('@grammyjs/conversations');
const { Menu } = require('@grammyjs/menu');
const database = require('./database');
const SolanaService = require('./solanaService');
const HeliusService = require('./heliusService');

class TelegramBot {
    constructor() {
        this.bot = new Bot(process.env.BOT_TOKEN);
        this.solanaService = new SolanaService();
        this.heliusService = new HeliusService();
        
        this.setupMiddleware();
        this.setupMenus();
        this.setupHandlers();
        this.setupCallbackHandlers();
    }

    setupMiddleware() {
        // Session management
        this.bot.use(session({
            initial: () => ({
                user: null,
                currentMenu: 'main',
                tempData: {}
            })
        }));

        // Conversations
        this.bot.use(conversations());
        this.bot.use(createConversation(this.walletConversation.bind(this), 'wallet'));
        this.bot.use(createConversation(this.alphaWalletConversation.bind(this), 'alphaWallet'));
        this.bot.use(createConversation(this.settingsConversation.bind(this), 'settings'));
    }

    setupMenus() {
        // Main menu
        this.mainMenu = new Menu('main')
            .text('👛 Connect Wallet', (ctx) => ctx.conversation.enter('wallet'))
            .text('🎯 Add Alpha Wallets', (ctx) => this.handleAlphaWallets(ctx)).row()
            .text('⚙️ Trading Settings', (ctx) => this.handleSettings(ctx))
            .text('📊 My Trades', (ctx) => this.handleMyTrades(ctx)).row()
            .text('💰 Portfolio', (ctx) => this.handlePortfolio(ctx))
            .text('❓ Help', (ctx) => this.handleHelp(ctx));

        // Alpha wallets menu
        this.alphaMenu = new Menu('alpha')
            .text('➕ Add New Wallet', (ctx) => ctx.conversation.enter('alphaWallet'))
            .text('📋 View All Wallets', (ctx) => this.showAlphaWallets(ctx)).row()
            .text('🗑️ Remove Wallet', (ctx) => this.handleRemoveAlpha(ctx))
            .text('🔙 Back', (ctx) => this.showMainMenu(ctx));

        // Settings menu
        this.settingsMenu = new Menu('settings')
            .text('💰 Max Trade Amount', (ctx) => this.handleMaxAmount(ctx))
            .text('📈 Slippage %', (ctx) => this.handleSlippage(ctx)).row()
            .text('🎯 Take Profit %', (ctx) => this.handleTakeProfit(ctx))
            .text('🛑 Stop Loss %', (ctx) => this.handleStopLoss(ctx)).row()
            .text('🤖 Auto-Sell Toggle', (ctx) => this.toggleAutoSell(ctx))
            .text('🔙 Back', (ctx) => this.showMainMenu(ctx));

        this.bot.use(this.mainMenu);
        this.bot.use(this.alphaMenu);
        this.bot.use(this.settingsMenu);
    }

    setupHandlers() {
        // Start command
        this.bot.command('start', async (ctx) => {
            await this.initUser(ctx);
            await this.showWelcome(ctx);
        });

        // Help command
        this.bot.command('help', (ctx) => this.handleHelp(ctx));

        // Status command
        this.bot.command('status', (ctx) => this.handleStatus(ctx));

        // Error handling
        this.bot.catch((err) => {
            console.error('Bot error:', err);
        });
    }

    setupCallbackHandlers() {
        this.bot.on('callback_query', async (ctx) => {
            const data = ctx.callbackQuery.data;
            
            try {
                await ctx.answerCallbackQuery();
                
                switch (data) {
                    case 'main_menu':
                        await this.showMainMenu(ctx);
                        break;
                    case 'alpha_wallets':
                        await this.handleAlphaWallets(ctx);
                        break;
                    case 'alpha_add':
                        await ctx.conversation.enter('alphaWallet');
                        break;
                    case 'settings':
                        await this.handleSettings(ctx);
                        break;
                    case 'portfolio':
                        await this.handlePortfolio(ctx);
                        break;
                    case 'view_alpha':
                        await this.showAlphaWallets(ctx);
                        break;
                    case 'remove_select':
                        await this.handleRemoveAlpha(ctx);
                        break;
                    case 'status_refresh':
                        await this.handleStatus(ctx);
                        break;
                    default:
                        if (data.startsWith('remove_alpha_')) {
                            const walletId = data.replace('remove_alpha_', '');
                            await this.removeAlphaWallet(ctx, walletId);
                        } else if (data.startsWith('setting_')) {
                            const settingType = data.replace('setting_', '');
                            ctx.session.tempData.settingType = settingType;
                            await ctx.conversation.enter('settings');
                        } else if (data === 'cancel') {
                            await this.deleteMessage(ctx);
                            await this.showMainMenu(ctx);
                        }
                        break;
                }
            } catch (error) {
                console.error('Error handling callback query:', error);
                await ctx.answerCallbackQuery('❌ Something went wrong. Please try again.');
            }
        });
    }

    async initUser(ctx) {
        try {
            const telegramId = ctx.from.id;
            let user = await database.getUser(telegramId);
            
            if (!user) {
                await database.createUser(telegramId);
                user = await database.getUser(telegramId);
            }
            
            ctx.session.user = user;
        } catch (error) {
            console.error('Error initializing user:', error);
            await ctx.reply('❌ Error initializing user. Please try again.');
        }
    }

    async showWelcome(ctx) {
        const welcomeText = `
🚀 <b>Welcome to Solana Copy Trading Bot!</b>

📋 <b>Quick Start:</b>
1️⃣ Connect your Solana wallet
2️⃣ Add alpha wallets to track
3️⃣ Configure trading settings
4️⃣ Start copy trading!

⚡️ <b>Features:</b>
• Real-time copy trading
• Customizable settings
• Auto take-profit/stop-loss
• Trade notifications
• Portfolio tracking

🔐 <b>Security:</b> Your private key is encrypted and never shared.
        `;

        await ctx.reply(welcomeText, { 
            parse_mode: 'HTML',
            reply_markup: this.mainMenu
        });
    }

    async showMainMenu(ctx) {
        await this.deleteMessage(ctx);
        
        const user = ctx.session.user;
        const statusText = `
🏠 <b>Main Menu</b>

👤 <b>User:</b> @${ctx.from.username || ctx.from.first_name}
💼 <b>Wallet:</b> ${user.wallet_address ? `${user.wallet_address.slice(0, 8)}...` : 'Not connected'}
🎯 <b>Alpha Wallets:</b> ${await this.getAlphaWalletCount(user.id)}
💰 <b>Max Trade:</b> ${user.max_trade_amount} SOL
        `;

        await ctx.reply(statusText, {
            parse_mode: 'HTML',
            reply_markup: this.mainMenu
        });
    }

    async walletConversation(conversation, ctx) {
        await ctx.reply(
            '🔐 <b>Connect Your Solana Wallet</b>\n\n' +
            '⚠️ <b>SECURITY WARNING:</b>\n' +
            '• Never share your private key with anyone\n' +
            '• Your key will be encrypted and stored securely\n' +
            '• Consider using a dedicated trading wallet\n\n' +
            '📝 Please send your wallet private key (base58 format):',
            { 
                parse_mode: 'HTML',
                reply_markup: new InlineKeyboard().text('❌ Cancel', 'cancel')
            }
        );

        const response = await conversation.wait();
        
        if (response.message?.text === '/cancel' || response.callbackQuery?.data === 'cancel') {
            await ctx.reply('❌ Wallet connection cancelled.');
            return;
        }

        const privateKey = response.message?.text?.trim();
        if (!privateKey) {
            await ctx.reply('❌ Invalid private key format.');
            return;
        }

        try {
            const isValid = await this.validatePrivateKey(privateKey);
            if (!isValid) {
                await ctx.reply('❌ Invalid private key. Please check and try again.');
                return;
            }

            const publicKey = await this.getPublicKeyFromPrivate(privateKey);
            
            await database.updateUser(ctx.from.id, {
                wallet_address: publicKey,
                private_key: this.encryptPrivateKey(privateKey)
            });

            await this.deleteMessage(ctx, response.message.message_id);
            
            await ctx.reply(
                '✅ <b>Wallet Connected Successfully!</b>\n\n' +
                `💼 <b>Address:</b> <code>${publicKey}</code>\n` +
                `💰 <b>Balance:</b> ${await this.solanaService.getWalletBalance(publicKey)} SOL\n\n` +
                '🎯 Now add some alpha wallets to start copy trading!',
                { 
                    parse_mode: 'HTML',
                    reply_markup: new InlineKeyboard()
                        .text('🎯 Add Alpha Wallets', 'alpha_wallets')
                        .text('🏠 Main Menu', 'main_menu').row()
                }
            );
        } catch (error) {
            console.error('Wallet connection error:', error);
            await ctx.reply('❌ Error connecting wallet. Please try again.');
        }
    }

    async alphaWalletConversation(conversation, ctx) {
        await ctx.reply(
            '🎯 <b>Add Alpha Wallet</b>\n\n' +
            '📝 Send wallet address(es) to track:\n' +
            '• Single wallet: <code>ADDRESS</code>\n' +
            '• Multiple wallets: <code>ADDR1,ADDR2,ADDR3</code>\n' +
            '• Maximum 3 wallets per user\n\n' +
            '💡 <b>Tip:</b> Add a nickname after address: <code>ADDRESS:nickname</code>',
            { 
                parse_mode: 'HTML',
                reply_markup: new InlineKeyboard().text('❌ Cancel', 'cancel')
            }
        );

        const response = await conversation.wait();
        
        if (response.callbackQuery?.data === 'cancel') {
            await ctx.reply('❌ Adding alpha wallet cancelled.');
            return;
        }

        const input = response.message?.text?.trim();
        if (!input) {
            await ctx.reply('❌ Please provide wallet address(es).');
            return;
        }

        try {
            const wallets = input.split(',').map(w => w.trim()).slice(0, 3);
            const results = [];

            for (const wallet of wallets) {
                const [address, nickname] = wallet.includes(':') ? wallet.split(':') : [wallet, ''];
                
                const isValid = await this.solanaService.validateWallet(address);
                if (!isValid) {
                    results.push(`❌ Invalid: ${address.slice(0, 8)}...`);
                    continue;
                }

                await database.addAlphaWallet(
                    ctx.session.user.id,
                    address,
                    nickname || `Alpha${results.length + 1}`
                );
                
                results.push(`✅ Added: ${nickname || address.slice(0, 8)}...`);
            }

            await this.updateUserWebhooks(ctx.session.user.id);

            await ctx.reply(
                '🎯 <b>Alpha Wallet Results:</b>\n\n' + results.join('\n'),
                { 
                    parse_mode: 'HTML',
                    reply_markup: new InlineKeyboard()
                        .text('📋 View All Wallets', 'view_alpha')
                        .text('🏠 Main Menu', 'main_menu').row()
                }
            );
        } catch (error) {
            console.error('Error adding alpha wallet:', error);
            await ctx.reply('❌ Error adding alpha wallet. Please try again.');
        }
    }

    async settingsConversation(conversation, ctx) {
        const settingType = ctx.session.tempData.settingType;
        
        const prompts = {
            maxAmount: '💰 Enter maximum trade amount (SOL):',
            slippage: '📈 Enter slippage tolerance (1-50%):',
            takeProfit: '🎯 Enter take profit percentage (10-1000%):',
            stopLoss: '🛑 Enter stop loss percentage (5-50%):'
        };

        await ctx.reply(
            prompts[settingType] || '⚙️ Enter new value:',
            { reply_markup: new InlineKeyboard().text('❌ Cancel', 'cancel') }
        );

        const response = await conversation.wait();
        
        if (response.callbackQuery?.data === 'cancel') {
            await ctx.reply('❌ Setting update cancelled.');
            return;
        }

        const value = parseFloat(response.message?.text);
        if (isNaN(value)) {
            await ctx.reply('❌ Please enter a valid number.');
            return;
        }

        try {
            const updates = {};
            const fieldMap = {
                maxAmount: 'max_trade_amount',
                slippage: 'slippage',
                takeProfit: 'take_profit',
                stopLoss: 'stop_loss'
            };

            updates[fieldMap[settingType]] = value;
            await database.updateUser(ctx.from.id, updates);

            await ctx.reply(
                `✅ <b>${settingType} updated successfully!</b>\n\n` +
                `New value: ${value}${settingType.includes('Percent') ? '%' : settingType === 'maxAmount' ? ' SOL' : ''}`,
                { 
                    parse_mode: 'HTML',
                    reply_markup: new InlineKeyboard().text('⚙️ Settings', 'settings')
                }
            );
        } catch (error) {
            console.error('Error updating setting:', error);
            await ctx.reply('❌ Error updating setting. Please try again.');
        }
    }

    async handleAlphaWallets(ctx) {
        await this.deleteMessage(ctx);
        
        const alphaWallets = await database.getAlphaWallets(ctx.session.user.id);
        
        let message = '🎯 <b>Alpha Wallets Management</b>\n\n';
        
        if (alphaWallets.length === 0) {
            message += '📭 No alpha wallets added yet.\n\n' +
                      '💡 Add wallets of successful traders to copy their trades automatically!';
        } else {
            message += `📊 <b>Tracking ${alphaWallets.length}/3 wallets:</b>\n\n`;
            alphaWallets.forEach((wallet, index) => {
                message += `${index + 1}. <b>${wallet.nickname}</b>\n` +
                          `   <code>${wallet.wallet_address}</code>\n\n`;
            });
        }

        await ctx.reply(message, {
            parse_mode: 'HTML',
            reply_markup: this.alphaMenu
        });
    }

    async handleSettings(ctx) {
        await this.deleteMessage(ctx);
        
        const user = await database.getUser(ctx.from.id);
        
        const message = `
⚙️ <b>Trading Settings</b>

💰 <b>Max Trade Amount:</b> ${user.max_trade_amount} SOL
📈 <b>Slippage:</b> ${user.slippage}%
🎯 <b>Take Profit:</b> ${user.take_profit}%
🛑 <b>Stop Loss:</b> ${user.stop_loss}%
🤖 <b>Auto-Sell:</b> ${user.auto_sell_enabled ? '✅ Enabled' : '❌ Disabled'}

📝 Select setting to modify:
        `;

        await ctx.reply(message, {
            parse_mode: 'HTML',
            reply_markup: this.settingsMenu
        });
    }

    async handleMyTrades(ctx) {
        await this.deleteMessage(ctx);
        
        const trades = await database.getUserTrades(ctx.session.user.id, 10);
        
        let message = '📊 <b>Recent Trades</b>\n\n';
        
        if (trades.length === 0) {
            message += '📭 No trades yet.\n\n' +
                      '🚀 Start copy trading by adding alpha wallets and connecting your wallet!';
        } else {
            trades.forEach((trade, index) => {
                const date = new Date(trade.created_at).toLocaleDateString();
                const profitEmoji = trade.profit_loss >= 0 ? '🟢' : '🔴';
                
                message += `${index + 1}. ${profitEmoji} <b>${trade.side.toUpperCase()}</b> ${trade.token_symbol}\n` +
                          `   💰 ${trade.amount} SOL | 📅 ${date}\n` +
                          `   📈 P&L: ${trade.profit_loss.toFixed(2)}%\n\n`;
            });
        }

        await ctx.reply(message, {
            parse_mode: 'HTML',
            reply_markup: new InlineKeyboard().text('🔙 Back', 'main_menu')
        });
    }

    async handlePortfolio(ctx) {
        await this.deleteMessage(ctx);
        
        const user = await database.getUser(ctx.from.id);
        if (!user.wallet_address) {
            await ctx.reply('❌ Please connect your wallet first.');
            return;
        }

        const balance = await this.solanaService.getWalletBalance(user.wallet_address);
        const tokenAccounts = await this.solanaService.getTokenAccounts(user.wallet_address);

        let message = `
💰 <b>Portfolio Overview</b>

👛 <b>Wallet:</b> <code>${user.wallet_address.slice(0, 8)}...${user.wallet_address.slice(-8)}</code>
💎 <b>SOL Balance:</b> ${balance.toFixed(4)} SOL
🪙 <b>Token Holdings:</b> ${tokenAccounts.length} tokens

📊 <b>Trading Stats:</b>
• Total Trades: ${await this.getTotalTrades(user.id)}
• Win Rate: ${await this.getWinRate(user.id)}%
• Total P&L: ${await this.getTotalPnL(user.id)}%
        `;

        await ctx.reply(message, {
            parse_mode: 'HTML',
            reply_markup: new InlineKeyboard()
                .text('🔄 Refresh', 'portfolio')
                .text('🔙 Back', 'main_menu')
        });
    }

    async handleHelp(ctx) {
        const helpText = `
❓ <b>Copy Trading Bot Help</b>

🚀 <b>Getting Started:</b>
1. Use /start to begin
2. Connect your Solana wallet
3. Add alpha wallets to track
4. Configure trading settings

⚙️ <b>Commands:</b>
• /start - Start the bot
• /help - Show this help
• /status - Show bot status

🔒 <b>Security:</b>
• Your private key is encrypted
• Use a dedicated trading wallet
• Never share your private keys

💡 <b>Tips:</b>
• Start with small amounts
• Monitor your trades regularly
• Adjust settings based on performance

📞 <b>Support:</b> Contact @YourSupport
        `;

        await ctx.reply(helpText, { parse_mode: 'HTML' });
    }

    async handleStatus(ctx) {
        try {
            await this.deleteMessage(ctx);
            
            const user = await database.getUser(ctx.from.id);
            const alphaWallets = await database.getAlphaWallets(user?.id || 0);
            const recentTrades = await database.getUserTrades(user?.id || 0, 5);

            let walletBalance = 0;
            if (user?.wallet_address) {
                walletBalance = await this.solanaService.getWalletBalance(user.wallet_address);
            }

            const statusMessage = `
📊 <b>Bot Status Report</b>

👤 <b>User Info:</b>
• ID: ${ctx.from.id}
• Username: @${ctx.from.username || 'N/A'}
• Name: ${ctx.from.first_name || 'N/A'}

💼 <b>Wallet Status:</b>
• Connected: ${user?.wallet_address ? '✅ Yes' : '❌ No'}
• Balance: ${walletBalance.toFixed(4)} SOL
• Address: ${user?.wallet_address ? `<code>${user.wallet_address.slice(0, 8)}...${user.wallet_address.slice(-8)}</code>` : 'Not connected'}

🎯 <b>Alpha Wallets:</b>
• Count: ${alphaWallets.length}/3
• Status: ${alphaWallets.length > 0 ? '✅ Active' : '⏸️ None added'}

📈 <b>Trading Status:</b>
• Recent Trades: ${recentTrades.length}
• Max Trade: ${user?.max_trade_amount || 0.1} SOL
• Slippage: ${user?.slippage || 5}%
• Auto-sell: ${user?.auto_sell_enabled ? '✅ On' : '❌ Off'}

🤖 <b>System Status:</b>
• Bot: ✅ Online
• Database: ✅ Connected  
• Last Update: ${new Date().toLocaleString()}
            `;

            await ctx.reply(statusMessage, { 
                parse_mode: 'HTML',
                reply_markup: new InlineKeyboard()
                    .text('🔄 Refresh', 'status_refresh')
                    .text('🏠 Main Menu', 'main_menu')
            });
        } catch (error) {
            console.error('Error getting status:', error);
            await ctx.reply('❌ Error retrieving status. Please try again.');
        }
    }

    async toggleAutoSell(ctx) {
        try {
            await this.deleteMessage(ctx);
            
            const user = await database.getUser(ctx.from.id);
            const newValue = user.auto_sell_enabled ? 0 : 1;
            
            await database.updateUser(ctx.from.id, { auto_sell_enabled: newValue });
            
            const statusEmoji = newValue ? '✅' : '❌';
            const statusText = newValue ? 'enabled' : 'disabled';
            
            await ctx.reply(
                `🤖 <b>Auto-Sell ${statusText.charAt(0).toUpperCase() + statusText.slice(1)}!</b>\n\n` +
                `Status: ${statusEmoji} Auto-sell is now ${statusText}\n\n` +
                (newValue ? 
                    '💡 The bot will now automatically sell based on your take profit and stop loss settings.' :
                    '⚠️ You will need to manually manage your positions.'
                ),
                { 
                    parse_mode: 'HTML',
                    reply_markup: new InlineKeyboard().text('⚙️ Settings', 'settings')
                }
            );
        } catch (error) {
            console.error('Error toggling auto-sell:', error);
            await ctx.reply('❌ Error updating setting. Please try again.');
        }
    }

    async showAlphaWallets(ctx) {
        await this.deleteMessage(ctx);
        
        const alphaWallets = await database.getAlphaWallets(ctx.session.user.id);
        
        if (alphaWallets.length === 0) {
            await ctx.reply(
                '📭 <b>No Alpha Wallets</b>\n\n' +
                'You haven\'t added any alpha wallets yet.\n' +
                'Add wallets of successful traders to copy their moves!', 
                {
                    parse_mode: 'HTML',
                    reply_markup: new InlineKeyboard()
                        .text('➕ Add Wallet', 'alpha_add')
                        .text('🔙 Back', 'alpha_wallets')
                }
            );
            return;
        }

        let message = '📋 <b>Your Alpha Wallets</b>\n\n';
        
        alphaWallets.forEach((wallet, index) => {
            const truncatedAddress = `${wallet.wallet_address.slice(0, 6)}...${wallet.wallet_address.slice(-6)}`;
            message += `${index + 1}. <b>${wallet.nickname}</b>\n` +
                      `   💼 <code>${truncatedAddress}</code>\n` +
                      `   📅 Added: ${new Date(wallet.created_at).toLocaleDateString()}\n\n`;
        });

        await ctx.reply(message, {
            parse_mode: 'HTML',
            reply_markup: new InlineKeyboard()
                .text('➕ Add New', 'alpha_add')
                .text('🗑️ Remove', 'remove_select').row()
                .text('🔙 Back', 'alpha_wallets')
        });
    }

    async handleRemoveAlpha(ctx) {
        await this.deleteMessage(ctx);
        
        const alphaWallets = await database.getAlphaWallets(ctx.session.user.id);
        
        if (alphaWallets.length === 0) {
            await ctx.reply('📭 No alpha wallets to remove.', {
                reply_markup: new InlineKeyboard().text('🔙 Back', 'alpha_wallets')
            });
            return;
        }

        let message = '🗑️ <b>Remove Alpha Wallet</b>\n\nSelect wallet to remove:\n\n';
        const keyboard = new InlineKeyboard();

        alphaWallets.forEach((wallet, index) => {
            message += `${index + 1}. ${wallet.nickname} (${wallet.wallet_address.slice(0, 8)}...)\n`;
            
            if (index % 2 === 0) {
                keyboard.text(`${index + 1}. ${wallet.nickname}`, `remove_alpha_${wallet.id}`);
            } else {
                keyboard.text(`${index + 1}. ${wallet.nickname}`, `remove_alpha_${wallet.id}`).row();
            }
        });

        keyboard.text('🔙 Back', 'alpha_wallets');

        await ctx.reply(message, {
            parse_mode: 'HTML',
            reply_markup: keyboard
        });
    }

    async removeAlphaWallet(ctx, walletId) {
        try {
            await database.deleteAlphaWallet(walletId);
            await this.updateUserWebhooks(ctx.session.user.id);
            
            await this.deleteMessage(ctx);
            await ctx.reply(
                '✅ <b>Alpha Wallet Removed!</b>\n\n' +
                'The wallet has been removed from tracking.\n' +
                'Webhooks have been updated.',
                {
                    parse_mode: 'HTML',
                    reply_markup: new InlineKeyboard()
                        .text('📋 View Wallets', 'view_alpha')
                        .text('🎯 Alpha Menu', 'alpha_wallets')
                }
            );
        } catch (error) {
            console.error('Error removing alpha wallet:', error);
            await ctx.reply('❌ Error removing wallet. Please try again.');
        }
    }

    async handleMaxAmount(ctx) {
        ctx.session.tempData.settingType = 'maxAmount';
        await ctx.conversation.enter('settings');
    }

    async handleSlippage(ctx) {
        ctx.session.tempData.settingType = 'slippage';
        await ctx.conversation.enter('settings');
    }

    async handleTakeProfit(ctx) {
        ctx.session.tempData.settingType = 'takeProfit';
        await ctx.conversation.enter('settings');
    }

    async handleStopLoss(ctx) {
        ctx.session.tempData.settingType = 'stopLoss';
        await ctx.conversation.enter('settings');
    }

    async deleteMessage(ctx, messageId = null) {
        try {
            const targetMessageId = messageId || ctx.callbackQuery?.message?.message_id || ctx.message?.message_id;
            if (targetMessageId) {
                await ctx.api.deleteMessage(ctx.chat?.id || ctx.from.id, targetMessageId);
            }
        } catch (error) {
            console.log('Could not delete message:', error.message);
        }
    }

    async getAlphaWalletCount(userId) {
        try {
            const wallets = await database.getAlphaWallets(userId);
            return wallets.length;
        } catch (error) {
            return 0;
        }
    }

    encryptPrivateKey(privateKey) {
        const crypto = require('crypto');
        const algorithm = 'aes-256-cbc';
        const key = crypto.scryptSync(process.env.ENCRYPTION_KEY || 'default-key', 'salt', 32);
        const iv = crypto.randomBytes(16);
        
        const cipher = crypto.createCipher(algorithm, key);
        let encrypted = cipher.update(privateKey, 'utf8', 'hex');
        encrypted += cipher.final('hex');
        
        return `${iv.toString('hex')}:${encrypted}`;
    }

    decryptPrivateKey(encryptedKey) {
        try {
            const crypto = require('crypto');
            const algorithm = 'aes-256-cbc';
            const key = crypto.scryptSync(process.env.ENCRYPTION_KEY || 'default-key', 'salt', 32);
            
            const [ivHex, encryptedData] = encryptedKey.split(':');
            const decipher = crypto.createDecipher(algorithm, key);
            
            let decrypted = decipher.update(encryptedData, 'hex', 'utf8');
            decrypted += decipher.final('utf8');
            
            return decrypted;
        } catch (error) {
            console.error('Decryption error:', error);
            return null;
        }
    }

    async validatePrivateKey(privateKey) {
        try {
            if (!privateKey || typeof privateKey !== 'string') return false;
            
            const bs58 = require('bs58');
            const decoded = bs58.decode(privateKey);
            return decoded.length === 64;
        } catch (error) {
            return false;
        }
    }

    async getPublicKeyFromPrivate(privateKey) {
        try {
            const { Keypair } = require('@solana/web3.js');
            const bs58 = require('bs58');
            
            const secretKey = bs58.decode(privateKey);
            const keypair = Keypair.fromSecretKey(secretKey);
            return keypair.publicKey.toString();
        } catch (error) {
            console.error('Error deriving public key:', error);
            return null;
        }
    }

    async updateUserWebhooks(userId) {
        try {
            const alphaWallets = await database.getAlphaWallets(userId);
            const walletAddresses = alphaWallets.map(w => w.wallet_address);
            
            if (walletAddresses.length > 0) {
                const result = await this.heliusService.createWebhook(walletAddresses, userId);
                if (result) {
                    console.log('Webhooks updated successfully for user:', userId);
                    return true;
                }
            } else {
                console.log('No alpha wallets to create webhooks for user:', userId);
            }
            return false;
        } catch (error) {
            console.error('Error updating webhooks:', error);
            return false;
        }
    }

    async getTotalTrades(userId) {
        return new Promise((resolve) => {
            database.db.get(
                'SELECT COUNT(*) as count FROM trades WHERE user_id = ?',
                [userId],
                (err, row) => resolve(row?.count || 0)
            );
        });
    }

    async getWinRate(userId) {
        return new Promise((resolve) => {
            database.db.get(
                'SELECT COUNT(*) as wins FROM trades WHERE user_id = ? AND profit_loss > 0',
                [userId],
                async (err, row) => {
                    const wins = row?.count || 0;
                    const total = await this.getTotalTrades(userId);
                    resolve(total > 0 ? Math.round((wins / total) * 100) : 0);
                }
            );
        });
    }

    async getTotalPnL(userId) {
        return new Promise((resolve) => {
            database.db.get(
                'SELECT SUM(profit_loss) as total FROM trades WHERE user_id = ?',
                [userId],
                (err, row) => resolve(row?.total || 0)
            );
        });
    }

    async sendTemporaryMessage(ctx, text, options = {}, deleteAfter = 5000) {
        try {
            const message = await ctx.reply(text, options);
            
            setTimeout(async () => {
                try {
                    await ctx.api.deleteMessage(ctx.chat.id, message.message_id);
                } catch (error) {
                    // Ignore deletion errors
                }
            }, deleteAfter);
            
            return message;
        } catch (error) {
            console.error('Error sending temporary message:', error);
        }
    }

    async handleWithErrorCatch(ctx, handler) {
        try {
            await handler(ctx);
        } catch (error) {
            console.error('Handler error:', error);
            await ctx.reply('❌ Something went wrong. Please try again or contact support.');
        }
    }

    start() {
        this.bot.catch((err) => {
            const ctx = err.ctx;
            console.error('Bot error for update', ctx.update.update_id, ':', err.error);
            
            if (ctx.chat) {
                ctx.reply('❌ An error occurred. Please try again.').catch(() => {});
            }
        });
        
        console.log('🤖 Starting Telegram bot...');
        
        this.bot.start({
            drop_pending_updates: true,
            onStart: (botInfo) => {
                console.log('✅ Telegram bot started successfully');
                console.log(`📱 Bot: @${botInfo.username}`);
                console.log(`🆔 Bot ID: ${botInfo.id}`);
            }
        });

        return this.bot;
    }

    stop() {
        if (this.bot) {
            this.bot.stop();
            console.log('🤖 Telegram bot stopped');
        }
    }

    getBot() {
        return this.bot;
    }

    isHealthy() {
        return {
            bot: !!this.bot,
            database: !!database.db,
            timestamp: new Date().toISOString()
        };
    }
}

module.exports = TelegramBot;
