// grid-swap-solana.js  (bulk‑BUY + bulk‑SELL + fee‑guard)

import 'dotenv/config';
import fs   from 'fs';
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

/* ─── .env ─── */
const {
    SOLANA_RPC_URL, KEYPAIR_PATH,
    INPUT_MINT,     OUTPUT_MINT,
    SLIPPAGE_BPS,   CHECK_INTERVAL,
    GRID_LOWER,     GRID_UPPER,
    GRID_STEPS,     SELL_THRESHOLD
} = process.env;

/* ─── параметры стратегии ─── */
const MIN_BUY_SOL             = 0.001;     // не меньше этой суммы
const MAX_PRIORITY_LAMPORTS   = 20_000;    // 0.00002 SOL
const RESERVE_SOL             = 0.01;      // запас на комиссии

/* ─── state file ─── */
const STATE_PATH = path.resolve('grid_state.json');
function loadState(gridPrices){
    let old=null; try{ old=JSON.parse(fs.readFileSync(STATE_PATH)); }catch{}
    const levels = gridPrices.map(p=>({price:p,bought:false,phAmount:null}));
    if(old?.levels){
        for(const l of old.levels) if(l.bought){
            const dst=levels.find(n=>Math.abs(n.price-l.price)<Number.EPSILON);
            if(dst){ dst.bought=true; dst.phAmount=l.phAmount; }
        }
    }
    fs.writeFileSync(STATE_PATH, JSON.stringify({levels},null,2));
    return {levels};
}
const saveState=s=>fs.writeFileSync(STATE_PATH,JSON.stringify(s,null,2));

class NodeWallet{
    constructor(kp){ this.keypair=kp; this.publicKey=kp.publicKey; }
    async signTransaction(tx){ tx.sign([this.keypair]); return tx; }
}

/* ───────────────── MAIN ───────────────── */
async function main(){
    /* wallet / rpc */
    const raw = JSON.parse(fs.readFileSync(KEYPAIR_PATH));
    const kp  = Keypair.fromSecretKey(new Uint8Array(raw));
    const w   = new NodeWallet(kp);
    const cxn = new Connection(SOLANA_RPC_URL,'confirmed');

    /* grid */
    const low=+GRID_LOWER, up=+GRID_UPPER, steps=+GRID_STEPS;
    const gridPrices = Array.from({length:steps+1},(_,i)=>low+(up-low)*i/steps);
    const state = loadState(gridPrices);
    console.log('Grid levels:', gridPrices.map(p=>p.toFixed(9)));

    /* ensure ATA */
    const outMint=new PublicKey(OUTPUT_MINT);
    const ata    = await getAssociatedTokenAddress(outMint,w.publicKey);
    if(!await cxn.getAccountInfo(ata)){
        const ix=createAssociatedTokenAccountInstruction(w.publicKey,ata,w.publicKey,outMint);
        const tx=new Transaction().add(ix);
        tx.feePayer=w.publicKey;
        tx.recentBlockhash=(await cxn.getLatestBlockhash()).blockhash;
        tx.sign(kp); await cxn.sendRawTransaction(tx.serialize(),{skipPreflight:true});
        console.log('✅ ATA created:',ata.toBase58());
    }else console.log('✅ ATA exists:',ata.toBase58());

    const outMintInfo=await getMint(cxn,outMint);
    const outDec = outMintInfo.decimals;
    const reserveLamports = BigInt(RESERVE_SOL*1e9);
    let prevPrice = Infinity;

    console.log(`\nStarting grid every ${CHECK_INTERVAL/1000}s\n`);
    setInterval(trySwap, +CHECK_INTERVAL);

    /* ───────── core loop ───────── */
    async function trySwap(){
        const now = new Date().toLocaleTimeString();
        try{
            /* 0) текущая цена (quote на 0.001 SOL) */
            const sampleAmt = 1_000_000n; // 0.001 SOL
            const price = await getPrice(sampleAmt);
            if(!price){ console.log(`[${now}] no price`); return; }

            /* 1) балансы */
            const solLam = await cxn.getBalance(w.publicKey,'confirmed');
            const solBal = solLam/1e9;
            const phRaw  = (await cxn.getTokenAccountBalance(ata)).value.amount;
            const phBal  = Number(phRaw)/(10**outDec);

            /* 2) капиталы */
            const investedSOL = state.levels
                .filter(l=>l.bought && l.phAmount)
                .reduce((s,l)=>s + (Number(l.phAmount)/(10**outDec))*price ,0);
            const totalValueSOL = solBal + phBal*price;
            let   freeValueSOL  = totalValueSOL - investedSOL - RESERVE_SOL;
            let   remain = steps - state.levels.filter(l=>l.bought).length;

            /* расчёт первого per‑grid */
            let perGridLamports = calcPerGridLamports();
            console.log(`[${now}] perGrid=${(Number(perGridLamports)/1e9).toFixed(6)} SOL | price=${price.toFixed(9)}`);

            /* 3) BULK‑BUY: покупаем все уровни, которые пересекли */
            if(perGridLamports>0n){
                for(let i=0;i<gridPrices.length;i++){
                    const lvl = state.levels[i];
                    if(!lvl.bought && prevPrice>lvl.price && price<=lvl.price){
                        // хватает ли ещё свободного капитала?
                        if(perGridLamports===0n) break;
                        console.log(`🔔 BUY grid#${i} @${lvl.price.toFixed(9)}`);
                        const buyQ = await getQuote(INPUT_MINT,OUTPUT_MINT,perGridLamports);
                        if(!buyQ){ console.log('   ↳ no route'); break; }
                        const ok  = await execSwap(buyQ);
                        if(!ok) break;                        // остановиться, если swap отклонён
                        lvl.bought=true; lvl.phAmount=buyQ.outAmount;
                        saveState(state);

                        // обновляем свободный капитал и пересчитываем объём
                        freeValueSOL -= Number(perGridLamports)/1e9;
                        remain--;
                        perGridLamports = calcPerGridLamports();
                    }
                }
                prevPrice = price;
            }

            /* 4) SELL лесенкой */
            const phBalRaw = BigInt((await cxn.getTokenAccountBalance(ata)).value.amount);
            for(let i=0;i<state.levels.length-1;i++){
                const lvl=state.levels[i];
                if(lvl.bought && lvl.phAmount && phBalRaw>=BigInt(lvl.phAmount)){
                    const sellJ = await getQuote(OUTPUT_MINT,INPUT_MINT,lvl.phAmount);
                    if(!sellJ) continue;
                    const solOut=Number(sellJ.outAmount)/1e9;
                    const phIn  = Number(lvl.phAmount)/(10**outDec);
                    if(solOut/phIn >= +SELL_THRESHOLD){
                        console.log(`🔔 SELL grid#${i} price=${(solOut/phIn).toFixed(9)}`);
                        const ok=await execSwap(sellJ);
                        if(ok){ lvl.bought=false; lvl.phAmount=null; saveState(state); }
                        break;
                    }
                }
            }

            /* 5) BULK‑SELL при пампе ≥ GRID_UPPER */
            const toSellRaw = state.levels
                .filter(l=>l.bought && l.phAmount)
                .reduce((s,l)=> s+BigInt(l.phAmount),0n);

            if(toSellRaw>0n && price>=+GRID_UPPER){
                console.log(`🔔 Price ≥ GRID_UPPER (${GRID_UPPER}) — bulk‑SELL ALL`);
                const bulkQ = await getQuote(OUTPUT_MINT,INPUT_MINT,toSellRaw);
                if(bulkQ && await execSwap(bulkQ)){
                    for(const l of state.levels){ l.bought=false; l.phAmount=null; }
                    saveState(state);
                    console.log(`✅ Bulk‑sold ${toSellRaw} raw units`);
                }
            }

            /* helper для пересчёта perGridLamports */
            function calcPerGridLamports(){
                if(remain<=0) return 0n;
                const v = freeValueSOL/remain;
                return v<MIN_BUY_SOL ? 0n : BigInt(Math.floor(v*1e9));
            }

        }catch(e){ console.error(`[${now}] Error`,e); }
    }

    /* ─────── helpers ─────── */
    async function getQuote(inMint,outMint,amt){
        if(amt===0n) return null;
        const u = new URL('https://lite-api.jup.ag/swap/v1/quote');
        u.searchParams.set('inputMint',inMint);
        u.searchParams.set('outputMint',outMint);
        u.searchParams.set('amount',amt.toString());
        u.searchParams.set('slippageBps',SLIPPAGE_BPS);
        const j = await (await fetch(u)).json();
        return j.routePlan?.length ? j : null;
    }
    async function getPrice(sampleAmt){
        const q = await getQuote(INPUT_MINT,OUTPUT_MINT,sampleAmt);
        return q ? (Number(sampleAmt)/1e9)/(Number(q.outAmount)/(10**outDec)) : null;
    }
    async function execSwap(qJson){
        const res = await fetch('https://lite-api.jup.ag/swap/v1/swap',{
            method:'POST', headers:{'Content-Type':'application/json'},
            body:JSON.stringify({
                quoteResponse:qJson,
                userPublicKey:w.publicKey.toBase58(),
                wrapUnwrapSOL:true,
                computeUnitPriceMicroLamports:0
            })
        });
        const j = await res.json();
        if(j.prioritizationFeeLamports>MAX_PRIORITY_LAMPORTS){
            console.log('   ↳ skip swap: high priority fee',j.prioritizationFeeLamports);
            return false;
        }
        const tx  = VersionedTransaction.deserialize(Buffer.from(j.swapTransaction,'base64'));
        await w.signTransaction(tx);
        const sig = await cxn.sendRawTransaction(tx.serialize());
        await cxn.confirmTransaction(sig);
        console.log('   ↳ tx:',sig);
        return true;
    }
}

main().catch(e=>{ console.error('Fatal',e); process.exit(1); });
