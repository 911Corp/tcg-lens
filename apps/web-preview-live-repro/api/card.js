const LANGS = new Set(['fr','en','ja']);
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
function marketFromPricing(p){
  const cm=p?.cardmarket||null, tp=p?.tcgplayer||null;
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
    const u=`https://api.tcgdex.net/v2/${lang}/cards/${encodeURIComponent(id)}`;
    const upstream=await fetch(u,{headers:{accept:'application/json'}}); if(!upstream.ok)return res.status(upstream.status).json({error:'not found'});
    const c=await upstream.json(); const pricing=c.pricing||{};
    const body={id:c.id,name:c.name,localId:String(c.localId??''),category:c.category||null,hp:c.hp||null,types:c.types||[],rarity:c.rarity||null,illustrator:c.illustrator||null,description:c.description||null,set:c.set||null,variants:c.variants||null,pricing,image:c.image?`${c.image}/high.webp`:null,market:marketFromPricing(pricing),heat:heatFromPricing(pricing),supplyDemand:{score:null,label:'Beta N/A',estimated:true,confidence:'LOW',reason:'Real offer/demand inventory and sold-volume inputs are unavailable in this preview.'},lang};
    res.setHeader('Cache-Control','s-maxage=900, stale-while-revalidate=3600'); return res.status(200).json(body);
  }catch(e){return res.status(500).json({error:String(e?.message||e)});}
}
