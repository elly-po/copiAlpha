// solanaService.js
const {
    Connection,
    PublicKey,
    LAMPORTS_PER_SOL,
    Transaction,
    sendAndConfirmTransaction,
    Keypair
} = require('@solana/web3.js');
const { PumpAmmSdk, Direction } = require('@pump-fun/pump-swap-sdk');
const bs58 = require('bs58');
const Bottleneck = require('bottleneck');
const axios = require('axios');

class SolanaService {
    constructor() {
        this.connection = new Connection(process.env.SOLANA_RPC_URL, 'confirmed');
        this.sdk = new PumpAmmSdk(this.connection);

        // Rate limiter for RPC calls
        this.limiter = new Bottleneck({
            maxConcurrent: 5,
            minTime: 200
        });

        // In-memory caches
        this.tokenMetadataCache = new Map();
        this.priceCache = new Map();
        this.cacheConfig = {
            tokenMetadata: 5 * 60 * 1000,
            price: 30 * 1000
        };
    }

    log(...args) {
        console.log(new Date().toISOString(), ...args);
    }

    // -------------------- CACHE HELPERS --------------------
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

    // -------------------- WALLET HELPERS --------------------
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

    // -------------------- TOKEN METADATA --------------------
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
            const mintInfo = await this.limiter.schedule(() =>
                this.connection.getParsedAccountInfo(mintPubkey)
            );

            const decimals = mintInfo?.value?.data?.parsed?.info?.decimals ?? 9;
            const tokenData = {
                mint: mintAddress,
                name: "Unknown Token",
                symbol: "UNKNOWN",
                decimals,
                logoURI: null
            };

            this.setCacheWithExpiry(this.tokenMetadataCache, mintAddress, tokenData, this.cacheConfig.tokenMetadata);
            return tokenData;
        } catch (error) {
            this.log(`⚠️ Metadata fetch failed for ${mintAddress}:`, error.message);
            return { mint: mintAddress, name: "Unknown Token", symbol: "UNKNOWN", decimals: 9, logoURI: null };
        }
    }

    // -------------------- PRICE --------------------
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
                price = 0; // placeholder, could fetch from pump.fun price API
            }

            if (price > 0) this.setCacheWithExpiry(this.priceCache, tokenAddress, price, this.cacheConfig.price);
            return price;
        } catch {
            return 0;
        }
    }

    // -------------------- UNIFIED SWAP --------------------
    async executePumpSwap({ decryptedKey, tokenIn, tokenOut, amountIn, slippageBps, poolPDA, side = 'buy' }) {
        try {
            const secretKey = bs58.decode(decryptedKey);
            const payer = Keypair.fromSecretKey(secretKey);

            // Normalize SOL token
            const wsol = 'So11111111111111111111111111111111111111112';

            // 1. Get pool state (replaces getPool)
            const { globalConfig, pool } = await this.sdk.swapSolanaState(
                new PublicKey(poolPDA),   // ⚠️ may need to try tokenIn depending on SDK expectations
                payer.publicKey
            );

            let instructions, inputAmount, outputAmount;

            // 2. Build swap instructions
            if (side === 'buy') {
                ({ instructions, inputAmount, outputAmount } = await this.sdk.swapInstructions(
                    pool,
                    amountIn,
                    Direction.QuoteToBase,
                    slippageBps,
                    payer.publicKey
                ));
            } else {
                const tokenMetadata = await this.getTokenMetadata(tokenIn);
                const rawAmount = BigInt(Math.floor(Number(amountIn) * (10 ** tokenMetadata.decimals)));

                ({ instructions, inputAmount, outputAmount } = await this.sdk.swapInstructions(
                    pool,
                    rawAmount,
                    Direction.BaseToQuote,
                    slippageBps,
                    payer.publicKey
                ));
            }

            // 3. Send transaction
            const tx = new Transaction().add(...instructions);
            const signature = await sendAndConfirmTransaction(this.connection, tx, [payer]);

            this.log(`✅ PumpSwap ${side.toUpperCase()} executed:`, { signature });
            return { signature, inputAmount: inputAmount.toString(), outputAmount: outputAmount.toString() };

        } catch (error) {
            throw new Error(`Swap ${side} failed: ${error.message}`);
        }
    }
}

module.exports = SolanaService;
