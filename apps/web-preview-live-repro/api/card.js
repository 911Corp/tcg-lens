import { readFile } from 'node:fs/promises';
import { loadCandidatePool } from './_candidate-pool.js';
const LANGS = new Set(['fr','en','ja']);
// v0.3.8: canonical prices (data/card-prices.json, tools/export-card-prices.mjs) first; live TCGdex second.
const pricesFile = process.env.TCG_LENS_POOL_DIR ? `${process.env.TCG_LENS_POOL_DIR.replace(/\/$/, '')}/card-prices.json` : new URL('../data/card-prices.json', import.meta.url);
let pricesP = null;
const canonicalPrices = () => (pricesP ??= readFile(pricesFile, 'utf8').then(JSON.parse).catch(() => ({ prices: {} })));
/** Canonical price entry → {market, cardmarket-like pricing for Heat}. TCGplayer: one sub-type → its price; several → the lowest, flagged `from`. */
export function marketFromCanonical(entry, asOf = null, prefer = 'eu') {
  if (!entry) return null;
  const [trend, avg1, avg7, avg30, low] = entry.cm || [];
  const center = [trend, avg7, avg30, avg1].find(v => Number(v) > 0) ?? null;
  const pricing = center != null ? { cardmarket: { trend, avg1, avg7, avg30, low } } : {};
  const cm = center != null ? { market: { center, low: low ?? null, high: null, currency: 'EUR', updated: asOf, source: 'Cardmarket' }, pricing } : null;
  const tpRows = Object.entries(entry.tp || {}).filter(([, v]) => Number(v) > 0);
  // Cardmarket momentum still feeds Heat when the TCGplayer price is shown.
  const tp = tpRows.length ? { market: { center: Math.min(...tpRows.map(([, v]) => v)), low: null, high: null, currency: 'USD', updated: asOf, source: 'TCGplayer', from: tpRows.length > 1, subtypes: Object.fromEntries(tpRows) }, pricing } : null;
  // v0.4.0: preferred market follows the app language (us → TCGplayer USD, eu → Cardmarket EUR), the other one as fallback.
  return prefer === 'us' ? (tp || cm) : (cm || tp);
}
const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
function heatFromPricing(p){
  const cm=p?.cardmarket||{};
  const vals=[cm.avg1,cm.avg7,cm.avg30,cm.trend].filter(v=>Number.isFinite(Number(v))&&Number(v)>0).map(Number);
  const weights={salesVelocity:.35,sellThrough:.25,demandMomentum:.20,marketDepth:.10,priceMomentum:.10};
  if(vals.length<2) return {score:null,label:'COLD',trend:'UNKNOWN',confidence:'LOW',beta:true,coverage:0,weights,components:{salesVelocity:null,sellThrough:null,demandMomentum:null,marketDepth:null,priceMomentum:null},reason:'Heat unavailable: confirmed sales velocity, sell-through, demand and market-depth inputs are not available.'};
  const avg1=Number(cm.avg1||cm.trend||cm.avg7||cm.avg30);
  const avg7=Number(cm.avg7||cm.trend||cm.avg30||avg1);
  const avg30=Number(cm.avg30||cm.trend||avg7);
  const m1=avg7>0?(avg1/avg7-1):0, m7=avg30>0?(avg7/avg30-1):0;
  const momentum=0.65*m1+0.35*m7;
  const priceMomentum=Math.round(clamp(50+momentum*260,0,100));
  // Preview-only partial estimate. Only the 10% Price Momentum component is populated.
  // Missing sales/supply inputs stay null instead of being fabricated.
  const score=priceMomentum;
  const label=score>=85?'SURGING':score>=65?'HOT':score>=40?'WARM':score>=20?'COOL':'COLD';
  const trend=momentum>0.04?'HEATING':momentum<-0.04?'COOLING':'STABLE';
  return {score,label,trend,confidence:'LOW',beta:true,coverage:.10,weights,components:{salesVelocity:null,sellThrough:null,demandMomentum:null,marketDepth:null,priceMomentum},momentum:Number(momentum.toFixed(4)),reason:'Heat Beta partial estimate: only Price Momentum is available here (10% of the target Heat model). Sales velocity, sell-through, demand momentum and market depth are not fabricated.'};
}
function marketFromPricing(p,prefer='eu'){
  let cm=p?.cardmarket||null, tp=p?.tcgplayer||null;
  if(prefer==='us'&&tp&&Object.values(tp).some(v=>v&&typeof v==='object'&&(Number(v.marketPrice)>0||Number(v.midPrice)>0)))cm=null;
  let center=null,low=null,high=null,currency='EUR',updated=null;
  if(cm){
    const centerCandidates=[cm.trend,cm.avg7,cm.avg30,cm.avg,cm.avg1].map(Number).filter(v=>Number.isFinite(v)&&v>0);
    center=centerCandidates[0]??null; low=Number(cm.low)>0?Number(cm.low):null;
    high=null; currency=typeof cm.unit==='string'?cm.unit:'EUR'; updated=cm.updated||null;
  } else if(tp){
    const variants=Object.values(tp).filter(v=>v&&typeof v==='object');
    const mp=variants.map(v=>Number(v.marketPrice||v.midPrice)).filter(v=>Number.isFinite(v)&&v>0);
    center=mp[0]??null; low=Math.min(...variants.map(v=>Number(v.lowPrice)).filter(v=>Number.isFinite(v)&&v>0)); if(!Number.isFinite(low)) low=null;
    high=null; currency=typeof tp.unit==='string'?tp.unit:'USD'; updated=tp.updated||null;
  }
  return {center,low,high,currency,updated};
}
export default async function handler(req,res){
  try{
    const lang=LANGS.has(String(req.query.lang||''))?String(req.query.lang):'fr';
    const id=String(req.query.id||'').trim(); if(!id)return res.status(400).json({error:'id required'});
    // Candidate languages (language not proven yet): canonical price of the first priced one.
    const alts=String(req.query.langs||'').split(',').filter(l=>LANGS.has(l)&&l!==lang);
    const store=await canonicalPrices();
    const priceLang=[lang,...alts].find(l=>store.prices?.[`${l}:${id}`]);
    const prefer=String(req.query.market||'')==='us'?'us':'eu';
    const canon=priceLang?marketFromCanonical(store.prices[`${priceLang}:${id}`],store.asOf,prefer):null;
    // TCGdex details (not available for printings imported from TCGplayer: their id is a canonical UUID).
    let c=null;
    if(!/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(id)){
      try{const upstream=await fetch(`https://api.tcgdex.net/v2/${lang}/cards/${encodeURIComponent(id)}`,{headers:{accept:'application/json'},signal:AbortSignal.timeout(4000)}); if(upstream.ok)c=await upstream.json();}catch{}
    }
    // v0.3.9: identity fields from the canonical pool when TCGdex does not know the printing (TCGplayer gap import).
    const pooled=(await loadCandidatePool(lang))?.byId?.get(id)||null;
    if(!c&&!canon&&!pooled)return res.status(404).json({error:'not found'});
    c=c||{id};
    if(pooled){
      c={...c,name:c.name||pooled.name,localId:c.localId??pooled.localId,
        set:c.set||{id:pooled.setId,name:pooled.setName,cardCount:{official:pooled.printedTotal??null}},
        releaseDate:pooled.releaseDate};
      if(!c.image&&pooled.image)c.image=pooled.image.replace(/\/low\.webp$/,'');
    }
    const pricing=canon?canon.pricing:(c.pricing||{});
    const fromTd=canon?null:marketFromPricing(pricing,prefer);
    const market=canon?canon.market:{...fromTd,source:fromTd.currency==='USD'?'TCGplayer':pricing.cardmarket?'Cardmarket':null};
    const body={id:c.id,name:c.name||null,localId:String(c.localId??''),category:c.category||null,hp:c.hp||null,types:c.types||[],rarity:c.rarity||null,illustrator:c.illustrator||null,description:c.description||null,set:c.set||null,variants:c.variants||null,pricing,image:c.image?(/\.(jpe?g|png|webp)$/i.test(c.image)?c.image:`${c.image}/high.webp`):null,market,priceLang:canon?priceLang:lang,heat:heatFromPricing(pricing),supplyDemand:{score:null,label:'Beta N/A',estimated:true,confidence:'LOW',reason:'Real offer/demand inventory and sold-volume inputs are unavailable in this preview.'},lang};
    res.setHeader('Cache-Control','s-maxage=900, stale-while-revalidate=3600'); res.setHeader('Vary','Accept-Encoding'); return res.status(200).json(body);
  }catch(e){return res.status(500).json({error:String(e?.message||e)});}
}
