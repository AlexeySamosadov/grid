import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { Connection, Keypair, PublicKey, VersionedTransaction, Transaction } from '@solana/web3.js';
import { getMint, getAssociatedTokenAddress, createAssociatedTokenAccountInstruction } from '@solana/spl-token';
import { config } from './config';
import { logAndSendMessage } from './bot'; // Импортируем функцию для логирования

// Типы для состояния грида
interface GridLevel {
    price: number;
    bought: boolean;
    phAmount: string | null;
}

// Путь к файлу состояния грида
const STATE_PATH = path.resolve('grid_state.json');

// Функция для загрузки состояния
function loadState(gridPrices: number[]): { levels: GridLevel[] } {
    let old = null;
    try {
        old = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    } catch (e) {
        console.log('Не удалось загрузить состояние грида', e);
    }

    const levels: GridLevel[] = gridPrices.map(p => ({ price: p, bought: false, phAmount: null }));
    if (old?.levels) {
        for (const l of old.levels) {
            if (l.bought) {
                const dst = levels.find(n => Math.abs(n.price - l.price) < Number.EPSILON);
                if (dst) {
                    dst.bought = true;
                    dst.phAmount = l.phAmount;
                }
            }
        }
    }
    fs.writeFileSync(STATE_PATH, JSON.stringify({ levels }, null, 2));
    return { levels };
}

const saveState = (state: { levels: GridLevel[] }) => fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));

// Адаптер для кошелька
class NodeWallet {
    keypair: Keypair;
    publicKey: PublicKey;

    constructor(kp: Keypair) {
        this.keypair = kp;
        this.publicKey = kp.publicKey;
    }

    async signTransaction(tx: VersionedTransaction) {
        tx.sign([this.keypair]);
        return tx;
    }
}

// Проверка на NaN
function isValidNumber(value: any): boolean {
    return !isNaN(value) && value !== null && value !== undefined;
}

// Логирование сделок
const logFilePath = path.resolve('grid_trade_log.csv');

function logTrade(action: string, price: number, amount: string, solBalance: number, phBalance: number) {
    const timestamp = new Date().toLocaleString();
    const logEntry = `${timestamp},${action},${price},${amount},${solBalance},${phBalance}\n`;

    if (!fs.existsSync(logFilePath)) {
        fs.writeFileSync(logFilePath, 'Timestamp,Action,Price,Amount,Solana Balance,PH Balance\n');
    }

    fs.appendFileSync(logFilePath, logEntry);
    logAndSendMessage(`Logged: ${logEntry}`);
}

// Основная логика
async function main() {
    const raw = JSON.parse(fs.readFileSync(config.KEYPAIR_PATH, 'utf8'));
    const kp = Keypair.fromSecretKey(new Uint8Array(raw));
    const w = new NodeWallet(kp);
    const cxn = new Connection(config.SOLANA_RPC_URL, 'confirmed');

    const low = config.GRID_LOWER, up = config.GRID_UPPER, steps = config.GRID_STEPS;
    const gridPrices = Array.from({ length: steps + 1 }, (_, i) => low + (up - low) * i / steps);
    const state = loadState(gridPrices);
    logAndSendMessage('Grid levels: ' + gridPrices.map(p => p.toFixed(9)).join(', '));

    const outMint = new PublicKey(config.OUTPUT_MINT);
    const ata = await getAssociatedTokenAddress(outMint, w.publicKey);
    if (!await cxn.getAccountInfo(ata)) {
        const ix = createAssociatedTokenAccountInstruction(w.publicKey, ata, w.publicKey, outMint);
        const tx = new Transaction().add(ix);
        tx.feePayer = w.publicKey;
        tx.recentBlockhash = (await cxn.getLatestBlockhash()).blockhash;
        tx.sign(kp);
        await cxn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
        logAndSendMessage('✅ ATA created: ' + ata.toBase58());
    } else {
        logAndSendMessage('✅ ATA exists: ' + ata.toBase58());
    }

    const outMintInfo = await getMint(cxn, outMint);
    const outDec = outMintInfo.decimals;

    const commissionReserve = config.COMMISSION_RESERVE_MULTIPLIER * config.GRID_STEPS * Number(0.01); // Рассчитываем резерв для 30 ячеек

    let prevPrice = Infinity;
    logAndSendMessage(`\nStarting grid every ${config.CHECK_INTERVAL / 1000}s\n`);

    setInterval(trySwap, Number(config.CHECK_INTERVAL));

    async function trySwap() {
        const now = new Date().toLocaleTimeString();
        try {
            const sampleAmt = 1_000_000n;
            const sampleURL = new URL('https://lite-api.jup.ag/swap/v1/quote');
            sampleURL.searchParams.set('inputMint', config.INPUT_MINT);
            sampleURL.searchParams.set('outputMint', config.OUTPUT_MINT);
            sampleURL.searchParams.set('amount', sampleAmt.toString());
            sampleURL.searchParams.set('slippageBps', String(config.SLIPPAGE_BPS)); // Преобразуем в строку
            const sampleJ = await (await fetch(sampleURL)).json();
            if (!sampleJ.routePlan?.length) {
                logAndSendMessage(`[${now}] Нет цены для обмена`);
                return;
            }
            const curPrice = (Number(sampleAmt) / 1e9) / (Number(sampleJ.outAmount) / (10 ** outDec));
            logAndSendMessage(`[${now}] Актуальная цена: ${curPrice.toFixed(9)} SOL/PH`);

            const solLam = await cxn.getBalance(w.publicKey, 'confirmed');
            const solBal = solLam / 1e9;
            const phRaw = (await cxn.getTokenAccountBalance(ata)).value.amount;
            const phBal = Number(phRaw) / (10 ** outDec);
            logAndSendMessage(`[${now}] Балансы: SOL ${solBal.toFixed(6)} | PH ${phBal.toFixed(3)}`);

            const investedPhSOL = state.levels
                .filter(l => l.bought && l.phAmount)
                .reduce((sum, l) => sum + (Number(l.phAmount) / (10 ** outDec)) * curPrice, 0);
            const totalValueSOL = solBal + phBal * curPrice;
            const freeValueSOL = totalValueSOL - investedPhSOL - Number(commissionReserve) / 1e9;

            logAndSendMessage(`[${now}] Свободные средства для покупки: ${freeValueSOL.toFixed(6)} SOL`);

            const remain = steps - state.levels.filter(l => l.bought).length;
            let perGridLamports = 0n;

            const priceDiff = prevPrice - curPrice;
            const gridsToBuy = Math.floor(priceDiff / (gridPrices[1] - gridPrices[0]));
            if (gridsToBuy > 0 && freeValueSOL > commissionReserve) {
                const availableSOL = freeValueSOL - commissionReserve;
                perGridLamports = BigInt(Math.floor((availableSOL * 1e9) / gridsToBuy));
            }

            logAndSendMessage(`[${now}] Dynamic per-grid buy: ${(Number(perGridLamports) / 1e9).toFixed(6)} SOL`);
            logAndSendMessage(`[${now}] Балансы: ${solBal.toFixed(6)} SOL | ${phBal.toFixed(3)} PH | цена ${curPrice.toFixed(9)}`);

            if (perGridLamports > 0n) {
                const buyURL = new URL(sampleURL);
                buyURL.searchParams.set('amount', perGridLamports.toString());
                const buyJ = await (await fetch(buyURL)).json();
                if (buyJ.routePlan?.length) {
                    const phOut = Number(buyJ.outAmount) / (10 ** outDec);
                    const price = (Number(perGridLamports) / 1e9) / phOut;

                    for (let i = 0; i < gridPrices.length; i++) {
                        const lvl = state.levels[i];
                        if (!lvl.bought && prevPrice > lvl.price && price <= lvl.price) {
                            logAndSendMessage(`🔔 Цена упала ниже ${lvl.price.toFixed(9)} — grid#${i} BUY`);
                            await execSwap(buyJ);
                            lvl.bought = true;
                            lvl.phAmount = buyJ.outAmount;
                            saveState(state);
                            break;
                        }
                    }
                    prevPrice = price;
                }
            }
        } catch (e) {
            if (e instanceof Error) {
                logAndSendMessage(`[${now}] Ошибка: ${e.message}`);
            } else {
                logAndSendMessage(`[${now}] Ошибка: Неизвестная ошибка`);
            }
        }
    }

    async function execSwap(quoteJson: any) {
        const res = await fetch('https://lite-api.jup.ag/swap/v1/swap', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                quoteResponse: quoteJson,
                userPublicKey: w.publicKey.toBase58(),
                wrapUnwrapSOL: true,
                computeUnitPriceMicroLamports: 0
            })
        });
        const j = await res.json();
        const tx = VersionedTransaction.deserialize(Buffer.from(j.swapTransaction, 'base64'));
        await w.signTransaction(tx);
        const sig = await cxn.sendRawTransaction(tx.serialize());
        await cxn.confirmTransaction(sig);
        logAndSendMessage(`   ↳ tx: ${sig}`);
    }
}

main().catch(e => {
    logAndSendMessage('Fatal: ' + e.message);
    process.exit(1);
});
