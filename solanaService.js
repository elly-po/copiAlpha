const { Connection, PublicKey, Transaction, SystemProgram, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const { TOKEN_PROGRAM_ID, getAssociatedTokenAddress, createAssociatedTokenAccountInstruction } = require('@solana/spl-token');
const bs58 = require('bs58');
const Bottleneck = require('bottleneck');

class SolanaService {
    constructor() {
        this.connection = new Connection(process.env.SOLANA_RPC_URL, 'confirmed');
        
        // Rate limiter for RPC calls
        this.limiter = new Bottleneck({
            maxConcurrent: 5,
            minTime: 200
        });
    }

    async validateWallet(publicKeyStr) {
        try {
            const publicKey = new PublicKey(publicKeyStr);
            const accountInfo = await this.limiter.schedule(() => 
                this.connection.getAccountInfo(publicKey)
            );
            return accountInfo !== null;
        } catch (error) {
            return false;
        }
    }

    async getWalletBalance(publicKeyStr) {
        try {
            const publicKey = new PublicKey(publicKeyStr);
            const balance = await this.limiter.schedule(() => 
                this.connection.getBalance(publicKey)
            );
            return balance / LAMPORTS_PER_SOL;
        } catch (error) {
            console.error('Error getting wallet balance:', error);
            return 0;
        }
    }

    async getTokenAccounts(publicKeyStr) {
        try {
            const publicKey = new PublicKey(publicKeyStr);
            const tokenAccounts = await this.limiter.schedule(() => 
                this.connection.getTokenAccountsByOwner(publicKey, {
                    programId: TOKEN_PROGRAM_ID
                })
            );
            
            return tokenAccounts.value.map(account => ({
                pubkey: account.pubkey.toString(),
                account: account.account
            }));
        } catch (error) {
            console.error('Error getting token accounts:', error);
            return [];
        }
    }

    async parseTransaction(signature) {
        try {
            const transaction = await this.limiter.schedule(() => 
                this.connection.getParsedTransaction(signature, 'confirmed')
            );
            
            if (!transaction) return null;

            const instructions = transaction.transaction.message.instructions;
            const swapInstruction = instructions.find(ix => 
                ix.programId && ix.programId.toString().includes('Jupiter') ||
                ix.programId.toString().includes('Raydium') ||
                ix.programId.toString().includes('Serum')
            );

            if (!swapInstruction) return null;

            // Extract token addresses and amounts from the instruction
            const preBalances = transaction.meta.preTokenBalances || [];
            const postBalances = transaction.meta.postTokenBalances || [];
            
            const tokenChanges = this.calculateTokenChanges(preBalances, postBalances);
            
            return {
                signature,
                tokenChanges,
                accounts: transaction.transaction.message.accountKeys.map(key => key.pubkey.toString()),
                timestamp: transaction.blockTime
            };
        } catch (error) {
            console.error('Error parsing transaction:', error);
            return null;
        }
    }

    calculateTokenChanges(preBalances, postBalances) {
        const changes = {};
        
        postBalances.forEach(post => {
            const pre = preBalances.find(p => 
                p.accountIndex === post.accountIndex && 
                p.mint === post.mint
            );
            
            if (pre) {
                const change = post.uiTokenAmount.uiAmount - pre.uiTokenAmount.uiAmount;
                if (Math.abs(change) > 0.000001) { // Ignore dust
                    changes[post.mint] = {
                        change,
                        decimals: post.uiTokenAmount.decimals
                    };
                }
            } else if (post.uiTokenAmount.uiAmount > 0) {
                changes[post.mint] = {
                    change: post.uiTokenAmount.uiAmount,
                    decimals: post.uiTokenAmount.decimals
                };
            }
        });

        return changes;
    }

    async simulateSwap(tokenIn, tokenOut, amountIn, slippage = 5) {
        try {
            // This is a simplified simulation
            // In a real implementation, you'd use Jupiter API or similar
            const mockPrice = Math.random() * 0.01 + 0.001; // Random price for simulation
            const amountOut = amountIn / mockPrice;
            const minAmountOut = amountOut * (1 - slippage / 100);
            
            return {
                amountOut,
                minAmountOut,
                priceImpact: Math.random() * 2, // Mock price impact
                fee: amountIn * 0.003 // 0.3% fee
            };
        } catch (error) {
            console.error('Error simulating swap:', error);
            return null;
        }
    }

    async executeSwap(privateKeyStr, tokenIn, tokenOut, amountIn, slippage, minAmountOut) {
        try {
            // This is a placeholder for actual swap execution
            // In a real implementation, you'd build the swap transaction
            // using Jupiter API, Raydium SDK, or similar
            
            console.log('Executing swap:', {
                tokenIn,
                tokenOut,
                amountIn,
                slippage,
                minAmountOut
            });

            // Mock transaction signature
            const mockSignature = bs58.encode(Buffer.from(Array(64).fill(0).map(() => Math.floor(Math.random() * 256))));
            
            return {
                signature: mockSignature,
                success: true
            };
        } catch (error) {
            console.error('Error executing swap:', error);
            return {
                signature: null,
                success: false,
                error: error.message
            };
        }
    }

    async getTokenInfo(mintAddress) {
        try {
            // Mock token info - in real implementation, use token metadata
            return {
                address: mintAddress,
                symbol: 'TOKEN',
                name: 'Mock Token',
                decimals: 9,
                price: Math.random() * 0.01
            };
        } catch (error) {
            console.error('Error getting token info:', error);
            return null;
        }
    }
}

module.exports = SolanaService;

