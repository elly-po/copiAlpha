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
}

module.exports = SolanaService;

