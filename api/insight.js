import OpenAI from "openai";

const FINNHUB_TOKEN = process.env.FINNHUB_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

const API_BASE = "https://finnhub.io/api/v1";

async function finnhub(path, params = {}) {
  const url = new URL(API_BASE + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  url.searchParams.set("token", FINNHUB_TOKEN);

  const r = await fetch(url.toString(), { headers: { accept: "application/json" } });
  const ct = (r.headers.get("content-type") || "").toLowerCase();

  let payload;
  try {
    payload = ct.includes("application/json") ? await r.json() : await r.text();
  } catch {
    payload = null;
  }

  if (!r.ok) {
    const msg =
      (payload && payload.error) ||
      (typeof payload === "string" ? payload : JSON.stringify(payload));
    throw new Error(`Finnhub ${r.status}: ${msg}`);
  }

  return payload;
}

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

export default async function handler(req, res) {
  try {
    if (!OPENAI_API_KEY) {
      return res.status(500).json({ error: "Missing OPENAI_API_KEY env var" });
    }
    if (!FINNHUB_TOKEN) {
      return res.status(500).json({ error: "Missing FINNHUB_TOKEN env var" });
    }

    const symbol = String(req.query.symbol || "").trim().toUpperCase();
    if (!symbol) return res.status(400).json({ error: "Missing symbol" });

    const now = new Date();
    const fromNews = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const fromInsider = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);

    const [
      quote,
      profile,
      recTrend,
      priceTarget,
      companyNews,
      insiderTx,
    ] = await Promise.all([
      finnhub("/quote", { symbol }).catch(() => null),
      finnhub("/stock/profile2", { symbol }).catch(() => null),
      finnhub("/stock/recommendation", { symbol }).catch(() => []),
      finnhub("/stock/price-target", { symbol }).catch(() => null),
      finnhub("/company-news", { symbol, from: isoDate(fromNews), to: isoDate(now) }).catch(() => []),
      finnhub("/stock/insider-transactions", { symbol, from: isoDate(fromInsider), to: isoDate(now) }).catch(() => null),
    ]);

    const topNews = Array.isArray(companyNews)
      ? companyNews.slice(0, 6).map((n) => ({
          headline: n.headline,
          source: n.source,
          datetime: n.datetime,
          url: n.url,
          summary: n.summary,
        }))
      : [];

    const recommendation = Array.isArray(recTrend) ? recTrend[0] : null;

    const insiderSummary =
      insiderTx && Array.isArray(insiderTx.data)
        ? insiderTx.data.slice(0, 6).map((t) => ({
            name: t.name,
            transactionDate: t.transactionDate,
            transactionCode: t.transactionCode,
            transactionPrice: t.transactionPrice,
            transactionShare: t.transactionShare,
          }))
        : [];

    const facts = {
      symbol,
      quote,
      profile,
      recommendation,
      priceTarget,
      topNews,
      insiderSummary,
      asOf: now.toISOString(),
    };

    // Ask OpenAI for a single readable paragraph
    const schema = {
      type: "object",
      additionalProperties: false,
      properties: {
        insight: { type: "string" },
      },
      required: ["insight"],
    };

    const response = await openai.responses.create({
      model: "gpt-4o-mini",
      input: [
        {
          role: "system",
          content:
            "You write concise, finance-style market narratives. Use ONLY the provided facts. If facts are insufficient, say what is known and avoid guessing.",
        },
        {
          role: "user",
          content:
            "Write a short 'Insight' about why this stock may be moving today. Keep it 3-6 sentences max. " +
            "If there is no clear driver, say so. Facts:\n" +
            JSON.stringify(facts),
        },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "insight",
          schema,
        },
      },
    });

    // Responses API returns a string version of the JSON in output_text
    let parsed;
    try {
      parsed = JSON.parse(response.output_text || "{}");
    } catch {
      parsed = { insight: response.output_text || "" };
    }

    const insight = (parsed.insight || "").trim();

    res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=120");
    return res.status(200).json({
      symbol,
      insight: insight || "No clear single driver today based on available data.",
      updatedAt: new Date().toISOString(),
    });
  } catch (e) {
    return res.status(500).json({ error: e.message || "Server error" });
  }
}
