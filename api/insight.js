import OpenAI from "openai";

const FINNHUB_TOKEN = process.env.FINNHUB_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

const BASE_URL = "https://finnhub.io/api/v1/";

async function finnhubFetch(path, params = {}) {
  const url = new URL(BASE_URL + path);
  Object.entries(params).forEach(([k, v]) =>
    url.searchParams.set(k, v)
  );
  url.searchParams.set("token", FINNHUB_TOKEN);

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error("Finnhub error");
  return res.json();
}

export default async function handler(req, res) {
  try {
    const { symbol } = req.query;
    if (!symbol) {
      return res.status(400).json({ error: "Missing symbol" });
    }

    const quote = await finnhubFetch("quote", { symbol });
    const profile = await finnhubFetch("stock/profile2", { symbol });
    const news = await finnhubFetch("company-news", {
      symbol,
      from: "2024-01-01",
      to: "2026-12-31",
    });

    const prompt = {
      symbol,
      company: profile.name,
      price: quote.c,
      change: quote.dp,
      headlines: news.slice(0, 3).map(n => n.headline),
    };

    const response = await openai.responses.create({
      model: "gpt-4o-mini",
      input: [
        {
          role: "system",
          content: "You write concise, finance-style stock insights."
        },
        {
          role: "user",
          content: JSON.stringify(prompt)
        }
      ]
    });

    return res.status(200).json({
      insight: response.output_text
    });

  } catch (err) {
    return res.status(500).json({
      error: err.message
    });
  }
}
