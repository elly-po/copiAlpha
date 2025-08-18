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
        this.app = express();
        //this.bot = bot;
        this.heliusService = new HeliusService();
        this.tradingEngine = new TradingEngine(bot);

        this.dataFolder = path.join(__dirname, 'data');
        if (!fs.existsSync(this.dataFolder)) fs.mkdirSync(this.dataFolder);

        this.heliusLogPath = path.join(this.dataFolder, 'helius_data.log');

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
        const entry = { timestamp: new Date().toISOString(), data: payload };
        try {
            fs.appendFileSync(this.heliusLogPath, JSON.stringify(entry) + '\n');
            this.logWithTimestamp('📁 Helius payload logged to file:', this.heliusLogPath);
        } catch (err) {
            this.logWithTimestamp('❌ Error writing to helius_data.log:', err);
        }
    }

    setupMiddleware() {
        this.app.use(express.json({ limit: '10mb' }));
        this.app.use(express.urlencoded({ extended: true }));
    }

    setupRoutes() {
        this.app.get('/health', (req, res) => {
            this.logWithTimestamp('Health check requested');
            res.json({ status: 'OK', timestamp: new Date().toISOString() });
        });

        this.app.post('/webhook', async (req, res) => {
            this.logWithTimestamp('Webhook POST /webhook received');
            this.logHeliusData(req.body);

            try {
                res.status(200).json({ received: true });
                await this.webhookLimiter.schedule(() => this.processWebhook(req.body));
            } catch (error) {
                this.logWithTimestamp('❌ Webhook processing error:', error);
                res.status(500).json({ error: 'Internal server error' });
            }
        });

        this.app.post('/test-webhook', async (req, res) => {
            this.logWithTimestamp('Test webhook received');
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
        const transactions = Array.isArray(webhookData) ? webhookData : [webhookData];
        this.logWithTimestamp(`Received ${transactions.length} transaction(s) to process`);

        for (const transaction of transactions) {
            this.logWithTimestamp(`Scheduling processing for transaction: ${transaction.signature}`);
            await this.processTransaction(transaction);
        }
        this.logWithTimestamp('Finished processing webhook data');
    }

    async processTransaction(transaction) {
        this.logWithTimestamp('Processing transaction:', transaction.signature);

        if (!this.heliusService.isSwapTransaction(transaction)) {
            this.logWithTimestamp(`Transaction ${transaction.signature} is NOT a swap transaction, skipping`);
            return;
        }

        const involvedAccounts = this.extractAccountAddresses(transaction);
        for (const account of involvedAccounts) {
            const tracked = await this.isTrackedAlphaWallet(account);
            if (tracked) {
                this.logWithTimestamp(`Alpha wallet activity detected: ${account}`);

                // Pass the alpha wallet to extractSwapDetails
                const swapDetails = this.heliusService.extractSwapDetails(transaction, account);

                if (!swapDetails) {
                    this.logWithTimestamp(`Transaction ${transaction.signature} - Failed to extract swap details, skipping`);
                    continue;
                }

                this.logWithTimestamp(`Swap detected for transaction ${transaction.signature}:`, swapDetails);
                await this.tradingEngine.processSwapSignal(swapDetails, account);
            }
        }
    }

    extractAccountAddresses(transaction) {
        const accounts = new Set();
        if (transaction.accountData) transaction.accountData.forEach(acc => accounts.add(acc.account));
        if (transaction.instructions) transaction.instructions.forEach(ix => ix.accounts?.forEach(acc => accounts.add(acc)));
        if (transaction.feePayer) accounts.add(transaction.feePayer);
        if (transaction.signers) transaction.signers.forEach(signer => accounts.add(signer));
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
                    resolve(row.count > 0);
                }
            });
        });
    }

    start() {
        const port = process.env.WEBHOOK_PORT || 3001;
        this.server = this.app.listen(port, () => {
            this.logWithTimestamp(`🚀 Webhook server running on port ${port}`);
        });

        ['SIGTERM', 'SIGINT'].forEach(sig =>
            process.on(sig, () => {
                this.logWithTimestamp(`${sig} received, shutting down webhook server...`);
                this.server.close(() => process.exit(0));
            })
        );

        return this.server;
    }

    stop() {
        if (this.server) {
            this.logWithTimestamp('Stopping webhook server...');
            this.server.close(() => this.logWithTimestamp('Webhook server stopped'));
        }
    }
}

module.exports = WebhookServer;
