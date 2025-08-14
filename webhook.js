// webhook.js
const express = require('express');
const fs = require('fs');
const path = require('path');
const HeliusService = require('./heliusService');
const TradingEngine = require('./tradingEngine');
const Bottleneck = require('bottleneck');
const database = require('./database');

class WebhookServer {
    constructor(bot) {
        console.log('Current WEBHOOK_SECRET:', process.env.WEBHOOK_SECRET || 'NOT SET');
        this.app = express();
        this.bot = bot;
        this.heliusService = new HeliusService();
        this.tradingEngine = new TradingEngine(bot);

        // Path for saving raw webhook data
        this.heliusLogPath = path.join(__dirname, 'helius_data.log');

        // Rate limiter for webhook processing
        this.webhookLimiter = new Bottleneck({
            maxConcurrent: 5,
            minTime: 100
        });

        this.setupMiddleware();
        this.setupRoutes();
    }

    logWithTimestamp(...args) {
        console.log(new Date().toISOString(), ...args);
    }

    logHeliusData(payload) {
        const entry = {
            timestamp: new Date().toISOString(),
            data: payload
        };
        try {
            fs.appendFileSync(this.heliusLogPath, JSON.stringify(entry) + '\n');
            this.logWithTimestamp('📁 Helius payload logged to file');
        } catch (err) {
            this.logWithTimestamp('❌ Error writing to helius_data.log:', err);
        }
    }

    setupMiddleware() {
        this.app.use(express.json({ limit: '10mb' }));
        this.app.use(express.urlencoded({ extended: true }));

        // Basic webhook validation
        this.app.use('/webhook', (req, res, next) => {
            const webhookSecret = req.headers['x-webhook-secret'];
            if (webhookSecret !== process.env.WEBHOOK_SECRET) {
                this.logWithTimestamp('⚠️ Invalid webhook secret:', webhookSecret);
            } else {
                this.logWithTimestamp('✅ Valid webhook secret received');
            }
            next();
        });
    }

    setupRoutes() {
        // Health check endpoint
        this.app.get('/health', (req, res) => {
            this.logWithTimestamp('Health check requested');
            res.json({ status: 'OK', timestamp: new Date().toISOString() });
        });

        // Main webhook endpoint for Helius
        this.app.post('/webhook', async (req, res) => {
            this.logWithTimestamp('Webhook POST /webhook received:', JSON.stringify(req.body));

            // Save raw payload to file for later analysis
            this.logHeliusData(req.body);

            try {
                // Respond quickly to avoid timeout
                res.status(200).json({ received: true });

                // Process webhook data asynchronously with rate limiting
                await this.webhookLimiter.schedule(() => 
                    this.processWebhook(req.body)
                );
                this.logWithTimestamp('Webhook processing scheduled');
            } catch (error) {
                this.logWithTimestamp('❌ Webhook processing error:', error);
                res.status(500).json({ error: 'Internal server error' });
            }
        });

        // Test endpoint for development
        this.app.post('/test-webhook', async (req, res) => {
            this.logWithTimestamp('Test webhook received:', JSON.stringify(req.body));

            // Save raw payload to file
            this.logHeliusData(req.body);

            try {
                await this.processWebhook(req.body);
                res.json({ status: 'Test webhook processed' });
                this.logWithTimestamp('Test webhook processed successfully');
            } catch (error) {
                this.logWithTimestamp('❌ Test webhook error:', error);
                res.status(500).json({ error: error.message });
            }
        });
    }

    async processWebhook(webhookData) {
        this.logWithTimestamp('Processing webhook data...');
        try {
            const transactions = Array.isArray(webhookData) ? webhookData : [webhookData];
            this.logWithTimestamp(`Received ${transactions.length} transaction(s) to process`);

            for (const transaction of transactions) {
                this.logWithTimestamp(`Scheduling processing for transaction: ${transaction.signature}`);
                await this.processTransaction(transaction);
            }
            this.logWithTimestamp('Finished processing webhook data');
        } catch (error) {
            this.logWithTimestamp('❌ Error processing webhook:', error);
        }
    }

    async processTransaction(transaction) {
        this.logWithTimestamp('Processing transaction:', transaction.signature);
        try {
            const involvedAccounts = this.extractAccountAddresses(transaction);
            this.logWithTimestamp('Involved accounts extracted:', involvedAccounts);

            if (!this.heliusService.isSwapTransaction(transaction)) {
                this.logWithTimestamp(`Transaction ${transaction.signature} is NOT a swap transaction, skipping`);
                return;
            }

            const swapDetails = this.heliusService.extractSwapDetails(transaction);
            if (!swapDetails) {
                this.logWithTimestamp(`Transaction ${transaction.signature} - Failed to extract swap details, skipping`);
                return;
            }

            this.logWithTimestamp(`Swap detected for transaction ${transaction.signature}:`, swapDetails);

            for (const account of involvedAccounts) {
                const tracked = await this.isTrackedAlphaWallet(account);
                if (tracked) {
                    this.logWithTimestamp(`Alpha wallet activity detected: ${account}`);
                    await this.tradingEngine.processSwapSignal(swapDetails, account);
                } else {
                    this.logWithTimestamp(`Account ${account} is not a tracked alpha wallet`);
                }
            }
        } catch (error) {
            this.logWithTimestamp('❌ Error processing transaction:', error);
        }
    }

    extractAccountAddresses(transaction) {
        const accounts = new Set();

        if (transaction.accountData) {
            transaction.accountData.forEach(acc => accounts.add(acc.account));
        }

        if (transaction.instructions) {
            transaction.instructions.forEach(ix => {
                if (ix.accounts) {
                    ix.accounts.forEach(acc => accounts.add(acc));
                }
            });
        }

        if (transaction.feePayer) accounts.add(transaction.feePayer);
        if (transaction.signers) {
            transaction.signers.forEach(signer => accounts.add(signer));
        }

        return Array.from(accounts);
    }

    async isTrackedAlphaWallet(walletAddress) {
        return new Promise((resolve, reject) => {
            const query = 'SELECT COUNT(*) as count FROM alpha_wallets WHERE wallet_address = ? AND active = 1';

            database.db.get(query, [walletAddress], (err, row) => {
                if (err) {
                    this.logWithTimestamp('❌ DB error checking alpha wallet:', err);
                    reject(err);
                } else {
                    const isTracked = row.count > 0;
                    this.logWithTimestamp(`Wallet ${walletAddress} tracked status: ${isTracked}`);
                    resolve(isTracked);
                }
            });
        });
    }

    start() {
        const port = process.env.WEBHOOK_PORT || 3001;

        this.server = this.app.listen(port, () => {
            this.logWithTimestamp(`🚀 Webhook server running on port ${port}`);
            this.logWithTimestamp(`Webhook endpoint: http://localhost:${port}/webhook`);
        });

        process.on('SIGTERM', () => {
            this.logWithTimestamp('SIGTERM received, shutting down webhook server...');
            this.server.close(() => {
                this.logWithTimestamp('Webhook server closed');
                process.exit(0);
            });
        });

        process.on('SIGINT', () => {
            this.logWithTimestamp('SIGINT received, shutting down webhook server...');
            this.server.close(() => {
                this.logWithTimestamp('Webhook server closed');
                process.exit(0);
            });
        });

        return this.server;
    }

    stop() {
        if (this.server) {
            this.logWithTimestamp('Stopping webhook server...');
            this.server.close(() => {
                this.logWithTimestamp('Webhook server stopped');
            });
        }
    }
}

module.exports = WebhookServer;