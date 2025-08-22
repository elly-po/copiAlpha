const { Connection, PublicKey, Transaction, SystemProgram, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const { TOKEN_PROGRAM_ID, getAssociatedTokenAddress, createAssociatedTokenAccountInstruction, getMint } = require('@solana/spl-token');
const bs58 = require('bs58');
const Bottleneck = require('bottleneck');

// Metaplex Token Metadata Program ID
const METADATA_PROGRAM_ID = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");

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

    async getTokenMetadata(mintAddress) {
        try {
            // ✅ Special-case for SOL
            if (mintAddress === "So11111111111111111111111111111111111111112" || mintAddress === "SOL") {
                return {
                    mint: "So11111111111111111111111111111111111111112",
                    name: "Solana",
                    symbol: "SOL",
                    decimals: 9,
                    logoURI: "https://cryptologos.cc/logos/solana-sol-logo.png"
                };
            }
            
            const mintPubkey = new PublicKey(mintAddress);
            const mintInfo = await this.limiter.schedule(() => getMint(this.connection, mintPubkey));
            
            // Derive PDA for metadata
            const [metadataPDA] = await PublicKey.findProgramAddress(
                [
                    Buffer.from("metadata"),
                    METADATA_PROGRAM_ID.toBuffer(),
                    mintPubkey.toBuffer(),
                ],
                METADATA_PROGRAM_ID
            );
            
            const accountInfo = await this.connection.getAccountInfo(metadataPDA);
            let name = "Unknown Token";
            let symbol = "UNKNOWN";
            let uri = null;
            
            if (accountInfo?.data) {
                const data = accountInfo.data;
                name = data.slice(1, 33).toString().replace(/\0/g, "") || name;
                symbol = data.slice(33, 43).toString().replace(/\0/g, "") || symbol;
                uri = data.slice(43, 243).toString().replace(/\0/g, "") || null;
            }
            
            return {
                mint: mintAddress,
                name,
                symbol,
                decimals: mintInfo.decimals ?? 9,
                logoURI: uri
            };
        } catch (error) {
            console.warn(`⚠️ Metadata fetch failed for ${mintAddress}: ${error.message}`);
            return {
                mint: mintAddress,
                name: "Unknown Token",
                symbol: "UNKNOWN",
                decimals: 9,
                logoURI: null
            };
        }
    }
}

module.exports = SolanaService;
