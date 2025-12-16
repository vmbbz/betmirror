
import 'dotenv/config';
import mongoose from 'mongoose';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { loadEnv, TOKENS } from '../config/env.js';
import { ConsoleLogger } from '../utils/logger.util.js';
import { Wallet, JsonRpcProvider, Contract, Interface, formatUnits } from 'ethers';
import { deriveSafe } from '@polymarket/builder-relayer-client/dist/builder/derive.js';
import { connectDB, User } from '../database/index.js';
import readline from 'readline';

// LEGACY FACTORY (Used by standard Gnosis deployments)
const LEGACY_FACTORY = "0xa6b71e26c5e0845f74c812102ca7114b6a896ab2"; 
const LOST_SIGNER_TARGET = "0xBBc264c10F54A61607A31B53358a5A87d4B045be"; // The specific signer user lost
const SAFE_ABI = [
    "function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool success)",
    "function nonce() view returns (uint256)",
    "function getTransactionHash(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 _nonce) view returns (bytes32)",
    "function getOwners() view returns (address[])"
];
const USDC_ABI = ["function balanceOf(address) view returns (uint256)", "function transfer(address, uint256) returns (bool)"];

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

const question = (query: string): Promise<string> => {
    return new Promise((resolve) => {
        rl.question(query, resolve);
    });
};

// --- Decryption Helper ---
function decrypt(encryptedTextStr: string, encryptionKey: string): string {
    const textParts = encryptedTextStr.split(':');
    const iv = Buffer.from(textParts.shift()!, 'hex');
    const encryptedText = Buffer.from(textParts.join(':'), 'hex');
    const key = crypto.scryptSync(encryptionKey, 'salt', 32);
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    let decrypted = decipher.update(encryptedText);
    decrypted = Buffer.concat([decrypted, decipher.final()]);
    return decrypted.toString();
}

// --- File Scanner ---
function scanLocalFilesForKey(targetAddress: string): string | null {
    console.log(`\n🕵️  Scanning local .env.generated for signer ${targetAddress}...`);
    const filePath = path.resolve(process.cwd(), '.env.generated');
    
    if (!fs.existsSync(filePath)) {
        console.log("   ❌ .env.generated file not found.");
        return null;
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');
    
    for (const line of lines) {
        if (line.includes('PRIVATE_KEY=')) {
            const pk = line.split('=')[1].trim();
            try {
                const w = new Wallet(pk);
                if (w.address.toLowerCase() === targetAddress.toLowerCase()) {
                    console.log(`   ✅ FOUND IT! Key found in line: ${line.substring(0, 20)}...`);
                    return pk;
                }
            } catch (e) {
                // ignore invalid lines
            }
        }
    }
    console.log("   ❌ Key not found in local backup.");
    return null;
}

async function run() {
    const logger = new ConsoleLogger();
    const env = loadEnv();
    
    console.log("\n🚑 BET MIRROR | DEEP RESCUE TOOL 🚑\n");

    const provider = new JsonRpcProvider(env.rpcUrl);
    let signer: Wallet | null = null;

    // STEP 1: AUTO-SCAN FOR LOST KEY (0xBBc...)
    const foundKey = scanLocalFilesForKey(LOST_SIGNER_TARGET);
    if (foundKey) {
        signer = new Wallet(foundKey, provider);
        console.log(`\n🔓 RECOVERED LOST SIGNER: ${signer.address}`);
    }

    // STEP 2: IF NOT FOUND, ASK USER
    if (!signer) {
        console.log("\nChoose Recovery Method:");
        console.log("1. Search Database (Active Users)");
        console.log("2. Enter Private Key Manually");
        
        const mode = await question("\nSelect [1 or 2]: ");

        if (mode === '2') {
            const pkInput = await question("Paste Private Key: ");
            try {
                signer = new Wallet(pkInput.trim(), provider);
                console.log(`   ✅ Loaded Signer: ${signer.address}`);
            } catch (e) {
                logger.error("Invalid Private Key.");
                process.exit(1);
            }
        } else {
            // Database Search Logic
            console.log("🔌 Connecting to Database...");
            await mongoose.connect(env.mongoUri);
            
            const targetInput = await question(`Search User Address (or ENTER for list): `);
            const normAddr = targetInput.trim().toLowerCase();

            let user: any = null;
            if (normAddr) {
                user = await User.findOne({ 
                    $or: [{ address: normAddr }, { "tradingWallet.address": normAddr }, { "tradingWallet.safeAddress": normAddr }]
                });
            }

            if (!user) {
                const users = await User.find({ "tradingWallet.encryptedPrivateKey": { $exists: true } });
                users.forEach((u, idx) => console.log(`   [${idx + 1}] ${u.address} (Signer: ${u.tradingWallet?.address?.slice(0,6)}...)`));
                const choice = await question(`Select User (1-${users.length}): `);
                user = users[parseInt(choice) - 1];
            }

            if (user) {
                const pk = decrypt(user.tradingWallet.encryptedPrivateKey, env.mongoEncryptionKey);
                signer = new Wallet(pk, provider);
                console.log(`   ✅ Decrypted Signer: ${signer.address}`);
            }
        }
    }

    if (!signer) {
        console.log("❌ No signer loaded. Exiting.");
        process.exit(1);
    }

    // STEP 3: DERIVE LEGACY SAFE & CHECK FUNDS
    const legacySafeAddress = await deriveSafe(signer.address, LEGACY_FACTORY);
    console.log(`\n🔎 Calculated Legacy Safe: \x1b[33m${legacySafeAddress}\x1b[0m`);

    let targetSafe = legacySafeAddress;
    // Optional Override
    const manualAddr = await question(`\nIs ${targetSafe} the target? [Y/n] (or paste address): `);
    if (manualAddr.trim().length > 40 && manualAddr.trim().startsWith('0x')) {
        targetSafe = manualAddr.trim();
    }

    const usdcContract = new Contract(TOKENS.USDC_BRIDGED, USDC_ABI, provider);
    const balance = await usdcContract.balanceOf(targetSafe);
    const balanceFmt = formatUnits(balance, 6);
    console.log(`   💰 Safe Balance: \x1b[32m$${balanceFmt} USDC\x1b[0m`);

    // Also check signer balance
    const signerBal = await usdcContract.balanceOf(signer.address);
    if (signerBal > 0n) {
        console.log(`   💰 Signer Balance: $${formatUnits(signerBal, 6)} USDC (Money is in EOA, not Safe!)`);
    }

    if (balance <= 0n) {
        console.log("   No funds in Safe.");
        if (signerBal > 0n) {
             const q = await question("   Recover funds from SIGNER (EOA) instead? [y/N]: ");
             if (q.toLowerCase() === 'y') {
                 // EOA Transfer Logic
                 console.log("   Sending from EOA...");
                 // Use a self-transfer to destination or just ask user for dest? 
                 // The prompt logic implies user has the key, so we just guide them.
                 // But to fix the TS error we cast to any.
                 const tx = await (usdcContract.connect(signer) as any).transfer(signer.address, signerBal); 
                 console.log("   You have the private key. Import it into Metamask to move these EOA funds.");
             }
        }
        process.exit(0);
    }

    // STEP 4: WITHDRAW FROM SAFE
    const confirm = await question(`\n⚠️  WITHDRAW $${balanceFmt} from SAFE to SIGNER (${signer.address})? [y/N]: `);
    if (confirm.toLowerCase() !== 'y') process.exit(0);

    // Gas check
    const gasBal = await provider.getBalance(signer.address);
    if (gasBal < 10000000000000000n) { 
            logger.error("❌ Insufficient POL in Signer to pay gas.");
            console.log(`   Send ~0.1 POL to ${signer.address} and retry.`);
            process.exit(1);
    }

    const safeContract = new Contract(targetSafe, SAFE_ABI, signer);
    const nonce = await safeContract.nonce();
    const usdcInterface = new Interface(USDC_ABI);
    const data = usdcInterface.encodeFunctionData("transfer", [signer.address, balance]);
    
    const txHashBytes = await safeContract.getTransactionHash(
        TOKENS.USDC_BRIDGED, 0, data, 0, 0, 0, 0,
        "0x0000000000000000000000000000000000000000",
        "0x0000000000000000000000000000000000000000",
        nonce
    );

    const signature = await signer.signMessage(Buffer.from(txHashBytes.slice(2), 'hex'));
    
    const tx = await safeContract.execTransaction(
        TOKENS.USDC_BRIDGED, 0, data, 0, 0, 0, 0,
        "0x0000000000000000000000000000000000000000",
        "0x0000000000000000000000000000000000000000",
        signature
    );
    
    console.log(`\n✅ SUCCESS! Tx: https://polygonscan.com/tx/${tx.hash}`);
    process.exit(0);
}

run().catch(console.error);
