// api/insight.js
import OpenAI from "openai";

const FINNHUB_TOKEN = process.env.FINNHUB_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

const API_BASE = "https://finnhub.io/api/v1";

async function finnhub(path, params = {}) {
  const url = new URL(API_BASE + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set("token", FINNHUB_TOKEN);

  const r = await fetch(url.toString(), { headers: { accept: "application/json" } });
  const ct = (r.headers.get("content-type") || "").toLowerCase();

  let payload = null;
  try {
    payload = ct.includes("application/json") ? await r.json() : await r.text();
  } catch {
    payload = null;
  }

  if (!r.ok) {
    const msg =
      payload && payload.error
        ? payload.error
        : typeof payload === "string"
        ? payload
        : JSON.stringify(payload);
    throw new Error(`Finnhub ${r.status}: ${msg}`);
  }

  return payload;
}

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

export default async function handler(req, res) {
  try {
    if (!OPENAI_API_KEY) return res.status(500).json({ error: "Server missing OPENAI_API_KEY env var" });
    if (!FINNHUB_TOKEN) return res.status(500).json({ error: "Server missing FINNHUB_TOKEN env var" });

    const url = new URL(req.url, `https://${req.headers.host}`);
    const symbol = String(url.searchParams.get("symbol") || "").trim().toUpperCase();
    if (!symbol) return res.status(400).json({ error: "Missing symbol" });

    // Time windows
    const now = new Date();
    const fromNews = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);
    const fromEarnings = new Date(now.getTime() - 120 * 24 * 60 * 60 * 1000);
    const toEarnings = new Date(now.getTime() + 120 * 24 * 60 * 60 * 1000);
    const fromInsider = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);

    // Pull Finnhub data (best-effort; don’t fail whole request if one endpoint fails)
    const [
      quote,
      profile,
      companyNews,
      earningsCal,
      recTrend,
      priceTarget,
      insiderTx,
    ] = await Promise.all([
      finnhub("/quote", { symbol }).catch(() => null),
      finnhub("/stock/profile2", { symbol }).catch(() => ({})),
      finnhub("/company-news", { symbol, from: isoDate(fromNews), to: isoDate(now) }).catch(() => []),
      finnhub("/calendar/earnings", { symbol, from: isoDate(fromEarnings), to: isoDate(toEarnings) }).catch(() => ({})),
      finnhub("/stock/recommendation", { symbol }).catch(() => []),
      finnhub("/stock/price-target", { symbol }).catch(() => null),
      finnhub("/stock/insider-transactions", { symbol, from: isoDate(fromInsider), to: isoDate(now) }).catch(() => ({})),
    ]);

    const topNews = Array.isArray(companyNews)
      ? companyNews.slice(0, 10).map((n) => ({
          headline: n.headline,
          source: n.source,
          datetime: n.datetime,
          url: n.url,
          summary: n.summary,
        }))
      : [];

    const facts = {
      symbol,
      quote,
      profile,
      news: topNews,
      earningsCalendar: earningsCal?.earningsCalendar || [],
      recommendationTrend: Array.isArray(recTrend) ? recTrend.slice(0, 2) : [],
      priceTarget,
      insiderTransactions: insiderTx?.data ? insiderTx.data.slice(0, 3) : [],
    };

    // JSON Schema the model must follow
    const schema = {
      type: "object",
      additionalProperties: false,
      properties: {
        title: { type: "string" },
        updatedLabel: { type: "string" },
        sentiment: { type: "string", enum: ["up", "down", "flat", "unknown"] },
        sections: {
          type: "array",
          minItems: 3,
          maxItems: 6,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              heading: { type: "string" },
              body: { type: "string" },
            },
            required: ["heading", "body"],
          },
        },
        citations: {
          type: "array",
          maxItems: 10,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              label: { type: "string" },
              url: { type: "string" },
            },
            required: ["label", "url"],
          },
        },
      },
      required: ["title", "updatedLabel", "sentiment", "sections", "citations"],
    };

    const prompt = {
      goal: "Generate a Robinhood-style 'Insight' story that explains why the stock is moving today.",
      rules: [
        "Use ONLY the provided facts. DO NOT invent events, numbers, deals, or dates.",
        "If facts are insufficient to explain the move, say 'No clear single driver' and focus on what IS known (e.g., earnings, guidance, analyst changes, macro).",
        "Short punchy writing. No more than 2 sentences per section.",
        "Headings should be short (2–6 words).",
        "When you mention a headline, include it in citations with its URL.",
      ],
      facts,
    };

    // ✅ Correct OpenAI call (fixes the 'text.format.name' error)
    const response = await openai.responses.create({
      model: "gpt-4o-mini",
      input: [
        {
          role: "system",
          content: "You write concise, finance-style market narratives. Follow the rules exactly.",
        },
        {
          role: "user",
          content: JSON.stringify(prompt),
        },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "insight",
          schema: schema,
        },
      },
    });

    const out = JSON.parse(response.output_text);

    // Basic cache headers
    res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=120");
    return res.status(200).json(out);
  } catch (e) {
    return res.status(500).json({ error: e?.message || String(e) });
  }
}


