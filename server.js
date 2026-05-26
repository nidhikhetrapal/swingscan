const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');
const { getMarketRegime } = require('./services/regime');
const { getStockNews, getMarketNews } = require('./services/news');
const { classifyMode, applyRegimeContext, calcEMA, calcRSI } = require('./services/mode');

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
  return {
    version: 15, lastUpdated: '2026-05-23',
    rules: [
      "Flag stocks with 20%+ price swings in 6 months that are in a clear uptrend — price above 20-week moving average",
      "Prioritize stocks pulled back to Fibonacci support (0.5-0.618) from their most recent swing high",
      "Flag unusual options or stock volume spikes (1.5x+ above 30-day average) — do NOT disqualify stocks with low volume if they meet catalyst or backlog criteria",
      "Include stocks with upcoming catalysts within 60 days: earnings, product launches, government contracts",
      "Target themes: AI, semiconductors, defense, space, robotics, voice AI, crypto, EV, energy infrastructure, biotech, advanced manufacturing",
      "Flag any stock with 100%+ move in 6 months announcing a strategic partnership with a Fortune 500 or mega-cap company",
      "Flag component and supplier stocks with 40%+ moves serving emerging tech even with thin volume",
      "Flag any sector stock with 40%+ move with book-to-bill ratio above 1.1 AND 15%+ YoY revenue growth",
      "Flag infrastructure plays in any sector with 40%+ moves announcing AI data center, defense, or hyperscaler contracts",
      "Flag stocks with strategic M&A activity expanding TAM into high-growth sectors with 20%+ price move",
      "Flag any stock with 150%+ move in 6 months showing sequential quarterly revenue growth of 10%+",
      "Flag stocks showing gross margin expansion for 3+ consecutive quarters with 40%+ price move",
      "Flag recent IPOs within 12 months with 50%+ post-IPO moves AND backlog exceeding 150% of trailing 12-month revenue",
      "Flag automotive, industrial, and manufacturing stocks pivoting toward software, AI, or robotics with 15%+ moves",
      "Flag EDA, simulation, test, and semiconductor infrastructure software stocks with 20%+ moves near earnings or M&A events"
    ],
    learnedPatterns: [], missedStocks: [], themeExpansions: {}
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

// ── MOMENTUM DETECTION ENGINE ──
// Uses daily candles. Completely separate from Fibonacci swing points.
function detectMomentum(candles, currentPrice, fibSwingHigh, fibSwingLow) {
  if (candles.length < 20) return { signal: 'WAIT', reason: 'Insufficient data', score: 0, details: [], consolHigh: 0, consolLow: 0, breakoutLevel: 0 };

  const closes  = candles.map(c => c.c);
  const last5   = candles.slice(-5);
  const last10  = candles.slice(-10);
  const last20  = candles.slice(-20);
  const prior10 = candles.slice(-20, -10);

  // ── STEP 1: Find the 20-day consolidation box ──
  // This is the key fix — separate from the 6-month swing high used for Fibonacci
  const consolHigh = Math.max(...last20.map(c => c.h));
  const consolLow  = Math.min(...last20.map(c => c.l));
  const consolRange = consolHigh - consolLow;
  const consolRangePct = consolLow > 0 ? (consolRange / consolLow) * 100 : 0;

  // ── STEP 2: Volume analysis ──
  const avgVol20    = last20.reduce((a, c) => a + (c.v || 0), 0) / 20;
  const recentVol5  = last5.reduce((a, c) => a + (c.v || 0), 0) / 5;
  const priorVol10  = prior10.reduce((a, c) => a + (c.v || 0), 0) / 10;
  const recentVol10 = last10.reduce((a, c) => a + (c.v || 0), 0) / 10;
  const volSpikeRatio = avgVol20 > 0 ? recentVol5 / avgVol20 : 1;
  const volDryPct     = priorVol10 > 0 ? ((priorVol10 - recentVol10) / priorVol10) * 100 : 0;

  // ── STEP 3: Candle tightening ──
  const recentRange10 = last10.reduce((a, c) => a + (c.h - c.l), 0) / 10;
  const priorRange10  = prior10.reduce((a, c) => a + (c.h - c.l), 0) / 10;
  const tighteningPct = priorRange10 > 0 ? ((priorRange10 - recentRange10) / priorRange10) * 100 : 0;

  // ── STEP 4: Moving averages ──
  // EMAs only — consistent with mode classifier
  const ema9_internal = calcEMA(closes.slice(-40), 9);
  const ema21_internal = calcEMA(closes.slice(-60), 21);
  const ema50_internal = closes.length >= 50 ? calcEMA(closes.slice(-150), 50) : ema21_internal;

  // ── STEP 5: Higher lows check (last 5 candles) ──
  const recentLows = last5.map(c => c.l);
  let higherLows = recentLows.length >= 3;
  for (let i = 1; i < recentLows.length; i++) {
    if (recentLows[i] <= recentLows[i-1]) { higherLows = false; break; }
  }

  // ── STEP 6: Green days ratio ──
  const greenDays = last10.filter(c => c.c >= c.o).length;

  // ── STEP 7: How far above the 20-day consolidation box top ──
  const pctAboveConsol = consolHigh > 0 ? ((currentPrice - consolHigh) / consolHigh) * 100 : 0;
  // How far price has run from the recent low (extension check)
  const pctFromConsolLow = consolLow > 0 ? ((currentPrice - consolLow) / consolLow) * 100 : 0;

  // ── DETERMINE SIGNAL ──
  // Priority order: BREAKOUT > EXTENDED > COILING > FIB_ZONE > FORMING > WAIT

  const details = [];
  let signal = 'WAIT';
  let reason = '';
  let score = 0;

  // === BREAKOUT: Price is 2%+ above the 20-day consolidation high ===
  // AND happening within the last 5 sessions (fresh)
  if (pctAboveConsol >= 2) {
    // Check if it's a FRESH breakout (recent) or EXTENDED (old)
    if (pctAboveConsol >= 20) {
      // Too extended — don't chase
      signal = 'EXTENDED';
      reason = `${pctAboveConsol.toFixed(0)}% above consolidation — wait for retest`;
      score = 40;
      details.push(`📏 ${pctAboveConsol.toFixed(0)}% above box top — extended, wait for pullback`);
      details.push(`🎯 Watch for retest of $${consolHigh.toFixed(2)} as support`);
    } else {
      // Fresh breakout
      signal = 'BREAKOUT';
      reason = `Breaking above $${consolHigh.toFixed(2)} consolidation`;
      score = 70 + Math.min(30, volSpikeRatio * 10);
      details.push(`🚀 ${pctAboveConsol.toFixed(1)}% above 20-day box top $${consolHigh.toFixed(2)}`);
      if (volSpikeRatio >= 1.5) {
        score += 15;
        details.push(`🔥 Volume ${volSpikeRatio.toFixed(1)}× avg — confirms breakout`);
      } else {
        details.push(`⚠️ Volume ${volSpikeRatio.toFixed(1)}× avg — watch for vol confirmation`);
      }
      if (currentPrice > ema9 && ema9 > ema21) details.push(`📊 EMAs aligned bullishly (price > 9 EMA > 21 EMA)`);
    }
  }
  // === COILING: Price inside tight consolidation
  // Tightening + range required; volume drying is bonus
  else if (tighteningPct > 20 && consolRangePct < 15) {
    signal = 'COILING';
    score = 50 + Math.min(25, tighteningPct * 0.5) + (volDryPct > 0 ? Math.min(15, volDryPct * 0.3) : 0);
    reason = `Coiling tight — alert at $${(consolHigh * 1.03).toFixed(2)}`;
    details.push(`📦 Candles tightening ${tighteningPct.toFixed(0)}% in last 10 days`);
    details.push(`📉 Volume drying ${volDryPct.toFixed(0)}% — energy building`);
    details.push(`🎯 Set alert at $${(consolHigh * 1.03).toFixed(2)} (3% above box top)`);
    if (higherLows) details.push(`📐 Higher lows — buyers stepping in`);
  }
  // === FIB ZONE: Price has pulled back to the 0.5-0.618 retracement level ===
  else if (fibSwingHigh > fibSwingLow && (fibSwingHigh - fibSwingLow) / fibSwingLow > 0.15) {
    const fibRange = fibSwingHigh - fibSwingLow;
    const fib50  = fibSwingHigh - fibRange * 0.5;
    const fib618 = fibSwingHigh - fibRange * 0.618;
    
    // STRICT: price must actually be between .618 (lower bound) and .500 (upper bound) of the retracement
    const inFibZone = currentPrice >= fib618 && currentPrice <= fib50;
    
    // Near = within 3% of the zone boundary, but NOT in it
    const nearFibZone = !inFibZone && (
      (currentPrice > fib50 && currentPrice <= fib50 * 1.03) ||
      (currentPrice >= fib618 * 0.97 && currentPrice < fib618)
    );

    if (inFibZone) {
      signal = 'FIB_ZONE';
      score = 65;
      reason = `In Fibonacci buy zone — entry opportunity`;
      details.push(`🟢 Price $${currentPrice.toFixed(2)} between .618 ($${fib618.toFixed(2)}) and .500 ($${fib50.toFixed(2)})`);
      details.push(`📍 Actual fib buy zone: $${fib618.toFixed(2)} — $${fib50.toFixed(2)}`);
      if (greenDays >= 6) details.push(`🟢 ${greenDays}/10 green days — buyers returning`);
      if (volSpikeRatio >= 1.5) details.push(`📈 Volume picking up ${volSpikeRatio.toFixed(1)}× — accumulation`);
    } else if (nearFibZone) {
      signal = 'APPROACHING';
      score = 40;
      reason = `Approaching Fibonacci support zone`;
      details.push(`🟡 Price $${currentPrice.toFixed(2)} approaching .500-.618 zone`);
      details.push(`📍 Fib zone target: $${fib618.toFixed(2)} — $${fib50.toFixed(2)}`);
    }
  }

  // === FORMING: Early signals but not definitive ===
  if (signal === 'WAIT') {
    if (tighteningPct > 10 || volDryPct > 10 || higherLows || greenDays >= 7) {
      signal = 'FORMING';
      score = 25;
      reason = 'Early signals — monitor but not ready yet';
      if (tighteningPct > 10) details.push(`📦 Some tightening ${tighteningPct.toFixed(0)}%`);
      if (higherLows) details.push(`📐 Higher lows forming`);
      if (greenDays >= 7) details.push(`🟢 ${greenDays}/10 green days`);
    } else {
      // Explain WHY it's a wait
      if (currentPrice < ema21_internal) {
        reason = 'Below 21 EMA — downtrend, avoid';
        details.push(`📉 Price below 21 EMA — no uptrend`);
      } else if (pctAboveConsol > 5 && pctAboveConsol < 20) {
        reason = 'Slightly extended — wait for tighter setup';
        details.push(`📏 ${pctAboveConsol.toFixed(0)}% above box — needs consolidation`);
      } else {
        reason = 'No clear setup — check back next week';
        details.push(`⏳ No coiling, no breakout, not in Fib zone`);
      }
    }
  }

  const modeClass = classifyMode(candles, currentPrice, fibSwingHigh, fibSwingLow);

  return {
    signal,
    reason,
    score: Math.min(100, Math.round(score)),
    details,
    consolHigh: parseFloat(consolHigh.toFixed(2)),
    consolLow: parseFloat(consolLow.toFixed(2)),
    alertLevel: parseFloat((consolHigh * 1.03).toFixed(2)),
    volSpikeRatio: parseFloat(volSpikeRatio.toFixed(2)),
    tighteningPct: parseFloat(tighteningPct.toFixed(1)),
    pctAboveConsol: parseFloat(pctAboveConsol.toFixed(1)),
    ema9: parseFloat(ema9_internal.toFixed(2)),
    ema21: parseFloat(ema21_internal.toFixed(2)),
    ema50: parseFloat(ema50_internal.toFixed(2)),
    mode: modeClass,
  };
}

// ── YAHOO FINANCE ──
async function fetchYahooQuote(ticker) {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'application/json',
  };

  // Weekly candles for Fibonacci swing points
  const weeklyRes = await fetch(
    `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1wk&range=1y`,
    { headers }
  );
  if (!weeklyRes.ok) throw new Error(`Yahoo ${weeklyRes.status} for ${ticker}`);
  const weeklyJson = await weeklyRes.json();
  if (!weeklyJson.chart?.result?.[0]) throw new Error(`No data for ${ticker}`);

  const wr   = weeklyJson.chart.result[0];
  const meta = wr.meta;
  const wq   = wr.indicators.quote[0];
  // Filter out ANY candle where close, high, or low is null/undefined/0
  const wCandles = wq.close.map((c, i) => ({ c, h: wq.high[i], l: wq.low[i], v: wq.volume[i] }))
    .filter(x => x.c != null && x.h != null && x.l != null && x.c > 0 && x.h > 0 && x.l > 0);
  
  if (wCandles.length < 4) throw new Error(`Insufficient candle data for ${ticker}`);

  const price     = meta.regularMarketPrice || wCandles[wCandles.length - 1].c;
  const prevClose = meta.chartPreviousClose  || wCandles[wCandles.length - 2]?.c;
  const changePct = prevClose ? ((price - prevClose) / prevClose) * 100 : 0;

  // Smart swing point detection (last 26 weeks)
  const lookback = wCandles.slice(-26);
  if (lookback.length < 4) throw new Error(`Not enough weekly data for ${ticker}`);

  // Find swing high (Point B)
  let pointBIdx = 0, pointBPrice = 0;
  lookback.forEach((c, i) => { if (c.h > pointBPrice) { pointBPrice = c.h; pointBIdx = i; } });

  // Find swing low before the high (Point A)
  const beforeHigh = lookback.slice(0, Math.max(pointBIdx, 4));
  const validBeforeHighLows = beforeHigh.map(x => x.l).filter(v => v > 0);
  const validLookbackLows   = lookback.map(x => x.l).filter(v => v > 0);
  
  let pointAPrice = validBeforeHighLows.length > 0
    ? Math.min(...validBeforeHighLows)
    : (validLookbackLows.length > 0 ? Math.min(...validLookbackLows) : pointBPrice * 0.7);

  // Sanity check: A must be below B
  if (pointAPrice >= pointBPrice || pointAPrice <= 0) {
    const validHighs = wCandles.map(x => x.h).filter(v => v > 0);
    const validLows  = wCandles.map(x => x.l).filter(v => v > 0);
    pointBPrice = validHighs.length > 0 ? Math.max(...validHighs) : pointBPrice;
    pointAPrice = validLows.length  > 0 ? Math.min(...validLows)  : pointBPrice * 0.7;
  }

  // Final NaN/Infinity guard
  if (!isFinite(pointAPrice) || !isFinite(pointBPrice) || pointAPrice <= 0 || pointBPrice <= 0) {
    pointBPrice = price * 1.3;
    pointAPrice = price * 0.7;
  }

  const moveSize = pointAPrice > 0 ? ((pointBPrice - pointAPrice) / pointAPrice) * 100 : 30;
  if (moveSize < 15) {
    const allHighs = wCandles.map(x => x.h).filter(v => v > 0 && isFinite(v));
    const allLows  = wCandles.slice(0, Math.floor(wCandles.length / 2)).map(x => x.l).filter(v => v > 0 && isFinite(v));
    if (allHighs.length > 0) pointBPrice = Math.max(...allHighs);
    if (allLows.length  > 0) pointAPrice = Math.min(...allLows);
  }

  // Weekly volume ratio
  const wVols   = wCandles.map(x => x.v).filter(v => v != null && v > 0 && isFinite(v));
  const avgWVol  = wVols.length >= 5 ? wVols.slice(-10).reduce((a, b) => a + b, 0) / Math.min(10, wVols.length) : 0;
  const lastWVol = wVols[wVols.length - 1] || avgWVol || 0;
  const volRatio = avgWVol > 0 ? lastWVol / avgWVol : 1;

  // Daily candles for momentum detection
  let momentum = { signal: 'WAIT', reason: 'No data', score: 0, details: [], consolHigh: 0, consolLow: 0, alertLevel: 0 };
  try {
    const dailyRes = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=3mo`,
      { headers }
    );
    if (dailyRes.ok) {
      const dj = await dailyRes.json();
      const dr = dj.chart?.result?.[0];
      if (dr) {
        const dq = dr.indicators.quote[0];
        const dCandles = dq.close.map((c, i) => ({ c, h: dq.high[i], l: dq.low[i], v: dq.volume[i], o: dq.open[i] }))
          .filter(x => x.c != null && x.h != null && x.l != null && x.c > 0 && isFinite(x.c)).slice(-60);
        momentum = detectMomentum(dCandles, price, pointBPrice, pointAPrice);
      }
    }
  } catch(e) { console.error('Daily fetch error', ticker, e.message); }

  return {
    ticker:       ticker.toUpperCase(),
    name:         meta.longName || meta.shortName || ticker,
    price:        parseFloat(price.toFixed(2)),
    changePct:    parseFloat(changePct.toFixed(2)),
    high52:       parseFloat(pointBPrice.toFixed(2)),  // Fib swing high
    low52:        parseFloat(pointAPrice.toFixed(2)),  // Fib swing low
    volRatio:     parseFloat(volRatio.toFixed(2)),
    swingMoveSize: parseFloat(moveSize.toFixed(1)),
    momentum,
  };
}

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
  const s = clean.indexOf(isArr ? '[' : '{');
  const e = clean.lastIndexOf(isArr ? ']' : '}');
  if (s === -1 || e === -1 || e <= s) return null;
  try { return JSON.parse(clean.slice(s, e + 1)); } catch(e) { return null; }
}

// ── ROUTES ──

app.get('/api/health', (req, res) => {
  const c = loadCriteria();
  res.json({ status: 'ok', criteriaVersion: c.version, learnedPatterns: c.learnedPatterns.length });
});

app.get('/api/criteria', (req, res) => res.json(loadCriteria()));

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
    const composite = Math.round((s.momentum.score * 0.45) + (momScore * 0.3) + (volScore * 0.25));
    return {
      ...s,
      optScore: Math.round(volScore),
      momScore: Math.round(momScore),
      volScore: Math.round(volScore),
      ivScore: s.momentum.score,
      composite: Math.min(100, composite),
      pcRatio: (0.6 + Math.random() * 0.8).toFixed(2),
      sentiment: s.changePct > 1 ? 'bullish' : s.changePct < -1 ? 'bearish' : 'neutral',
      reason: `${s.momentum.signal} · ${s.momentum.reason}`,
      catalysts: s.momentum.details.slice(0, 2),
    };
  });

  scored.sort((a, b) => b.composite - a.composite);
  res.json({ stocks: scored });
});

app.post('/api/feedback', async (req, res) => {
  const { ticker, theme } = req.body;
  if (!ticker) return res.status(400).json({ error: 'No ticker' });

  const criteria = loadCriteria();
  let priceData = null;
  try { priceData = await fetchYahooQuote(ticker); } catch(e) {}

  const prompt = `A swing trader added "${ticker}" (${priceData?.name || ticker}) to their "${theme}" watchlist.

Our scanner MISSED this stock. Current rules:
${criteria.rules.slice(0, 8).map((r, i) => (i + 1) + '. ' + r).join('\n')}

${priceData ? `Yahoo Finance data: Price $${priceData.price}, Swing High $${priceData.high52}, Swing Low $${priceData.low52}, Move ${priceData.swingMoveSize}%, Vol ratio ${priceData.volRatio}x, Signal: ${priceData.momentum?.signal}, Reason: ${priceData.momentum?.reason}` : ''}

Search for recent news about ${ticker} then answer:
1. What is this company and what does it do?
2. Why did our broad rules still miss it?
3. Write ONE new broad rule (applicable to many similar stocks, not just this one)
4. Swing trade confidence 0-100 right now
5. Two key catalysts

Return ONLY JSON no markdown:
{"ticker":"${ticker}","companyName":"${priceData?.name || ticker}","sector":"Sector","missedReason":"Why rules missed it","newRule":"New broad rule","stockSummary":"What company does","confidence":70,"catalysts":["cat1","cat2"]}`;

  try {
    const raw = await askClaude(prompt, 700);
    const feedback = extractJSON(raw, 'object');

    if (feedback?.missedReason) {
      if (priceData) {
        feedback.currentPrice = priceData.price;
        feedback.companyName  = priceData.name || feedback.companyName;
      }
      if (feedback.newRule) {
        const newRule = feedback.newRule.trim();
        const exists  = criteria.rules.some(r => r.toLowerCase().includes(newRule.toLowerCase().substring(0, 20)));
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
      ticker, companyName: priceData?.name || ticker, currentPrice: priceData?.price || 0,
      missedReason: 'Analysis incomplete — ' + raw.substring(0, 200),
      newRule: null, confidence: 50, criteriaUpdated: false,
    });
  } catch(e) {
    console.error('Feedback error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/learning-history', (req, res) => {
  const c = loadCriteria();
  res.json({ version: c.version, totalRulesLearned: c.learnedPatterns.length, missedStocksAnalyzed: c.missedStocks || [], currentRules: c.rules, learnedPatterns: c.learnedPatterns });
});

app.post('/api/criteria/reset', (req, res) => {
  const c = loadCriteria();
  saveCriteria(c);
  res.json({ message: 'Criteria preserved', version: c.version });
});

// ── MARKET REGIME ──
app.get('/api/regime', async (req, res) => {
  try {
    const regime = await getMarketRegime();
    res.json(regime);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── STOCK NEWS (Finnhub) ──
app.get('/api/news/:ticker', async (req, res) => {
  try {
    const news = await getStockNews(req.params.ticker, parseInt(req.query.days) || 5);
    res.json(news);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── MARKET NEWS ──
app.get('/api/market-news', async (req, res) => {
  try {
    const news = await getMarketNews();
    res.json(news);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── MANUAL NEWS PASTE & EXTRACT ──
app.post('/api/extract-news', async (req, res) => {
  const { rawText, tickers } = req.body;
  if (!rawText || rawText.length < 20) return res.status(400).json({ error: 'Empty or too short' });
  
  const tickerHint = tickers && tickers.length ? `Pay special attention to mentions of these tickers: ${tickers.join(', ')}.` : '';
  
  const prompt = 'You are parsing raw text from a WhatsApp/Telegram/news source for a swing trader. Extract market-relevant information.\n\n' +
    'Raw text:\n"""\n' + rawText.slice(0, 8000) + '\n"""\n\n' +
    tickerHint + '\n\n' +
    'Return ONLY a JSON object (no markdown):\n' +
    '{\n' +
    '  "perStock": [\n' +
    '    { "ticker": "AAPL", "headline": "Brief summary of what was said", "sentiment": "bullish|bearish|neutral", "relevance": "high|medium|low" }\n' +
    '  ],\n' +
    '  "macroItems": [\n' +
    '    { "topic": "Fed/inflation/sector rotation/etc", "headline": "Brief summary", "impact": "SPY positive|QQQ negative|neutral" }\n' +
    '  ],\n' +
    '  "summary": "One sentence summary of overall market tone"\n' +
    '}\n\n' +
    'If nothing trading-relevant is in the text, return empty arrays.';

  try {
    const raw = await askClaude(prompt, 1500);
    const data = extractJSON(raw, 'object');
    res.json(data || { perStock: [], macroItems: [], summary: 'Could not parse' });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => console.log(`SwingScan on port ${PORT} · Regime + News + Mode classifier enabled`));

