let cache={at:0,products:null};
async function products(){
  if(cache.products && Date.now()-cache.at<6*3600e3)return cache.products;
  const r=await fetch('https://downloads.s3.cardmarket.com/productCatalog/productList/products_nonsingles_6.json');
  if(!r.ok)throw new Error('Cardmarket catalog unavailable');
  const j=await r.json(); const arr=j.products||j.productList||j.items||[]; cache={at:Date.now(),products:arr}; return arr;
}
const classify=n=>{n=n.toLowerCase();if(/elite trainer|\betb\b/.test(n))return'ETB';if(/booster box|display/.test(n))return'BOOSTER_BOX';if(/booster bundle/.test(n))return'BOOSTER_BUNDLE';if(/booster pack/.test(n))return'BOOSTER_PACK';if(/blister/.test(n))return'BLISTER';if(/\btin\b/.test(n))return'TIN';if(/collection|collector chest|box/.test(n))return'COLLECTION_BOX';if(/deck/.test(n))return'DECK';return'SEALED_OTHER'};
export default async function handler(req,res){
  try{const q=String(req.query.q||'').trim().toLowerCase();if(q.length<2)return res.status(400).json({error:'q too short'});const arr=await products();
    const out=[]; for(const p of arr){const name=String(p.name||p.Name||'');const exp=String(p.expansionName||p.expansion||'');if((name+' '+exp).toLowerCase().includes(q)){out.push({id:String(p.idProduct||p.id_product||p.id||''),name,expansion:exp||null,category:p.categoryName||p.category||null,type:classify(name),dateAdded:p.dateAdded||p.date_added||null});if(out.length>=35)break;}}
    res.setHeader('Cache-Control','s-maxage=21600, stale-while-revalidate=86400');return res.status(200).json({items:out});
  }catch(e){return res.status(500).json({error:String(e?.message||e)});}
}
