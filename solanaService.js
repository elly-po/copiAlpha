// solanaService.js
const { Connection, PublicKey, LAMPORTS_PER_SOL, getMint } = require('@solana/web3.js');
const bs58 = require('bs58');
const Bottleneck = require('bottleneck');
const axios = require('axios');

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

    async getTokenMetadata(mintAddress) {
        try {
            if (mintAddress === "SOL" || mintAddress === "So11111111111111111111111111111111111111112") {
                return {
                    mint: "So11111111111111111111111111111111111111112",
                    name: "Solana",
                    symbol: "SOL",
                    decimals: 9,
                    logoURI: "https://cryptologos.cc/logos/solana-sol-logo.png"
                };
            }

            const cached = this.getCacheValue(this.tokenMetadataCache, mintAddress);
            if (cached) return cached;

            const mintPubkey = new PublicKey(mintAddress);
            const mintInfo = await this.limiter.schedule(() => getMint(this.connection, mintPubkey));

            const [metadataPDA] = await PublicKey.findProgramAddress(
                [Buffer.from("metadata"), METADATA_PROGRAM_ID.toBuffer(), mintPubkey.toBuffer()],
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
            return { mint: mintAddress, name: "Unknown Token", symbol: "UNKNOWN", decimals: 9, logoURI: null };
        }
    }

    async getIndicativePriceUSD(tokenAddress) {
        try {
            const cached = this.getCacheValue(this.priceCache, tokenAddress);
            if (cached) return cached;

            let price = 0;
            if (tokenAddress === "SOL" || tokenAddress === "So11111111111111111111111111111111111111112") {
                try {
                    const response = await axios.get('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
                    price = response.data.solana?.usd || 0;
                } catch {
                    price = 0;
                }
            } else {
                price = await this.fetchPumpSwapPrice(tokenAddress);
            }

            if (price > 0) this.setCacheWithExpiry(this.priceCache, tokenAddress, price, this.cacheConfig.price);
            return price;
        } catch {
            return 0;
        }
    }

    async fetchPumpSwapPrice(tokenAddress) {
        try {
            const response = await axios.get(`https://api.pumpswap.io/v1/price/${tokenAddress}`);
            return response.data?.price || 0;
        } catch (error) {
            this.log('Error fetching PumpSwap price:', error.message);
            return 0;
        }
    }

    async executePumpSwap({ decryptedKey, tokenIn, tokenOut, amountIn, slippageBps }) {
        try {
            // Decode private key
            const privateKeyBytes = bs58.decode(decryptedKey);
            const keypair = {
                publicKey: new PublicKey(privateKeyBytes.slice(32)),
                secretKey: privateKeyBytes
            };
            // Fetch token decimals
            const tokenInMetadata = await this.getTokenMetadata(tokenIn);
            const decimals = tokenInMetadata?.decimals ?? 9;
            // Convert human-readable amount to raw units
            const rawAmount = Math.floor(Number(amountIn) * (10 ** decimals));
            // Log raw amount being sent on-chain
            this.log("💰 Raw amount for PumpSwap:", { rawAmount });
            this.log("🚀 PumpSwap execution requested:", { tokenIn, tokenOut, amountIn: rawAmount, slippageBps });
            // Call PumpSwap API with raw units
            const response = await axios.post('https://api.pumpswap.io/v1/swap', {
                wallet: keypair.publicKey.toBase58(),
                tokenIn,
                tokenOut,
                amountIn: rawAmount,
                slippageBps
            });
            
            const result = response.data;
            if (!result?.txid) throw new Error('PumpSwap execution failed');
            
            // Wait for transaction confirmation
            const confirmation = await this.connection.confirmTransaction(result.txid, 'confirmed');
            if (confirmation.value.err) throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
            
            this.log("✅ PumpSwap executed successfully:", { txid: result.txid });
            
            return {
                signature: result.txid,
                inputAmount: rawAmount,
                outputAmount: result.outAmount,
                priceImpact: result.priceImpactPct,
                gasUsed: result.gasUsed
            };
        } catch (error) {
            throw new Error(`PumpSwap execution failed: ${error.message}`);
        }
    }
}

module.exports = SolanaService;
