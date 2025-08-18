require('dotenv').config();
const path = require('path');
const fs = require('fs');

// Create data directory if it doesn't exist
const dataDir = path.join(__dirname, '../data');
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

const TelegramBot = require('./telegramBot');
const WebhookServer = require('./webhook');
const database = require('./database');

class CopyTradingBot {
    constructor() {
        this.telegramBot = null;
        this.webhookServer = null;
        this.isRunning = false;
    }

    async start() {
        try {
            console.log('🚀 Starting Solana Copy Trading Bot...');
            
            // Validate environment variables
            this.validateEnvironment();
            
            // Initialize database
            console.log('📊 Initializing database...');
            await this.waitForDatabase();
            
            // Start Telegram bot
            console.log('🤖 Starting Telegram bot...');
            this.telegramBot = new TelegramBot();
            
            const botInstance = this.telegramBot.getBot(); // <- call the method
            botInstance.start({
                drop_pending_updates: true,
                onStart: (botInfo) => {
                    console.log("✅ Telegram bot started successfully");
                    console.log(`📱 Bot: @${botInfo.username}`);
                    console.log(`🆔 Bot ID: ${botInfo.id}`);
                    console.log(`🔒 Encryption: AES-256-GCM enabled`);
                    console.log(`📊 Max alpha wallets: ${this.config.MAX_ALPHA_WALLETS}`);
                },
            });
            
            // Start webhook server
            console.log('🌐 Starting webhook server...');
            this.webhookServer = new WebhookServer();
            this.webhookServer.start();
            
            this.isRunning = true;
            console.log('✅ Copy Trading Bot started successfully!');
            console.log(`📱 Telegram Bot: @${process.env.BOT_TOKEN?.split(':')[0] || 'Unknown'}`);
            console.log('🎯 Bot is now ready to copy trades!');
            
            // Setup graceful shutdown
            this.setupGracefulShutdown();
            
        } catch (error) {
            console.error('❌ Failed to start bot:', error);
            process.exit(1);
        }
    }

    validateEnvironment() {
        const requiredEnvVars = [
            'BOT_TOKEN',
            'SOLANA_RPC_URL',
            'HELIUS_API_KEY',
            'ENCRYPTION_KEY',
            'WEBHOOK_URL'
        ];

        const missing = requiredEnvVars.filter(varName => !process.env[varName]);
        
        if (missing.length > 0) {
            console.error('❌ Missing required environment variables:');
            missing.forEach(varName => console.error(`   - ${varName}`));
            console.error('\n💡 Please check your .env file and ensure all required variables are set.');
            process.exit(1);
        }

        console.log('✅ Environment variables validated');
    }

    async waitForDatabase() {
        return new Promise((resolve) => {
            // Give database a moment to initialize
            setTimeout(() => {
                console.log('✅ Database initialized');
                resolve();
            }, 1000);
        });
    }

    setupGracefulShutdown() {
        const shutdownHandler = async (signal) => {
            console.log(`\n📥 Received ${signal}, shutting down gracefully...`);
            
            if (this.isRunning) {
                this.isRunning = false;
                
                // Stop Telegram bot
                if (this.telegramBot) {
                    console.log('🤖 Stopping Telegram bot...');
                    this.telegramBot.stop();
                }
                
                // Stop webhook server
                if (this.webhookServer) {
                    console.log('🌐 Stopping webhook server...');
                    this.webhookServer.stop();
                }
                
                // Close database connection
                if (database.db) {
                    console.log('📊 Closing database connection...');
                    database.db.close((err) => {
                        if (err) {
                            console.error('Error closing database:', err);
                        } else {
                            console.log('✅ Database connection closed');
                        }
                    });
                }
                
                console.log('✅ Bot shutdown complete');
                process.exit(0);
            }
        };

        process.on('SIGTERM', shutdownHandler);
        process.on('SIGINT', shutdownHandler);
        process.on('SIGQUIT', shutdownHandler);

        // Handle uncaught exceptions
        process.on('uncaughtException', (error) => {
            console.error('❌ Uncaught Exception:', error);
            shutdownHandler('UNCAUGHT_EXCEPTION');
        });

        process.on('unhandledRejection', (reason, promise) => {
            console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
            shutdownHandler('UNHANDLED_REJECTION');
        });
    }

    async stop() {
        if (this.isRunning) {
            console.log('🛑 Stopping bot...');
            await this.setupGracefulShutdown('MANUAL_STOP');
        }
    }

    getStatus() {
        return {
            isRunning: this.isRunning,
            telegramBot: !!this.telegramBot,
            webhookServer: !!this.webhookServer,
            timestamp: new Date().toISOString()
        };
    }
}

// Create and start the bot if this file is run directly
if (require.main === module) {
    const bot = new CopyTradingBot();
    bot.start().catch(error => {
        console.error('❌ Failed to start application:', error);
        process.exit(1);
    });
}

module.exports = CopyTradingBot;

