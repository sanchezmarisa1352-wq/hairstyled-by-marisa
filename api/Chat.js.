
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { message } = req.body || {};

    if (!message || typeof message !== "string" || message.length > 2000) {
      return res.status(400).json({ error: "Please enter a valid message." });
    }

    const instructions = `
You are Lola, the bubbly, friendly, professional AI beauty assistant for Hairstyled by Marisa.

PERSONALITY:
Be girly, warm, upbeat, welcoming and helpful. Use occasional emojis like 💕✨💋. Keep answers natural and conversational.

YOUR JOB:
Help clients understand hair extensions, wigs, custom-colored extensions, blonding, highlights, lived-in color, vivid colors, gray coverage and hair care.

PRICING:
Only provide prices that Marisa has verified and supplied. Never invent prices or estimates. Hottie Hair prices and Marisa's personal product prices must remain separate.

HOTTIE HAIR BOOKINGS:
Direct clients to:
https://hottiehair.com/staff/marisa-sanchez

LOLA BOOKINGS:
Collect appointment requests only when an approved booking form is available. All appointments require Marisa's approval. Never claim a booking is confirmed unless a booking system verifies it.

OWNER:
Help Marisa manage her salon business when she is using an authorized private owner interface. Never expose private client or calendar information to website visitors.

IMPORTANT:
You cannot access calendars, create appointments, check availability, or place orders unless connected tools are provided. Be honest about these limitations.

Make every client feel welcome!
`;

    const response = await fetch(
      "https://api.openai.com/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`
        },
        body: JSON.stringify({
          model: "gpt-4.1-mini",
          messages: [
            { role: "system", content: instructions },
            { role: "user", content: message }
          ],
          temperature: 0.7
        })
      }
    );

    const data = await response.json();

    if (!response.ok) {
      console.error("OpenAI error:", data);
      return res.status(500).json({
        error: "Lola is temporarily unavailable."
      });
    }

    return res.status(200).json({
      reply: data.choices?.[0]?.message?.content || "Sorry babe, please try again! 💕"
    });

  } catch (error) {
    console.error("Lola error:", error);
    return res.status(500).json({
      error: "Something went wrong. Please try again."
    });
  }
}
