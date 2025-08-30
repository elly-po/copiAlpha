// solanaService.js
const {
  Connection,
  PublicKey,
  LAMPORTS_PER_SOL,
  Transaction,
  sendAndConfirmTransaction,
  Keypair,
  SystemProgram,
} = require('@solana/web3.js');

const {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  TOKEN_PROGRAM_ID,
} = require('@solana/spl-token');
const bs58 = require('bs58');
const Bottleneck = require('bottleneck');
const axios = require('axios');

class SolanaService {
  constructor() {
    this.connection = new Connection(process.env.SOLANA_RPC_URL, 'confirmed');

    // Rate limiter
    this.limiter = new Bottleneck({
      maxConcurrent: 5,
      minTime: 200,
    });

    // Caches
    this.tokenMetadataCache = new Map();
    this.priceCache = new Map();
    this.cacheConfig = {
      tokenMetadata: 5 * 60 * 1000,
      price: 30 * 1000,
    };

    // Pump.fun program + accounts
    this.PUMP_PROGRAM_ID = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
    this.GLOBAL_FEE_VAULT = new PublicKey('CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM');
    this.CONFIG_AUTHORITY = new PublicKey('Ce6TQqeCH9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1');

    // Buy discriminator
    this.BUY_DISCRIM_HEX = '66063d1201daebea';
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
      if (mintAddress === 'SOL' || mintAddress === 'So11111111111111111111111111111111111111112') {
        return {
          mint: 'So11111111111111111111111111111111111111112',
          name: 'Solana',
          symbol: 'SOL',
          decimals: 9,
          logoURI: 'https://cryptologos.cc/logos/solana-sol-logo.png',
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
        name: 'Unknown Token',
        symbol: 'UNKNOWN',
        decimals,
        logoURI: null,
      };

      this.setCacheWithExpiry(this.tokenMetadataCache, mintAddress, tokenData, this.cacheConfig.tokenMetadata);
      return tokenData;
    } catch (error) {
      this.log(`⚠️ Metadata fetch failed for ${mintAddress}:`, error.message);
      return { mint: mintAddress, name: 'Unknown Token', symbol: 'UNKNOWN', decimals: 9, logoURI: null };
    }
  }

  // -------------------- PRICE --------------------
  async getIndicativePriceUSD(tokenAddress) {
    try {
      const cached = this.getCacheValue(this.priceCache, tokenAddress);
      if (cached) return cached;

      let price = 0;
      if (tokenAddress === 'SOL' || tokenAddress === 'So11111111111111111111111111111111111111112') {
        try {
          const response = await axios.get(
            'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd'
          );
          price = response.data?.solana?.usd || 0;
        } catch {
          price = 0;
        }
      } else {
        price = 0; // placeholder for token USD price
      }

      if (price > 0)
        this.setCacheWithExpiry(this.priceCache, tokenAddress, price, this.cacheConfig.price);
      return price;
    } catch {
      return 0;
    }
  }

  // -------------------- INTERNAL HELPERS (Pump.fun) --------------------
  async _deriveGlobalPda() {
    const [pda] = await PublicKey.findProgramAddress(
      [Buffer.from('global')],
      this.PUMP_PROGRAM_ID
    );
    return pda;
  }

  async _deriveBondingCurvePda(mintPubkey) {
    const [pda] = await PublicKey.findProgramAddress(
      [Buffer.from('bonding-curve'), mintPubkey.toBuffer()],
      this.PUMP_PROGRAM_ID
    );
    return pda;
  }

  async _getOrCreateATAIx(ownerPubkey, mintPubkey, payerPubkey) {
    const ata = await getAssociatedTokenAddress(mintPubkey, ownerPubkey, true);
    const info = await this.connection.getAccountInfo(ata);
    if (!info) {
      const ix = createAssociatedTokenAccountInstruction(
        payerPubkey,
        ata,
        ownerPubkey,
        mintPubkey
      );
      return { ata, ix };
    }
    return { ata, ix: null };
  }

  // -------------------- SWAP (Pump.fun BUY) --------------------
  async executePumpSwap({ decryptedKey, tokenIn = 'SOL', tokenOut, amountIn }) {
    if (!tokenOut || !amountIn) throw new Error('tokenOut and amountIn are required');

    try {
      const secretKey = bs58.decode(decryptedKey);
      const payer = Keypair.fromSecretKey(secretKey);

      const wsol = 'So11111111111111111111111111111111111111112';
      if (tokenIn.toUpperCase() === 'SOL') tokenIn = wsol;
      if (tokenOut.toUpperCase() === 'SOL') tokenOut = wsol;

      const mintPubkey = new PublicKey(tokenOut);

      const { blockhash } = await this.connection.getLatestBlockhash();

      const lamportsIn = BigInt(Math.floor(Number(amountIn) * 1e9));
      const maxSol = BigInt(-1);

      const data = Buffer.alloc(24);
      Buffer.from(this.BUY_DISCRIM_HEX, 'hex').copy(data, 0);
      data.writeBigInt64LE(lamportsIn, 8);
      data.writeBigInt64LE(maxSol, 16);

      const [globalPda] = await PublicKey.findProgramAddress([Buffer.from('global')], this.PUMP_PROGRAM_ID);
      const [bondingCurvePda] = await PublicKey.findProgramAddress(
        [Buffer.from('bonding-curve'), mintPubkey.toBuffer()],
        this.PUMP_PROGRAM_ID
      );

      const bondingCurveATA = await getAssociatedTokenAddress(mintPubkey, bondingCurvePda, true);
      const { ata: userATA, ix: createUserAtaIx } = await this._getOrCreateATAIx(
        payer.publicKey,
        mintPubkey,
        payer.publicKey
      );

      const keys = [
        { pubkey: globalPda, isSigner: false, isWritable: false },
        { pubkey: this.GLOBAL_FEE_VAULT, isSigner: false, isWritable: true },
        { pubkey: mintPubkey, isSigner: false, isWritable: false },
        { pubkey: bondingCurvePda, isSigner: false, isWritable: true },
        { pubkey: bondingCurveATA, isSigner: false, isWritable: true },
        { pubkey: userATA, isSigner: false, isWritable: true },
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: new PublicKey("SysvarRent11111111111111111111111111111111"), isSigner: false, isWritable: false },
        { pubkey: this.CONFIG_AUTHORITY, isSigner: false, isWritable: false },
        { pubkey: this.PUMP_PROGRAM_ID, isSigner: false, isWritable: false },
      ];

      const buyIx = { keys, programId: this.PUMP_PROGRAM_ID, data };

      const tx = new Transaction({ recentBlockhash: blockhash, feePayer: payer.publicKey });
      if (createUserAtaIx) tx.add(createUserAtaIx);
      tx.add(buyIx);

      // Optional: simulate before sending
      try {
        const simResult = await this.connection.simulateTransaction(tx);
        this.log('Simulation result:', simResult.value);
      } catch (simErr) {
        this.log('Simulation failed (continuing to send):', simErr.message || simErr);
      }

      const signature = await sendAndConfirmTransaction(this.connection, tx, [payer], { commitment: 'confirmed' });
      this.log('✅ PumpFun BUY executed', { signature });
      return { signature };
    } catch (err) {
      this.log('❌ PumpFun BUY failed:', err?.message || err);
      throw new Error(`Swap buy failed: ${err?.message || err}`);
    }
  }
}

module.exports = SolanaService;
