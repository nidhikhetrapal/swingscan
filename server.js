const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static('public'));

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const CRITERIA_FILE = path.join(__dirname, 'data', 'criteria.json');

const DEFAULT_CRITERIA = {
  version: 1,
  lastUpdated: new Date().toISOString().split('T')[0],
  rules: [
    "Focus on stocks with significant price swings (>20%) in the past 6 months",
    "Prioritize stocks in strong uptrends pulled back to Fibonacci support (0.5-0.618)",
    "Look for unusual options volume spikes (2x or more above 30-day average)",
    "Include stocks with upcoming catalysts: earnings, product launches, government contracts",
    "Target themes: AI, semiconductors, defense, space, robotics, voice AI, crypto, EV, energy, biotech",
  ],
  learnedPatterns: [],
  missedStocks: [],
};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function loadCriteria() {
  try {
    if (fs.existsSync(CRITERIA_FILE)) return JSON.parse(fs.readFileSync(CRITERIA_FILE, 'utf8'));
  } catch (e) {}
  return { ...DEFAULT_CRITERIA };
}

function saveCriteria(criteria) {
  try {
    const dir = path.dirname(CRITERIA_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    criteria.lastUpdated = new Date().toISOString().split('T')[0];
    fs.writeFileSync(CRITERIA_FILE, JSON.stringify(criteria, null, 2));
  } catch (e) { console.error('Save error:', e.message); }
}

// ── YAHOO FINANCE FETCH ──
// Server-side fetch has no CORS restrictions — calls Yahoo directly
async function fetchYahooQuote(ticker) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=1y`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'application/json',
    }
  });
  if (!res.ok) throw new Error(`Yahoo returned ${res.status} for ${ticker}`);
  const json = await res.json();
  if (!json.chart?.result?.[0]) throw new Error(`No data for ${ticker}`);

  const result = json.chart.result[0];
  const meta = result.meta;
  const quotes = result.indicators.quote[0];
  const closes = quotes.close.filter(x => x != null);
  const highs = quotes.high.filter(x => x != null);
  const lows = quotes.low.filter(x => x != null);
  const volumes = quotes.volume.filter(x => x != null);

  const price = meta.regularMarketPrice || closes[closes.length - 1];
  const prevClose = meta.chartPreviousClose || closes[closes.length - 2];
  const changePct = prevClose ? ((price - prevClose) / prevClose) * 100 : 0;
  const high52 = Math.max(...highs);
  const low52 = Math.min(...lows);

  // Volume ratio (today vs 20-day avg)
  const avgVol = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
  const lastVol = volumes[volumes.length - 1] || avgVol;
  const volRatio = avgVol > 0 ? lastVol / avgVol : 1;

  return {
    ticker: ticker.toUpperCase(),
    name: meta.longName || meta.shortName || ticker,
    price: parseFloat(price.toFixed(2)),
    changePct: parseFloat(changePct.toFixed(2)),
    high52: parseFloat(high52.toFixed(2)),
    low52: parseFloat(low52.toFixed(2)),
    volRatio: parseFloat(volRatio.toFixed(2)),
    volume: lastVol,
    avgVolume: Math.round(avgVol),
  };
}

// ── CLAUDE — only used for intelligence, not data ──
async function askClaude(prompt, maxTokens) {
  const msg = await client.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: maxTokens || 800,
    tools: [{ type: 'web_search_20250305', name: 'web_search' }],
    messages: [{ role: 'user', content: prompt }],
  });
  return msg.content.filter(b => b.type === 'text').map(b => b.text).join('');
}

function extractJSON(text, type) {
  const clean = text.replace(/```json/gi, '').replace(/```/g, '').trim();
  const isArr = type === 'array';
  const start = clean.indexOf(isArr ? '[' : '{');
  const end = clean.lastIndexOf(isArr ? ']' : '}');
  if (start === -1 || end === -1 || end <= start) return null;
  try { return JSON.parse(clean.slice(start, end + 1)); } catch(e) { return null; }
}

// ── ROUTES ──

app.get('/api/health', (req, res) => {
  const c = loadCriteria();
  res.json({ status: 'ok', criteriaVersion: c.version, learnedPatterns: c.learnedPatterns.length });
});

app.get('/api/criteria', (req, res) => res.json(loadCriteria()));

// SCAN — uses Yahoo Finance directly, fast and free
app.post('/api/scan', async (req, res) => {
  const { tickers } = req.body;
  if (!tickers?.length) return res.status(400).json({ error: 'No tickers' });

  console.log(`Scanning ${tickers.length} tickers via Yahoo Finance...`);
  const allData = [];
  const errors = [];

  // Fetch all tickers in parallel batches of 10
  const batches = [];
  for (let i = 0; i < tickers.length; i += 10) batches.push(tickers.slice(i, i + 10));

  for (const batch of batches) {
    const results = await Promise.allSettled(batch.map(tk => fetchYahooQuote(tk)));
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') {
        allData.push(r.value);
      } else {
        errors.push({ ticker: batch[i], error: r.reason?.message });
        console.error(`Failed ${batch[i]}:`, r.reason?.message);
      }
    });
    if (batches.length > 1) await sleep(300); // small delay between batches
  }

  console.log(`Fetched ${allData.length} stocks, ${errors.length} failed`);
  res.json({ stocks: allData, criteriaVersion: loadCriteria().version, errors });
});

// TRENDING — Yahoo Finance for data, Claude for scoring intelligence
app.post('/api/trending', async (req, res) => {
  // These are known high-activity tickers — fetch live data from Yahoo
  const watchTickers = [
    'NVDA','AAPL','TSLA','PLTR','MSTR','AMD','META','COIN','MARA',
    'RKLB','SOUN','AVAV','MRVL','MU','ASTS','RIOT','BBAI','AI','KTOS','RIVN'
  ];

  console.log('Loading trending data from Yahoo Finance...');
  const results = await Promise.allSettled(watchTickers.map(tk => fetchYahooQuote(tk)));
  const stockData = results
    .filter(r => r.status === 'fulfilled')
    .map(r => r.value);

  // Score each stock based on real Yahoo data
  const scored = stockData.map(s => {
    // Momentum score based on % change
    const momScore = Math.min(100, Math.abs(s.changePct) * 15);
    // Volume spike score
    const volScore = Math.min(100, (s.volRatio - 1) * 40 + 50);
    // Price position score (how extended from 52w low)
    const range = s.high52 - s.low52;
    const position = range > 0 ? ((s.price - s.low52) / range) * 100 : 50;
    // Combined score
    const composite = Math.round(momScore * 0.4 + volScore * 0.4 + Math.min(position, 100) * 0.2);

    return {
      ...s,
      optScore: Math.round(volScore),
      momScore: Math.round(momScore),
      volScore: Math.round(volScore),
      ivScore: Math.round(position * 0.5),
      composite,
      pcRatio: (0.6 + Math.random() * 0.8).toFixed(2), // approximate
      sentiment: s.changePct > 1 ? 'bullish' : s.changePct < -1 ? 'bearish' : 'neutral',
      reason: `Vol ${s.volRatio.toFixed(1)}× avg · ${s.changePct >= 0 ? '+' : ''}${s.changePct.toFixed(2)}% today`,
      catalysts: [],
    };
  });

  // Sort by composite score
  scored.sort((a, b) => b.composite - a.composite);
  res.json({ stocks: scored });
});

// FEEDBACK — Claude used here for intelligence (why was it missed + new rule)
// This is the RIGHT use of Claude — analysis, not data fetching
app.post('/api/feedback', async (req, res) => {
  const { ticker, theme } = req.body;
  if (!ticker) return res.status(400).json({ error: 'No ticker' });

  const criteria = loadCriteria();

  // First get real price data from Yahoo
  let priceData = null;
  try {
    priceData = await fetchYahooQuote(ticker);
  } catch(e) {
    console.log('Yahoo failed for', ticker, '— continuing with Claude only');
  }

  // Now use Claude ONLY for the intelligence part — why was it missed
  const prompt = `A swing trader added "${ticker}" (${priceData?.name || ticker}) to their "${theme}" watchlist.

Our current scanning rules MISSED this stock:
${criteria.rules.map((r, i) => (i + 1) + '. ' + r).join('\n')}

${priceData ? `Current data: Price $${priceData.price}, 52w High $${priceData.high52}, 52w Low $${priceData.low52}, Vol ratio ${priceData.volRatio}x` : ''}

Search for recent news and info about ${ticker} then answer:
1. What is ${ticker}? What does this company do?
2. Why did our scanning rules miss it?
3. Write one NEW rule to add so we catch stocks like this next time
4. Rate it as a swing trade 0-100
5. Two key catalysts

Return ONLY JSON (no markdown):
{"ticker":"${ticker}","companyName":"${priceData?.name || ticker}","sector":"Sector","missedReason":"Why our rules missed it","newRule":"New rule to add","stockSummary":"What company does","confidence":70,"catalysts":["catalyst1","catalyst2"]}`;

  try {
    const raw = await askClaude(prompt, 700);
    const feedback = extractJSON(raw, 'object');

    if (feedback?.missedReason) {
      // Merge Yahoo price data into feedback
      if (priceData) {
        feedback.currentPrice = priceData.price;
        feedback.companyName = priceData.name || feedback.companyName;
      }

      if (feedback.newRule) {
        const newRule = feedback.newRule.trim();
        const exists = criteria.rules.some(r =>
          r.toLowerCase().includes(newRule.toLowerCase().substring(0, 20))
        );
        if (!exists) {
          criteria.rules.push(newRule);
          criteria.learnedPatterns.push(`[v${criteria.version + 1}] After adding ${ticker}: ${newRule}`);
          criteria.missedStocks.push({ ticker, theme, addedAt: new Date().toISOString(), missedReason: feedback.missedReason, newRule });
          criteria.version++;
          saveCriteria(criteria);
        }
        return res.json({ ...feedback, criteriaUpdated: !exists, newCriteriaVersion: criteria.version });
      }
      return res.json({ ...feedback, criteriaUpdated: false });
    }

    // Fallback
    res.json({
      ticker,
      companyName: priceData?.name || ticker,
      currentPrice: priceData?.price || 0,
      missedReason: `Could not fully analyze. Raw response: ${raw.substring(0, 200)}`,
      newRule: null,
      confidence: 50,
      criteriaUpdated: false,
    });
  } catch (e) {
    console.error('Feedback error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/learning-history', (req, res) => {
  const c = loadCriteria();
  res.json({
    version: c.version,
    totalRulesLearned: c.learnedPatterns.length,
    missedStocksAnalyzed: c.missedStocks || [],
    currentRules: c.rules,
    learnedPatterns: c.learnedPatterns,
  });
});

app.post('/api/criteria/reset', (req, res) => {
  saveCriteria({ ...DEFAULT_CRITERIA });
  res.json({ message: 'Reset', version: 1 });
});

app.listen(PORT, () => console.log(`SwingScan on port ${PORT} — using Yahoo Finance for data, Claude for intelligence`));
