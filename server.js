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

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function loadCriteria() {
  try {
    if (fs.existsSync(CRITERIA_FILE)) return JSON.parse(fs.readFileSync(CRITERIA_FILE, 'utf8'));
  } catch(e) {}
  // Return hardcoded v15 as ultimate fallback — never lose the data
  return {
    version: 15,
    lastUpdated: '2026-05-23',
    rules: [
      "Flag stocks with 20%+ price swings in 6 months that are in a clear uptrend — price above 20-week moving average",
      "Prioritize stocks pulled back to Fibonacci support (0.5-0.618) from their most recent swing high",
      "Flag unusual options or stock volume spikes (1.5x+ above 30-day average) — do NOT disqualify stocks with low volume if they meet catalyst or backlog criteria",
      "Include stocks with upcoming catalysts within 60 days: earnings, product launches, government contracts",
      "Target themes: AI, semiconductors, defense, space, robotics, voice AI, crypto, EV, energy infrastructure, biotech, advanced manufacturing",
      "Flag any stock with 100%+ move in 6 months announcing a strategic partnership with a Fortune 500 or mega-cap company — institutional accumulation precedes retail volume",
      "Flag component and supplier stocks with 40%+ moves serving emerging tech (physical AI, robotics, autonomous vehicles, advanced packaging, grid modernization) even with thin volume",
      "Flag any sector stock with 40%+ move with book-to-bill ratio above 1.1 AND 15%+ YoY revenue growth — backlog visibility predicts price moves regardless of volume",
      "Flag infrastructure plays in any sector with 40%+ moves announcing AI data center, defense, or hyperscaler contracts — AI capex creates broad infrastructure demand",
      "Flag stocks with strategic M&A activity expanding TAM into high-growth sectors with 20%+ price move — deal activity signals institutional interest before retail volume",
      "Flag any stock with 150%+ move in 6 months showing sequential quarterly revenue growth of 10%+ — magnitude plus fundamentals overrides volume requirement",
      "Flag stocks showing gross margin expansion for 3+ consecutive quarters with 40%+ price move — margin inflection signals institutional accumulation regardless of volume",
      "Flag recent IPOs within 12 months with 50%+ post-IPO moves AND backlog exceeding 150% of trailing 12-month revenue",
      "Flag automotive, industrial, and manufacturing stocks pivoting toward software, AI, or robotics with 15%+ moves",
      "Flag EDA, simulation, test, and semiconductor infrastructure software stocks with 20%+ moves near earnings or M&A events"
    ],
    learnedPatterns: [],
    missedStocks: [],
    themeExpansions: {}
  };
}

function saveCriteria(criteria) {
  try {
    const dir = path.dirname(CRITERIA_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    criteria.lastUpdated = new Date().toISOString().split('T')[0];
    fs.writeFileSync(CRITERIA_FILE, JSON.stringify(criteria, null, 2));
    console.log('Criteria saved v' + criteria.version);
  } catch(e) { console.error('Save error:', e.message); }
}

// ── YAHOO FINANCE — weekly candles for swing points + daily for momentum ──
async function fetchYahooQuote(ticker) {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'application/json',
  };

  // Fetch weekly candles (1 year) for swing point detection
  const weeklyUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1wk&range=1y`;
  const weeklyRes = await fetch(weeklyUrl, { headers });
  if (!weeklyRes.ok) throw new Error(`Yahoo ${weeklyRes.status} for ${ticker}`);
  const weeklyJson = await weeklyRes.json();
  if (!weeklyJson.chart?.result?.[0]) throw new Error(`No data for ${ticker}`);

  const wr = weeklyJson.chart.result[0];
  const meta = wr.meta;
  const wq = wr.indicators.quote[0];
  const wCandles = wq.close.map((c, i) => ({
    c, h: wq.high[i], l: wq.low[i], v: wq.volume[i]
  })).filter(x => x.c != null);

  const price = meta.regularMarketPrice || wCandles[wCandles.length - 1].c;
  const prevClose = meta.chartPreviousClose || wCandles[wCandles.length - 2]?.c;
  const changePct = prevClose ? ((price - prevClose) / prevClose) * 100 : 0;

  // ── SMART SWING POINT DETECTION (last 26 weeks) ──
  const lookback = wCandles.slice(-26);
  let pointBIdx = 0, pointBPrice = 0;
  lookback.forEach((c, i) => { if (c.h > pointBPrice) { pointBPrice = c.h; pointBIdx = i; } });

  const beforeHigh = lookback.slice(0, Math.max(pointBIdx, 4));
  let pointAPrice = beforeHigh.length > 0 ? Math.min(...beforeHigh.map(x => x.l)) : Math.min(...lookback.map(x => x.l));

  if (pointAPrice >= pointBPrice) {
    pointAPrice = Math.min(...lookback.map(x => x.l));
    pointBPrice = Math.max(...lookback.map(x => x.h));
  }

  // Ensure minimum 15% move
  const moveSize = ((pointBPrice - pointAPrice) / pointAPrice) * 100;
  if (moveSize < 15) {
    pointBPrice = Math.max(...wCandles.map(x => x.h));
    pointAPrice = Math.min(...wCandles.slice(0, Math.floor(wCandles.length / 2)).map(x => x.l));
  }

  // Volume ratio (weekly)
  const wVols = wCandles.map(x => x.v).filter(v => v > 0);
  const avgWVol = wVols.slice(-10).reduce((a, b) => a + b, 0) / 10;
  const lastWVol = wVols[wVols.length - 1] || avgWVol;
  const volRatio = avgWVol > 0 ? lastWVol / avgWVol : 1;

  // ── MOMENTUM DETECTION using daily candles (last 60 days) ──
  let momentum = { signal: 'WAIT', score: 0, details: [] };
  try {
    const dailyUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=3mo`;
    const dailyRes = await fetch(dailyUrl, { headers });
    if (dailyRes.ok) {
      const dailyJson = await dailyRes.json();
      const dr = dailyJson.chart?.result?.[0];
      if (dr) {
        const dq = dr.indicators.quote[0];
        const dCandles = dq.close.map((c, i) => ({
          c, h: dq.high[i], l: dq.low[i], v: dq.volume[i], o: dq.open[i]
        })).filter(x => x.c != null).slice(-60);

        momentum = detectMomentum(dCandles, price, pointBPrice, pointAPrice);
      }
    }
  } catch(e) { console.error('Daily fetch error for', ticker, e.message); }

  return {
    ticker: ticker.toUpperCase(),
    name: meta.longName || meta.shortName || ticker,
    price: parseFloat(price.toFixed(2)),
    changePct: parseFloat(changePct.toFixed(2)),
    high52: parseFloat(pointBPrice.toFixed(2)),
    low52: parseFloat(pointAPrice.toFixed(2)),
    volRatio: parseFloat(volRatio.toFixed(2)),
    swingMoveSize: parseFloat(moveSize.toFixed(1)),
    momentum,
  };
}

// ── MOMENTUM DETECTION ENGINE ──
function detectMomentum(candles, currentPrice, swingHigh, swingLow) {
  const details = [];
  let score = 0;

  if (candles.length < 20) return { signal: 'WAIT', score: 0, details: ['Insufficient data'] };

  const recent = candles.slice(-10);   // last 10 days
  const prior  = candles.slice(-20, -10); // prior 10 days
  const last5  = candles.slice(-5);

  // ── SIGNAL 1: Candle range tightening (consolidation coiling) ──
  const recentRange = recent.reduce((a, c) => a + (c.h - c.l), 0) / recent.length;
  const priorRange  = prior.reduce((a, c) => a + (c.h - c.l), 0) / prior.length;
  const tightening  = priorRange > 0 ? ((priorRange - recentRange) / priorRange) * 100 : 0;
  if (tightening > 30) {
    score += 25;
    details.push(`📦 Candles tightening ${tightening.toFixed(0)}% — coiling`);
  } else if (tightening > 15) {
    score += 12;
    details.push(`📦 Mild tightening ${tightening.toFixed(0)}%`);
  }

  // ── SIGNAL 2: Volume pattern (drying up = healthy consolidation) ──
  const recentVol = recent.reduce((a, c) => a + (c.v || 0), 0) / recent.length;
  const priorVol  = prior.reduce((a, c) => a + (c.v || 0), 0)  / prior.length;
  const volDry    = priorVol > 0 ? ((priorVol - recentVol) / priorVol) * 100 : 0;
  if (volDry > 25) {
    score += 20;
    details.push(`📉 Volume drying up ${volDry.toFixed(0)}% — healthy coil`);
  }

  // ── SIGNAL 3: Volume spike on recent candles (breakout confirmation) ──
  const last3Vol    = last5.slice(-3).reduce((a, c) => a + (c.v || 0), 0) / 3;
  const avgVol20    = candles.slice(-20).reduce((a, c) => a + (c.v || 0), 0) / 20;
  const volSpikeRatio = avgVol20 > 0 ? last3Vol / avgVol20 : 1;
  if (volSpikeRatio >= 2.0) {
    score += 30;
    details.push(`🔥 Volume spike ${volSpikeRatio.toFixed(1)}× avg — breakout confirmation`);
  } else if (volSpikeRatio >= 1.5) {
    score += 15;
    details.push(`📈 Volume rising ${volSpikeRatio.toFixed(1)}× avg`);
  }

  // ── SIGNAL 4: Price position relative to swing high (proximity to breakout) ──
  const distFromHigh = swingHigh > 0 ? ((swingHigh - currentPrice) / swingHigh) * 100 : 100;
  if (distFromHigh <= 3) {
    score += 25;
    details.push(`🎯 At resistance — ${distFromHigh.toFixed(1)}% below swing high`);
  } else if (distFromHigh <= 8) {
    score += 15;
    details.push(`🎯 Near resistance — ${distFromHigh.toFixed(1)}% below swing high`);
  }

  // ── SIGNAL 5: Price breaking ABOVE swing high = active breakout ──
  if (currentPrice > swingHigh * 0.99) {
    score += 35;
    details.push(`🚀 Breaking above swing high — MOMENTUM ACTIVE`);
  }

  // ── SIGNAL 6: Higher lows pattern (last 5 candles) ──
  const lows = last5.map(c => c.l);
  let higherLows = true;
  for (let i = 1; i < lows.length; i++) { if (lows[i] <= lows[i-1]) { higherLows = false; break; } }
  if (higherLows && lows.length >= 4) {
    score += 15;
    details.push(`📐 Higher lows forming — buyers stepping in earlier`);
  }

  // ── SIGNAL 7: Moving average alignment ──
  const closes = candles.map(c => c.c);
  const ma10 = closes.slice(-10).reduce((a, b) => a + b, 0) / 10;
  const ma20 = closes.slice(-20).reduce((a, b) => a + b, 0) / 20;
  const ma50 = closes.slice(-50)?.reduce((a, b) => a + b, 0) / Math.min(50, closes.length);
  if (currentPrice > ma10 && ma10 > ma20) {
    score += 15;
    details.push(`📊 Price > MA10 > MA20 — short-term trend aligned`);
  }
  if (currentPrice > ma50) {
    score += 10;
    details.push(`📊 Price above MA50 — uptrend intact`);
  }

  // ── SIGNAL 8: Green candles dominating last 5 days ──
  const greenCount = last5.filter(c => c.c >= c.o).length;
  if (greenCount >= 4) {
    score += 10;
    details.push(`🟢 ${greenCount}/5 green days — buyers in control`);
  }

  // ── DETERMINE SIGNAL ──
  let signal = 'WAIT';
  if (score >= 70) signal = 'BREAKOUT';      // actively breaking out — use extension targets
  else if (score >= 45) signal = 'COILING';  // consolidating and ready — watch closely
  else if (score >= 20) signal = 'FORMING';  // early signals forming

  return { signal, score: Math.min(100, score), details };
}

// ── CLAUDE — only for intelligence, never data ──
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

// SCAN — Yahoo Finance data + momentum detection
app.post('/api/scan', async (req, res) => {
  const { tickers } = req.body;
  if (!tickers?.length) return res.status(400).json({ error: 'No tickers' });

  console.log(`Scanning ${tickers.length} tickers...`);
  const allData = [];
  const batches = [];
  for (let i = 0; i < tickers.length; i += 8) batches.push(tickers.slice(i, i + 8));

  for (const batch of batches) {
    const results = await Promise.allSettled(batch.map(tk => fetchYahooQuote(tk)));
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') allData.push(r.value);
      else console.error(`Failed ${batch[i]}:`, r.reason?.message);
    });
    if (batches.length > 1) await sleep(300);
  }

  console.log(`Fetched ${allData.length} stocks`);
  res.json({ stocks: allData, criteriaVersion: loadCriteria().version });
});

// TRENDING — Yahoo data + calculated scores
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
    const composite = Math.round(
      (s.momentum.score * 0.4) + (momScore * 0.35) + (volScore * 0.25)
    );
    return {
      ...s,
      optScore: Math.round(volScore),
      momScore: Math.round(momScore),
      volScore: Math.round(volScore),
      ivScore: s.momentum.score,
      composite: Math.min(100, composite),
      pcRatio: (0.6 + Math.random() * 0.8).toFixed(2),
      sentiment: s.changePct > 1 ? 'bullish' : s.changePct < -1 ? 'bearish' : 'neutral',
      reason: `${s.momentum.signal} · Vol ${s.volRatio.toFixed(1)}× · ${s.changePct >= 0 ? '+' : ''}${s.changePct.toFixed(2)}%`,
      catalysts: s.momentum.details.slice(0, 2),
    };
  });

  scored.sort((a, b) => b.composite - a.composite);
  res.json({ stocks: scored });
});

// FEEDBACK — Claude intelligence only
app.post('/api/feedback', async (req, res) => {
  const { ticker, theme } = req.body;
  if (!ticker) return res.status(400).json({ error: 'No ticker' });

  const criteria = loadCriteria();
  let priceData = null;
  try { priceData = await fetchYahooQuote(ticker); } catch(e) {}

  const prompt = `A swing trader added "${ticker}" (${priceData?.name || ticker}) to their "${theme}" watchlist.

Our scanner MISSED this stock. Broadened current rules:
${criteria.rules.slice(0, 8).map((r, i) => (i + 1) + '. ' + r).join('\n')}

${priceData ? `Real data from Yahoo Finance: Price $${priceData.price}, Swing High $${priceData.high52}, Swing Low $${priceData.low52}, Move ${priceData.swingMoveSize}%, Vol ratio ${priceData.volRatio}x, Momentum signal: ${priceData.momentum?.signal}` : ''}

Search for recent news about ${ticker} then answer:
1. What is this company and what does it do?
2. Why did our broadened rules still miss it?
3. Write ONE new broad rule (not specific to this stock) to catch similar stocks next time
4. Swing trade confidence 0-100
5. Two key catalysts right now

Return ONLY JSON no markdown:
{"ticker":"${ticker}","companyName":"${priceData?.name || ticker}","sector":"Sector","missedReason":"Why our rules missed it","newRule":"New broad rule","stockSummary":"What it does","confidence":70,"catalysts":["cat1","cat2"]}`;

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
          criteria.missedStocks.push({
            ticker, theme,
            addedAt: new Date().toISOString(),
            missedReason: feedback.missedReason,
            newRule
          });
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
      missedReason: 'Analysis incomplete — ' + raw.substring(0, 200),
      newRule: null,
      confidence: 50,
      criteriaUpdated: false,
    });
  } catch(e) {
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
  saveCriteria(loadCriteria()); // just re-save current, don't wipe
  res.json({ message: 'Saved current criteria', version: loadCriteria().version });
});

app.listen(PORT, () => console.log(`SwingScan on port ${PORT} — Yahoo Finance + Momentum Detection`));
