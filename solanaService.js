// solanaService.js
const {
    Connection,
    PublicKey,
    LAMPORTS_PER_SOL,
    Transaction,
    sendAndConfirmTransaction,
    Keypair
} = require('@solana/web3.js');
const { PumpSdk } = require('@pump-fun/pump-sdk');
const bs58 = require('bs58');
const Bottleneck = require('bottleneck');
const axios = require('axios');

// Metaplex Token Metadata Program ID
const METADATA_PROGRAM_ID = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");

class SolanaService {
    constructor() {
        this.connection = new Connection(process.env.SOLANA_RPC_URL, 'confirmed');
        this.sdk = new PumpSdk(this.connection);

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
    async executePumpSwap({ decryptedKey, tokenIn, tokenOut, amountIn, slippageBps, side = 'buy' }) {
        try {
            const secretKey = bs58.decode(decryptedKey);
            const payer = Keypair.fromSecretKey(secretKey);

            // Normalize SOL token
            const wsol = 'So11111111111111111111111111111111111111112';

            if (side === 'buy') {
                try {
                    // Try bonding curve first
                    const mint = new PublicKey(tokenOut);
                    const global = await this.sdk.fetchGlobal();
                    const { bondingCurveAccountInfo, bondingCurve, associatedUserAccountInfo } =
                        await this.sdk.fetchBuyState(mint, payer.publicKey);

                    const solAmount = BigInt(Math.floor(Number(amountIn) * LAMPORTS_PER_SOL));
                    const tokenAmount = this.sdk.getBuyTokenAmountFromSolAmount(global, bondingCurve, solAmount);

                    const instructions = await this.sdk.buyInstructions({
                        global,
                        bondingCurveAccountInfo,
                        bondingCurve,
                        associatedUserAccountInfo,
                        mint,
                        user: payer.publicKey,
                        solAmount,
                        amount: tokenAmount,
                        slippage: slippageBps
                    });

                    const tx = new Transaction().add(...instructions);
                    const signature = await sendAndConfirmTransaction(this.connection, tx, [payer]);

                    this.log('✅ PumpFun bonding curve BUY executed:', { signature });
                    return { signature, inputAmount: solAmount.toString(), outputAmount: tokenAmount.toString() };
                } catch (bcError) {
                    this.log(`⚠️ Bonding curve not found for ${tokenOut}, falling back to PumpSwap`, bcError.message);
                }
            }

            // PumpSwap fallback
            const mint = new PublicKey(side === 'buy' ? tokenOut : tokenIn);
            const global = await this.sdk.fetchGlobal();
            let instructions, inputAmount, outputAmount;

            if (side === 'buy') {
                ({ instructions, inputAmount, outputAmount } = await this.sdk.swapBuyInstructions({
                    global,
                    mint,
                    user: payer.publicKey,
                    solAmount: BigInt(Math.floor(Number(amountIn) * LAMPORTS_PER_SOL)),
                    slippage: slippageBps
                }));
            } else {
                const tokenMetadata = await this.getTokenMetadata(tokenIn);
                const rawAmount = BigInt(Math.floor(Number(amountIn) * (10 ** tokenMetadata.decimals)));
                ({ instructions, inputAmount, outputAmount } = await this.sdk.swapSellInstructions({
                    global,
                    mint,
                    user: payer.publicKey,
                    tokenAmount: rawAmount,
                    slippage: slippageBps
                }));
            }

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