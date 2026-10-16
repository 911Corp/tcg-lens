const LANGS = new Set(['fr','en','ja']);
const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
function heatFromPricing(p){
  const cm=p?.cardmarket||{};
  const vals=[cm.avg1,cm.avg7,cm.avg30,cm.trend].filter(v=>Number.isFinite(Number(v))&&Number(v)>0).map(Number);
  if(vals.length<2) return {score:null,label:'INSUFFICIENT',trend:'UNKNOWN',confidence:'LOW',reason:'Not enough comparable market history'};
  const avg1=Number(cm.avg1||cm.trend||cm.avg7||cm.avg30);
  const avg7=Number(cm.avg7||cm.trend||cm.avg30||avg1);
  const avg30=Number(cm.avg30||cm.trend||avg7);
  const m1=avg7>0?(avg1/avg7-1):0, m7=avg30>0?(avg7/avg30-1):0;
  const momentum=0.65*m1+0.35*m7;
  const coverage=(p?.cardmarket?1:0)+(p?.tcgplayer?1:0);
  const score=Math.round(clamp(50+momentum*180+coverage*4,10,92));
  const label=score>=80?'HOT':score>=65?'WARM':score>=45?'NEUTRAL':score>=30?'COOL':'COLD';
  const trend=momentum>0.04?'HEATING':momentum<-0.04?'COOLING':'STABLE';
  return {score,label,trend,confidence:'LOW',momentum:Number(momentum.toFixed(4)),reason:'Beta score based on price momentum and source coverage; confirmed sales volume is not available here.'};
}
function marketFromPricing(p){
  const cm=p?.cardmarket||null, tp=p?.tcgplayer||null;
  let center=null,low=null,high=null,currency='EUR',updated=null;
  if(cm){
    const centerCandidates=[cm.trend,cm.avg7,cm.avg30,cm.avg,cm.avg1].map(Number).filter(v=>Number.isFinite(v)&&v>0);
    center=centerCandidates[0]??null; low=Number(cm.low)>0?Number(cm.low):null;
    const spread=center&&low?Math.max(center-low,center*.08):center?center*.12:null;
    high=center&&spread?Number((center+spread).toFixed(2)):null; currency=typeof cm.unit==='string'?cm.unit:'EUR'; updated=cm.updated||null;
  } else if(tp){
    const variants=Object.values(tp).filter(v=>v&&typeof v==='object');
    const mp=variants.map(v=>Number(v.marketPrice||v.midPrice)).filter(v=>Number.isFinite(v)&&v>0);
    center=mp[0]??null; low=Math.min(...variants.map(v=>Number(v.lowPrice)).filter(v=>Number.isFinite(v)&&v>0)); if(!Number.isFinite(low)) low=null;
    high=center?Number((center*1.18).toFixed(2)):null; currency=typeof tp.unit==='string'?tp.unit:'USD'; updated=tp.updated||null;
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
    const body={id:c.id,name:c.name,localId:String(c.localId??''),category:c.category||null,hp:c.hp||null,types:c.types||[],rarity:c.rarity||null,illustrator:c.illustrator||null,description:c.description||null,set:c.set||null,variants:c.variants||null,pricing,image:c.image?`${c.image}/high.webp`:null,market:marketFromPricing(pricing),heat:heatFromPricing(pricing),lang};
    res.setHeader('Cache-Control','s-maxage=900, stale-while-revalidate=3600'); return res.status(200).json(body);
  }catch(e){return res.status(500).json({error:String(e?.message||e)});}
}
