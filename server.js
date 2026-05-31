// PaperTrade — Live Price Server (zero dependencies)
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = 5500;

// All NIFTY 50 stocks + key indices
const NIFTY50_SYMBOLS = [
  'RELIANCE','TCS','HDFCBANK','INFY','ICICIBANK','HINDUNILVR','SBIN','BHARTIARTL',
  'ITC','KOTAKBANK','LT','AXISBANK','ASIANPAINT','MARUTI','SUNPHARMA','TATAMOTORS',
  'WIPRO','ULTRACEMCO','BAJFINANCE','BAJAJFINSV','TITAN','NESTLEIND','TATASTEEL',
  'ADANIENT','NTPC','POWERGRID','ONGC','JSWSTEEL','M&M','HCLTECH','TECHM','INDUSINDBK',
  'HINDALCO','COALINDIA','DRREDDY','CIPLA','GRASIM','BPCL','APOLLOHOSP','EICHERMOT',
  'DIVISLAB','TATACONSUM','SBILIFE','BRITANNIA','HEROMOTOCO','BAJAJ-AUTO','ADANIPORTS',
  'HDFCLIFE','SHRIRAMFIN','WIPRO'
];

const INDICES = ['^NSEI', '^BSESN', '^NSEBANK']; // Nifty50, Sensex, BankNifty

// Sector mapping
const SECTOR_MAP = {
  RELIANCE:'Oil & Gas', TCS:'IT', HDFCBANK:'Banking', INFY:'IT', ICICIBANK:'Banking',
  HINDUNILVR:'FMCG', SBIN:'Banking', BHARTIARTL:'Telecom', ITC:'FMCG', KOTAKBANK:'Banking',
  LT:'Infrastructure', AXISBANK:'Banking', ASIANPAINT:'Paints', MARUTI:'Auto', SUNPHARMA:'Pharma',
  TATAMOTORS:'Auto', WIPRO:'IT', ULTRACEMCO:'Cement', BAJFINANCE:'Finance', BAJAJFINSV:'Finance',
  TITAN:'Consumer', NESTLEIND:'FMCG', TATASTEEL:'Metals', ADANIENT:'Conglomerate', NTPC:'Power',
  POWERGRID:'Power', ONGC:'Oil & Gas', JSWSTEEL:'Metals', 'M&M':'Auto', HCLTECH:'IT',
  TECHM:'IT', INDUSINDBK:'Banking', HINDALCO:'Metals', COALINDIA:'Mining', DRREDDY:'Pharma',
  CIPLA:'Pharma', GRASIM:'Cement', BPCL:'Oil & Gas', APOLLOHOSP:'Healthcare', EICHERMOT:'Auto',
  DIVISLAB:'Pharma', TATACONSUM:'FMCG', SBILIFE:'Insurance', BRITANNIA:'FMCG', HEROMOTOCO:'Auto',
  'BAJAJ-AUTO':'Auto', ADANIPORTS:'Infrastructure', HDFCLIFE:'Insurance', SHRIRAMFIN:'Finance'
};

let cachedStocks = null;
let cachedIndices = null;
let lastFetch = 0;
const CACHE_MS = 15000; // refresh every 15 seconds

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('Parse error')); }
      });
    }).on('error', reject);
  });
}

async function fetchQuotes(symbols) {
  const ySymbols = symbols.map(s => s.startsWith('^') ? s : s + '.NS');

  // Try batch API first
  const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${ySymbols.join(',')}`;
  try {
    const data = await fetchJSON(url);
    if (data.quoteResponse && data.quoteResponse.result && data.quoteResponse.result.length > 0) {
      return data.quoteResponse.result;
    }
  } catch(e) {
    console.log('Yahoo v7 batch failed, fetching individually...', e.message);
  }

  // Fallback: fetch ALL stocks one by one using chart API (no limit)
  const results = [];
  for (const sym of ySymbols) {
    try {
      const url2 = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=1d`;
      const d = await fetchJSON(url2);
      if (d.chart && d.chart.result && d.chart.result[0]) {
        const meta = d.chart.result[0].meta;
        results.push({
          symbol: sym.replace('.NS', ''),
          shortName: meta.shortName || sym.replace('.NS', ''),
          regularMarketPrice: meta.regularMarketPrice,
          regularMarketChange: meta.regularMarketPrice - meta.chartPreviousClose,
          regularMarketChangePercent: ((meta.regularMarketPrice - meta.chartPreviousClose) / meta.chartPreviousClose) * 100,
          regularMarketVolume: meta.regularMarketVolume || 0,
          fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh || meta.regularMarketPrice * 1.2,
          fiftyTwoWeekLow: meta.fiftyTwoWeekLow || meta.regularMarketPrice * 0.8,
          marketCap: 0,
          trailingPE: 0,
        });
      }
    } catch(e) { /* skip failed stock */ }
    // Small delay to avoid rate limiting
    await new Promise(r => setTimeout(r, 100));
  }
  return results;
}

async function refreshData() {
  const now = Date.now();
  if (now - lastFetch < CACHE_MS && cachedStocks) return;
  lastFetch = now;

  console.log('📡 Fetching live prices from Yahoo Finance...');
  try {
    // Fetch all stocks
    const allSymbols = [...new Set(NIFTY50_SYMBOLS)];
    const quotes = await fetchQuotes(allSymbols);

    cachedStocks = quotes.map(q => {
      const sym = (q.symbol || '').replace('.NS', '');
      return {
        symbol: sym,
        name: q.shortName || q.longName || sym,
        sector: SECTOR_MAP[sym] || 'Other',
        price: round(q.regularMarketPrice || 0),
        change: round(q.regularMarketChange || 0),
        changePercent: round(q.regularMarketChangePercent || 0),
        high52w: round(q.fiftyTwoWeekHigh || 0),
        low52w: round(q.fiftyTwoWeekLow || 0),
        marketCap: formatMC(q.marketCap || 0),
        pe: round(q.trailingPE || 0),
        volume: q.regularMarketVolume || 0,
      };
    }).filter(s => s.price > 0);

    // Fetch indices
    const idxQuotes = await fetchQuotes(INDICES);
    cachedIndices = {};
    for (const q of idxQuotes) {
      const sym = q.symbol;
      const label = sym === '^NSEI' ? 'NIFTY50' : sym === '^BSESN' ? 'SENSEX' : 'BANKNIFTY';
      cachedIndices[label] = {
        value: round(q.regularMarketPrice || 0),
        change: round(q.regularMarketChange || 0),
        changePercent: round(q.regularMarketChangePercent || 0),
      };
    }

    console.log(`✅ Got ${cachedStocks.length} stocks, ${Object.keys(cachedIndices).length} indices`);
  } catch(e) {
    console.error('❌ Fetch error:', e.message);
  }
}

function round(n) { return Math.round((n || 0) * 100) / 100; }
function formatMC(n) {
  if (!n) return 'N/A';
  if (n >= 1e12) return (n/1e12).toFixed(1) + 'L Cr';
  if (n >= 1e10) return (n/1e10).toFixed(1) + 'K Cr';
  if (n >= 1e7) return (n/1e7).toFixed(1) + ' Cr';
  return n.toLocaleString('en-IN');
}

// Generate options chain from live index price
function generateOptionsChain(indexName, spotPrice) {
  const step = indexName === 'NIFTY' ? 50 : 100; // strike interval
  const lotSize = indexName === 'NIFTY' ? 65 : 15;
  const spot = Math.round(spotPrice / step) * step; // ATM strike

  // Generate expiry dates (next 3 Tuesdays — NSE weekly expiry)
  const expiries = [];
  const now = new Date();
  for (let i = 0; i < 21 && expiries.length < 3; i++) {
    const d = new Date(now); d.setDate(now.getDate() + i);
    if (d.getDay() === 2) { // Tuesday (NSE new expiry day)
      expiries.push(d.toISOString().split('T')[0]);
    }
  }

  const strikes = [];
  for (let i = -10; i <= 10; i++) {
    const strike = spot + i * step;
    const diff = spotPrice - strike;
    const daysToExpiry = Math.max(1, Math.ceil((new Date(expiries[0]) - now) / 86400000));
    const timeValue = Math.sqrt(daysToExpiry) * step * 0.08;

    // Simplified premium calc
    const ceIntrinsic = Math.max(0, spotPrice - strike);
    const peIntrinsic = Math.max(0, strike - spotPrice);
    const volatilityFactor = 1 + Math.random() * 0.3;

    const cePremium = Math.round((ceIntrinsic + timeValue * volatilityFactor * (1 - Math.abs(diff) / (spot * 0.1))) * 100) / 100;
    const pePremium = Math.round((peIntrinsic + timeValue * volatilityFactor * (1 - Math.abs(diff) / (spot * 0.1))) * 100) / 100;

    // Simulate change
    const ceChg = Math.round((Math.random() - 0.45) * cePremium * 0.1 * 100) / 100;
    const peChg = Math.round((Math.random() - 0.55) * pePremium * 0.1 * 100) / 100;

    strikes.push({
      strike,
      ce: { premium: Math.max(0.5, cePremium), change: ceChg, oi: Math.round(Math.random() * 500000 + 50000), volume: Math.round(Math.random() * 200000) },
      pe: { premium: Math.max(0.5, pePremium), change: peChg, oi: Math.round(Math.random() * 500000 + 50000), volume: Math.round(Math.random() * 200000) },
      isATM: i === 0,
    });
  }

  return { index: indexName, spot: spotPrice, lotSize, expiries, strikes };
}

// HTTP Server
const server = http.createServer(async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  if (req.url === '/api/quotes') {
    await refreshData();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ stocks: cachedStocks || [], indices: cachedIndices || {} }));
  }
  else if (req.url.startsWith('/api/options')) {
    await refreshData();
    const niftySpot = cachedIndices?.NIFTY50?.value || 23500;
    const bniftySpot = cachedIndices?.BANKNIFTY?.value || 54000;
    const chains = {
      NIFTY: generateOptionsChain('NIFTY', niftySpot),
      BANKNIFTY: generateOptionsChain('BANKNIFTY', bniftySpot),
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(chains));
  }
  else if (req.url === '/' || req.url === '/index.html') {
    const file = path.join(__dirname, 'index.html');
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); res.end('Not found'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(data);
    });
  }
  else {
    res.writeHead(404);
    res.end('Not found');
  }
});

// Pre-fetch data then start
refreshData().then(() => {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🚀 PaperTrade running at http://localhost:${PORT}`);
    console.log(`📊 ${(cachedStocks||[]).length} stocks loaded with live prices\n`);
  });
});
