export default function handler(req,res){res.status(200).json({ok:true,service:'tcg-lens-functional',time:new Date().toISOString()});}
