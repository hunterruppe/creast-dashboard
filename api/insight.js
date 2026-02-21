import OpenAI from "openai";

const FINNHUB_TOKEN = process.env.FINNHUB_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

const API_BASE = "https://finnhub.io/api/v1";

async function finnhub(path, params = {}) {
  if (!FINNHUB_TOKEN) throw new Error("Missing FINNHUB_TOKEN env var");

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
      (typeof payload === "string" ? payload : "") ||
      `${r.status} ${r.statusText}`;
    throw new Error(`Finnhub ${r.status}: ${msg}`);
  }

  return payload;
}

function isoDaysAgo(n) {
  const d = new Date(Date.now() - n * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

function isoToday() {
  return new Date().toISOString().slice(0, 10);
}

export default async function handler(req, res) {
  try {
    const symbol = String(req.query.symbol || "").trim().toUpperCase();
    if (!symbol) return res.status(400).json({ error: "Missing ?symbol=XYZ" });

    if (!OPENAI_API_KEY) {
      return res.status(500).json({ error: "Missing OPENAI_API_KEY env var in Vercel" });
    }

    // ---------- Finnhub context ----------
    const from = isoDaysAgo(7);
    const to = isoToday();

    const [quote, profile, recs, pt, news] = await Promise.all([
      finnhub("/quote", { symbol }).catch(() => null),
      finnhub("/stock/profile2", { symbol }).catch(() => ({})),
      finnhub("/stock/recommendation", { symbol }).catch(() => []),
      finnhub("/stock/price-target", { symbol }).catch(() => null),
      finnhub("/company-news", { symbol, from, to }).catch(() => []),
    ]);

    const topNews = Array.isArray(news)
      ? news
          .filter((n) => n && n.headline && n.url)
          .sort((a, b) => (b.datetime || 0) - (a.datetime || 0))
          .slice(0, 6)
          .map((n) => ({
            headline: n.headline,
            source: n.source,
            url: n.url,
            datetime: n.datetime,
          }))
      : [];

    const recLatest = Array.isArray(recs) && recs.length ? recs[0] : null;

    // ---------- JSON Schema the UI expects ----------
    const schema = {
      type: "object",
      additionalProperties: false,
      properties: {
        title: { type: "string" },
        sentiment: { type: "string", enum: ["up", "down", "neutral"] },
        updatedLabel: { type: "string" },
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
          maxItems: 6,
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
      required: ["title", "sentiment", "updatedLabel", "sections", "citations"],
    };

    const input = [
      {
        role: "system",
        content:
          "Write concise, retail-investor-friendly market insight in a Robinhood style. Be factual. No hype. No financial advice. Keep each section short and clear.",
      },
      {
        role: "user",
        content: JSON.stringify(
          {
            symbol,
            quote,
            profile,
            analyst_recommendation_latest: recLatest,
            price_target: pt,
            top_news: topNews,
          },
          null,
          2
        ),
      },
    ];

    // ✅ IMPORTANT FIX: include text.format.name and schema directly
    const resp = await openai.responses.create({
      model: "gpt-4.1-mini",
      input,
      text: {
        format: {
          type: "json_schema",
          name: "crest_insight",
          schema,
          strict: true,
        },
      },
    });

    const outText = resp.output_text || "";
    let parsed;
    try {
      parsed = JSON.parse(outText);
    } catch {
      return res.status(500).json({
        error: "AI returned non-JSON output",
        debug: outText.slice(0, 800),
      });
    }

    parsed.symbol = symbol;
    return res.status(200).json(parsed);
  } catch (err) {
    return res.status(500).json({ error: err?.message || "Unknown server error" });
  }
}
