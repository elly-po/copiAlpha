const fs = require "fs";
import { address, IInstruction} from 'solana/web3.js'

(async () =>{
  const pumpProgramID = address("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P")
  const dataBuffer = new Buffer.alloc(24);
  dataBuffer.write("66063d1201daebea158771840500000034526000000000","hex");
  const ix: IInstruction = {
    programAddress: pumpProgramID,
    accounts: [

      
    ],
    data:
  }
})();
