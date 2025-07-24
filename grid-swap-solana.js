import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import {
    Connection, Keypair, PublicKey,
    VersionedTransaction, Transaction
} from '@solana/web3.js';
import {
    getMint,
    getAssociatedTokenAddress,
    createAssociatedTokenAccountInstruction
} from '@solana/spl-token';

/* ─── Конфигурация из .env ─── */
const {
    SOLANA_RPC_URL, KEYPAIR_PATH,
    INPUT_MINT, OUTPUT_MINT,
    SLIPPAGE_BPS, CHECK_INTERVAL,
    GRID_LOWER, GRID_UPPER,
    GRID_STEPS, SELL_THRESHOLD,
    COMMISSION_RESERVE_MULTIPLIER // Множитель для комиссии
} = process.env;

/* ─── Путь к файлу состояния грида ─── */
const STATE_PATH = path.resolve('grid_state.json');

/* ─── Функции для загрузки и сохранения состояния ─── */
function loadState(gridPrices) {
    let old = null;
    try { old = JSON.parse(fs.readFileSync(STATE_PATH)); } catch {}
    const levels = gridPrices.map(p => ({ price: p, bought: false, phAmount: null }));
    if (old?.levels) {
        for (const l of old.levels) if (l.bought) {
            const dst = levels.find(n => Math.abs(n.price - l.price) < Number.EPSILON);
            if (dst) { dst.bought = true; dst.phAmount = l.phAmount; }
        }
    }
    fs.writeFileSync(STATE_PATH, JSON.stringify({ levels }, null, 2));
    return { levels };
}

const saveState = s => fs.writeFileSync(STATE_PATH, JSON.stringify(s, null, 2));

/* ─── Маленький адаптер для кошелька ─── */
class NodeWallet {
    constructor(kp) { this.keypair = kp; this.publicKey = kp.publicKey; }
    async signTransaction(tx) { tx.sign([this.keypair]); return tx; }
}

/* ─── Логирование сделок ─── */
const logFilePath = path.resolve('grid_trade_log.csv');

function logTrade(action, price, amount, solBalance, phBalance) {
    const timestamp = new Date().toLocaleString();
    const logEntry = `${timestamp},${action},${price},${amount},${solBalance},${phBalance}\n`;

    if (!fs.existsSync(logFilePath)) {
        fs.writeFileSync(logFilePath, 'Timestamp,Action,Price,Amount,Solana Balance,PH Balance\n');
    }

    fs.appendFileSync(logFilePath, logEntry);
    console.log(`Logged: ${logEntry}`);
}

/* ─── MAIN ЛОГИКА ─── */
async function main() {
    const raw = JSON.parse(fs.readFileSync(KEYPAIR_PATH));
    const kp = Keypair.fromSecretKey(new Uint8Array(raw));
    const w = new NodeWallet(kp);
    const cxn = new Connection(SOLANA_RPC_URL, 'confirmed');

    const low = Number(GRID_LOWER), up = Number(GRID_UPPER), steps = Number(GRID_STEPS);
    const gridPrices = Array.from({ length: steps + 1 }, (_, i) => low + (up - low) * i / steps);
    const state = loadState(gridPrices);
    console.log('Grid levels:', gridPrices.map(p => p.toFixed(9)));

    const outMint = new PublicKey(OUTPUT_MINT);
    const ata = await getAssociatedTokenAddress(outMint, w.publicKey);
    if (!await cxn.getAccountInfo(ata)) {
        const ix = createAssociatedTokenAccountInstruction(w.publicKey, ata, w.publicKey, outMint);
        const tx = new Transaction().add(ix);
        tx.feePayer = w.publicKey;
        tx.recentBlockhash = (await cxn.getLatestBlockhash()).blockhash;
        tx.sign(kp);
        await cxn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
        console.log('✅ ATA created:', ata.toBase58());
    } else {
        console.log('✅ ATA exists:', ata.toBase58());
    }

    const outMintInfo = await getMint(cxn, outMint);
    const outDec = outMintInfo.decimals;

    // Резерв на комиссию для 30 ячеек
    const commissionReserve = COMMISSION_RESERVE_MULTIPLIER * GRID_STEPS * Number(0.01); // Рассчитываем резерв для 30 ячеек

    let prevPrice = Infinity;
    console.log(`\nStarting grid every ${CHECK_INTERVAL / 1000}s\n`);

    setInterval(trySwap, Number(CHECK_INTERVAL));

    async function trySwap() {
        const now = new Date().toLocaleTimeString();
        try {
            // --- Шаг 1: Узнаём актуальную цену ---
            const sampleAmt = 1_000_000n; // 0.001 SOL
            const sampleURL = new URL('https://lite-api.jup.ag/swap/v1/quote');
            sampleURL.searchParams.set('inputMint', INPUT_MINT);
            sampleURL.searchParams.set('outputMint', OUTPUT_MINT);
            sampleURL.searchParams.set('amount', sampleAmt.toString());
            sampleURL.searchParams.set('slippageBps', SLIPPAGE_BPS);
            const sampleJ = await (await fetch(sampleURL)).json();
            if (!sampleJ.routePlan?.length) {
                console.log(`[${now}] Нет цены для обмена`);
                return;
            }
            const curPrice = (Number(sampleAmt) / 1e9) / (Number(sampleJ.outAmount) / (10 ** outDec));

            console.log(`[${now}] Актуальная цена: ${curPrice.toFixed(9)} SOL/PH`);

            // --- Шаг 2: Балансы ---
            const solLam = await cxn.getBalance(w.publicKey, 'confirmed');
            const solBal = solLam / 1e9;
            const phRaw = (await cxn.getTokenAccountBalance(ata)).value.amount;
            const phBal = Number(phRaw) / (10 ** outDec);

            console.log(`[${now}] Балансы: SOL ${solBal.toFixed(6)} | PH ${phBal.toFixed(3)}`);

            // --- Шаг 3: Портфель и свободный капитал ---
            const investedPhSOL = state.levels
                .filter(l => l.bought && l.phAmount)
                .reduce((sum, l) => sum + (Number(l.phAmount) / (10 ** outDec)) * curPrice, 0);
            const totalValueSOL = solBal + phBal * curPrice;
            const freeValueSOL = totalValueSOL - investedPhSOL - Number(commissionReserve) / 1e9;

            console.log(`[${now}] Свободные средства для покупки: ${freeValueSOL.toFixed(6)} SOL`);

            // --- Шаг 4: Свободные средства для покупки ---
            const remain = steps - state.levels.filter(l => l.bought).length;
            let perGridLamports = 0n;

            // Если цена упала, определяем, сколько ячеек можно купить
            const priceDiff = prevPrice - curPrice;
            const gridsToBuy = Math.floor(priceDiff / (gridPrices[1] - gridPrices[0]));
            if (gridsToBuy > 0 && freeValueSOL > commissionReserve) {
                const availableSOL = freeValueSOL - commissionReserve;
                perGridLamports = BigInt(Math.floor((availableSOL * 1e9) / gridsToBuy));
            }

            console.log(`[${now}] Dynamic per-grid buy: ${(Number(perGridLamports) / 1e9).toFixed(6)} SOL`);
            console.log(`[${now}] Балансы: ${solBal.toFixed(6)} SOL | ${phBal.toFixed(3)} PH | цена ${curPrice.toFixed(9)}`);

            // Если на балансе недостаточно средств для покупки или всё куплено — только продажи
            if (perGridLamports > 0n) {
                // --- Шаг 5: Покупка с новым объёмом ---
                const buyURL = new URL(sampleURL);
                buyURL.searchParams.set('amount', perGridLamports.toString());
                const buyJ = await (await fetch(buyURL)).json();
                if (buyJ.routePlan?.length) {
                    const phOut = Number(buyJ.outAmount) / (10 ** outDec);
                    const price = (Number(perGridLamports) / 1e9) / phOut;

                    // Покупка по цене
                    for (let i = 0; i < gridPrices.length; i++) {
                        const lvl = state.levels[i];
                        if (!lvl.bought && prevPrice > lvl.price && price <= lvl.price) {
                            console.log(`🔔 Цена упала ниже ${lvl.price.toFixed(9)} — grid#${i} BUY`);
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

            // --- Шаг 6: Логика продажи (как раньше) ---
            const phBalRaw = BigInt((await cxn.getTokenAccountBalance(ata)).value.amount);
            for (let i = 0; i < state.levels.length - 1; i++) {
                const lvl = state.levels[i], next = state.levels[i + 1];
                if (lvl.bought && lvl.phAmount && phBalRaw >= BigInt(lvl.phAmount)) {
                    const sellURL = new URL('https://lite-api.jup.ag/swap/v1/quote');
                    sellURL.searchParams.set('inputMint', OUTPUT_MINT);
                    sellURL.searchParams.set('outputMint', INPUT_MINT);
                    sellURL.searchParams.set('amount', lvl.phAmount);
                    sellURL.searchParams.set('slippageBps', SLIPPAGE_BPS);
                    const sellJ = await (await fetch(sellURL)).json();
                    if (!sellJ.routePlan?.length) continue;
                    const solOut = Number(sellJ.outAmount) / 1e9;
                    const phIn = Number(lvl.phAmount) / (10 ** outDec);
                    const sellPr = solOut / phIn;
                    if (sellPr >= Number(SELL_THRESHOLD)) {
                        console.log(`🔔 Цена >= ${sellPr.toFixed(9)} — grid#${i} SELL`);
                        await execSwap(sellJ);
                        lvl.bought = false;
                        lvl.phAmount = null;
                        saveState(state);
                        break;
                    }
                }
            }

        } catch (e) {
            console.error(`[${now}] Ошибка:`, e);
        }
    }

    // Функция для выполнения swap
    async function execSwap(quoteJson) {
        const res = await fetch('https://lite-api.jup.ag/swap/v1/swap', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ quoteResponse: quoteJson, userPublicKey: w.publicKey.toBase58(), wrapUnwrapSOL: true, computeUnitPriceMicroLamports: 0 })
        });
        const j = await res.json();
        const tx = VersionedTransaction.deserialize(Buffer.from(j.swapTransaction, 'base64'));
        await w.signTransaction(tx);
        const sig = await cxn.sendRawTransaction(tx.serialize());
        await cxn.confirmTransaction(sig);
        console.log(`   ↳ tx: ${sig}`);
    }
}

main().catch(e => {
    console.error('Fatal', e);
    process.exit(1);
});
