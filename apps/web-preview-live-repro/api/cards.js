const LANGS = new Set(['fr','en','ja']);

export default async function handler(req,res){
  try{
    const lang = LANGS.has(String(req.query.lang||'')) ? String(req.query.lang) : 'fr';
    const q = String(req.query.q||'').trim();
    const localId = String(req.query.localId||'').trim();
    if(!q && !localId) return res.status(400).json({error:'q or localId required'});
    const u = new URL(`https://api.tcgdex.net/v2/${lang}/cards`);
    if(localId) u.searchParams.set('localId', localId.replace(/\/.*/,''));
    else u.searchParams.set('name', q);
    const upstream = await fetch(u, {headers:{accept:'application/json'}});
    if(!upstream.ok) return res.status(upstream.status).json({error:'TCGdex upstream error'});
    const data = await upstream.json();
    const out = (Array.isArray(data)?data:[]).slice(0,60).map(c=>({
      id:c.id, localId:String(c.localId??''), name:c.name,
      image:c.image ? `${c.image}/low.webp` : null, lang
    }));
    res.setHeader('Cache-Control','s-maxage=3600, stale-while-revalidate=86400');
    return res.status(200).json({items:out});
  }catch(e){return res.status(500).json({error:String(e?.message||e)});}
}
