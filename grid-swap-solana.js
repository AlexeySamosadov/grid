// grid-swap-solana.js

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import {
    Connection,
    Keypair,
    PublicKey,
    VersionedTransaction,
    Transaction
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
    SOLANA_RPC_URL,
    KEYPAIR_PATH,
    INPUT_MINT,
    OUTPUT_MINT,
    SLIPPAGE_BPS,
    CHECK_INTERVAL,
    GRID_LOWER,
    GRID_UPPER,
    GRID_STEPS,
    SELL_THRESHOLD
} = process.env;

////////////////////////////////////////////////////////////////////////////////
// Путь к файлу состояния грида
////////////////////////////////////////////////////////////////////////////////
const STATE_PATH = path.resolve('grid_state.json');

////////////////////////////////////////////////////////////////////////////////
// Функции для загрузки/сохранения state с миграцией старых флагов
////////////////////////////////////////////////////////////////////////////////
function loadState(gridPrices) {
    let oldState = null;
    try {
        oldState = JSON.parse(fs.readFileSync(STATE_PATH));
    } catch {
        // старого state нет
    }

    // Строим новый массив уровней
    const newLevels = gridPrices.map(price => ({ price, bought: false, phAmount: null }));

    // Переносим bought/phAmount из старого state по совпадению цен
    if (oldState && Array.isArray(oldState.levels)) {
        for (const lvl of oldState.levels) {
            if (lvl.bought) {
                const match = newLevels.find(nl => Math.abs(nl.price - lvl.price) < Number.EPSILON);
                if (match) {
                    match.bought = true;
                    match.phAmount = lvl.phAmount;
                }
            }
        }
    }

    const state = { levels: newLevels };
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
    return state;
}

function saveState(state) {
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

////////////////////////////////////////////////////////////////////////////////
// Легкий wallet-адаптер для VersionedTransaction
////////////////////////////////////////////////////////////////////////////////
class NodeWallet {
    constructor(keypair) {
        this.keypair   = keypair;
        this.publicKey = keypair.publicKey;
    }
    async signTransaction(tx) {
        tx.sign([this.keypair]);
        return tx;
    }
}

////////////////////////////////////////////////////////////////////////////////
// Основная логика
////////////////////////////////////////////////////////////////////////////////
async function main() {
    // 1) Load wallet + RPC
    const raw    = JSON.parse(fs.readFileSync(KEYPAIR_PATH));
    const kp     = Keypair.fromSecretKey(new Uint8Array(raw));
    const wallet = new NodeWallet(kp);
    const conn   = new Connection(SOLANA_RPC_URL, 'confirmed');

    // 2) Build grid price levels
    const lower = Number(GRID_LOWER);
    const upper = Number(GRID_UPPER);
    const steps = Number(GRID_STEPS);
    const gridPrices = [];
    for (let i = 0; i <= steps; i++) {
        gridPrices.push(lower + (upper - lower) * i / steps);
    }
    const state = loadState(gridPrices);
    console.log('Grid levels:', gridPrices.map(p => p.toFixed(9)));

    // 3) Ensure ATA for output mint
    const outMint     = new PublicKey(OUTPUT_MINT);
    const ataAddress  = await getAssociatedTokenAddress(outMint, wallet.publicKey);
    if (!(await conn.getAccountInfo(ataAddress))) {
        console.log('⚙️ ATA not found, creating...');
        const ix = createAssociatedTokenAccountInstruction(
            wallet.publicKey,
            ataAddress,
            wallet.publicKey,
            outMint
        );
        const tx0 = new Transaction().add(ix);
        tx0.feePayer        = wallet.publicKey;
        tx0.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
        tx0.sign(kp);
        const sig0 = await conn.sendRawTransaction(tx0.serialize());
        await conn.confirmTransaction(sig0);
        console.log('✅ ATA created:', ataAddress.toBase58());
    } else {
        console.log('✅ ATA exists:', ataAddress.toBase58());
    }

    // 4) Get decimals for output token
    const outMintInfo = await getMint(conn, outMint);
    const outDecimals = outMintInfo.decimals;

    // 5) Reserve for fees (static)
    const reserve = BigInt(0.01 * 1e9);  // reserve 0.01 SOL for fees

    // prevPrice для покупки только при прохождении уровня сверху вниз
    let prevPrice = Infinity;

    console.log(`
Starting grid swap every ${Number(CHECK_INTERVAL)/1000} sec
`);

    // 6) Cyclic function
    async function trySwap() {
        const now = new Date().toLocaleTimeString();

        // Dynamic allocation per grid cell based on current SOL balance
        const balanceLamports = await conn.getBalance(wallet.publicKey, 'confirmed');
        const usable = BigInt(balanceLamports) - reserve;
        const perGridLamports = usable / BigInt(steps);
        console.log(`[${now}] Dynamic per-grid buy: ${(Number(perGridLamports)/1e9).toFixed(6)} SOL`);
        () {
            const now = new Date().toLocaleTimeString();
            try {
                // 6.1) Fetch buy quote SOL→PH
                const buyUrl = new URL('https://lite-api.jup.ag/swap/v1/quote');
                buyUrl.searchParams.set('inputMint',  INPUT_MINT);
                buyUrl.searchParams.set('outputMint', OUTPUT_MINT);
                buyUrl.searchParams.set('amount',      perGridLamports.toString());
                buyUrl.searchParams.set('slippageBps', SLIPPAGE_BPS);
                const buyJ = await (await fetch(buyUrl)).json();

                if (buyJ.routePlan?.length) {
                    const solIn = Number(perGridLamports)/1e9;
                    const phOut = Number(buyJ.outAmount)/(10**outDecimals);
                    const price = solIn / phOut;
                    console.log(`[${now}] Current price: ${price.toFixed(9)} SOL/PH`);

                    // Grid BUY:
                    for (let i = 0; i < gridPrices.length; i++) {
                        const lvl = state.levels[i];
                        if (!lvl.bought && prevPrice > lvl.price && price <= lvl.price) {
                            console.log(`🔔 Price dropped through ${lvl.price.toFixed(9)} — grid#${i} BUY`);
                            const swapRes = await fetch('https://lite-api.jup.ag/swap/v1/swap', {
                                method:'POST', headers:{'Content-Type':'application/json'},
                                body: JSON.stringify({
                                    quoteResponse: buyJ,
                                    userPublicKey: wallet.publicKey.toBase58(),
                                    wrapUnwrapSOL:true
                                })
                            });
                            const swapJson = await swapRes.json();
                            const tx1 = VersionedTransaction.deserialize(
                                Buffer.from(swapJson.swapTransaction,'base64')
                            );
                            await wallet.signTransaction(tx1);
                            const txid1 = await conn.sendRawTransaction(tx1.serialize());
                            await conn.confirmTransaction(txid1);
                            console.log(`[${now}] ✅ GRID BUY txid: ${txid1}`);
                            lvl.bought   = true;
                            lvl.phAmount = buyJ.outAmount;
                            saveState(state);
                            break;
                        }
                    }
                    prevPrice = price;
                }

                // 6.2) Grid SELL для всех, кроме последнего
                const balInfo   = await conn.getTokenAccountBalance(ataAddress);
                const phBalance = BigInt(balInfo.value.amount);
                for (let i = 0; i < state.levels.length - 1; i++) {
                    const lvl  = state.levels[i];
                    const next = state.levels[i+1];
                    if (lvl.bought && lvl.phAmount && phBalance >= BigInt(lvl.phAmount)) {
                        const sellUrl = new URL('https://lite-api.jup.ag/swap/v1/quote');
                        sellUrl.searchParams.set('inputMint',  OUTPUT_MINT);
                        sellUrl.searchParams.set('outputMint', INPUT_MINT);
                        sellUrl.searchParams.set('amount',      lvl.phAmount);
                        sellUrl.searchParams.set('slippageBps', SLIPPAGE_BPS);
                        const sellJ = await (await fetch(sellUrl)).json();
                        if (sellJ.routePlan?.length) {
                            const solOut = Number(sellJ.outAmount)/1e9;
                            const phIn   = Number(lvl.phAmount)/(10**outDecimals);
                            const sellPr = solOut / phIn;
                            if (sellPr >= Number(SELL_THRESHOLD)) {
                                console.log(`🔔 Price ≥ ${sellPr.toFixed(9)} ≥ thresh — grid#${i} SELL`);
                                const swapRes2 = await fetch('https://lite-api.jup.ag/swap/v1/swap', {
                                    method:'POST', headers:{'Content-Type':'application/json'},
                                    body: JSON.stringify({
                                        quoteResponse: sellJ,
                                        userPublicKey: wallet.publicKey.toBase58(),
                                        wrapUnwrapSOL:true
                                    })
                                });
                                const swapJson2 = await swapRes2.json();
                                const tx2 = VersionedTransaction.deserialize(
                                    Buffer.from(swapJson2.swapTransaction,'base64')
                                );
                                await wallet.signTransaction(tx2);
                                const txid2 = await conn.sendRawTransaction(tx2.serialize());
                                await conn.confirmTransaction(txid2);
                                console.log(`[${now}] ✅ GRID SELL txid: ${txid2}`);
                                lvl.bought   = false;
                                lvl.phAmount = null;
                                saveState(state);
                                break;
                            }
                        }
                    }
                }

                // 6.3) SELL последнего уровня по достижении GRID_UPPER
                const last = state.levels[state.levels.length - 1];
                if (last.bought) {
                    const sellUrl = new URL('https://lite-api.jup.ag/swap/v1/quote');
                    sellUrl.searchParams.set('inputMint',  OUTPUT_MINT);
                    sellUrl.searchParams.set('outputMint', INPUT_MINT);
                    sellUrl.searchParams.set('amount',      last.phAmount);
                    sellUrl.searchParams.set('slippageBps', SLIPPAGE_BPS);
                    const sellJ = await (await fetch(sellUrl)).json();
                    if (sellJ.routePlan?.length) {
                        const solOut = Number(sellJ.outAmount)/1e9;
                        const phIn   = Number(last.phAmount)/(10**outDecimals);
                        const sellPr = solOut / phIn;
                        if (sellPr >= Number(GRID_UPPER)) {
                            console.log(`🔔 Price ≥ ${GRID_UPPER} — GRID SELL LAST`);
                            const swapRes3 = await fetch('https://lite-api.jup.ag/swap/v1/swap', {
                                method:'POST', headers:{'Content-Type':'application/json'},
                                body: JSON.stringify({
                                    quoteResponse: sellJ,
                                    userPublicKey: wallet.publicKey.toBase58(),
                                    wrapUnwrapSOL:true
                                })
                            });
                            const swapJson3 = await swapRes3.json();
                            const tx3 = VersionedTransaction.deserialize(
                                Buffer.from(swapJson3.swapTransaction,'base64')
                            );
                            await wallet.signTransaction(tx3);
                            const txid3 = await conn.sendRawTransaction(tx3.serialize());
                            await conn.confirmTransaction(txid3);
                            console.log(`[${now}] ✅ GRID SELL LAST txid: ${txid3}`);
                            last.bought   = false;
                            last.phAmount = null;
                            saveState(state);
                        }
                    }
                }

            } catch (err) {
                console.error(`[${new Date().toLocaleTimeString()}] Error in trySwap:`, err);
            }
        }

        setInterval(trySwap, Number(CHECK_INTERVAL));
    }

    main().catch(err => {
        console.error('Fatal:', err);
        process.exit(1);
    });
