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
            return await this.updateWebhook(existing.webhookID); // pass only webhookID
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

    // UPDATED: merge all active alpha wallets
    async updateWebhook(webhookId) {
        try {
            // fetch all active alpha wallets from DB
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
                tokenTransfers: tx.tokenTransfers || []
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
        this.logWithTimestamp(`Transaction ${transaction.signature} is ${isSwap ? '' : 'not '}a swap transaction (according to Helius type)`);
        return isSwap;
    }
    extractSwapDetails(transaction) {
        this.logWithTimestamp(`Extracting swap details from transaction: ${transaction.signature}`);
        try {
            if ((!transaction.tokenTransfers || transaction.tokenTransfers.length === 0) &&
            (!transaction.nativeTransfers || transaction.nativeTransfers.length === 0)) {
                this.logWithTimestamp('No tokenTransfers or nativeTransfers found in transaction');
                return null;
            }

            const tokenTransfers = transaction.tokenTransfers || [];
            const nativeTransfers = transaction.nativeTransfers || [];

            // SPL token changes
            const positiveChanges = tokenTransfers.filter(c => c.tokenAmount > 0);
            const negativeChanges = tokenTransfers.filter(c => c.tokenAmount < 0);

            const swapDetails = {
                signature: transaction.signature,
                timestamp: transaction.timestamp,
                tokenChanges: tokenTransfers,
                tokenIn: null,
                tokenOut: null,
                amountIn: 0,
                amountOut: 0,
                side: 'buy'
            };

            // Determine tokenIn
            if (negativeChanges.length > 0) {
            // Pick largest absolute outflow
                const largestNeg = negativeChanges.reduce((prev, curr) =>
                Math.abs(curr.tokenAmount) > Math.abs(prev.tokenAmount) ? curr : prev
            );
            swapDetails.tokenIn = largestNeg.mint;
            swapDetails.amountIn = Math.abs(largestNeg.tokenAmount);
                this.logWithTimestamp(`Detected tokenIn from SPL negativeChanges: ${swapDetails.tokenIn}`);
            } else if (nativeTransfers.length > 0) {
                // Native SOL outflow
                const totalSolSpent = nativeTransfers
                .filter(nt => nt.amount < 0)
                .reduce((sum, nt) => sum + Math.abs(nt.amount), 0);
            if (totalSolSpent > 0) {
                swapDetails.tokenIn = 'SOL';
                swapDetails.amountIn = totalSolSpent / 1e9; // lamports to SOL
                this.logWithTimestamp(`Detected tokenIn from nativeTransfers: SOL`);
            }
        }

        // Determine tokenOut
        if (positiveChanges.length > 0) {
            // Pick largest inflow
            const largestPos = positiveChanges.reduce((prev, curr) =>
                Math.abs(curr.tokenAmount) > Math.abs(prev.tokenAmount) ? curr : prev
            );
            swapDetails.tokenOut = largestPos.mint;
            swapDetails.amountOut = Math.abs(largestPos.tokenAmount);
            this.logWithTimestamp(`Detected tokenOut from SPL positiveChanges: ${swapDetails.tokenOut}`);
        } else if (nativeTransfers.length > 0) {
            // Native SOL inflow
            const totalSolReceived = nativeTransfers
                .filter(nt => nt.amount > 0)
                .reduce((sum, nt) => sum + nt.amount, 0);
            if (totalSolReceived > 0) {
                swapDetails.tokenOut = 'SOL';
                swapDetails.amountOut = totalSolReceived / 1e9;
                this.logWithTimestamp(`Detected tokenOut from nativeTransfers: SOL`);
            }
        }

        // Determine side
        if (swapDetails.tokenOut && swapDetails.tokenOut !== 'SOL') {
            swapDetails.side = 'buy';
        } else {
            swapDetails.side = 'sell';
        }

        this.logWithTimestamp(`Extracted swap details: ${JSON.stringify(swapDetails)}`);
        return swapDetails;

    } catch (error) {
        this.logWithTimestamp('Error extracting swap details:', error);
        return null;
    }
}
}

module.exports = HeliusService;