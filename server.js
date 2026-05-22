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
    "Prioritize stocks in strong uptrends that have pulled back to Fibonacci support (0.5-0.618)",
    "Look for unusual options volume spikes (2x or more above 30-day average)",
    "Include stocks with upcoming catalysts: earnings, product launches, government contracts",
    "Target themes: AI, semiconductors, defense, space, robotics, voice AI, crypto, EV, energy, biotech",
  ],
  learnedPatterns: [],
  missedStocks: [],
  themeExpansions: {},
};

function loadCriteria() {
  try {
    if (fs.existsSync(CRITERIA_FILE)) {
      return JSON.parse(fs.readFileSync(CRITERIA_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('Failed to load criteria:', e.message);
  }
  return { ...DEFAULT_CRITERIA };
}

function saveCriteria(criteria) {
  try {
    const dir = path.dirname(CRITERIA_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    criteria.lastUpdated = new Date().toISOString().split('T')[0];
    fs.writeFileSync(CRITERIA_FILE, JSON.stringify(criteria, null, 2));
    console.log('Criteria updated to v' + criteria.version);
  } catch (e) {
    console.error('Failed to save criteria:', e.message);
  }
}

async function askClaude(prompt, maxTokens) {
  const tokens = maxTokens || 1000;
  const msg = await client.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: tokens,
    tools: [{ type: 'web_search_20250305', name: 'web_search' }],
    messages: [{ role: 'user', content: prompt }],
  });
  return msg.content.filter(b => b.type === 'text').map(b => b.text).join('');
}

// Robust JSON extractor — handles Claude wrapping text around JSON
function extractJSON(text, type) {
  const isArray = type === 'array';
  const clean = text.replace(/```json/gi, '').replace(/```/g, '').trim();
  
  if (isArray) {
    const start = clean.indexOf('[');
    const end = clean.lastIndexOf(']');
    if (start !== -1 && end !== -1 && end > start) {
      try { return JSON.parse(clean.slice(start, end + 1)); } catch(e) {}
    }
  } else {
    const start = clean.indexOf('{');
    const end = clean.lastIndexOf('}');
    if (start !== -1 && end !== -1 && end > start) {
      try { return JSON.parse(clean.slice(start, end + 1)); } catch(e) {}
    }
  }
  return null;
}

// Health check
app.get('/api/health', (req, res) => {
  const c = loadCriteria();
  res.json({ status: 'ok', criteriaVersion: c.version, learnedPatterns: c.learnedPatterns.length });
});

// Get criteria
app.get('/api/criteria', (req, res) => res.json(loadCriteria()));

// Scan stocks
app.post('/api/scan', async (req, res) => {
  const { tickers } = req.body;
  if (!tickers || !tickers.length) return res.status(400).json({ error: 'No tickers' });

  const batches = [];
  for (let i = 0; i < tickers.length; i += 6) batches.push(tickers.slice(i, i + 6));

  const allData = [];
  const today = new Date().toISOString().split('T')[0];

  for (const batch of batches) {
    const prompt = `Today is ${today}. Search the web right now for live stock market data.

Look up each of these stock tickers on Yahoo Finance or Google: ${batch.join(', ')}

For each stock I need today's live data:
1. Current stock price (as of today ${today})
2. Today's percentage change
3. 52-week high price
4. 52-week low price
5. Company full name

Return ONLY a JSON array. No markdown. No explanation. Just the array:
[{"ticker":"AAPL","name":"Apple Inc","price":211.50,"changePct":0.5,"high52":260.10,"low52":169.21},{"ticker":"NVDA","name":"NVIDIA Corp","price":135.20,"changePct":1.2,"high52":190.00,"low52":75.00}]

Search the web for each ticker to get accurate current prices. Skip any ticker that does not exist.`;

    try {
      console.log('Scanning batch:', batch.join(','));
      const raw = await askClaude(prompt, 1200);
      console.log('Raw response sample:', raw.substring(0, 200));
      const parsed = extractJSON(raw, 'array');
      if (parsed && Array.isArray(parsed)) {
        parsed.filter(s => s && s.ticker && s.price && s.high52 && s.low52).forEach(s => allData.push(s));
      }
    } catch (e) {
      console.error('Batch error:', batch.join(','), e.message);
    }
  }

  console.log('Total stocks fetched:', allData.length);
  res.json({ stocks: allData, criteriaVersion: loadCriteria().version });
});

// Trending stocks
app.post('/api/trending', async (req, res) => {
  const criteria = loadCriteria();
  const today = new Date().toISOString().split('T')[0];

  const prompt = `Today is ${today}. Search the web for the most actively traded US stocks right now.

Find 15-20 stocks with the highest unusual options activity, momentum, and buzz today.

For each stock provide:
- Current price
- Today % change
- Options activity score 0-100
- Momentum score 0-100
- Volume vs average score 0-100
- Squeeze/IV score 0-100
- Composite score (optScore*0.35 + momScore*0.25 + volScore*0.25 + ivScore*0.15)
- Put/call ratio
- Sentiment (bullish/bearish/neutral)
- Main reason for activity

Return ONLY a JSON array sorted by composite score descending:
[{"ticker":"NVDA","name":"NVIDIA Corp","price":135.20,"changePct":2.3,"optScore":85,"momScore":70,"volScore":65,"ivScore":55,"composite":74,"pcRatio":"0.7","sentiment":"bullish calls","reason":"Computex keynote upcoming","catalysts":["Jensen keynote June 1"]}]`;

  try {
    const raw = await askClaude(prompt, 1500);
    const parsed = extractJSON(raw, 'array');
    res.json({ stocks: parsed || [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Feedback — self-improvement
app.post('/api/feedback', async (req, res) => {
  const { ticker, theme } = req.body;
  if (!ticker) return res.status(400).json({ error: 'No ticker' });

  const criteria = loadCriteria();
  const today = new Date().toISOString().split('T')[0];

  const prompt = `Today is ${today}. A swing trader manually added the stock "${ticker}" to their "${theme}" watchlist.

This means our AI scanner MISSED this stock. Our current scanning rules were:
${criteria.rules.map((r, i) => (i + 1) + '. ' + r).join('\n')}

Please search the web for information about ${ticker} and answer:
1. What company is ${ticker}? What sector? What does it do?
2. What is its current stock price today?
3. WHY did our scanner miss it? Which specific rule failed to catch it?
4. What ONE new rule should we add to catch stocks like this in future?
5. Rate it as a swing trade right now from 0-100
6. What are 2-3 key catalysts making it interesting?

Return ONLY this JSON object (no markdown, no backticks):
{"ticker":"${ticker}","companyName":"Full Name","sector":"Sector","currentPrice":100.00,"missedReason":"Specific reason why scanner missed this","newRule":"New scanning rule to add","stockSummary":"What company does and why interesting for swing trading","confidence":70,"catalysts":["catalyst1","catalyst2"],"themeRecommendation":"${theme}"}`;

  try {
    console.log('Feedback for:', ticker);
    const raw = await askClaude(prompt, 1200);
    console.log('Feedback raw:', raw.substring(0, 300));
    const feedback = extractJSON(raw, 'object');
    console.log('Feedback parsed:', JSON.stringify(feedback));

    if (feedback && (feedback.missedReason || feedback.stockSummary)) {
      if (feedback.newRule) {
        const newRule = feedback.newRule.trim();
        const exists = criteria.rules.some(r => r.toLowerCase().includes(newRule.toLowerCase().substring(0, 25)));
        if (!exists) {
          criteria.rules.push(newRule);
          criteria.learnedPatterns.push('[v' + (criteria.version + 1) + '] After adding ' + ticker + ': ' + newRule);
          criteria.missedStocks.push({ ticker, theme, addedAt: new Date().toISOString(), missedReason: feedback.missedReason, newRule });
          criteria.version++;
          saveCriteria(criteria);
        }
        res.json({ ...feedback, criteriaUpdated: !exists, newCriteriaVersion: criteria.version });
      } else {
        res.json({ ...feedback, criteriaUpdated: false, newCriteriaVersion: criteria.version });
      }
    } else {
      res.json({ ticker, companyName: ticker, missedReason: 'Analysis failed — try again', newRule: null, criteriaUpdated: false, confidence: 50 });
    }
  } catch (e) {
    console.error('Feedback error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Learning history
app.get('/api/learning-history', (req, res) => {
  const c = loadCriteria();
  res.json({ version: c.version, totalRulesLearned: c.learnedPatterns.length, missedStocksAnalyzed: c.missedStocks || [], currentRules: c.rules, learnedPatterns: c.learnedPatterns });
});

// Reset criteria
app.post('/api/criteria/reset', (req, res) => {
  saveCriteria({ ...DEFAULT_CRITERIA });
  res.json({ message: 'Reset to defaults', version: 1 });
});

app.listen(PORT, () => console.log('SwingScan running on port ' + PORT));
