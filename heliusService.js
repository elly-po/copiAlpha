// heliusService.js
const axios = require('axios');
const Bottleneck = require('bottleneck');

class HeliusService {
    constructor() {
        this.apiKey = process.env.HELIUS_API_KEY;
        this.baseUrl = process.env.HELIUS_WEBHOOK_URL;
        this.webhookUrl = `https://e0e22f03-f254-46ee-8d3a-1c5568cf6c98-00-2s5y4moat23yo.kirk.replit.dev/webhook`;
        
        // Rate limiter for Helius API calls (free tier: 100 req/min)
        this.limiter = new Bottleneck({
            maxConcurrent: 2,
            minTime: 600 // 600ms between requests = 100 req/min max
        });
    }

    logWithTimestamp(...args) {
        console.log(new Date().toISOString(), ...args);
    }

    async createWebhook(walletAddresses, userId) {
        // First check if webhook already exists
        const existingWebhooks = await this.getWebhooks();
        const existing = existingWebhooks.find(
            w => w.webhookURL === this.webhookUrl
        );

        if (existing) {
            this.logWithTimestamp(
                `ℹ️ Found existing webhook ${existing.webhookID}, updating instead of creating...`
            );
            return await this.updateWebhook(existing.webhookID, walletAddresses);
        }

        // If no existing webhook found, create a new one
        const webhookData = {
            webhookURL: this.webhookUrl,
            transactionTypes: ['Any'],
            accountAddresses: walletAddresses,
            webhookType: 'enhanced'
        };
        this.logWithTimestamp(`Creating webhook for user ${userId} with addresses:`, walletAddresses);
        this.logWithTimestamp('Webhook payload:', JSON.stringify(webhookData));

        try {
            const response = await this.limiter.schedule(() =>
                axios.post(`${this.baseUrl}?api-key=${this.apiKey}`, webhookData)
            );
            console.log('Helius response:', response.data);

            this.logWithTimestamp('Webhook created successfully:', JSON.stringify(response.data));
            console.log('✅ Helius webhook created. Waiting for data...');
            return response.data;
        } catch (error) {
            console.log('Helius response error:', error.response?.data || error.message);
            this.logWithTimestamp('Error creating webhook:', error.response?.data || error.message);
            return null;
        }
    }

    async updateWebhook(webhookId, walletAddresses) {
        const updateData = {
            webhookURL: this.webhookUrl,
            transactionTypes: ['Any'],
            accountAddresses: walletAddresses,
            webhookType: 'enhanced'
        };
        this.logWithTimestamp(`Updating webhook ${webhookId} with addresses:`, walletAddresses);
        this.logWithTimestamp('Update payload:', JSON.stringify(updateData));

        try {
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
                accounts: tx.accountData?.map(acc => ({
                    account: acc.account,
                    nativeBalanceChange: acc.nativeBalanceChange,
                    tokenBalanceChanges: acc.tokenBalanceChanges || []
                })) || [],
                instructions: tx.instructions || [],
                events: tx.events || {}
            }));

            this.logWithTimestamp(`Processed ${transactions.length} transactions from webhook data`);
            return transactions;
        } catch (error) {
            this.logWithTimestamp('Error processing webhook data:', error);
            return [];
        }
    }

    isSwapTransaction(transaction) {
        const swapPrograms = [
            'JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB', // Jupiter
            '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', // Raydium
            '9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP'  // Orca
        ];

        const isSwap = transaction.instructions.some(ix => swapPrograms.includes(ix.programId));
        this.logWithTimestamp(`Transaction ${transaction.signature} is ${isSwap ? '' : 'not '}a swap transaction`);
        return isSwap;
    }

    extractSwapDetails(transaction) {
        this.logWithTimestamp(`Extracting swap details from transaction: ${transaction.signature}`);
        try {
            const swapDetails = {
                signature: transaction.signature,
                timestamp: transaction.timestamp,
                tokenChanges: []
            };

            transaction.accounts.forEach(account => {
                if (account.tokenBalanceChanges && account.tokenBalanceChanges.length > 0) {
                    account.tokenBalanceChanges.forEach(change => {
                        swapDetails.tokenChanges.push({
                            mint: change.mint,
                            rawTokenAmount: change.rawTokenAmount,
                            tokenAmount: change.tokenAmount,
                            account: account.account
                        });
                    });
                }
            });

            const positiveChanges = swapDetails.tokenChanges.filter(c => parseFloat(c.rawTokenAmount) > 0);
            const negativeChanges = swapDetails.tokenChanges.filter(c => parseFloat(c.rawTokenAmount) < 0);

            swapDetails.side = positiveChanges.length > 0 ? 'buy' : 'sell';
            swapDetails.tokenIn = negativeChanges[0]?.mint;
            swapDetails.tokenOut = positiveChanges[0]?.mint;
            swapDetails.amountIn = Math.abs(parseFloat(negativeChanges[0]?.tokenAmount || 0));
            swapDetails.amountOut = Math.abs(parseFloat(positiveChanges[0]?.tokenAmount || 0));

            this.logWithTimestamp(`Extracted swap details: ${JSON.stringify(swapDetails)}`);
            return swapDetails;
        } catch (error) {
            this.logWithTimestamp('Error extracting swap details:', error);
            return null;
        }
    }
}

module.exports = HeliusService;