// config.ts
import * as dotenv from 'dotenv';

dotenv.config();

interface Config {
    SOLANA_RPC_URL: string;
    KEYPAIR_PATH: string;
    INPUT_MINT: string;
    OUTPUT_MINT: string;
    SLIPPAGE_BPS: number;
    CHECK_INTERVAL: number;
    GRID_LOWER: number;
    GRID_UPPER: number;
    GRID_STEPS: number;
    SELL_THRESHOLD: number;
    COMMISSION_RESERVE_MULTIPLIER: number;
}

const config: Config = {
    SOLANA_RPC_URL: process.env.SOLANA_RPC_URL || '',
    KEYPAIR_PATH: process.env.KEYPAIR_PATH || '',
    INPUT_MINT: process.env.INPUT_MINT || '',
    OUTPUT_MINT: process.env.OUTPUT_MINT || '',
    SLIPPAGE_BPS: parseInt(process.env.SLIPPAGE_BPS || '0'),
    CHECK_INTERVAL: parseInt(process.env.CHECK_INTERVAL || '300000'),
    GRID_LOWER: parseFloat(process.env.GRID_LOWER || '0'),
    GRID_UPPER: parseFloat(process.env.GRID_UPPER || '1'),
    GRID_STEPS: parseInt(process.env.GRID_STEPS || '30'),
    SELL_THRESHOLD: parseFloat(process.env.SELL_THRESHOLD || '0.001'),
    COMMISSION_RESERVE_MULTIPLIER: parseFloat(process.env.COMMISSION_RESERVE_MULTIPLIER || '1'),
};

if (!config.SOLANA_RPC_URL || !config.KEYPAIR_PATH || !config.INPUT_MINT || !config.OUTPUT_MINT) {
    throw new Error('Missing required environment variables');
}

export { config };
