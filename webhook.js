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
            fs.appendFileSync(this.heliusLogPath, JSON.stringify(entry) + '\n');

            const transactions = Array.isArray(payload) ? payload : [payload];
            transactions.forEach(tx => {
                let summary = [];
                summary.push(`Signature: ${tx.signature || 'N/A'}`);
                summary.push(`FeePayer: ${tx.feePayer || 'N/A'}`);
                summary.push(`Slot: ${tx.slot || 'N/A'}`);
                summary.push(`BlockTime: ${tx.blockTime || 'N/A'}`);

                if (Array.isArray(tx.accountData)) {
                    tx.accountData.forEach(a => {
                        summary.push(`Account: ${a.account}, NativeChange: ${a.nativeBalanceChange || 0}`);
                        if (Array.isArray(a.tokenBalanceChanges)) {
                            a.tokenBalanceChanges.forEach(t => {
                                summary.push(`Token: ${t.mint}, Amount: ${t.rawTokenAmount.tokenAmount}, From: ${t.userAccount}, To: ${t.tokenAccount}`);
                            });
                        }
                    });
                }

                if (Array.isArray(tx.nativeTransfers)) {
                    tx.nativeTransfers.forEach(n => {
                        summary.push(`NativeTransfer: ${n.amount} lamports From ${n.fromUserAccount} → ${n.toUserAccount}`);
                    });
                }

                if (Array.isArray(tx.tokenTransfers)) {
                    tx.tokenTransfers.forEach(t => {
                        summary.push(`TokenTransfer: ${t.tokenAmount} Mint ${t.mint} From ${t.fromUserAccount} → ${t.toUserAccount}`);
                    });
                }

                if (Array.isArray(tx.instructions)) {
                    summary.push(`Programs: ${tx.instructions.map(ix => ix.programId).join(', ') || 'N/A'}`);
                }

                console.log(`💾📙📒 Helius TX | ${summary.join(' | ')}`);
            });
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

        this.app.post('/telegram-webhook', async (req, res) => {
            res.sendStatus(200);
            try {
                await this.bot.handleUpdate(req.body);
            } catch (err) {
                this.logWithTimestamp("❌ Error handling Telegram webhook:", err);
            }
        });

        this.app.post('/webhook', async (req, res) => {
            this.logWithTimestamp('Webhook POST /webhook received');
            this.logHeliusData(req.body);
            res.status(200).json({ received: true });

            try {
                await this.webhookLimiter.schedule(() => this.processWebhook(req.body));
            } catch (error) {
                this.logWithTimestamp('❌ Webhook processing error:', error);
            }
        });

        this.app.post('/test-webhook', async (req, res) => {
            this.logWithTimestamp('Test webhook received');
            this.logHeliusData(req.body);
            res.status(200).json({ received: true });

            try {
                await this.processWebhook(req.body);
            } catch (error) {
                this.logWithTimestamp('❌ Test webhook processing error:', error);
            }
        });
    }

    async processWebhook(webhookData) {
        const transactions = Array.isArray(webhookData) ? webhookData : [webhookData];
        this.logWithTimestamp(` ⤵️ Received ${transactions.length} transaction(s) to process`);

        let activeAlphaWallets = [];
        try {
            activeAlphaWallets = database.getAllActiveAlphaWallets();
            this.logWithTimestamp(`Fetched ${activeAlphaWallets.length} active alpha wallet(s)`);
        } catch (err) {
            this.logWithTimestamp('❌ Failed to fetch active alpha wallets:', err);
            return;
        }

        for (const transaction of transactions) {
            await this.processTransaction(transaction, activeAlphaWallets);
        }

        this.logWithTimestamp(`Finished processing ${transactions.length} webhook transaction(s)`);
    }

    async processTransaction(transaction, activeAlphaWallets) {
        this.logWithTimestamp('Processing transaction:', transaction.signature || 'N/A');

        if (!this.heliusService.isSwapTransaction(transaction)) {
            this.logWithTimestamp(`🚩 Transaction ${transaction.signature || 'N/A'} is NOT a swap transaction, skipping`);
            return;
        }

        const involvedAccounts = this.extractAccountAddresses(transaction);
        for (const account of involvedAccounts) {
            if (!activeAlphaWallets.includes(account)) continue;

            this.logWithTimestamp(`Alpha wallet activity detected: ${account}`);

            const swapDetails = this.heliusService.extractSwapDetails(transaction, account);
            if (!swapDetails) {
                this.logWithTimestamp(`Transaction ${transaction.signature || 'N/A'} - Failed to extract swap details, skipping`);
                continue;
            }

            const { tokenIn, tokenOut, amountIn, amountOut } = swapDetails.perspective;
            if (!tokenIn || !tokenOut || !amountIn || !amountOut || amountIn <= 0 || amountOut <= 0) {
                this.logWithTimestamp(`Transaction ${transaction.signature || 'N/A'} - Invalid swap details, skipping`);
                continue;
            }

            this.logWithTimestamp(`Swap detected for transaction ${transaction.signature || 'N/A'}:`, swapDetails);
            await this.tradingEngine.processSwapSignal(swapDetails, account);
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
