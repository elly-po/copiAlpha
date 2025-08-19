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
        this.bot = bot;
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
            // Save raw JSON to file
            fs.appendFileSync(this.heliusLogPath, JSON.stringify(entry) + '\n');

            // Ensure we always work with an array
            const transactions = Array.isArray(payload) ? payload : [payload];
            
            transactions.forEach(tx => {
                let summary = [];
                summary.push(`Signature: ${tx.signature || 'N/A'}`);
                summary.push(`FeePayer: ${tx.feePayer || 'N/A'}`);
                summary.push(`Slot: ${tx.slot || 'N/A'}`);
                summary.push(`BlockTime: ${tx.blockTime || 'N/A'}`);
                
                // Accounts + balance changes
                if (Array.isArray(tx.accountData)) {
                    tx.accountData.forEach(a => {
                        summary.push(`Account: ${a.account}, NativeChange: ${a.nativeBalanceChange || 0}`);
                        if (Array.isArray(a.tokenBalanceChanges) && a.tokenBalanceChanges.length) {
                            a.tokenBalanceChanges.forEach(t => {
                                summary.push(`Token: ${t.mint}, Amount: ${t.rawTokenAmount.tokenAmount}, From: ${t.userAccount}, To: ${t.tokenAccount}`);
                            });
                        }
                    });
                }
                
                // Native transfers
                if (Array.isArray(tx.nativeTransfers) && tx.nativeTransfers.length) {
                    tx.nativeTransfers.forEach(n => {
                        summary.push(`NativeTransfer: ${n.amount} lamports From ${n.fromUserAccount} → ${n.toUserAccount}`);
                    });
                }
                
                // Token transfers
                if (Array.isArray(tx.tokenTransfers) && tx.tokenTransfers.length) {
                    tx.tokenTransfers.forEach(t => {
                        summary.push(`TokenTransfer: ${t.tokenAmount} Mint ${t.mint} From ${t.fromUserAccount} → ${t.toUserAccount}`);
                    });
                }
                
                // Instructions
                if (Array.isArray(tx.instructions)) {
                    summary.push(`Programs: ${tx.instructions.map(ix => ix.programId).join(', ') || 'N/A'}`);
                }
                console.log(`💾📙📒 Helius TX | ${summary.join(' | ')}`);
            });
            
            // this.logWithTimestamp(`📁 Helius payload logged to file: ${this.heliusLogPath}`);
        } catch (err) {
            this.logWithTimestamp('❌ Error writing to helius_data.log:', err);
        }
    }

    setupMiddleware() {
        this.app.use(express.json({ limit: '10mb' }));
        this.app.use(express.urlencoded({ extended: true }));
    }

    setupRoutes() {
        // Health check
        this.app.get('/health', (req, res) => {
            this.logWithTimestamp('Health check requested');
            res.json({ status: 'OK', timestamp: new Date().toISOString() });
        });

        // Telegram webhook
        this.app.post('/telegram-webhook', async (req, res) => {
            res.sendStatus(200); // send immediately
            try {
                await this.bot.handleUpdate(req.body);
            } catch (err) {
                this.logWithTimestamp("❌ Error handling Telegram webhook:", err);
            }
        });

        // Main Helius webhook
        this.app.post('/webhook', async (req, res) => {
            this.logWithTimestamp('Webhook POST /webhook received');
            this.logHeliusData(req.body);

            res.status(200).json({ received: true }); // respond immediately

            try {
                await this.webhookLimiter.schedule(() => this.processWebhook(req.body));
            } catch (error) {
                this.logWithTimestamp('❌ Webhook processing error:', error);
            }
        });

        // Test webhook
        this.app.post('/test-webhook', async (req, res) => {
            this.logWithTimestamp('Test webhook received');
            this.logHeliusData(req.body);

            res.status(200).json({ received: true }); // respond immediately
            try {
                await this.processWebhook(req.body);
            } catch (error) {
                this.logWithTimestamp('❌ Test webhook processing error:', error);
            }
        });
    }

    async processWebhook(webhookData) {
        //this.logWithTimestamp('Processing webhook data...');

        const transactions = Array.isArray(webhookData) ? webhookData : [webhookData];
        this.logWithTimestamp(` ⤵️ Received ${transactions.length} transaction(s) to process`);

        // Fetch all active alpha wallets once
        let activeAlphaWallets = [];
        try {
            activeAlphaWallets = database.getAllActiveAlphaWallets();
            this.logWithTimestamp(`Fetched ${activeAlphaWallets.length} active alpha wallet(s)`);
        } catch (err) {
            this.logWithTimestamp('❌ Failed to fetch active alpha wallets:', err);
            return;
        }

        for (const transaction of transactions){
            await this.processTransaction(transaction, activeAlphaWallets);
        }

        this.logWithTimestamp('Finished processing webhook data', transaction.signature || 'N/A');
    }

    async processTransaction(transaction, activeAlphaWallets) {
        this.logWithTimestamp('Processing transaction:', transaction.signature || 'N/A');

        if (!this.heliusService.isSwapTransaction(transaction)) {
            this.logWithTimestamp(`🚩🚩 Transaction ${transaction.signature || 'N/A'} is NOT a swap transaction, skipping`);
            return;
        }

        const involvedAccounts = this.extractAccountAddresses(transaction);
        for (const account of involvedAccounts) {
            if (activeAlphaWallets.includes(account)) {
                this.logWithTimestamp(`Alpha wallet activity detected: ${account}`);

                const swapDetails = this.heliusService.extractSwapDetails(transaction, account);
                if (!swapDetails) {
                    this.logWithTimestamp(`Transaction ${transaction.signature || 'N/A'} - Failed to extract swap details, skipping`);
                    continue;
                }

                this.logWithTimestamp(`Swap detected for transaction ${transaction.signature || 'N/A'}:`, swapDetails);
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

    start() {
        const port = process.env.PORT || 3001;
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
