// solanaService.js
// ESM / v2-style refactor of your original SolanaService
// - Uses modular solana/web3.js + solana-program/web3.js APIs
// - Keeps helper functions (cache, validateWallet, balance, token metadata, price)
// - Implements Pump.fun BUY using createTransactionMessage pattern

import fs from "fs";
import path from "path";
import bs58 from "bs58";
import Bottleneck from "bottleneck";
import axios from "axios";

//
// v2 modular web3 imports
//
import {
  address,
  createSolanaRpc,
  createRpcSubscriptions,
  createKeyPairSignerFromBytes,
  getAddressEncoder,
  createTransactionMessage,
  appendTransactionMessageInstruction,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  getBase64EncodedWireTransaction,
  sendAndConfirmTransactionFactory,
} from "solana/web3.js";

import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenInstruction,
  getProgramDerivedAddress,
  TOKEN_PROGRAM_ADDRESS,
  getAssociatedTokenAddress as splGetAssociatedTokenAddress,
} from "solana-program/web3.js";

//
// NOTE: Depending on which v2 packages you actually have, names may differ slightly.
// The above names match the style used in your snippet. If your installed package
// exports slightly different helpers, adapt the imports accordingly.
//

export default class SolanaService {
  constructor(opts = {}) {
    // config
    this.rpcUrl = process.env.SOLANA_RPC_URL || opts.rpcUrl || "https://api.mainnet-beta.solana.com";
    this.rpcWss = process.env.SOLANA_RPC_WSS || opts.rpcWss || "wss://api.mainnet-beta.solana.com";

    // create rpc clients (v2 style)
    this.rpc = createSolanaRpc(this.rpcUrl);
    this.rpcSubscriptions = createRpcSubscriptions(this.rpcWss);

    // convenience wrapper for send+confirm
    this.sendAndConfirmTransaction = sendAndConfirmTransactionFactory({
      rpc: this.rpc,
      rpcSubscriptions: this.rpcSubscriptions,
    });

    // rate limiter for outgoing HTTP/RPC requests (metadata & price fetching)
    this.limiter = new Bottleneck({ maxConcurrent: 5, minTime: 200 });

    // caches
    this.tokenMetadataCache = new Map();
    this.priceCache = new Map();
    this.cacheConfig = {
      tokenMetadata: 5 * 60 * 1000, // 5m
      price: 30 * 1000, // 30s
    };

    // Pump.fun program + accounts (v2 address wrappers)
    this.PUMP_PROGRAM_ID = address("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
    this.GLOBAL_FEE_VAULT = address("CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM");
    this.CONFIG_AUTHORITY = address("Ce6TQqeCH9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1");

    // buy discriminator (8 bytes hex)
    this.BUY_DISCRIM_HEX = "66063d1201daebea";
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
  // Accepts an address string (v2 address()) or a base58 string
  async validateWallet(pubAddressStr) {
    try {
      const pubAddress = typeof pubAddressStr === "string" ? address(pubAddressStr) : pubAddressStr;
      const resp = await this.rpc.getAccountInfo({ address: pubAddress }).send();
      // rpc returns { value: ... } similar to v2 client's pattern
      return !!(resp?.value);
    } catch (err) {
      this.log("validateWallet error:", err?.message || err);
      return false;
    }
  }

  async getWalletBalance(pubAddressStr) {
    try {
      const pubAddress = typeof pubAddressStr === "string" ? address(pubAddressStr) : pubAddressStr;
      const resp = await this.rpc.getBalance({ address: pubAddress }).send();
      const lamports = resp?.value ?? 0;
      return Number(lamports) / 1e9;
    } catch (error) {
      this.log("Error getting wallet balance:", error?.message || error);
      return 0;
    }
  }

  // -------------------- TOKEN METADATA --------------------
  // Keep a simple metadata fetch: returns decimals, name placeholder, symbol placeholder
  async getTokenMetadata(mintAddrStr) {
    try {
      // treat native SOL specially
      if (mintAddrStr === "SOL" || mintAddrStr === "So11111111111111111111111111111111111111112") {
        return {
          mint: "So11111111111111111111111111111111111111112",
          name: "Solana",
          symbol: "SOL",
          decimals: 9,
          logoURI: "https://cryptologos.cc/logos/solana-sol-logo.png",
        };
      }

      const cached = this.getCacheValue(this.tokenMetadataCache, mintAddrStr);
      if (cached) return cached;

      const mintAddr = address(mintAddrStr);
      // fetch parsed mint account (v2 rpc)
      const parsed = await this.rpc.getParsedAccountInfo({ address: mintAddr }).send();
      const decimals = parsed?.value?.data?.parsed?.info?.decimals ?? 9;

      const tokenData = {
        mint: mintAddrStr,
        name: "Unknown Token",
        symbol: "UNKNOWN",
        decimals,
        logoURI: null,
      };

      this.setCacheWithExpiry(this.tokenMetadataCache, mintAddrStr, tokenData, this.cacheConfig.tokenMetadata);
      return tokenData;
    } catch (error) {
      this.log(`⚠️ Metadata fetch failed for ${mintAddrStr}:`, error?.message || error);
      return {
        mint: mintAddrStr,
        name: "Unknown Token",
        symbol: "UNKNOWN",
        decimals: 9,
        logoURI: null,
      };
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
          const response = await axios.get(
            "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd"
          );
          price = response.data?.solana?.usd || 0;
        } catch (e) {
          this.log("Coingecko fetch failed:", e?.message || e);
          price = 0;
        }
      } else {
        // placeholder for non-SOL tokens
        price = 0;
      }

      if (price > 0) {
        this.setCacheWithExpiry(this.priceCache, tokenAddress, price, this.cacheConfig.price);
      }
      return price;
    } catch (err) {
      this.log("getIndicativePriceUSD error:", err?.message || err);
      return 0;
    }
  }

  // -------------------- INTERNAL HELPERS (Pump.fun PDAs - v2) --------------------
  async _deriveGlobalPda() {
    const [pda] = getProgramDerivedAddress({
      seeds: [Buffer.from("global")],
      programAddress: this.PUMP_PROGRAM_ID,
    });
    return pda;
  }

  async _deriveBondingCurvePda(mintAddress) {
    const m = address(mintAddress);
    const encoder = getAddressEncoder();
    const [pda] = getProgramDerivedAddress({
      seeds: [Buffer.from("bonding-curve"), encoder.encode(m)],
      programAddress: this.PUMP_PROGRAM_ID,
    });
    return pda;
  }

  async _getOrCreateATAIx(ownerAddr, mintAddr, payerAddr) {
    // ownerAddr, mintAddr, payerAddr are v2 address() objects (or strings)
    const mint = typeof mintAddr === "string" ? address(mintAddr) : mintAddr;
    const owner = typeof ownerAddr === "string" ? address(ownerAddr) : ownerAddr;
    const payer = typeof payerAddr === "string" ? address(payerAddr) : payerAddr;

    const { ata } = findAssociatedTokenPda({
      mint,
      owner,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });

    // findAssociatedTokenPda returns [ata, bump] style in some libs; handle both shapes:
    const ataAddress = ata ?? ata; // keep shape, if library returns object shape adapt accordingly

    // In v2 helper there is getCreateAssociatedTokenInstruction
    const ix = getCreateAssociatedTokenInstruction({
      ata: ataAddress,
      mint,
      owner,
      payer,
    });

    return { ata: ataAddress, ix };
  }

  // -------------------- SWAP (Pump.fun BUY) --------------------
  // Accepts: { decryptedKey: bs58(secretKey), tokenIn (optional), tokenOut (mint string), amountIn (SOL number or string) }
  async executePumpSwap({ decryptedKey, tokenIn = "SOL", tokenOut, amountIn, slippageBps = 100, side = "buy" } = {}) {
    if (side !== "buy") {
      throw new Error("Only BUY is implemented in this v2 helper.");
    }

    try {
      // --- signer from bs58 secret (keep your existing workflow)
      // decryptedKey can be either base58 secretKey string or a Uint8Array/Buffer already
      let secretBytes;
      if (typeof decryptedKey === "string") {
        // treat as base58
        secretBytes = bs58.decode(decryptedKey);
      } else if (decryptedKey instanceof Uint8Array || Buffer.isBuffer(decryptedKey)) {
        secretBytes = decryptedKey;
      } else {
        throw new Error("decryptedKey must be a base58 string or Uint8Array/Buffer");
      }

      const signer = await createKeyPairSignerFromBytes(secretBytes);
      const signerAddress = signer.address; // v2 signer exposes .address()

      // --- normalize WSOL
      const wsol = "So11111111111111111111111111111111111111112";
      if ((tokenIn ?? "").toString().toUpperCase() === "SOL") tokenIn = wsol;
      if ((tokenOut ?? "").toString().toUpperCase() === "SOL") tokenOut = wsol;

      // --- build data buffer (24 bytes: 8 byte discrim + i64 + i64)
      const amountLamports = BigInt(Math.floor(Number(amountIn) * 1e9)); // assume amountIn is SOL
      const maxSol = BigInt(-1);

      const dataBuffer = Buffer.alloc(24);
      // copy discriminator bytes
      Buffer.from(this.BUY_DISCRIM_HEX, "hex").copy(dataBuffer, 0);
      dataBuffer.writeBigInt64LE(amountLamports, 8);
      dataBuffer.writeBigInt64LE(maxSol, 16);

      const data = new Uint8Array(dataBuffer);

      // --- PDAs / ATAs
      const mintAddr = address(tokenOut);
      const encoder = getAddressEncoder();

      const [globalPda] = getProgramDerivedAddress({
        seeds: [Buffer.from("global")],
        programAddress: this.PUMP_PROGRAM_ID,
      });

      const [bondingCurvePda] = getProgramDerivedAddress({
        seeds: [Buffer.from("bonding-curve"), encoder.encode(mintAddr)],
        programAddress: this.PUMP_PROGRAM_ID,
      });

      const [bondingCurveATA] = findAssociatedTokenPda({
        mint: mintAddr,
        owner: bondingCurvePda,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
      });

      const [userATA] = findAssociatedTokenPda({
        mint: mintAddr,
        owner: signerAddress,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
      });

      // --- ensure user ATA exists: build create-ata instruction only if necessary via RPC
      // Use rpc.getAccountInfo to check existence
      const ataInfoResp = await this.rpc.getAccountInfo({ address: userATA }).send();
      let createUserAtaIx = null;
      if (!ataInfoResp?.value) {
        // Create associated token instruction (v2 helper)
        createUserAtaIx = getCreateAssociatedTokenInstruction({
          ata: userATA,
          mint: mintAddr,
          owner: signerAddress,
          payer: signerAddress,
        });
      }

      // --- Build Pump.fun instruction (v2 IInstruction shape)
      const pumpIx = {
        programAddress: this.PUMP_PROGRAM_ID,
        accounts: [
          { address: globalPda, role: "readonly" },
          { address: this.GLOBAL_FEE_VAULT, role: "writable" },
          { address: mintAddr, role: "readonly" },
          { address: bondingCurvePda, role: "writable" },
          { address: bondingCurveATA, role: "writable" },
          { address: userATA, role: "writable" },
          { address: signerAddress, role: "writable-signer" },
          { address: address("11111111111111111111111111111111"), role: "readonly" }, // system program
          { address: TOKEN_PROGRAM_ADDRESS, role: "readonly" },
          { address: address("SysvarRent11111111111111111111111111111111"), role: "readonly" },
          { address: this.CONFIG_AUTHORITY, role: "readonly" },
          { address: this.PUMP_PROGRAM_ID, role: "readonly" },
        ],
        data,
      };

      // --- latest blockhash
      const latestBlockhashResp = await this.rpc.getLatestBlockhash().send();
      const latestBlockhash = latestBlockhashResp?.value?.blockhash ?? latestBlockhashResp?.blockhash;

      // --- Build transaction message with ATA create (optional) + pump instruction
      let txMessage = createTransactionMessage({ version: 0 });
      txMessage = setTransactionMessageFeePayer(signer, txMessage);
      txMessage = setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, txMessage);

      if (createUserAtaIx) txMessage = appendTransactionMessageInstruction(createUserAtaIx, txMessage);
      txMessage = appendTransactionMessageInstruction(pumpIx, txMessage);

      // --- Sign and encode
      const signedTx = await signTransactionMessageWithSigners(txMessage);
      const encodedTx = await getBase64EncodedWireTransaction(signedTx);

      // --- simulate (optional but useful)
      try {
        const sim = await this.rpc.simulateTransaction(encodedTx, { encoding: "base64" }).send();
        this.log("simulation result:", sim);
      } catch (simErr) {
        this.log("simulation error (continuing to send):", simErr?.message || simErr);
      }

      // --- send & confirm
      await this.sendAndConfirmTransaction(signedTx, { commitment: "confirmed" });

      const signature = signedTx.signatures?.[signerAddress] ?? null;
      this.log("✅ PumpFun BUY executed", { signature });
      return { signature };
    } catch (err) {
      this.log("❌ PumpFun BUY failed:", err?.message || err);
      throw new Error(`Swap buy failed: ${err?.message || err}`);
    }
  }
}