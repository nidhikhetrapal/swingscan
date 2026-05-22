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
};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function loadCriteria() {
  try {
    if (fs.existsSync(CRITERIA_FILE)) return JSON.parse(fs.readFileSync(CRITERIA_FILE, 'utf8'));
  } catch (e) { console.error('Load criteria error:', e.message); }
  return { ...DEFAULT_CRITERIA };
}

function saveCriteria(criteria) {
  try {
    const dir = path.dirname(CRITERIA_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    criteria.lastUpdated = new Date().toISOString().split('T')[0];
    fs.writeFileSync(CRITERIA_FILE, JSON.stringify(criteria, null, 2));
    console.log('Criteria saved v' + criteria.version);
  } catch (e) { console.error('Save criteria error:', e.message); }
}

// Single Claude call — NO web search tool to save tokens on scan
async function askClaudeSearch(prompt, maxTokens) {
  const msg = await client.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: maxTokens || 800,
    tools: [{ type: 'web_search_20250305', name: 'web_search' }],
    messages: [{ role: 'user', content: prompt }],
  });
  return msg.content.filter(b => b.type === 'text').map(b => b.text).join('');
}

// Robust JSON extractor
function extractJSON(text, type) {
  const clean = text.replace(/```json/gi, '').replace(/```/g, '').trim();
  const isArr = type === 'array';
  const start = clean.indexOf(isArr ? '[' : '{');
  const end = clean.lastIndexOf(isArr ? ']' : '}');
  if (start === -1 || end === -1 || end <= start) return null;
  try { return JSON.parse(clean.slice(start, end + 1)); } catch(e) { return null; }
}

// Health
app.get('/api/health', (req, res) => {
  const c = loadCriteria();
  res.json({ status: 'ok', criteriaVersion: c.version, learnedPatterns: c.learnedPatterns.length });
});

app.get('/api/criteria', (req, res) => res.json(loadCriteria()));

// SCAN — fetches ALL tickers in ONE call to avoid rate limits
app.post('/api/scan', async (req, res) => {
  const { tickers } = req.body;
  if (!tickers || !tickers.length) return res.status(400).json({ error: 'No tickers' });

  const today = new Date().toISOString().split('T')[0];
  console.log('Scanning', tickers.length, 'tickers');

  // Split into batches of 5, with 4 second delay between each
  const batches = [];
  for (let i = 0; i < tickers.length; i += 5) batches.push(tickers.slice(i, i + 5));

  const allData = [];

  for (let bi = 0; bi < batches.length; bi++) {
    const batch = batches[bi];
    if (bi > 0) {
      console.log('Waiting 4s before next batch...');
      await sleep(4000); // wait 4 seconds between batches to avoid rate limit
    }

    const prompt = `Today is ${today}. Search Yahoo Finance for current stock prices.

Get today's live data for: ${batch.join(', ')}

Return ONLY JSON array, no other text:
[{"ticker":"AAPL","name":"Apple Inc","price":211.50,"changePct":0.5,"high52":260.10,"low52":169.21}]`;

    try {
      console.log('Batch', bi + 1, ':', batch.join(','));
      const raw = await askClaudeSearch(prompt, 600);
      const parsed = extractJSON(raw, 'array');
      if (parsed && Array.isArray(parsed)) {
        parsed.filter(s => s && s.ticker && s.price && s.high52 && s.low52).forEach(s => allData.push(s));
        console.log('Got', parsed.length, 'stocks from batch', bi + 1);
      }
    } catch (e) {
      console.error('Batch error:', e.message);
      if (e.message && e.message.includes('rate_limit')) {
        console.log('Rate limited — waiting 10s...');
        await sleep(10000);
      }
    }
  }

  console.log('Total fetched:', allData.length);
  res.json({ stocks: allData, criteriaVersion: loadCriteria().version });
});

// TRENDING
app.post('/api/trending', async (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  const prompt = `Today is ${today}. Search for the 15 most active US stocks by options volume and momentum.

Return ONLY JSON array:
[{"ticker":"NVDA","name":"NVIDIA Corp","price":135.20,"changePct":2.3,"optScore":85,"momScore":70,"volScore":65,"ivScore":55,"composite":74,"pcRatio":"0.7","sentiment":"bullish","reason":"Computex keynote","catalysts":["June 1 keynote"]}]
Sort by composite score descending.`;

  try {
    const raw = await askClaudeSearch(prompt, 1200);
    const parsed = extractJSON(raw, 'array');
    res.json({ stocks: parsed || [] });
  } catch (e) {
    console.error('Trending error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// FEEDBACK — self-improvement
app.post('/api/feedback', async (req, res) => {
  const { ticker, theme } = req.body;
  if (!ticker) return res.status(400).json({ error: 'No ticker' });

  const criteria = loadCriteria();
  const today = new Date().toISOString().split('T')[0];

  const prompt = `Today is ${today}. Search the web for information about the stock ticker "${ticker}".

Our AI scanner missed this stock. Our scanning rules are:
${criteria.rules.map((r, i) => (i + 1) + '. ' + r).join('\n')}

Find out:
1. What company is ${ticker}? What sector?
2. Current stock price
3. Why did our rules miss it? Which rule failed?
4. One new rule to add to catch stocks like this
5. Swing trade confidence 0-100
6. Two catalysts making it interesting

Return ONLY this JSON (no markdown):
{"ticker":"${ticker}","companyName":"Company Name Here","sector":"Sector Here","currentPrice":100.00,"missedReason":"Explain why scanner missed it","newRule":"New rule to add","stockSummary":"What company does","confidence":70,"catalysts":["catalyst1","catalyst2"],"themeRecommendation":"${theme}"}`;

  try {
    console.log('Feedback for:', ticker);
    const raw = await askClaudeSearch(prompt, 900);
    console.log('Feedback response:', raw.substring(0, 400));
    const feedback = extractJSON(raw, 'object');

    if (feedback && feedback.companyName && feedback.companyName !== 'undefined') {
      if (feedback.newRule) {
        const newRule = feedback.newRule.trim();
        const exists = criteria.rules.some(r => r.toLowerCase().includes(newRule.toLowerCase().substring(0, 20)));
        if (!exists) {
          criteria.rules.push(newRule);
          criteria.learnedPatterns.push('[v' + (criteria.version + 1) + '] Added after ' + ticker + ': ' + newRule);
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
      return res.json({ ...feedback, criteriaUpdated: false, newCriteriaVersion: criteria.version });
    }

    // Fallback if JSON parse failed
    res.json({
      ticker,
      companyName: ticker + ' (search failed)',
      sector: 'Unknown',
      missedReason: 'Could not analyze — Claude response did not contain valid JSON. Raw: ' + raw.substring(0, 150),
      newRule: null,
      confidence: 50,
      criteriaUpdated: false
    });
  } catch (e) {
    console.error('Feedback error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Learning history
app.get('/api/learning-history', (req, res) => {
  const c = loadCriteria();
  res.json({
    version: c.version,
    totalRulesLearned: c.learnedPatterns.length,
    missedStocksAnalyzed: c.missedStocks || [],
    currentRules: c.rules,
    learnedPatterns: c.learnedPatterns
  });
});

// Reset
app.post('/api/criteria/reset', (req, res) => {
  saveCriteria({ ...DEFAULT_CRITERIA });
  res.json({ message: 'Reset to defaults', version: 1 });
});

app.listen(PORT, () => console.log('SwingScan running on port ' + PORT));
