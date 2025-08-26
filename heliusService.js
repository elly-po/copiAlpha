// heliusService.js
const axios = require('axios');
const Bottleneck = require('bottleneck');
const database = require('./database'); // ensure you import your DB module

class HeliusService {
    constructor() {
        this.apiKey = process.env.HELIUS_API_KEY;
        this.baseUrl = process.env.HELIUS_WEBHOOK_URL;
        this.webhookUrl = process.env.WEBHOOK_URL;

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
        //this.logWithTimestamp(`Transaction ${transaction.signature} is ${isSwap ? '' : 'not '}a swap transaction`);
        return isSwap;
    }

    extractSwapDetails(transaction, alphaWallet) {
        this.logWithTimestamp(`Extracting detailed swap info from tx: ${transaction.signature}`);
        
        try {
            const tokenTransfers = transaction.tokenTransfers || [];
            const nativeTransfers = transaction.nativeTransfers || [];
            const accountData = transaction.accountData || [];
            const instructions = transaction.instructions || [];
            
            // Initialize swap details
            const swapDetails = {
                signature: transaction.signature,
                slot: transaction.slot,
                timestamp: transaction.timestamp,
                fee: transaction.fee || 0,
                type: transaction.type,
                programIds: [...new Set(instructions.map(ix => ix.programId))],
                involvedAccounts: [...new Set([
                    ...(accountData.map(a => a.account)),
                    ...(instructions.flatMap(ix => ix.accounts || []))
                ])],
                
                // all flows
                tokenTransfers,
                nativeTransfers,
                accountData,
                instructions,
                
                // summary for the alphaWallet specifically
                perspective: {
                    wallet: alphaWallet,
                    tokenIn: null,
                    tokenOut: null,
                    amountIn: 0,
                    amountOut: 0,
                    side: null,
                    poolPDA: null // NEW: dynamically extracted pool PDA
                    }
            };
            
            // derive alphaWallet's tokenIn/tokenOut
            tokenTransfers.forEach(t => {
                const normalizedAmount = Math.abs(t.tokenAmount) / (10 ** (t.decimals || 0));
                
                if (t.fromUserAccount === alphaWallet) {
                    swapDetails.perspective.tokenIn = t.mint;
                    swapDetails.perspective.amountIn += normalizedAmount;
                }
                
                if (t.toUserAccount === alphaWallet) {
                    swapDetails.perspective.tokenOut = t.mint;
                    swapDetails.perspective.amountOut += normalizedAmount;
                    
                    // Set pool PDA as the account sending tokens to alpha wallet
                    swapDetails.perspective.poolPDA = t.fromUserAccount;
                }
            });
            
            // handle SOL (native transfers / nativeBalanceChange
            const nativeChange = accountData.find(a => a.account === alphaWallet)?.nativeBalanceChange || 0;
            if (nativeChange < 0) {
                swapDetails.perspective.tokenIn = 'SOL';
                swapDetails.perspective.amountIn += Math.abs(nativeChange);
                
                // Pool PDA = where SOL went
                const solTransfer = nativeTransfers.find(n => n.fromUserAccount === alphaWallet && n.toUserAccount !== alphaWallet);
                if (solTransfer) swapDetails.perspective.poolPDA = solTransfer.toUserAccount;
            } else if (nativeChange > 0) {
                swapDetails.perspective.tokenOut = 'SOL';
                swapDetails.perspective.amountOut += nativeChange;
                
                // Pool PDA = who sent the SOL
                const solTransfer = nativeTransfers.find(n => n.toUserAccount === alphaWallet && n.fromUserAccount !== alphaWallet);
                if (solTransfer) swapDetails.perspective.poolPDA = solTransfer.fromUserAccount;
            }
            
            // Determine swap side
            const { tokenIn, tokenOut, amountIn, amountOut } = swapDetails.perspective;
            if (tokenIn === 'SOL' && tokenOut !== 'SOL') {
                swapDetails.perspective.side = 'buy';
            } else if (tokenIn !== 'SOL' && tokenOut === 'SOL') {
                swapDetails.perspective.side = 'sell';
            } else {
                swapDetails.perspective.side = amountIn >= amountOut ? 'sell' : 'buy';
            }
            this.logWithTimestamp(`✅ Detailed swap: ${JSON.stringify(swapDetails)}`);
            return swapDetails;
        } catch (err) {
            this.logWithTimestamp('❌ Error extracting swap details:', err);
            return null;
        }
    }
}

module.exports = HeliusService;
