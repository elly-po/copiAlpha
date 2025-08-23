// solanaService.js
const { Connection, PublicKey, LAMPORTS_PER_SOL, Transaction, SystemProgram, sendAndConfirmTransaction } = require('@solana/web3.js');
const bs58 = require('bs58');
const { TOKEN_PROGRAM_ID, getAssociatedTokenAddress, createAssociatedTokenAccountInstruction, getMint } = require('@solana/spl-token');
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

        // Simple in-memory caches
        this.tokenMetadataCache = new Map();
        this.priceCache = new Map();
        this.cacheConfig = {
            tokenMetadata: 5 * 60 * 1000, // 5 minutes
            price: 30 * 1000 // 30 seconds
        };
    }

    log(...args) {
        console.log(new Date().toISOString(), ...args);
    }

    setCacheWithExpiry(cache, key, value, expiry) {
        cache.set(key, { value, expiry: Date.now() + expiry });
    }

    getCacheValue(cache, key) {
        const cached = cache.get(key);
        if (!cached) return null;
        if (Date.now() > cached.expiry) {
            cache.delete(key);
            return null;
        }
        return cached.value;
    }

    async validateWallet(publicKeyStr) {
        try {
            const publicKey = new PublicKey(publicKeyStr);
            const accountInfo = await this.limiter.schedule(() => 
                this.connection.getAccountInfo(publicKey)
            );
            return accountInfo !== null;
        } catch {
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
            this.log('Error getting wallet balance:', error);
            return 0;
        }
    }

    async getTokenAccounts(publicKeyStr) {
        try {
            const publicKey = new PublicKey(publicKeyStr);
            const tokenAccounts = await this.limiter.schedule(() => 
                this.connection.getTokenAccountsByOwner(publicKey, { programId: TOKEN_PROGRAM_ID })
            );
            return tokenAccounts.value.map(account => ({
                pubkey: account.pubkey.toString(),
                account: account.account
            }));
        } catch (error) {
            this.log('Error getting token accounts:', error);
            return [];
        }
    }

    async getTokenMetadata(mintAddress) {
        try {
            // Special-case for SOL
            if (mintAddress === "SOL" || mintAddress === "So11111111111111111111111111111111111111112") {
                return {
                    mint: "So11111111111111111111111111111111111111112",
                    name: "Solana",
                    symbol: "SOL",
                    decimals: 9,
                    logoURI: "https://cryptologos.cc/logos/solana-sol-logo.png"
                };
            }

            // Check cache
            const cached = this.getCacheValue(this.tokenMetadataCache, mintAddress);
            if (cached) return cached;

            const mintPubkey = new PublicKey(mintAddress);
            const mintInfo = await this.limiter.schedule(() => getMint(this.connection, mintPubkey));

            // Derive metadata PDA
            const [metadataPDA] = await PublicKey.findProgramAddress(
                [
                    Buffer.from("metadata"),
                    METADATA_PROGRAM_ID.toBuffer(),
                    mintPubkey.toBuffer()
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

            const tokenData = {
                mint: mintAddress,
                name,
                symbol,
                decimals: mintInfo.decimals ?? 9,
                logoURI: uri
            };

            this.setCacheWithExpiry(this.tokenMetadataCache, mintAddress, tokenData, this.cacheConfig.tokenMetadata);
            return tokenData;
        } catch (error) {
            this.log(`⚠️ Metadata fetch failed for ${mintAddress}:`, error.message);
            return {
                mint: mintAddress,
                name: "Unknown Token",
                symbol: "UNKNOWN",
                decimals: 9,
                logoURI: null
            };
        }
    }

    async getIndicativePriceUSD(tokenAddress) {
        try {
            // Placeholder logic; replace with real price fetch
            const cached = this.getCacheValue(this.priceCache, tokenAddress);
            if (cached) return cached;

            // Example: fetch from some price oracle or API
            const price = Math.random() * 100; // dummy price
            this.setCacheWithExpiry(this.priceCache, tokenAddress, price, this.cacheConfig.price);
            return price;
        } catch (error) {
            this.log('Error fetching token price:', error);
            return 0;
        }
    }
    
    async executeAxiom({ userPrivateKey, tokenIn, tokenOut, amountIn, minOut, routeInfo }) {
        try {
            // Decode private key
            const privateKeyBytes = bs58.decode(userPrivateKey);
            const keypair = {
                publicKey: new PublicKey(privateKeyBytes.slice(32)),
                secretKey: privateKeyBytes
            };
            
            // TODO: integrate real Axiom swap instructions here
            const tx = new Transaction().add(
                SystemProgram.transfer({
                    fromPubkey: keypair.publicKey,
                    toPubkey: keypair.publicKey, // replace with actual Axiom swap program account
                    lamports: 1 // placeholder lamports
                        })
            );
            const signature = await sendAndConfirmTransaction(this.connection, tx, [keypair]);
            return { signature, gasUsed: 0 }; // placeholder
        } catch (error) {
            throw new Error(`Live Axiom execution failed: ${error.message}`);
        }
    }
}

module.exports = SolanaService;
