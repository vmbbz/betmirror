import 'dotenv/config';
import mongoose from 'mongoose';
import { loadEnv } from '../config/env.js';
import readline from 'readline';
const env = loadEnv();
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});
async function wipe() {
    console.log('\n🔍 Connecting to inspect database...');
    try {
        // 1. Connect first to get the DB Name
        await mongoose.connect(env.mongoUri);
        const dbName = mongoose.connection.name;
        const host = mongoose.connection.host;
        console.log(`\n⚠️  DANGER ZONE: DATABASE WIPE ⚠️`);
        console.log(`-----------------------------------`);
        console.log(`📡 Host:      ${host}`);
        console.log(`🗄️  Database:  \x1b[31m${dbName}\x1b[0m  <-- THIS SPECIFIC DB WILL BE ERASED`);
        console.log(`-----------------------------------`);
        if (env.mongoUri.includes('prod') || env.mongoUri.includes('production')) {
            console.error('❌ SAFETY LOCK: Cannot wipe a URI containing "prod" via this script.');
            process.exit(1);
        }
        rl.question(`Are you sure you want to DROP the entire "${dbName}" database? (type "delete"): `, async (answer) => {
            if (answer === 'delete') {
                console.log(`🔥 Dropping database: ${dbName}...`);
                await mongoose.connection.dropDatabase();
                console.log('✅ Wiped Successfully.');
                console.log('   - Users collection removed');
                console.log('   - Trades collection removed');
                console.log('   - Registry collection removed');
                await mongoose.disconnect();
                process.exit(0);
            }
            else {
                console.log('🚫 Aborted. Nothing was deleted.');
                await mongoose.disconnect();
                process.exit(0);
            }
        });
    }
    catch (e) {
        console.error("Connection failed:", e);
        process.exit(1);
    }
}
wipe();
