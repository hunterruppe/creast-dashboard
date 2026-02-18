Deploy Crest Dashboard + AI Insight on Vercel (no local server needed)

Files:
- public/index.html  (your dashboard)
- api/insight.js     (serverless function that calls Finnhub + OpenAI)

Deploy steps:
1) Create a free Vercel account.
2) Create a new project -> "Import" -> upload this folder (or connect GitHub).
3) In Vercel Project Settings -> Environment Variables, add:
   - OPENAI_API_KEY = your OpenAI API key
   - FINNHUB_TOKEN  = your Finnhub token
4) Deploy.
5) After deploy, open your site URL.
   The dashboard will call /api/insight?symbol=NVDA automatically when you select a ticker.

Test the API:
- https://YOUR-VERCEL-URL/api/insight?symbol=AAPL
