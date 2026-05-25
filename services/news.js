// services/news.js — Finnhub news integration
// Free tier: 60 calls/min

const FINNHUB_KEY = process.env.FINNHUB_API_KEY;

async function fhFetch(endpoint) {
  if (!FINNHUB_KEY) throw new Error('FINNHUB_API_KEY not set');
  const url = `https://finnhub.io/api/v1${endpoint}${endpoint.includes('?') ? '&' : '?'}token=${FINNHUB_KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Finnhub ${res.status}`);
  return res.json();
}

function dateFmt(d) {
  return d.toISOString().split('T')[0];
}

async function getStockNews(ticker, daysBack = 5) {
  if (!FINNHUB_KEY) return { available: false, items: [] };
  try {
    const today = new Date();
    const fromDate = new Date(today.getTime() - daysBack * 24 * 60 * 60 * 1000);
    const news = await fhFetch(`/company-news?symbol=${ticker.toUpperCase()}&from=${dateFmt(fromDate)}&to=${dateFmt(today)}`);
    
    // Sort newest first, limit to 8
    const items = (news || [])
      .sort((a, b) => b.datetime - a.datetime)
      .slice(0, 8)
      .map(n => ({
        headline: n.headline,
        source: n.source,
        url: n.url,
        summary: n.summary?.slice(0, 200),
        date: new Date(n.datetime * 1000).toISOString().split('T')[0],
        timestamp: n.datetime,
      }));
    
    return { available: true, items, ticker: ticker.toUpperCase() };
  } catch(e) {
    console.error(`News fetch error ${ticker}:`, e.message);
    return { available: false, items: [], error: e.message };
  }
}

async function getMarketNews() {
  if (!FINNHUB_KEY) return { available: false, items: [] };
  try {
    const news = await fhFetch(`/news?category=general`);
    const items = (news || [])
      .slice(0, 15)
      .map(n => ({
        headline: n.headline,
        source: n.source,
        url: n.url,
        summary: n.summary?.slice(0, 200),
        date: new Date(n.datetime * 1000).toISOString().split('T')[0],
        timestamp: n.datetime,
        category: n.category,
      }));
    return { available: true, items };
  } catch(e) {
    console.error('Market news error:', e.message);
    return { available: false, items: [], error: e.message };
  }
}

module.exports = { getStockNews, getMarketNews };
