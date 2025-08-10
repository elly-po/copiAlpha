const axios = require('axios');
const Bottleneck = require('bottleneck');

class HeliusService {
    constructor() {
        this.apiKey = process.env.HELIUS_API_KEY;
        this.baseUrl = process.env.HELIUS_WEBHOOK_URL;
        this.webhookUrl = `http://localhost:${process.env.WEBHOOK_PORT}/webhook`;
        
        // Rate limiter for Helius API calls (free tier: 100 req/min)
        this.limiter = new Bottleneck({
            maxConcurrent: 2,
            minTime: 600 // 600ms between requests = 100 req/min max
        });
    }

    async createWebhook(walletAddresses, userId) {
        try {
            const webhookData = {
                webhookURL: this.webhookUrl,
                transactionTypes: ['Any'],
                accountAddresses: walletAddresses,
                webhookType: 'enhanced'
            };

            const response = await this.limiter.schedule(() =>
                axios.post(`${this.baseUrl}?api-key=${this.apiKey}`, webhookData)
            );

            console.log('Webhook created:', response.data);
            return response.data;
        } catch (error) {
            console.error('Error creating webhook:', error.response?.data || error.message);
            return null;
        }
    }

    async updateWebhook(webhookId, walletAddresses) {
        try {
            const updateData = {
                webhookURL: this.webhookUrl,
                transactionTypes: ['Any'],
                accountAddresses: walletAddresses,
                webhookType: 'enhanced'
            };

            const response = await this.limiter.schedule(() =>
                axios.put(`${this.baseUrl}/${webhookId}?api-key=${this.apiKey}`, updateData)
            );

            console.log('Webhook updated:', response.data);
            return response.data;
        } catch (error) {
            console.error('Error updating webhook:', error.response?.data || error.message);
            return null;
        }
    }

    async deleteWebhook(webhookId) {
        try {
            const response = await this.limiter.schedule(() =>
                axios.delete(`${this.baseUrl}/${webhookId}?api-key=${this.apiKey}`)
            );

            console.log('Webhook deleted:', webhookId);
            return true;
        } catch (error) {
            console.error('Error deleting webhook:', error.response?.data || error.message);
            return false;
        }
    }

    async getWebhooks() {
        try {
            const response = await this.limiter.schedule(() =>
                axios.get(`${this.baseUrl}?api-key=${this.apiKey}`)
            );

            return response.data;
        } catch (error) {
            console.error('Error getting webhooks:', error.response?.data || error.message);
            return [];
        }
    }

    processWebhookData(webhookData) {
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

            return transactions;
        } catch (error) {
            console.error('Error processing webhook data:', error);
            return [];
        }
    }

    isSwapTransaction(transaction) {
        // Check if transaction contains swap-related instructions
        const swapPrograms = [
            'JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB', // Jupiter
            '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', // Raydium
            '9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP'  // Orca
        ];

        return transaction.instructions.some(ix => 
            swapPrograms.includes(ix.programId)
        );
    }

    extractSwapDetails(transaction) {
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

            // Determine buy/sell based on token changes
            const positiveChanges = swapDetails.tokenChanges.filter(c => parseFloat(c.rawTokenAmount) > 0);
            const negativeChanges = swapDetails.tokenChanges.filter(c => parseFloat(c.rawTokenAmount) < 0);

            swapDetails.side = positiveChanges.length > 0 ? 'buy' : 'sell';
            swapDetails.tokenIn = negativeChanges[0]?.mint;
            swapDetails.tokenOut = positiveChanges[0]?.mint;
            swapDetails.amountIn = Math.abs(parseFloat(negativeChanges[0]?.tokenAmount || 0));
            swapDetails.amountOut = Math.abs(parseFloat(positiveChanges[0]?.tokenAmount || 0));

            return swapDetails;
        } catch (error) {
            console.error('Error extracting swap details:', error);
            return null;
        }
    }
}

module.exports = HeliusService;
