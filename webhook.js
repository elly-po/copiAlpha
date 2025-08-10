const express = require('express');
const HeliusService = require('./heliusService');
const TradingEngine = require('./tradingEngine');
const Bottleneck = require('bottleneck');

class WebhookServer {
    constructor(bot) {
        this.app = express();
        this.bot = bot;
        this.heliusService = new HeliusService();
        this.tradingEngine = new TradingEngine(bot);
        
        // Rate limiter for webhook processing
        this.webhookLimiter = new Bottleneck({
            maxConcurrent: 5,
            minTime: 100
        });

        this.setupMiddleware();
        this.setupRoutes();
    }

    setupMiddleware() {
        this.app.use(express.json({ limit: '10mb' }));
        this.app.use(express.urlencoded({ extended: true }));
        
        // Basic webhook validation
        this.app.use('/webhook', (req, res, next) => {
            const webhookSecret = req.headers['x-webhook-secret'];
            if (webhookSecret !== process.env.WEBHOOK_SECRET) {
                console.log('Invalid webhook secret');
            }
            next();
        });
    }

    setupRoutes() {
        // Health check endpoint
        this.app.get('/health', (req, res) => {
            res.json({ status: 'OK', timestamp: new Date().toISOString() });
        });

        // Main webhook endpoint for Helius
        this.app.post('/webhook', async (req, res) => {
            try {
                // Respond quickly to avoid timeout
                res.status(200).json({ received: true });

                // Process webhook data asynchronously
                await this.webhookLimiter.schedule(() => 
                    this.processWebhook(req.body)
                );
            } catch (error) {
                console.error('Webhook processing error:', error);
                res.status(500).json({ error: 'Internal server error' });
            }
        });

        // Test endpoint for development
        this.app.post('/test-webhook', async (req, res) => {
            try {
                console.log('Test webhook received:', req.body);
                await this.processWebhook(req.body);
                res.json({ status: 'Test webhook processed' });
            } catch (error) {
                console.error('Test webhook error:', error);
                res.status(500).json({ error: error.message });
            }
        });
    }

    async processWebhook(webhookData) {
        try {
            console.log('Processing webhook data...');
            
            // Handle array of transactions or single transaction
            const transactions = Array.isArray(webhookData) ? webhookData : [webhookData];
            
            for (const transaction of transactions) {
                await this.processTransaction(transaction);
            }
        } catch (error) {
            console.error('Error processing webhook:', error);
        }
    }

    async processTransaction(transaction) {
        try {
            console.log('Processing transaction:', transaction.signature);

            // Extract account addresses from the transaction
            const involvedAccounts = this.extractAccountAddresses(transaction);
            
            // Check if this is a swap transaction
            if (!this.heliusService.isSwapTransaction(transaction)) {
                console.log('Not a swap transaction, skipping');
                return;
            }

            // Extract swap details
            const swapDetails = this.heliusService.extractSwapDetails(transaction);
            if (!swapDetails) {
                console.log('Could not extract swap details, skipping');
                return;
            }

            console.log('Swap detected:', swapDetails);

            // Find which alpha wallets were involved
            for (const account of involvedAccounts) {
                if (await this.isTrackedAlphaWallet(account)) {
                    console.log('Alpha wallet activity detected:', account);
                    await this.tradingEngine.processSwapSignal(swapDetails, account);
                }
            }
        } catch (error) {
            console.error('Error processing transaction:', error);
        }
    }

    extractAccountAddresses(transaction) {
        const accounts = new Set();
        
        // Add accounts from accountData
        if (transaction.accountData) {
            transaction.accountData.forEach(acc => {
                accounts.add(acc.account);
            });
        }

        // Add accounts from instructions
        if (transaction.instructions) {
            transaction.instructions.forEach(ix => {
                if (ix.accounts) {
                    ix.accounts.forEach(acc => accounts.add(acc));
                }
            });
        }

        // Add fee payer and other signers
        if (transaction.feePayer) accounts.add(transaction.feePayer);
        if (transaction.signers) {
            transaction.signers.forEach(signer => accounts.add(signer));
        }

        return Array.from(accounts);
    }

    async isTrackedAlphaWallet(walletAddress) {
        return new Promise((resolve, reject) => {
            const query = 'SELECT COUNT(*) as count FROM alpha_wallets WHERE wallet_address = ? AND active = 1';
            
            require('./database').db.get(query, [walletAddress], (err, row) => {
                if (err) reject(err);
                else resolve(row.count > 0);
            });
        });
    }

    start() {
        const port = process.env.WEBHOOK_PORT || 3001;
        
        this.server = this.app.listen(port, () => {
            console.log(`Webhook server running on port ${port}`);
            console.log(`Webhook endpoint: http://localhost:${port}/webhook`);
        });

        // Graceful shutdown
        process.on('SIGTERM', () => {
            console.log('SIGTERM received, shutting down webhook server...');
            this.server.close(() => {
                console.log('Webhook server closed');
                process.exit(0);
            });
        });

        process.on('SIGINT', () => {
            console.log('SIGINT received, shutting down webhook server...');
            this.server.close(() => {
                console.log('Webhook server closed');
                process.exit(0);
            });
        });

        return this.server;
    }

    stop() {
        if (this.server) {
            this.server.close();
        }
    }
}

module.exports = WebhookServer;
