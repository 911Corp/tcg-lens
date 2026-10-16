export default async function handler(req,res){
  try{
    const raw=String(req.query.url||'');
    const u=new URL(raw);
    if(u.protocol!=='https:'||u.hostname!=='assets.tcgdex.net')return res.status(400).json({error:'unsupported image host'});
    const r=await fetch(u,{headers:{accept:'image/webp,image/*'}});
    if(!r.ok)return res.status(r.status).end();
    const buf=Buffer.from(await r.arrayBuffer());
    res.setHeader('Content-Type',r.headers.get('content-type')||'image/webp');
    res.setHeader('Cache-Control','public, s-maxage=604800, stale-while-revalidate=2592000');
    res.setHeader('Cross-Origin-Resource-Policy','cross-origin');
    return res.status(200).send(buf);
  }catch(e){return res.status(400).json({error:String(e?.message||e)})}
}
