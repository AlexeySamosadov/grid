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

////////////////////////////////////////////////////////////////////////////////
// Конфиг из .env
////////////////////////////////////////////////////////////////////////////////
const {
    SOLANA_RPC_URL, KEYPAIR_PATH,
    INPUT_MINT, OUTPUT_MINT,
    SLIPPAGE_BPS, CHECK_INTERVAL,
    GRID_LOWER, GRID_UPPER,
    GRID_STEPS, SELL_THRESHOLD,
    COMMISSION_RESERVE_MULTIPLIER // Добавлено: множитель для комиссии
} = process.env;

////////////////////////////////////////////////////////////////////////////////
// Путь к файлу состояния грида
////////////////////////////////////////////////////////////////////////////////
const STATE_PATH = path.resolve('grid_state.json');

////////////////////////////////////////////////////////////////////////////////
// Функции для загрузки/сохранения state с миграцией старых флагов
////////////////////////////////////////////////////////////////////////////////
function loadState(gridPrices) {
    let old = null;
    try { old = JSON.parse(fs.readFileSync(STATE_PATH)); } catch {}
    const levels = gridPrices.map(p => ({ price: p, bought:false, phAmount:null }));
    if (old?.levels) {
        for (const l of old.levels) if (l.bought) {
            const dst = levels.find(n => Math.abs(n.price-l.price)<Number.EPSILON);
            if (dst) { dst.bought=true; dst.phAmount=l.phAmount; }
        }
    }
    fs.writeFileSync(STATE_PATH, JSON.stringify({levels},null,2));
    return { levels };
}
const saveState = s => fs.writeFileSync(STATE_PATH, JSON.stringify(s,null,2));

/* ─── tiny wallet adapter ─── */
class NodeWallet {
    constructor(kp){ this.keypair=kp; this.publicKey=kp.publicKey; }
    async signTransaction(tx){ tx.sign([this.keypair]); return tx; }
}

/* ──────────────── MAIN ──────────────── */
async function main(){
    /* 1) RPC & wallet */
    const raw = JSON.parse(fs.readFileSync(KEYPAIR_PATH));
    const kp  = Keypair.fromSecretKey(new Uint8Array(raw));
    const w   = new NodeWallet(kp);
    const cxn = new Connection(SOLANA_RPC_URL,'confirmed');

    /* 2) grid levels */
    const low = Number(GRID_LOWER), up = Number(GRID_UPPER), steps=Number(GRID_STEPS);
    const gridPrices = Array.from({length:steps+1},(_,i)=> low+(up-low)*i/steps);
    const state = loadState(gridPrices);
    console.log('Grid levels:', gridPrices.map(p=>p.toFixed(9)));

    /* 3) ensure ATA */
    const outMint=new PublicKey(OUTPUT_MINT);
    const ata = await getAssociatedTokenAddress(outMint,w.publicKey);
    if(!await cxn.getAccountInfo(ata)){
        const ix=createAssociatedTokenAccountInstruction(w.publicKey,ata,w.publicKey,outMint);
        const tx=new Transaction().add(ix);
        tx.feePayer=w.publicKey;
        tx.recentBlockhash=(await cxn.getLatestBlockhash()).blockhash;
        tx.sign(kp); await cxn.sendRawTransaction(tx.serialize(),{skipPreflight:true});
        console.log('✅ ATA created:',ata.toBase58());
    } else console.log('✅ ATA exists:',ata.toBase58());

    const outMintInfo=await getMint(cxn,outMint);
    const outDec   = outMintInfo.decimals;

    const reserve = BigInt(0.01*1e9);                       // 0.01 SOL на комиссии
    let prevPrice  = Infinity;

    // Величина резерва для комиссии
    const commissionReserve = COMMISSION_RESERVE_MULTIPLIER * GRID_STEPS * Number(0.01); // Рассчитываем резерв для 30 ячеек

    console.log(`\nStarting grid every ${CHECK_INTERVAL / 1000}s\n`);

    /* ─── main loop ─── */
    setInterval(trySwap, Number(CHECK_INTERVAL));

    async function trySwap(){
        const now = new Date().toLocaleTimeString();
        try{
            // --- Шаг 0: узнаём актуальную цену ---
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

            // --- Шаг 1: балансы ---
            const solLam = await cxn.getBalance(w.publicKey, 'confirmed');
            const solBal = solLam / 1e9;
            const phRaw  = (await cxn.getTokenAccountBalance(ata)).value.amount;
            const phBal  = Number(phRaw) / (10 ** outDec);

            // --- Шаг 2: портфель и свободные капитал ---
            const investedPhSOL = state.levels
                .filter(l => l.bought && l.phAmount)
                .reduce((sum, l) => sum + (Number(l.phAmount) / (10 ** outDec)) * curPrice, 0);
            const totalValueSOL = solBal + phBal * curPrice;
            const freeValueSOL  = totalValueSOL - investedPhSOL - Number(reserve) / 1e9;

            // --- Шаг 3: свободные средства для покупки ---
            const remain = steps - state.levels.filter(l => l.bought).length;
            const perGridLamports = remain > 0 && freeValueSOL > commissionReserve
                ? BigInt(Math.floor((freeValueSOL - commissionReserve) * 1e9 / remain))
                : 0n;

            console.log(`[${now}] Dynamic per-grid buy: ${(Number(perGridLamports) / 1e9).toFixed(6)} SOL`);
            console.log(`[${now}] Balances: ${solBal.toFixed(6)} SOL | ${phBal.toFixed(3)} PH | price ${curPrice.toFixed(9)}`);

            // Если нет свободного SOL или всё куплено — только продажи
            if (perGridLamports > 0n) {
                // --- Шаг 4: покупка с новым объёмом ---
                const buyURL = new URL(sampleURL);
                buyURL.searchParams.set('amount', perGridLamports.toString());
                const buyJ = await (await fetch(buyURL)).json();
                if (buyJ.routePlan?.length) {
                    const phOut = Number(buyJ.outAmount) / (10 ** outDec);
                    const price = (Number(perGridLamports) / 1e9) / phOut;

                    // Покупка, если цена меньше, чем текущая
                    for (let i = 0; i < gridPrices.length; i++) {
                        const lvl = state.levels[i];
                        if (!lvl.bought && price <= lvl.price) {
                            console.log(`🔔 Цена упала ниже ${lvl.price.toFixed(9)} — grid#${i} BUY`);
                            await execSwap(buyJ);
                            lvl.bought = true;
                            lvl.phAmount = buyJ.outAmount;
                            saveState(state);
                            break;
                        }
                    }
                }
            }

            // --- Шаг 5: Логика продажи (как раньше) ---
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
                    const phIn   = Number(lvl.phAmount) / (10**outDec);
                    const sellPr = solOut / phIn;
                    if (sellPr >= Number(SELL_THRESHOLD)){
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
