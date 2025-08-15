// heliusService.js
const axios = require('axios');
const Bottleneck = require('bottleneck');
const database = require('./database'); // ensure you import your DB module

class HeliusService {
    constructor() {
        this.apiKey = process.env.HELIUS_API_KEY;
        this.baseUrl = process.env.HELIUS_WEBHOOK_URL;
        this.webhookUrl = `https://e0e22f03-f254-46ee-8d3a-1c5568cf6c98-00-2s5y4moat23yo.kirk.replit.dev/webhook`;

        this.limiter = new Bottleneck({
            maxConcurrent: 2,
            minTime: 600
        });
    }

    logWithTimestamp(...args) {
        console.log(new Date().toISOString(), ...args);
    }

    async createWebhook(walletAddresses, userId) {
        const existingWebhooks = await this.getWebhooks();
        const existing = existingWebhooks.find(w => w.webhookURL === this.webhookUrl);

        if (existing) {
            this.logWithTimestamp(`ℹ️ Found existing webhook ${existing.webhookID}, updating instead of creating...`);
            return await this.updateWebhook(existing.webhookID);
        }

        const webhookData = {
            webhookURL: this.webhookUrl,
            transactionTypes: ['Any'],
            accountAddresses: walletAddresses,
            webhookType: 'enhanced'
        };

        this.logWithTimestamp(`Creating webhook for user ${userId} with addresses:`, walletAddresses);

        try {
            const response = await this.limiter.schedule(() =>
                axios.post(`${this.baseUrl}?api-key=${this.apiKey}`, webhookData)
            );

            this.logWithTimestamp('Webhook created successfully:', JSON.stringify(response.data));
            console.log('✅ Helius webhook created. Waiting for data...');
            return response.data;
        } catch (error) {
            this.logWithTimestamp('Error creating webhook:', error.response?.data || error.message);
            return null;
        }
    }

    async updateWebhook(webhookId) {
        try {
            const allWallets = await database.getAllActiveAlphaWallets();
            if (!allWallets.length) return;

            const addresses = [...new Set(allWallets)];

            const updateData = {
                webhookURL: this.webhookUrl,
                transactionTypes: ['Any'],
                accountAddresses: addresses,
                webhookType: 'enhanced'
            };

            this.logWithTimestamp(`Updating webhook ${webhookId} with addresses:`, addresses);

            const response = await this.limiter.schedule(() =>
                axios.put(`${this.baseUrl}/${webhookId}?api-key=${this.apiKey}`, updateData)
            );

            this.logWithTimestamp('Webhook updated successfully:', JSON.stringify(response.data));
            return response.data;
        } catch (error) {
            this.logWithTimestamp('Error updating webhook:', error.response?.data || error.message);
            return null;
        }
    }

    async deleteWebhook(webhookId) {
        this.logWithTimestamp(`Deleting webhook ${webhookId}`);
        try {
            await this.limiter.schedule(() =>
                axios.delete(`${this.baseUrl}/${webhookId}?api-key=${this.apiKey}`)
            );

            this.logWithTimestamp('Webhook deleted:', webhookId);
            return true;
        } catch (error) {
            this.logWithTimestamp('Error deleting webhook:', error.response?.data || error.message);
            return false;
        }
    }

    async getWebhooks() {
        this.logWithTimestamp('Fetching all webhooks');
        try {
            const response = await this.limiter.schedule(() =>
                axios.get(`${this.baseUrl}?api-key=${this.apiKey}`)
            );

            this.logWithTimestamp(`Fetched ${response.data.length} webhooks`);
            return response.data;
        } catch (error) {
            this.logWithTimestamp('Error getting webhooks:', error.response?.data || error.message);
            return [];
        }
    }

    processWebhookData(webhookData) {
        this.logWithTimestamp('Processing webhook data:', JSON.stringify(webhookData));
        try {
            const transactions = webhookData.map(tx => ({
                signature: tx.signature,
                slot: tx.slot,
                timestamp: tx.timestamp,
                accountData: tx.accountData || [],
                instructions: tx.instructions || [],
                events: tx.events || {},
                type: tx.type,
                swap: tx.swap || null,
                tokenTransfers: tx.tokenTransfers || [],
                nativeTransfers: tx.nativeTransfers || []
            }));

            this.logWithTimestamp(`Processed ${transactions.length} transactions from webhook data`);
            return transactions;
        } catch (error) {
            this.logWithTimestamp('Error processing webhook data:', error);
            return [];
        }
    }

    isSwapTransaction(transaction) {
        const isSwap = transaction.type === 'SWAP';
        this.logWithTimestamp(`Transaction ${transaction.signature} is ${isSwap ? '' : 'not '}a swap transaction`);
        return isSwap;
    }

    extractSwapDetails(transaction, alphaWallet) {
        this.logWithTimestamp(`Extracting swap details from transaction: ${transaction.signature}`);

        try {
            const tokenTransfers = transaction.tokenTransfers || [];
            const accountData = transaction.accountData || [];

            const swapDetails = {
                signature: transaction.signature,
                timestamp: transaction.timestamp,
                tokenChanges: tokenTransfers,
                tokenIn: null,
                tokenOut: null,
                amountIn: 0,
                amountOut: 0,
                side: null
            };

            // Process tokenTransfers
            tokenTransfers.forEach(t => {
                if (t.fromUserAccount === alphaWallet) {
                    swapDetails.tokenIn = t.mint;
                    swapDetails.amountIn = Math.abs(t.tokenAmount);
                }
                if (t.toUserAccount === alphaWallet) {
                    swapDetails.tokenOut = t.mint;
                    swapDetails.amountOut = Math.abs(t.tokenAmount);
                }
            });

            // Process nativeBalanceChange for SOL
            const nativeChange = accountData.find(a => a.account === alphaWallet)?.nativeBalanceChange || 0;

            if (nativeChange < 0) {
                swapDetails.tokenIn = 'SOL';
                swapDetails.amountIn = Math.abs(nativeChange) / 1e9;
            } else if (nativeChange > 0) {
                swapDetails.tokenOut = 'SOL';
                swapDetails.amountOut = nativeChange / 1e9;
            }

            // Determine side
            if (swapDetails.tokenIn && !swapDetails.tokenOut) swapDetails.side = 'sell';
            else if (!swapDetails.tokenIn && swapDetails.tokenOut) swapDetails.side = 'buy';
            else swapDetails.side = swapDetails.amountIn >= swapDetails.amountOut ? 'sell' : 'buy';

            this.logWithTimestamp(`Extracted swap details: ${JSON.stringify(swapDetails)}`);
            return swapDetails;

        } catch (error) {
            this.logWithTimestamp('Error extracting swap details:', error);
            return null;
        }
    }
}

module.exports = HeliusService;