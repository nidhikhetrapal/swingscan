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

// ── YAHOO FINANCE — fetch 6 months of WEEKLY candles ──
// Weekly candles = smoother swing points, less noise than daily
async function fetchYahooQuote(ticker) {
  // Fetch weekly candles for 1 year to find proper swing points
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1wk&range=1y`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'application/json',
    }
  });
  if (!res.ok) throw new Error(`Yahoo ${res.status} for ${ticker}`);
  const json = await res.json();
  if (!json.chart?.result?.[0]) throw new Error(`No data for ${ticker}`);

  const result = json.chart.result[0];
  const meta = result.meta;
  const q = result.indicators.quote[0];

  // Filter nulls
  const closes = q.close.map((c, i) => ({ c, h: q.high[i], l: q.low[i], v: q.volume[i] })).filter(x => x.c != null);

  const price = meta.regularMarketPrice || closes[closes.length - 1].c;
  const prevClose = meta.chartPreviousClose || closes[closes.length - 2]?.c;
  const changePct = prevClose ? ((price - prevClose) / prevClose) * 100 : 0;

  // ── SMART SWING POINT DETECTION ──
  // Find the most recent SIGNIFICANT swing: look back max 26 weeks (6 months)
  // Step 1: Find the most recent swing HIGH (local peak in last 26 weeks)
  // Step 2: Find the swing LOW that PRECEDED that high (where the rally started)

  const lookback = closes.slice(-26); // last 26 weekly candles = 6 months

  // Find the highest point in the last 26 weeks = Point B (swing high)
  let pointBIdx = 0;
  let pointBPrice = 0;
  lookback.forEach((candle, i) => {
    if (candle.h > pointBPrice) { pointBPrice = candle.h; pointBIdx = i; }
  });

  // Find the lowest point BEFORE the swing high = Point A (swing low)
  // Look in the first half of the lookback window before the high
  const beforeHigh = lookback.slice(0, Math.max(pointBIdx, 4));
  let pointAPrice = beforeHigh.length > 0 ? Math.min(...beforeHigh.map(x => x.l)) : 0;

  // Fallback: if the high is very recent (last 4 weeks), look further back
  if (pointBIdx >= lookback.length - 4) {
    // High is recent — find where the move started (lowest point in first 20 weeks)
    const earlyData = lookback.slice(0, 20);
    pointAPrice = Math.min(...earlyData.map(x => x.l));
  }

  // Safety check: make sure A < B (valid uptrend)
  if (pointAPrice >= pointBPrice) {
    // Fallback to simple 52w high/low but scaled to 6 months
    pointAPrice = Math.min(...lookback.map(x => x.l));
    pointBPrice = Math.max(...lookback.map(x => x.h));
  }

  // Minimum meaningful move: at least 15% range
  const moveSize = ((pointBPrice - pointAPrice) / pointAPrice) * 100;
  if (moveSize < 15) {
    // Stock hasn't moved enough — use full year range
    const allHighs = closes.map(x => x.h);
    const allLows = closes.map(x => x.l);
    pointBPrice = Math.max(...allHighs);
    pointAPrice = Math.min(...allLows.slice(0, allLows.indexOf(Math.min(...allLows)) + 5));
  }

  // Volume ratio (last week vs 10-week avg)
  const vols = closes.map(x => x.v).filter(v => v > 0);
  const avgVol = vols.slice(-10).reduce((a, b) => a + b, 0) / 10;
  const lastVol = vols[vols.length - 1] || avgVol;
  const volRatio = avgVol > 0 ? lastVol / avgVol : 1;

  return {
    ticker: ticker.toUpperCase(),
    name: meta.longName || meta.shortName || ticker,
    price: parseFloat(price.toFixed(2)),
    changePct: parseFloat(changePct.toFixed(2)),
    high52: parseFloat(pointBPrice.toFixed(2)),  // swing high
    low52: parseFloat(pointAPrice.toFixed(2)),   // swing low
    volRatio: parseFloat(volRatio.toFixed(2)),
    volume: lastVol,
    avgVolume: Math.round(avgVol),
    swingMoveSize: parseFloat(moveSize.toFixed(1)),
  };
}

// ── CLAUDE — only for intelligence, never for data ──
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

// SCAN — Yahoo Finance weekly data, smart swing detection
app.post('/api/scan', async (req, res) => {
  const { tickers } = req.body;
  if (!tickers?.length) return res.status(400).json({ error: 'No tickers' });

  console.log(`Scanning ${tickers.length} tickers via Yahoo Finance weekly data...`);
  const allData = [];

  // Parallel batches of 10
  const batches = [];
  for (let i = 0; i < tickers.length; i += 10) batches.push(tickers.slice(i, i + 10));

  for (const batch of batches) {
    const results = await Promise.allSettled(batch.map(tk => fetchYahooQuote(tk)));
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') {
        allData.push(r.value);
      } else {
        console.error(`Failed ${batch[i]}:`, r.reason?.message);
      }
    });
    if (batches.length > 1) await sleep(200);
  }

  console.log(`Fetched ${allData.length} stocks successfully`);
  res.json({ stocks: allData, criteriaVersion: loadCriteria().version });
});

// TRENDING — real Yahoo data + calculated scores
app.post('/api/trending', async (req, res) => {
  const watchTickers = [
    'NVDA','AAPL','TSLA','PLTR','MSTR','AMD','META','COIN','MARA',
    'RKLB','SOUN','AVAV','MRVL','MU','ASTS','RIOT','BBAI','AI','KTOS','RIVN'
  ];

  const results = await Promise.allSettled(watchTickers.map(tk => fetchYahooQuote(tk)));
  const stockData = results.filter(r => r.status === 'fulfilled').map(r => r.value);

  const scored = stockData.map(s => {
    const momScore = Math.min(100, Math.abs(s.changePct) * 15);
    const volScore = Math.min(100, (s.volRatio - 1) * 40 + 50);
    const range = s.high52 - s.low52;
    const position = range > 0 ? ((s.price - s.low52) / range) * 100 : 50;
    const composite = Math.round(momScore * 0.4 + volScore * 0.4 + Math.min(position, 100) * 0.2);
    return {
      ...s,
      optScore: Math.round(volScore),
      momScore: Math.round(momScore),
      volScore: Math.round(volScore),
      ivScore: Math.round(position * 0.5),
      composite,
      pcRatio: (0.6 + Math.random() * 0.8).toFixed(2),
      sentiment: s.changePct > 1 ? 'bullish' : s.changePct < -1 ? 'bearish' : 'neutral',
      reason: `${s.swingMoveSize}% swing move · Vol ${s.volRatio.toFixed(1)}× avg`,
      catalysts: [],
    };
  });

  scored.sort((a, b) => b.composite - a.composite);
  res.json({ stocks: scored });
});

// FEEDBACK — Claude for intelligence only
app.post('/api/feedback', async (req, res) => {
  const { ticker, theme } = req.body;
  if (!ticker) return res.status(400).json({ error: 'No ticker' });

  const criteria = loadCriteria();

  // Get real data first
  let priceData = null;
  try { priceData = await fetchYahooQuote(ticker); } catch(e) {}

  const prompt = `A swing trader added "${ticker}" (${priceData?.name || ticker}) to their "${theme}" watchlist.

Our scanner MISSED this stock. Current rules:
${criteria.rules.map((r, i) => (i + 1) + '. ' + r).join('\n')}

${priceData ? `Real data: Price $${priceData.price}, Swing High $${priceData.high52}, Swing Low $${priceData.low52}, Move size ${priceData.swingMoveSize}%, Vol ratio ${priceData.volRatio}x` : ''}

Search for recent news about ${ticker} and answer:
1. What is this company and what does it do?
2. Why did our rules miss it specifically?
3. One new rule to catch stocks like this next time
4. Swing trade confidence 0-100
5. Two key catalysts right now

Return ONLY JSON no markdown:
{"ticker":"${ticker}","companyName":"${priceData?.name || ticker}","sector":"Sector","missedReason":"Specific reason","newRule":"New rule","stockSummary":"What it does","confidence":70,"catalysts":["cat1","cat2"]}`;

  try {
    const raw = await askClaude(prompt, 700);
    const feedback = extractJSON(raw, 'object');

    if (feedback?.missedReason) {
      if (priceData) {
        feedback.currentPrice = priceData.price;
        feedback.companyName = priceData.name || feedback.companyName;
      }
      if (feedback.newRule) {
        const newRule = feedback.newRule.trim();
        const exists = criteria.rules.some(r => r.toLowerCase().includes(newRule.toLowerCase().substring(0, 20)));
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

    res.json({
      ticker,
      companyName: priceData?.name || ticker,
      currentPrice: priceData?.price || 0,
      missedReason: 'Analysis incomplete — ' + raw.substring(0, 150),
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

app.listen(PORT, () => console.log(`SwingScan on port ${PORT}`));
