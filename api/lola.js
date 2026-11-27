export default async function handler(req,res){
if(req.method!=="POST")return res.status(405).json({error:"Method not allowed"});
if(!process.env.OPENAI_API_KEY)return res.status(503).json({error:"Lola is awaiting AI configuration."});
const messages=req.body?.messages;
if(!Array.isArray(messages)||messages.length>24||messages.some(m=>!["user","assistant"].includes(m.role)||typeof m.content!=="string"||m.content.length>2000))return res.status(400).json({error:"Invalid conversation"});
try{
const r=await fetch("https://api.openai.com/v1/chat/completions",{method:"POST",headers:{Authorization:"Bearer "+process.env.OPENAI_API_KEY,"Content-Type":"application/json"},body:JSON.stringify({model:process.env.LOLA_MODEL||"gpt-4.1-mini",max_completion_tokens:350,messages:[{role:"system",content:"You are Lola, bubbly professional salon concierge for Hairstyled by Marisa in Henderson/Las Vegas. Marisa is licensed in AZ and NV and DreamCatchers certified. Specialties: blonding, lived-in color, vivids, gray coverage, wefts, I-tips, K-tips, brows and scalp treatments. No lashes. Direct salon booking: https://hottiehair.com/staff/marisa-sanchez . Wigs and custom extensions: https://r0sktv-ya.myshopify.com . Never invent prices, stock, availability or confirmations. Refer to website service menu for pricing not verified. Independent booking is not enabled yet. Never access Square or imply synchronization. Do not request sensitive data. Be concise and friendly."},...messages]})});
if(!r.ok)return res.status(502).json({error:"Lola is temporarily unavailable."});
const j=await r.json();return res.json({reply:j.choices[0].message.content});
}catch{return res.status(502).json({error:"Lola is temporarily unavailable."})}
}