const fs = require "fs";
import path from "path";
import {readFile, readFileSync} from "fs";
import { address, IInstruction, AccountRole, SimulateTransactionApi, createTransactionMessage} from "solana/web3.js"
import {findAssociatedTokenPda, getCreateAssociatedTokenInstruction, getProgramDerivedAddress } from "solana-program/web3.js"


(async () =>{
  const keypairPath = path.join('keys', 'hotwallet.json');
  const keypairBytes = new Unit8Array(JSON.parse(readFileSync(keypairPath, 'utf-8')));
  const signer = await createKeyPairSignerFromBytes(keypairBytes);
  
  const rpc = createSolanaRpc('https://api.mainnet-beta.solana.com');
  const rpcSubscriptions = createRpcSubscruptions('ws://api.mainnet-beta.solana.com');

  const sendAndConfirmTransaction = sendAndConfirmTransactionFactory({rpc.rpcSubscriptions});
  const {value: latestBlockhash} = await rpc.getLatestBlockhash().send();

  const pumpProgramID = address("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P")

  const amount = BigInt(5000000000);
  const maxSol = BigInt(-1);
  const dataBuffer = Buffer.alloc(24);
  
  dataBuffer.write("66063d1201daebea","hex");
  dataBuffer.writeBigInt64LE(amount,8);
  dataBuffer.writeBigInt64LE(maxSol,16);
  //console.log(dataBuffer)
  
  const data = new Unit8Array(dataBuffer);
  console.log(data)

  const mint = address('6KzmxarneXfT6L7zrCiwQvNgmqpBukn8PUfAQxbopump');

  const addressEncoder = getAddressEncoder();

  const [global, _bg] = getProgramDerivedAddress({
    seed:["global"],
    programAdderss: pumpProgramID
  })
  console.log("pumpfun global: " +global)
  
  const [bondingCurve, _b0] = getProgramDerivedAddress({
    seed:["bonding-curve", addressEncoder.encode(mint)],
    programAdderss: pumpProgramID
  })
  console.log("bondingCurve: " +bondingCurve)

  const [bondingCurveATA, _b1] = findAssociatedTokenPda({
    mint,
    owner: bondingCurve,
    tokenProgram: TOKEN_PROGRAM_ADDRESS
  });
  console.log("bondingCurveATA: "+bondingCurveATA);
  
  const [ata, _bump] = findAssociatedTokenPda({
    mint,
    owner: signer.address,
    tokenProgram: TOKEN_PROGRAM_ADDRESS
  });
  console.log("User ata: "+ata);
  
  const ataIx = getCreateAssociatedTokenInstruction({
    ata,
    mint,
    owner: signer.address,
    payer: signer
  });
  
  const ix: IInstruction = {
    programAddress: pumpProgramID,
    accounts: [
      {address: address(global), role: AccountRole.READONLY},
      {address: address("CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM"), role: AccountRole.WRITABLE},
      {address: address(mint), role: AccountRole.READONLY}, //mint
      {address: address(bondingCurve), role: AccountRole.WRITABLE},
      {address: address(bondingCurveATA), role: AccountRole.WRITABLE},
      {address: address(ata), role: AccountRole.WRITABLE}, //user ata
      {address: address(signer.address), role: AccountRole.WRITABLE_SIGNER}, //user wallet
      {address: address("11111111111111111111111111111111"), role: AccountRole.READONLY},
      {address: address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"), role: AccountRole.READONLY},
      {address: address("SysvarRent11111111111111111111111111111111"), role: AccountRole.READONLY},
      {address: address("Ce6TQqeCH9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1"), role: AccountRole.READONLY},
      {address: address(pumpProgramID), role: AccountRole.READONLY},
    ],
    data
  }
  const tx = pipe(
    createTransactionMessage({version:0}),
    tx => setTransactionMessageFeePayer(signer, tx),
    tx => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, tx),
    tx => appendTransactionMessageInstruction(ataIx,tx),
    tx => appendTransactionMessageInstruction(ix,tx),
  );
  const signedTx = await signTransactionMessageWithSigners(tx);
  const encodedTx = await getBase64EncodedWireTransaction(signedTx);

  const simulation = await rpc.simulateTransaction(encodedTx, {encoding: 'base64'}).send();
  console.log(simulation)

  await sendAndConfirmTransaction(signedTx, {commitment: "confirmed"});
  
  console.log("tx sent");
  console.log("signature: "+signedTx.signatures[signer.address]);
  
})();
