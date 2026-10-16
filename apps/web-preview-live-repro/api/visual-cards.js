const LANGS=new Set(['fr','en','ja']);
async function getJson(url){const r=await fetch(url,{headers:{accept:'application/json'}});if(!r.ok)throw new Error(`TCGdex ${r.status}`);return r.json()}
export default async function handler(req,res){
  try{
    const lang=LANGS.has(String(req.query.lang||''))?String(req.query.lang):'fr';
    const size=Math.max(8,Math.min(80,Number(req.query.size)||40));
    const raw=String(req.query.cursor||'1:0');
    let [setPage,offset]=raw.split(':').map(Number);setPage=Math.max(1,Math.min(500,setPage||1));offset=Math.max(0,offset||0);
    const setsUrl=new URL(`https://api.tcgdex.net/v2/${lang}/sets`);
    setsUrl.searchParams.set('sort:field','releaseDate');setsUrl.searchParams.set('sort:order','DESC');setsUrl.searchParams.set('pagination:page',String(setPage));setsUrl.searchParams.set('pagination:itemsPerPage','1');
    let sets=await getJson(setsUrl);
    if(!Array.isArray(sets)||!sets.length){setPage=1;offset=0;setsUrl.searchParams.set('pagination:page','1');sets=await getJson(setsUrl)}
    const set=sets[0];if(!set?.id)return res.status(200).json({lang,items:[],nextCursor:'1:0'});
    const detail=await getJson(`https://api.tcgdex.net/v2/${lang}/sets/${encodeURIComponent(set.id)}`);
    const cards=Array.isArray(detail?.cards)?detail.cards:[];
    const slice=cards.slice(offset,offset+size);
    const items=slice.map(c=>({id:c.id,localId:String(c.localId??''),name:c.name||c.id,image:c.image?`${c.image}/low.webp`:null,lang,setId:set.id,setName:set.name||detail?.name||set.id})).filter(c=>c.image);
    const nextOffset=offset+size;const nextCursor=nextOffset<cards.length?`${setPage}:${nextOffset}`:`${setPage+1}:0`;
    res.setHeader('Cache-Control','s-maxage=21600, stale-while-revalidate=86400');
    return res.status(200).json({lang,set:{id:set.id,name:set.name||detail?.name,releaseDate:detail?.releaseDate||null},cursor:`${setPage}:${offset}`,nextCursor,items});
  }catch(e){return res.status(500).json({error:String(e?.message||e)})}
}
