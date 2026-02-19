import OpenAI from "openai";

const FINNHUB_TOKEN = process.env.FINNHUB_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

const API_BASE = "https://finnhub.io/api/v1";

async function finnhub(path, params = {}) {
  const url = new URL(API_BASE + path);

  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, String(v));
  }

  url.searchParams.set("token", FINNHUB_TOKEN);

  const response = await fetch(url.toString(), {
    headers: { accept: "application/json" },
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(`Finnhub ${response.status}: ${JSON.stringify(data)}`);
  }

  return data;
}

export default async function handler(req, res) {
  try {
    const { symbol } = req.query;

    if (!symbol) {
      return res.status(400).json({ error: "Missing symbol" });
    }

    const quote = await finnhub("/quote", { symbol });

    const prompt = `
You are a financial analyst.

Stock: ${symbol}
Current Price: ${quote.c}
High: ${quote.h}
Low: ${quote.l}
Previous Close: ${quote.pc}

Write a short 3-5 sentence insight explaining today's movement.
Keep it clear and investor-friendly.
`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You are a helpful financial analyst." },
        { role: "user", content: prompt }
      ],
      temperature: 0.7
    });

    const insight = completion.choices[0].message.content;

    return res.status(200).json({
      insight,
      price: quote.c
    });

  } catch (error) {
    console.error(error);
    return res.status(500).json({
      error: error.message
    });
  }
}
