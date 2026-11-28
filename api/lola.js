import {database, publishableKey} from '../studio/client.js';

const guidance = `You are Lola, the friendly AI salon concierge for Hairstyled by Marisa in Henderson, Nevada.
Marisa is licensed in Arizona and Nevada and DreamCatchers certified. Help with blonding, lived-in color, vivids, gray coverage, extensions, brows and scalp treatments.
The approved catalog is the source of truth. Quote the exact display price for the matching service and distinguish starting prices, ranges, hair-only costs, installation units and consultation quotes. Calculate only from matching catalog entries and show quantities. If options or prices differ, ask one targeted question. Never invent a service, price, or salon policy. Marisa does not offer men's cuts or perms.
For hair consultations, ask about current hair, density, chemical history, maintenance, and desired result as relevant. Give conditional options and avoid guarantees, diagnoses and chemical formulas. Explain the difference between extension strands, pieces and rows. Custom wigs and colors require a quote when the catalog has no price.
Marisa accepts starts Monday–Wednesday and Friday–Saturday from 10 AM through 5:30 PM Pacific. Availability depends on service duration and is checked in the in-chat booking form. Never claim a slot is free or a request has been submitted. The form submits the request to Marisa for review. Do not request contact details in the chat transcript. If the latest message expresses an intent to check available times or make an appointment, set booking to true and invite the client to use the appointment form in the chat. Never suggest using Square or claim to approve, cancel or reschedule an appointment. Keep the reply concise and warm.`;

export default async function handler(req,res) {
  res.setHeader('Cache-Control','no-store');
  if (req.method !== 'POST') {
    res.setHeader('Allow','POST');
    return res.status(405).json({error:'Method not allowed'});
  }
  const messages = req.body?.messages;
  if (!Array.isArray(messages) || !messages.length || messages.length > 20 || messages.at(-1)?.role !== 'user'
    || messages.some(m => !m || !['user','assistant'].includes(m.role) ||
      typeof m.content !== 'string' || !m.content.trim() || m.content.length > 2000)) {
    return res.status(400).json({error:'Invalid conversation'});
  }
  const token = process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_OIDC_TOKEN;
  if (!token) return res.status(503).json({error:'Lola is temporarily unavailable.'});
  try {
    const catalogResponse = await fetch(database + '/rest/v1/lola_services?select=name,category,pricing_unit,price_cents&active=eq.true&order=category,name',
      {headers:{apikey:publishableKey},signal:AbortSignal.timeout(6000)});
    if (!catalogResponse.ok) throw new Error('Catalog unavailable');
    const catalog = await catalogResponse.json();
    if (!Array.isArray(catalog) || catalog.length < 50) throw new Error('Catalog incomplete');
    const result = await fetch('https://ai-gateway.vercel.sh/v1/chat/completions',{
      method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},
      signal:AbortSignal.timeout(20000),
      body:JSON.stringify({
        model:process.env.AI_GATEWAY_MODEL || 'openai/gpt-4.1-mini',
        max_completion_tokens:550,
        response_format:{type:'json_schema',json_schema:{name:'lola_reply',strict:true,schema:{
          type:'object',additionalProperties:false,required:['reply','booking'],
          properties:{reply:{type:'string'},booking:{type:'boolean'}}
        }}},
        messages:[
          {role:'system',content:guidance + '\nApproved catalog: ' + JSON.stringify(catalog)},
          ...messages.slice(-12).map(({role,content}) => ({role,content}))
        ]
      })
    });
    if (!result.ok) {
      console.error('LOLA_UPSTREAM',result.status);
      throw new Error('AI unavailable');
    }
    const response = await result.json();
    const {reply,booking} = JSON.parse(response.choices[0].message.content);
    if (typeof reply !== 'string' || typeof booking !== 'boolean') throw new Error('Invalid AI response');
    return res.json({reply,booking});
  } catch (error) {
    console.error('LOLA_EXCEPTION',error.name);
    return res.status(502).json({error:'Lola is temporarily unavailable.'});
  }
}
