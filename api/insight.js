import OpenAI from "openai";

const FINNHUB_TOKEN = process.env.FINNHUB_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

const API_BASE = "https://finnhub.io/api/v1";

async function finnhub(path, params = {}) {
  const url = new URL(API_BASE + path);

  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }

  url.searchParams.set("token", FINNHUB_TOKEN);

  const r = await fetch(url.toString(), {
    headers: { accept: "application/json" }
  });

  if (!r.ok) {
    throw new Error(`Finnhub ${r.status}`);
  }

  return r.json();
}

export default async function handler(req, res) {
  try {
    if (!OPENAI_API_KEY) {
      return res.status(500).json({ error: "Missing OPENAI_API_KEY" });
    }

    if (!FINNHUB_TOKEN) {
      return res.status(500).json({ error: "Missing FINNHUB_TOKEN" });
    }

    const url = new URL(req.url, `http://${req.headers.host}`);
    const symbol = url.searchParams.get("symbol");

    if (!symbol) {
      return res.status(400).json({ error: "Missing symbol" });
    }

    // Fetch data from Finnhub
    const [quote, profile, news] = await Promise.all([
      finnhub("/quote", { symbol }),
      finnhub("/stock/profile2", { symbol }),
      finnhub("/company-news", {
        symbol,
        from: new Date(Date.now() - 2 * 86400000)
          .toISOString()
          .slice(0, 10),
        to: new Date().toISOString().slice(0, 10)
      })
    ]);

    const facts = {
      symbol,
      price: quote?.c,
      change: quote?.d,
      percentChange: quote?.dp,
      company: profile?.name,
      industry: profile?.finnhubIndustry,
      news: news?.slice(0, 5) || []
    };

    const schema = {
      type: "object",
      additionalProperties: false,
      properties: {
        title: { type: "string" },
        sentiment: {
          type: "string",
          enum: ["up", "down", "flat", "unknown"]
        },
        sections: {
          type: "array",
          minItems: 2,
          maxItems: 5,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              heading: { type: "string" },
              body: { type: "string" }
            },
            required: ["heading", "body"]
          }
        }
      },
      required: ["title", "sentiment", "sections"]
    };

    const prompt = {
      goal: "Explain why this stock is moving today.",
      rules: [
        "Use ONLY the provided facts.",
        "Do not invent numbers or events.",
        "Keep writing concise and finance-style."
      ],
      facts
    };

    const response = await openai.responses.create({
      model: "gpt-4o-mini",
      input: [
        {
          role: "system",
          content:
            "You write concise, finance-style market narratives."
        },
        {
          role: "user",
          content: JSON.stringify(prompt)
        }
      ],
      text: {
        format: {
          type: "json_schema",
          json_schema: {
            name: "insight",
            strict: true,
            schema
          }
        }
      }
    });

    const output = JSON.parse(response.output_text);

    res.setHeader(
      "Cache-Control",
      "s-maxage=60, stale-while-revalidate=120"
    );

    res.status(200).json(output);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

