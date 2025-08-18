const { Bot, InlineKeyboard, session } = require("grammy");
const {
    conversations,
    createConversation,
} = require("@grammyjs/conversations");
const { Menu } = require("@grammyjs/menu");
const crypto = require("crypto");
const bs58 = require("bs58");
const { Keypair } = require("@solana/web3.js");

const database = require("./database");
const SolanaService = require("./solanaService");
const HeliusService = require("./heliusService");

class TelegramBot {
    constructor() {
        // Configuration constants
        this.config = {
            MAX_ALPHA_WALLETS: 3,
            ADDRESS_DISPLAY_LENGTH: 8,
            MAX_NICKNAME_LENGTH: 20,
            TEMP_MESSAGE_TIMEOUT: 5000,
            MAX_RECENT_TRADES: 10,
            ENCRYPTION: {
                ALGORITHM: 'aes-256-gcm',
                KEY_LENGTH: 32,
                IV_LENGTH: 16,
                TAG_LENGTH: 16,
                SALT: 'solana-bot-salt'
            },
            VALIDATION: {
                WALLET_REGEX: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/,
                NICKNAME_REGEX: /^[a-zA-Z0-9\s_-]+$/,
                MIN_SLIPPAGE: 0.1,
                MAX_SLIPPAGE: 50,
                MIN_AMOUNT: 0.01,
                MAX_AMOUNT: 100,
                MIN_TAKE_PROFIT: 1,
                MAX_TAKE_PROFIT: 1000,
                MIN_STOP_LOSS: 1,
                MAX_STOP_LOSS: 95
            }
        };

        this.bot = new Bot(this.validateBotToken());
        this.solanaService = new SolanaService();
        this.heliusService = new HeliusService();

        this.setupMiddleware();
        this.setupMenus();
        this.setupHandlers();
        this.setupCallbackHandlers();
    }

     async init() {
        // Initialize the bot (important for webhook mode)
        await this.bot.init();  
        console.log('✅ Telegram bot initialized (bot.init completed)');
     }

    validateBotToken() {
        const token = process.env.BOT_TOKEN;
        if (!token) {
            throw new Error('BOT_TOKEN environment variable is required');
        }
        return token;
    }

    getEncryptionKey() {
        const key = process.env.ENCRYPTION_KEY;
        if (!key || key === 'default-key') {
            throw new Error('ENCRYPTION_KEY environment variable must be set and cannot be "default-key"');
        }
        return crypto.scryptSync(key, this.config.ENCRYPTION.SALT, this.config.ENCRYPTION.KEY_LENGTH);
    }

    setupMiddleware() {
        // Session management with cleanup
        this.bot.use(
            session({
                initial: () => ({
                    user: null,
                    currentMenu: "main",
                    tempData: {},
                    lastActivity: Date.now()
                }),
            }),
        );

        // Clean up old temp data
        this.bot.use(async (ctx, next) => {
            if (ctx.session.tempData && Object.keys(ctx.session.tempData).length > 0) {
                const now = Date.now();
                const timeout = 30 * 60 * 1000; // 30 minutes
                if (now - (ctx.session.lastActivity || 0) > timeout) {
                    ctx.session.tempData = {};
                }
            }
            ctx.session.lastActivity = Date.now();
            await next();
        });

        // Conversations
        this.bot.use(conversations());
        this.bot.use(createConversation(this.walletConversation.bind(this), "wallet"));
        this.bot.use(createConversation(this.alphaWalletConversation.bind(this), "alphaWallet"));
        this.bot.use(createConversation(this.settingsConversation.bind(this), "settings"));
    }

    setupMenus() {
        // Main menu
        this.mainMenu = new Menu("main")
            .text("👛 Connect Wallet", (ctx) => ctx.conversation.enter("wallet"))
            .text("🎯 Add Alpha Wallets", async (ctx) => {
                await this.deleteMessage(ctx);
                await this.ensureUserSession(ctx);
                await ctx.reply("🎯 <b>Alpha Wallets Management</b>", {
                    parse_mode: "HTML",
                    reply_markup: new InlineKeyboard()
                        .text("➕ Add New Wallet", "alpha_add")
                        .text("📋 View All Wallets", "view_alpha")
                        .row()
                        .text("🗑️ Remove Wallet", "remove_select")
                        .text("🔙 Back", "main_menu"),
                });
            })
            .row()
            .text("⚙️ Trading Settings", async (ctx) => {
                await this.deleteMessage(ctx);
                await this.ensureUserSession(ctx);
                await ctx.reply("⚙️ <b>Trading Settings</b>", {
                    parse_mode: "HTML",
                    reply_markup: new InlineKeyboard()
                        .text("💰 Max Trade Amount", "settings_maxAmount")
                        .text("📈 Slippage %", "settings_slippage")
                        .row()
                        .text("🎯 Take Profit %", "settings_takeprofit")
                        .text("🛑 Stop Loss %", "settings_stoploss")
                        .row()
                        .text("🤖 Auto-Sell Toggle", "autoselltoggle")
                        .text("🔙 Back", "main_menu"),
                });
            })
            .text("📊 My Trades", (ctx) => this.handleWithErrorCatch(ctx, () => this.handleMyTrades(ctx)))
            .row()
            .text("💰 Portfolio", (ctx) => this.handleWithErrorCatch(ctx, () => this.handlePortfolio(ctx)))
            .text("❓ Help", (ctx) => this.handleHelp(ctx));

        this.alphaMenu = new Menu("alpha")
            .text("➕ Add New Wallet", (ctx) => ctx.conversation.enter("alphaWallet"))
            .text("📋 View All Wallets", (ctx) => this.showAlphaWallets(ctx))
            .row()
            .text("🗑️ Remove Wallet", (ctx) => this.handleRemoveAlpha(ctx))
            .text("🔙 Back", (ctx) => this.showMainMenu(ctx));

        // Settings menu
        this.settingsMenu = new Menu("settings")
            .text("💰 Max Trade Amount", (ctx) => this.handleMaxAmount(ctx))
            .text("📈 Slippage %", (ctx) => this.handleSlippage(ctx))
            .row()
            .text("🎯 Take Profit %", (ctx) => this.handleTakeProfit(ctx))
            .text("🛑 Stop Loss %", (ctx) => this.handleStopLoss(ctx))
            .row()
            .text("🤖 Auto-Sell Toggle", (ctx) => this.toggleAutoSell(ctx))
            .text("🔙 Back", (ctx) => this.showMainMenu(ctx));

        // Register menus with the bot
        this.bot.use(this.mainMenu);
        this.bot.use(this.alphaMenu);
        this.bot.use(this.settingsMenu);
    }

    setupHandlers() {
        // Start command
        this.bot.command("start", async (ctx) => {
            await this.handleWithErrorCatch(ctx, async () => {
                await this.handleStart(ctx);
            });
        });

        // Help command
        this.bot.command("help", (ctx) => this.handleHelp(ctx));

        // Status command
        this.bot.command("status", (ctx) => this.handleWithErrorCatch(ctx, () => this.handleStatus(ctx)));

        // Global error handling
        this.bot.catch((err) => {
            const sanitizedError = this.sanitizeError(err.error);
            console.error("Bot error for update", err.ctx.update.update_id, ":", sanitizedError);

            if (err.ctx.chat) {
                err.ctx.reply("❌ An unexpected error occurred. Please try again or contact support.").catch(() => {});
            }
        });
    }

    setupCallbackHandlers() {
        this.bot.on("callback_query", async (ctx) => {
            const data = ctx.callbackQuery.data;

            try {
                await ctx.answerCallbackQuery();
                await this.handleWithErrorCatch(ctx, async () => {
                    await this.routeCallback(ctx, data);
                });
            } catch (error) {
                console.error("Error handling callback query:", this.sanitizeError(error));
                await ctx.answerCallbackQuery("❌ Something went wrong. Please try again.").catch(() => {});
            }
        });
    }

    async routeCallback(ctx, data) {
        const routes = {
            "main_menu": () => this.showMainMenu(ctx),
            "alpha_wallets": () => this.handleAlphaWallets(ctx),
            "alpha_add": () => ctx.conversation.enter("alphaWallet"),
            "connect_wallet": () => ctx.conversation.enter("wallet"),
            "settings": () => this.handleSettings(ctx),
            "settings_maxAmount": () => this.handleMaxAmount(ctx),
            "settings_slippage": () => this.handleSlippage(ctx),
            "settings_takeprofit": () => this.handleTakeProfit(ctx),
            "settings_stoploss": () => this.handleStopLoss(ctx),
            "autoselltoggle": () => this.toggleAutoSell(ctx),
            "portfolio": () => this.handlePortfolio(ctx),
            "view_alpha": () => this.showAlphaWallets(ctx),
            "remove_select": () => this.handleRemoveAlpha(ctx),
            "copy_now": () => this.handleCopyNow(ctx),
            "my_trades": () => this.handleMyTrades(ctx),
            "help": () => this.handleHelp(ctx),
            "status_refresh": () => this.handleStatus(ctx),
            "cancel": async () => {
                await this.deleteMessage(ctx);
                await this.showMainMenu(ctx);
            }
        };

        if (routes[data]) {
            await routes[data]();
        } else if (data.startsWith("remove_alpha_")) {
            const walletId = data.replace("remove_alpha_", "");
            if (this.isValidId(walletId)) {
                await this.removeAlphaWallet(ctx, walletId);
            }
        } else if (data.startsWith("setting_")) {
            const settingType = data.replace("setting_", "");
            if (this.isValidSettingType(settingType)) {
                ctx.session.tempData.settingType = settingType;
                await ctx.conversation.enter("settings");
            }
        } else {
            console.warn(`Unknown callback data: ${data}`);
        }
    }

    // Input validation methods
    validateWalletAddress(address) {
        return typeof address === 'string' && 
               this.config.VALIDATION.WALLET_REGEX.test(address) &&
               address.length >= 32 && address.length <= 44;
    }

    validateNickname(nickname) {
        return typeof nickname === 'string' &&
               nickname.length > 0 &&
               nickname.length <= this.config.MAX_NICKNAME_LENGTH &&
               this.config.VALIDATION.NICKNAME_REGEX.test(nickname);
    }

    validateAmount(amount, min = this.config.VALIDATION.MIN_AMOUNT, max = this.config.VALIDATION.MAX_AMOUNT) {
        return typeof amount === 'number' && 
               amount >= min && 
               amount <= max &&
               !isNaN(amount);
    }

    validatePercentage(percentage, min, max) {
        return typeof percentage === 'number' && 
               percentage >= min && 
               percentage <= max &&
               !isNaN(percentage);
    }

    isValidId(id) {
        return /^\d+$/.test(id);
    }

    isValidSettingType(type) {
        return ['maxAmount', 'slippage', 'takeProfit', 'stopLoss'].includes(type);
    }

    sanitizeInput(input) {
        if (typeof input !== 'string') return '';
        return input.trim().replace(/[<>&"']/g, '');
    }

    sanitizeError(error) {
        if (!error) return 'Unknown error';
        const errorStr = error.toString();
        // Remove potential sensitive information
        return errorStr.replace(/private_key|secret|token|key/gi, '[REDACTED]');
    }

    truncateAddress(address, length = this.config.ADDRESS_DISPLAY_LENGTH) {
        if (!address || typeof address !== 'string') return 'N/A';
        if (address.length <= length * 2) return address;
        return `${address.slice(0, length)}...${address.slice(-length)}`;
    }

    // Enhanced encryption methods
    encryptPrivateKey(privateKey) {
        try {
            if (!privateKey || typeof privateKey !== 'string') {
                throw new Error('Invalid private key format');
            }

            const key = this.getEncryptionKey();
            const iv = crypto.randomBytes(this.config.ENCRYPTION.IV_LENGTH);

            const cipher = crypto.createCipheriv(this.config.ENCRYPTION.ALGORITHM, key, iv);

            let encrypted = cipher.update(privateKey, 'utf8', 'hex');
            encrypted += cipher.final('hex');

            const tag = cipher.getAuthTag();

            // Format: iv:tag:encryptedData
            return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted}`;
        } catch (error) {
            console.error('Encryption error:', this.sanitizeError(error));
            throw new Error('Failed to encrypt private key');
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

    async validatePrivateKey(privateKey) {
        try {
            if (!privateKey || typeof privateKey !== 'string') return false;

            const decoded = bs58.decode(privateKey);
            return decoded.length === 64;
        } catch (error) {
            return false;
        }
    }

    async getPublicKeyFromPrivate(privateKey) {
        try {
            const secretKey = bs58.decode(privateKey);
            const keypair = Keypair.fromSecretKey(secretKey);
            return keypair.publicKey.toString();
        } catch (error) {
            console.error('Error deriving public key:', this.sanitizeError(error));
            return null;
        }
    }

    // User and session management
    async initUser(ctx) {
        try {
            const telegramId = ctx.from.id;
            let user = await database.getUser(telegramId);

            if (!user) {
                await database.createUser(telegramId);
                user = await database.getUser(telegramId);
            }

            if (!user) {
                throw new Error('Failed to create or retrieve user');
            }

            ctx.session.user = user;
            return user;
        } catch (error) {
            console.error('Error initializing user:', this.sanitizeError(error));
            await ctx.reply("❌ Error initializing user. Please try again.");
            throw error;
        }
    }

    // Replace your current ensureUserSession with this
    async ensureUserSession(ctx, { refresh = false } = {}) {
        if (!ctx.session.user || refresh) {
            const telegramId = ctx.from.id;
            let user = await database.getUser(telegramId);
            
            if (!user) {
                await database.createUser(telegramId);
                user = await database.getUser(telegramId);
            }
            
            if (!user) throw new Error("Failed to initialize user");
            ctx.session.user = user;
        }
        return ctx.session.user;
    }

    // UI helpers
    async deleteMessage(ctx, messageId = null) {
        try {
            const targetMessageId = messageId ||
                ctx.callbackQuery?.message?.message_id ||
                ctx.message?.message_id;

            if (targetMessageId) {
                await ctx.api.deleteMessage(
                    ctx.chat?.id || ctx.from.id,
                    targetMessageId
                );
            }
        } catch (error) {
            // Message deletion errors are common and usually not critical
            console.log("Could not delete message:", error.message);
        }
    }

    async sendTemporaryMessage(ctx, text, options = {}, deleteAfter = this.config.TEMP_MESSAGE_TIMEOUT) {
        try {
            const message = await ctx.reply(text, options);

            setTimeout(async () => {
                try {
                    await ctx.api.deleteMessage(ctx.chat.id, message.message_id);
                } catch (error) {
                    // Ignore deletion errors for temporary messages
                }
            }, deleteAfter);

            return message;
        } catch (error) {
            console.error('Error sending temporary message:', this.sanitizeError(error));
        }
    }

    async handleWithErrorCatch(ctx, handler) {
        try {
            await handler();
        } catch (error) {
            console.error('Handler error:', this.sanitizeError(error));
            await ctx.reply("❌ Something went wrong. Please try again or contact support.").catch(() => {});
        }
    }

    // Main UI methods
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
            parse_mode: "HTML",
            reply_markup: this.mainMenu,
        });
    }

    async showMainMenu(ctx) {
    await this.deleteMessage(ctx);

    const user = await this.ensureUserSession(ctx, { refresh: true });
    const alphaWallets = await database.getAlphaWallets(user.id);
    const alphaCount = alphaWallets.length;

    const statusText = `
🏠 <b>Main Menu</b>

👤 <b>User:</b> @${ctx.from.username || ctx.from.first_name}
💼 <b>Wallet:</b> ${user.wallet_address ? this.truncateAddress(user.wallet_address) : "Not connected"}
🎯 <b>Alpha Wallets:</b> ${alphaCount}/${this.config.MAX_ALPHA_WALLETS}
💰 <b>Max Trade:</b> ${user.max_trade_amount} SOL
    `;

    const keyboard = new InlineKeyboard()
        .text("👛 Connect Wallet", "connect_wallet")
        .text("🎯 Add Alpha Wallets", "alpha_add")
        .row()
        .text("⚙️ Trading Settings", "settings");
    if (alphaCount > 0) {
        keyboard.text("🎯 Copy Now", "copy_now");
    }

    keyboard.row()
        .text("📊 My Trades", "my_trades")
        .text("💰 Portfolio", "portfolio")
        .row()
        .text("❓ Help", "help");

    await ctx.reply(statusText, { parse_mode: "HTML", reply_markup: keyboard });
    }

    // Conversation handlers
    async walletConversation(conversation, ctx) {
        await this.deleteMessage(ctx);

        const promptMsg = await ctx.reply(
            "🔐 <b>Connect Your Solana Wallet</b>\n\n" +
            "⚠️ <b>SECURITY WARNING:</b>\n" +
            "• Never share your private key with anyone\n" +
            "• Your key will be encrypted and stored securely\n" +
            "• Consider using a dedicated trading wallet\n\n" +
            "📝 Please send your wallet private key (base58 format):",
            {
                parse_mode: "HTML",
                reply_markup: new InlineKeyboard().text("🔙 Back", "main_menu"),
            }
        );

        const response = await conversation.waitFor(["message:text", "callback_query:data"]);

        if (response.callbackQuery?.data === "main_menu") {
            await this.deleteMessage(ctx, promptMsg.message_id);
            return;
        }

        const privateKey = this.sanitizeInput(response.message?.text || '');
        if (!privateKey) {
            await ctx.reply("❌ Invalid private key format.");
            return;
        }

        try {
            const isValid = await this.validatePrivateKey(privateKey);
            if (!isValid) {
                await ctx.reply("❌ Invalid private key. Please check and try again.");
                return;
            }

            const publicKey = await this.getPublicKeyFromPrivate(privateKey);
            if (!publicKey) {
                await ctx.reply("❌ Could not derive public key. Please check your private key.");
                return;
            }

            const encryptedKey = this.encryptPrivateKey(privateKey);

            await database.updateUser(ctx.from.id, {
                wallet_address: publicKey,
                private_key: encryptedKey,
            });

            // Delete the message containing the private key
            await this.deleteMessage(ctx, response.message.message_id);

            await this.deleteMessage(ctx, promptMsg.message_id);

            // Get wallet balance safely
            let balanceText = "Loading...";
            try {
                const balance = await this.solanaService.getWalletBalance(publicKey);
                balanceText = `${balance.toFixed(4)} SOL`;
            } catch (error) {
                balanceText = "Could not fetch";
                console.error('Error fetching balance:', this.sanitizeError(error));
            }

            await ctx.reply(
                "✅ <b>Wallet Connected Successfully!</b>\n\n" +
                `💼 <b>Address:</b> <code>${publicKey}</code>\n` +
                `💰 <b>Balance:</b> ${balanceText}\n\n` +
                "🎯 Now add some alpha wallets to start copy trading!",
                {
                    parse_mode: "HTML",
                    reply_markup: new InlineKeyboard()
                        .text("🎯 Add Alpha Wallets", "alpha_wallets")
                        .text("🏠 Main Menu", "main_menu")
                        .row(),
                }
            );
        } catch (error) {
            console.error('Wallet connection error:', this.sanitizeError(error));
            await ctx.reply("❌ Error connecting wallet. Please try again.");
        }
    }

    async alphaWalletConversation(conversation, ctx) {
        await this.deleteMessage(ctx);

        const user = await this.ensureUserSession(ctx);
        const currentCount = await this.getAlphaWalletCount(user.id);

        if (currentCount >= this.config.MAX_ALPHA_WALLETS) {
            await ctx.reply(
                `❌ <b>Maximum wallets reached!</b>\n\nYou can only track up to ${this.config.MAX_ALPHA_WALLETS} wallets. Please remove some first.`,
                {
                    parse_mode: "HTML",
                    reply_markup: new InlineKeyboard().text("🔙 Back", "alpha_wallets")
                }
            );
            return;
        }

        const remainingSlots = this.config.MAX_ALPHA_WALLETS - currentCount;

        const promptMsg = await ctx.reply(
            "🎯 <b>Add Alpha Wallet</b>\n\n" +
            "📝 Send wallet address(es) to track:\n" +
            "• Single wallet: <code>ADDRESS</code>\n" +
            "• Multiple wallets: <code>ADDR1,ADDR2,ADDR3</code>\n" +
            `• You can add ${remainingSlots} more wallet(s)\n\n` +
            "💡 <b>Tip:</b> Add a nickname after address: <code>ADDRESS:nickname</code>",
            {
                parse_mode: "HTML",
                reply_markup: new InlineKeyboard().text("🔙 Back", "alpha_wallets"),
            }
        );

        const response = await conversation.waitFor(["message:text", "callback_query:data"]);

        if (response.callbackQuery?.data === "alpha_wallets") {
            await this.deleteMessage(ctx, promptMsg.message_id);
            return;
        }

        const input = this.sanitizeInput(response.message?.text || '');
        if (!input) {
            await ctx.reply("❌ Please provide wallet address(es).");
            return;
        }
        
        await this.deleteMessage(ctx, response.message.message_id);
        await this.deleteMessage(ctx, promptMsg.message_id);

        try {
            const wallets = input
                .split(",")
                .map(w => w.trim())
                .filter(w => w.length > 0)
                .slice(0, remainingSlots);

            if (wallets.length === 0) {
                await ctx.reply("❌ No valid wallet addresses provided.");
                return;
            }

            const results = [];

            for (const wallet of wallets) {
                const [address, nickname] = wallet.includes(":")
                    ? wallet.split(":").map(s => s.trim())
                    : [wallet.trim(), ''];

                // Validate address
                if (!this.validateWalletAddress(address)) {
                    results.push(`❌ Invalid format: ${this.truncateAddress(address)}`);
                    continue;
                }

                // Validate nickname if provided
                const finalNickname = nickname || `Alpha${currentCount + results.filter(r => r.startsWith('✅')).length + 1}`;
                if (!this.validateNickname(finalNickname)) {
                    results.push(`❌ Invalid nickname: ${address.slice(0, 8)}...`);
                    continue;
                }

                // Check if wallet is valid on Solana network
                try {
                    const isValid = await this.solanaService.validateWallet(address);
                    if (!isValid) {
                        results.push(`❌ Invalid wallet: ${this.truncateAddress(address)}`);
                        continue;
                    }
                } catch (error) {
                    results.push(`❌ Cannot validate: ${this.truncateAddress(address)}`);
                    continue;
                }

                // Check if wallet already exists for this user
                const existingWallets = await database.getAlphaWallets(user.id);
                if (existingWallets.some(w => w.wallet_address === address)) {
                    results.push(`⚠️ Already added: ${this.truncateAddress(address)}`);
                    continue;
                }

                // Add wallet
                try {
                    await database.addAlphaWallet(user.id, address, finalNickname);
                    results.push(`✅ Added: ${finalNickname}`);
                } catch (error) {
                    console.error('Error adding alpha wallet:', this.sanitizeError(error));
                    results.push(`❌ Failed to add: ${this.truncateAddress(address)}`);
                }
            }

            // Update webhooks if any wallets were added successfully
            const successCount = results.filter(r => r.startsWith('✅')).length;
            if (successCount > 0) {
                try {
                    await this.updateUserWebhooks(user.id);
                } catch (error) {
                    console.error('Error updating webhooks:', this.sanitizeError(error));
                    results.push('⚠️ Webhooks update failed');
                }
            }

            await ctx.reply(
                "🎯 <b>Alpha Wallet Results:</b>\n\n" + results.join("\n"),
                {
                    parse_mode: "HTML",
                    reply_markup: new InlineKeyboard()
                        .text("📋 View All Wallets", "view_alpha")
                        .text("🏠 Main Menu", "main_menu")
                        .row(),
                }
            );
        } catch (error) {
            console.error('Error in alpha wallet conversation:', this.sanitizeError(error));
            await ctx.reply("❌ Error adding alpha wallet. Please try again.");
        }
    }

    async settingsConversation(conversation, ctx) {
        await this.deleteMessage(ctx);
        const settingType = ctx.session.tempData.settingType;

        if (!this.isValidSettingType(settingType)) {
            await ctx.reply("❌ Invalid setting type.");
            return;
        }

        const prompts = {
            maxAmount: `💰 Enter maximum trade amount (${this.config.VALIDATION.MIN_AMOUNT}-${this.config.VALIDATION.MAX_AMOUNT} SOL):`,
            slippage: `📈 Enter slippage tolerance (${this.config.VALIDATION.MIN_SLIPPAGE}-${this.config.VALIDATION.MAX_SLIPPAGE}%):`,
            takeProfit: `🎯 Enter take profit percentage (${this.config.VALIDATION.MIN_TAKE_PROFIT}-${this.config.VALIDATION.MAX_TAKE_PROFIT}%):`,
            stopLoss: `🛑 Enter stop loss percentage (${this.config.VALIDATION.MIN_STOP_LOSS}-${this.config.VALIDATION.MAX_STOP_LOSS}%):`,
        };

        await ctx.reply(prompts[settingType] || "⚙️ Enter new value:", {
            reply_markup: new InlineKeyboard().text("🔙 Back", "settings"),
        });

        const response = await conversation.waitFor(["message:text", "callback_query:data"]);

        if (response.callbackQuery?.data === "settings") {
            return;
        }

        const valueText = this.sanitizeInput(response.message?.text || '');
        const value = parseFloat(valueText);

        if (isNaN(value) || value <= 0) {
            await ctx.reply("❌ Please enter a valid positive number.");
            return;
        }

        // Validate based on setting type
        let isValid = false;
        let errorMessage = "";

        switch (settingType) {
            case 'maxAmount':
                isValid = this.validateAmount(value);
                errorMessage = `Amount must be between ${this.config.VALIDATION.MIN_AMOUNT} and ${this.config.VALIDATION.MAX_AMOUNT} SOL`;
                break;
            case 'slippage':
                isValid = this.validatePercentage(value, this.config.VALIDATION.MIN_SLIPPAGE, this.config.VALIDATION.MAX_SLIPPAGE);
                errorMessage = `Slippage must be between ${this.config.VALIDATION.MIN_SLIPPAGE}% and ${this.config.VALIDATION.MAX_SLIPPAGE}%`;
                break;
            case 'takeProfit':
                isValid = this.validatePercentage(value, this.config.VALIDATION.MIN_TAKE_PROFIT, this.config.VALIDATION.MAX_TAKE_PROFIT);
                errorMessage = `Take profit must be between ${this.config.VALIDATION.MIN_TAKE_PROFIT}% and ${this.config.VALIDATION.MAX_TAKE_PROFIT}%`;
                break;
            case 'stopLoss':
                isValid = this.validatePercentage(value, this.config.VALIDATION.MIN_STOP_LOSS, this.config.VALIDATION.MAX_STOP_LOSS);
                errorMessage = `Stop loss must be between ${this.config.VALIDATION.MIN_STOP_LOSS}% and ${this.config.VALIDATION.MAX_STOP_LOSS}%`;
                break;
        }

        if (!isValid) {
            await ctx.reply(`❌ ${errorMessage}`);
            return;
        }

        try {
            const updates = {};
            const fieldMap = {
                maxAmount: "max_trade_amount",
                slippage: "slippage",
                takeProfit: "take_profit",
                stopLoss: "stop_loss",
            };

            updates[fieldMap[settingType]] = value;
            await database.updateUser(ctx.from.id, updates);

            // Clear temp data
            delete ctx.session.tempData.settingType;

            const unitMap = {
                maxAmount: " SOL",
                slippage: "%",
                takeProfit: "%",
                stopLoss: "%"
            };

            await ctx.reply(
                `✅ <b>${this.formatSettingName(settingType)} updated successfully!</b>\n\n` +
                `New value: ${value}${unitMap[settingType] || ""}`,
                {
                    parse_mode: "HTML",
                    reply_markup: new InlineKeyboard().text("⚙️ Settings", "settings"),
                }
            );
        } catch (error) {
            console.error('Error updating setting:', this.sanitizeError(error));
            await ctx.reply("❌ Error updating setting. Please try again.");
        }
    }

    formatSettingName(settingType) {
        const nameMap = {
            maxAmount: "Max Trade Amount",
            slippage: "Slippage",
            takeProfit: "Take Profit",
            stopLoss: "Stop Loss"
        };
        return nameMap[settingType] || settingType;
    }

    async handleStart(ctx) {
        try {
            // Ensure the user exists and session is initialized
            const user = await this.initUser(ctx); // or ensureUserSession

            await this.showWelcome(ctx);

            const alphaWallets = await database.getAlphaWallets(user.id);

            // Determine the main menu buttons
            const keyboard = new InlineKeyboard()
            /*if (alphaWallets.length > 0) {
                keyboard.row().text("🎯 Copy Now", "copy_now");
            } else {
                keyboard.row().text("➕ Add Alpha Wallet", "alpha_add");
            }

            // Show the main menu
            /*await ctx.reply("🏠 Main Menu", {
                reply_markup: keyboard,
            });*/

        } catch (error) {
            console.error("Error in handleStart:", this.sanitizeError(error));
            await ctx.reply("❌ Error starting the bot. Please try again.");
        }
    }

    // Handler methods
    async handleAlphaWallets(ctx) {
        const user = await this.ensureUserSession(ctx);
        await this.deleteMessage(ctx);

        const alphaWallets = await database.getAlphaWallets(user.id);

        let message = "🎯 <b>Alpha Wallets Management</b>\n\n";

        if (alphaWallets.length === 0) {
            message +=
                "📭 No alpha wallets added yet.\n\n" +
                "💡 Add wallets of successful traders to copy their trades automatically!";
        } else {
            message += `📊 <b>Tracking ${alphaWallets.length}/${this.config.MAX_ALPHA_WALLETS} wallets:</b>\n\n`;
            alphaWallets.forEach((wallet, index) => {
                message +=
                    `${index + 1}. <b>${wallet.nickname}</b>\n` +
                    `   <code>${this.truncateAddress(wallet.wallet_address)}</code>\n\n`;
            });
        }

        await ctx.reply(message, {
            parse_mode: "HTML",
            reply_markup: this.alphaMenu,
        });
    }

    async handleSettings(ctx) {
        const user = await this.ensureUserSession(ctx);
        await this.deleteMessage(ctx);

        const message = `
⚙️ <b>Trading Settings</b>

💰 <b>Max Trade Amount:</b> ${user.max_trade_amount || 0.1} SOL
📈 <b>Slippage:</b> ${user.slippage || 5}%
🎯 <b>Take Profit:</b> ${user.take_profit || 100}%
🛑 <b>Stop Loss:</b> ${user.stop_loss || 20}%
🤖 <b>Auto-Sell:</b> ${user.auto_sell_enabled ? "✅ Enabled" : "❌ Disabled"}

📝 Select setting to modify:
        `;

        await ctx.reply(message, {
            parse_mode: "HTML",
            reply_markup: this.settingsMenu,
        });
    }

    async handleMyTrades(ctx) {
        const user = await this.ensureUserSession(ctx);
        await this.deleteMessage(ctx);

        try {
            const trades = await database.getUserTrades(user.id, this.config.MAX_RECENT_TRADES);

            let message = "📊 <b>Recent Trades</b>\n\n";

            if (trades.length === 0) {
                message +=
                    "📭 No trades yet.\n\n" +
                    "🚀 Start copy trading by adding alpha wallets and connecting your wallet!";
            } else {
                trades.forEach((trade, index) => {
                    const date = new Date(trade.created_at).toLocaleDateString();
                    const profitEmoji = trade.profit_loss >= 0 ? "🟢" : "🔴";

                    message +=
                        `${index + 1}. ${profitEmoji} <b>${trade.side.toUpperCase()}</b> ${trade.token_symbol || 'Unknown'}\n` +
                        `   💰 ${trade.amount || 0} SOL | 📅 ${date}\n` +
                        `   📈 P&L: ${(trade.profit_loss || 0).toFixed(2)}%\n\n`;
                });
            }

            await ctx.reply(message, {
                parse_mode: "HTML",
                reply_markup: new InlineKeyboard().text("🔙 Back", "main_menu"),
            });
        } catch (error) {
            console.error('Error fetching trades:', this.sanitizeError(error));
            await ctx.reply("❌ Error fetching trades. Please try again.");
        }
    }

    async handlePortfolio(ctx) {
        const user = await this.ensureUserSession(ctx, { refresh: true });
        await this.deleteMessage(ctx);

        if (!user.wallet_address) {
            await ctx.reply(
                "❌ <b>Wallet not connected!</b>\n\nPlease connect your wallet first to view portfolio.",
                {
                    parse_mode: "HTML",
                    reply_markup: new InlineKeyboard().text("👛 Connect Wallet", "main_menu")
                }
            );
            return;
        }

        try {
            // Fetch data with error handling
            let balance = 0;
            let tokenAccounts = [];
            let balanceError = false;

            try {
                balance = await this.solanaService.getWalletBalance(user.wallet_address);
            } catch (error) {
                console.error('Error fetching balance:', this.sanitizeError(error));
                balanceError = true;
            }

            try {
                tokenAccounts = await this.solanaService.getTokenAccounts(user.wallet_address);
            } catch (error) {
                console.error('Error fetching token accounts:', this.sanitizeError(error));
                tokenAccounts = [];
            }

            const totalTrades = database.getTotalTrades(user.id);
            const winRate = database.getWinRate(user.id);
            const totalPnL = database.getTotalPnL(user.id);

            let message = `
💰 <b>Portfolio Overview</b>

👛 <b>Wallet:</b> <code>${this.truncateAddress(user.wallet_address)}</code>
💎 <b>SOL Balance:</b> ${balanceError ? 'Error loading' : `${balance.toFixed(4)} SOL`}
🪙 <b>Token Holdings:</b> ${tokenAccounts.length} tokens

📊 <b>Trading Stats:</b>
• Total Trades: ${totalTrades}
• Win Rate: ${winRate}%
• Total P&L: ${totalPnL.toFixed(2)}%
            `;

            await ctx.reply(message, {
                parse_mode: "HTML",
                reply_markup: new InlineKeyboard()
                    .text("🔄 Refresh", "portfolio")
                    .text("🔙 Back", "main_menu"),
            });
        } catch (error) {
            console.error('Error in portfolio handler:', this.sanitizeError(error));
            await ctx.reply("❌ Error loading portfolio. Please try again.");
        }
    }

    async handleCopyNow(ctx) {
        await this.deleteMessage(ctx);

        // Ensure we have the user session
        const user = await this.ensureUserSession(ctx, { refresh: true });

        // Fetch all active alpha wallets for this user
        const alphaWallets = await database.getAlphaWallets(user.id);

        if (!alphaWallets || alphaWallets.length === 0) {
            await ctx.reply("⚠️ You don't have any alpha wallets yet. Please add at least one to start copying.");
            return;
        }

        try {
            // Prepare an array of wallet addresses
            const walletAddresses = alphaWallets.map(w => w.wallet_address);

            // Call HeliusService to create or update the webhook
            const result = await this.heliusService.createWebhook(walletAddresses, user.id);

            if (result) {
                const keyboard = new InlineKeyboard()
                    .text("📊 My Trades", "my_trades")
                    .text("🔙 Back", "main_menu");
                await ctx.reply(`✅ Copying started! Helius will now track ${walletAddresses.length} alpha wallet(s).`,{reply_markup : keyboard} );
            } else {
                await ctx.reply("❌ Failed to start copying. Please try again later.");
            }
        } catch (error) {
            console.error("Error in handleCopyNow:", error);
            await ctx.reply("❌ An unexpected error occurred while starting copy. Please try again.");
        }
    }

    async handleHelp(ctx) {
        await this.deleteMessage(ctx);

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
• Your private key is encrypted with AES-256-GCM
• Use a dedicated trading wallet
• Never share your private keys
• Keys are never logged or exposed

💡 <b>Tips:</b>
• Start with small amounts
• Monitor your trades regularly
• Adjust settings based on performance
• Maximum ${this.config.MAX_ALPHA_WALLETS} alpha wallets per user

📞 <b>Support:</b> Contact @YourSupport
        `;

        await ctx.reply(helpText, {
            parse_mode: "HTML",
            reply_markup: new InlineKeyboard()
                .text("🔄 Refresh", "help")
                .text("🔙 Back", "main_menu"),
        });
    }

    async handleStatus(ctx) {
        try {
            await this.deleteMessage(ctx);
            const user = await this.ensureUserSession(ctx, { refresh: true });

            const [alphaWallets, recentTrades] = await Promise.all([
                database.getAlphaWallets(user.id),
                database.getUserTrades(user.id, 5)
            ]);

            let walletBalance = 0;
            let balanceStatus = "❌ Not connected";

            if (user.wallet_address) {
                try {
                    walletBalance = await this.solanaService.getWalletBalance(user.wallet_address);
                    balanceStatus = "✅ Connected";
                } catch (error) {
                    balanceStatus = "⚠️ Connected (balance error)";
                    console.error('Error fetching balance for status:', this.sanitizeError(error));
                }
            }

            const statusMessage = `
📊 <b>Bot Status Report</b>

👤 <b>User Info:</b>
• ID: ${ctx.from.id}
• Username: @${ctx.from.username || "N/A"}
• Name: ${ctx.from.first_name || "N/A"}

💼 <b>Wallet Status:</b>
• Status: ${balanceStatus}
• Balance: ${user.wallet_address ? `${walletBalance.toFixed(4)} SOL` : "N/A"}
• Address: ${user.wallet_address ? `<code>${this.truncateAddress(user.wallet_address)}</code>` : "Not connected"}

🎯 <b>Alpha Wallets:</b>
• Count: ${alphaWallets.length}/${this.config.MAX_ALPHA_WALLETS}
• Status: ${alphaWallets.length > 0 ? "✅ Active" : "⏸️ None added"}

📈 <b>Trading Status:</b>
• Recent Trades: ${recentTrades.length}
• Max Trade: ${user.max_trade_amount || 0.1} SOL
• Slippage: ${user.slippage || 5}%
• Auto-sell: ${user.auto_sell_enabled ? "✅ On" : "❌ Off"}

🤖 <b>System Status:</b>
• Bot: ✅ Online
• Database: ✅ Connected  
• Last Update: ${new Date().toLocaleString()}
            `;

            await ctx.reply(statusMessage, {
                parse_mode: "HTML",
                reply_markup: new InlineKeyboard()
                    .text("🔄 Refresh", "status_refresh")
                    .text("🏠 Main Menu", "main_menu"),
            });
        } catch (error) {
            console.error('Error getting status:', this.sanitizeError(error));
            await ctx.reply("❌ Error retrieving status. Please try again.");
        }
    }

    async toggleAutoSell(ctx) {
        try {
            await this.deleteMessage(ctx);
            const user = await this.ensureUserSession(ctx, { refresh: true });
            const newValue = user.auto_sell_enabled ? 0 : 1;

            await database.updateUser(ctx.from.id, {
                auto_sell_enabled: newValue,
            });

            // Update session
            ctx.session.user.auto_sell_enabled = newValue;

            const statusEmoji = newValue ? "✅" : "❌";
            const statusText = newValue ? "enabled" : "disabled";

            await ctx.reply(
                `🤖 <b>Auto-Sell ${statusText.charAt(0).toUpperCase() + statusText.slice(1)}!</b>\n\n` +
                `Status: ${statusEmoji} Auto-sell is now ${statusText}\n\n` +
                (newValue
                    ? "💡 The bot will now automatically sell based on your take profit and stop loss settings."
                    : "⚠️ You will need to manually manage your positions."),
                {
                    parse_mode: "HTML",
                    reply_markup: new InlineKeyboard().text("⚙️ Settings", "settings"),
                }
            );
        } catch (error) {
            console.error('Error toggling auto-sell:', this.sanitizeError(error));
            await ctx.reply("❌ Error updating setting. Please try again.");
        }
    }

    async showAlphaWallets(ctx) {
        await this.deleteMessage(ctx);
        const user = await this.ensureUserSession(ctx);

        try {
            const alphaWallets = await database.getAlphaWallets(user.id);

            if (alphaWallets.length === 0) {
                await ctx.reply(
                    "📭 <b>No Alpha Wallets</b>\n\n" +
                    "You haven't added any alpha wallets yet.\n" +
                    "Add wallets of successful traders to copy their moves!",
                    {
                        parse_mode: "HTML",
                        reply_markup: new InlineKeyboard()
                            .text("➕ Add Wallet", "alpha_add")
                            .text("🔙 Back", "alpha_wallets"),
                    }
                );
                return;
            }

            let message = "📋 <b>Your Alpha Wallets</b>\n\n";

            alphaWallets.forEach((wallet, index) => {
                message +=
                    `${index + 1}. <b>${wallet.nickname}</b>\n` +
                    `   💼 <code>${this.truncateAddress(wallet.wallet_address)}</code>\n` +
                    `   📅 Added: ${new Date(wallet.created_at).toLocaleDateString()}\n\n`;
            });

            await ctx.reply(message, {
                parse_mode: "HTML",
                reply_markup: new InlineKeyboard()
                    .text("➕ Add New", "alpha_add")
                    .text("🗑️ Remove", "remove_select")
                    .row()
                    .text("🔙 Back", "alpha_wallets"),
            });
        } catch (error) {
            console.error('Error showing alpha wallets:', this.sanitizeError(error));
            await ctx.reply("❌ Error loading alpha wallets. Please try again.");
        }
    }

    async handleRemoveAlpha(ctx) {
        await this.deleteMessage(ctx);
        const user = await this.ensureUserSession(ctx);

        try {
            const alphaWallets = await database.getAlphaWallets(user.id);

            if (alphaWallets.length === 0) {
                await ctx.reply("📭 No alpha wallets to remove.", {
                    reply_markup: new InlineKeyboard().text("🔙 Back", "alpha_wallets"),
                });
                return;
            }

            let message = "🗑️ <b>Remove Alpha Wallet</b>\n\nSelect wallet to remove:\n\n";
            const keyboard = new InlineKeyboard();

            alphaWallets.forEach((wallet, index) => {
                message += `${index + 1}. ${wallet.nickname} (${this.truncateAddress(wallet.wallet_address)})\n`;

                // Create keyboard with 2 items per row
                if (index % 2 === 0) {
                    if (index + 1 < alphaWallets.length) {
                        keyboard
                            .text(`${index + 1}. ${wallet.nickname}`, `remove_alpha_${wallet.id}`)
                            .text(`${index + 2}. ${alphaWallets[index + 1].nickname}`, `remove_alpha_${alphaWallets[index + 1].id}`)
                            .row();
                    } else {
                        keyboard.text(`${index + 1}. ${wallet.nickname}`, `remove_alpha_${wallet.id}`).row();
                    }
                }
            });

            keyboard.text("🔙 Back", "alpha_wallets");

            await ctx.reply(message, {
                parse_mode: "HTML",
                reply_markup: keyboard,
            });
        } catch (error) {
            console.error('Error in remove alpha handler:', this.sanitizeError(error));
            await ctx.reply("❌ Error loading alpha wallets. Please try again.");
        }
    }

    async removeAlphaWallet(ctx, walletId) {
        try {
            const user = await this.ensureUserSession(ctx);

            // Validate wallet belongs to user
            const alphaWallets = await database.getAlphaWallets(user.id);
            const walletToRemove = alphaWallets.find(w => w.id.toString() === walletId);

            if (!walletToRemove) {
                await ctx.reply("❌ Wallet not found or access denied.");
                return;
            }

            await database.deleteAlphaWallet(walletId);

            // Update webhooks
            try {
                await this.updateUserWebhooks(user.id);
            } catch (error) {
                console.error('Error updating webhooks after removal:', this.sanitizeError(error));
            }

            await this.deleteMessage(ctx);
            await ctx.reply(
                `✅ <b>Alpha Wallet Removed!</b>\n\n` +
                `"${walletToRemove.nickname}" has been removed from tracking.\n` +
                `Webhooks have been updated.`,
                {
                    parse_mode: "HTML",
                    reply_markup: new InlineKeyboard()
                        .text("📋 View Wallets", "view_alpha")
                        .text("🎯 Alpha Menu", "alpha_wallets"),
                }
            );
        } catch (error) {
            console.error('Error removing alpha wallet:', this.sanitizeError(error));
            await ctx.reply("❌ Error removing wallet. Please try again.");
        }
    }

    // Setting handler methods
    async handleMaxAmount(ctx) {
        ctx.session.tempData.settingType = "maxAmount";
        await ctx.conversation.enter("settings");
    }

    async handleSlippage(ctx) {
        ctx.session.tempData.settingType = "slippage";
        await ctx.conversation.enter("settings");
    }

    async handleTakeProfit(ctx) {
        ctx.session.tempData.settingType = "takeProfit";
        await ctx.conversation.enter("settings");
    }

    async handleStopLoss(ctx) {
        ctx.session.tempData.settingType = "stopLoss";
        await ctx.conversation.enter("settings");
    }

    // Utility methods
    async getAlphaWalletCount(userId) {
        try {
            const wallets = await database.getAlphaWallets(userId);
            return wallets.length;
        } catch (error) {
            console.error('Error getting alpha wallet count:', this.sanitizeError(error));
            return 0;
        }
    }

    async updateUserWebhooks(userId) {
        try {
            const alphaWallets = await database.getAlphaWallets(userId);
            const walletAddresses = alphaWallets.map((w) => w.wallet_address);

            if (walletAddresses.length > 0) {
                const result = await this.heliusService.createWebhook(walletAddresses, userId);
                if (result) {
                    console.log("Webhooks updated successfully for user:", userId);
                    return true;
                } else {
                    console.warn("Webhook creation returned false for user:", userId);
                    return false;
                }
            } else {
                console.log("No alpha wallets to create webhooks for user:", userId);
                // Remove existing webhooks if no wallets
                try {
                    await this.heliusService.deleteWebhook(userId);
                } catch (error) {
                    console.error('Error deleting webhooks:', this.sanitizeError(error));
                }
                return true;
            }
        } catch (error) {
            console.error('Error updating webhooks:', this.sanitizeError(error));
            return false;
        }
    }

    // Database utility methods with better error handling
    async getTotalTrades(userId) {
        try {
            return await new Promise((resolve, reject) => {
                database.db.get(
                    "SELECT COUNT(*) as count FROM trades WHERE user_id = ?",
                    [userId],
                    (err, row) => {
                        if (err) {
                            reject(err);
                        } else {
                            resolve(row?.count || 0);
                        }
                    }
                );
            });
        } catch (error) {
            console.error('Error getting total trades:', this.sanitizeError(error));
            return 0;
        }
    }

    async getWinRate(userId) {
        try {
            const wins = await new Promise((resolve, reject) => {
                database.db.get(
                    "SELECT COUNT(*) as count FROM trades WHERE user_id = ? AND profit_loss > 0",
                    [userId],
                    (err, row) => {
                        if (err) {
                            reject(err);
                        } else {
                            resolve(row?.count || 0);
                        }
                    }
                );
            });

            const total = await this.getTotalTrades(userId);
            return total > 0 ? Math.round((wins / total) * 100) : 0;
        } catch (error) {
            console.error('Error getting win rate:', this.sanitizeError(error));
            return 0;
        }
    }

    async getTotalPnL(userId) {
        try {
            return await new Promise((resolve, reject) => {
                database.db.get(
                    "SELECT SUM(profit_loss) as total FROM trades WHERE user_id = ?",
                    [userId],
                    (err, row) => {
                        if (err) {
                            reject(err);
                        } else {
                            resolve(row?.total || 0);
                        }
                    }
                );
            });
        } catch (error) {
            console.error('Error getting total PnL:', this.sanitizeError(error));
            return 0;
        }
    }

    // Bot lifecycle methods
    start() {
        // Enhanced error handling for the bot
        this.bot.catch((err) => {
            const ctx = err.ctx;
            const sanitizedError = this.sanitizeError(err.error);

            console.error(
                `Bot error for update ${ctx.update.update_id}:`,
                sanitizedError
            );

            // Try to inform the user
            if (ctx.chat) {
                ctx.reply("❌ An unexpected error occurred. Please try again or contact support.")
                    .catch(() => {});
            }
        });

        console.log("🤖 Starting Telegram bot...");

        // Validate environment before starting
        try {
            this.getEncryptionKey(); // This will throw if key is invalid
        } catch (error) {
            console.error("❌ Environment validation failed:", error.message);
            process.exit(1);
        }
        return this.bot;
    }

    stop() {
        /*if (this.bot) {
            this.bot.stop();
            console.log("🤖 Telegram bot stopped");
        }*/
        console.log("🤖 Telegram bot stopped (webhook mode doesn't poll)");
    }

    getBot() {
        return this.bot;
    }

    isHealthy() {
        try {
            return {
                bot: !!this.bot,
                database: !!database.db,
                encryption: !!process.env.ENCRYPTION_KEY && process.env.ENCRYPTION_KEY !== 'default-key',
                services: {
                    solana: !!this.solanaService,
                    helius: !!this.heliusService
                },
                config: {
                    maxAlphaWallets: this.config.MAX_ALPHA_WALLETS,
                    encryptionAlgorithm: this.config.ENCRYPTION.ALGORITHM
                },
                timestamp: new Date().toISOString(),
            };
        } catch (error) {
            return {
                bot: false,
                database: false,
                encryption: false,
                error: this.sanitizeError(error),
                timestamp: new Date().toISOString(),
            };
        }
    }
}

module.exports = TelegramBot;
