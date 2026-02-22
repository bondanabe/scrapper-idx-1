import express from 'express';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { createClient } from '@supabase/supabase-js';
import { getSupabaseConfig } from './config.js';
import { ScrapeJob } from './scrape-job.js';
import { logger } from './logger.js';
import 'dotenv/config';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
app.use(express.static(resolve(__dirname, '..', 'public')));

// Supabase client for read queries
const { url, key } = getSupabaseConfig();
const supabase = createClient(url, key, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// Singleton scrape job
const scrapeJob = new ScrapeJob();

// ── GET /api/companies ──────────────────────────────────────────────

app.get('/api/companies', async (req, res) => {
  try {
    const search = req.query.search || '';
    const sector = req.query.sector || '';
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 50));
    const offset = (page - 1) * limit;

    let query = supabase
      .from('companies')
      .select('id, symbol, name, sector, subsector', { count: 'exact' })
      .order('symbol', { ascending: true })
      .range(offset, offset + limit - 1);

    if (search) {
      query = query.or(`symbol.ilike.%${search}%,name.ilike.%${search}%`);
    }
    if (sector) {
      query = query.eq('sector', sector);
    }

    const { data, count, error } = await query;
    if (error) throw error;

    res.json({ data: data || [], total: count || 0, page, limit });
  } catch (err) {
    logger.error(`GET /api/companies: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/companies/sectors ──────────────────────────────────────

app.get('/api/companies/sectors', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('companies')
      .select('sector')
      .order('sector');

    if (error) throw error;

    const sectors = [...new Set((data || []).map(r => r.sector).filter(Boolean))];
    res.json({ sectors });
  } catch (err) {
    logger.error(`GET /api/companies/sectors: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/prices ─────────────────────────────────────────────────

app.get('/api/prices', async (req, res) => {
  try {
    const symbol = req.query.symbol;
    if (!symbol) {
      return res.status(400).json({ error: 'Missing required query param: symbol' });
    }

    const from = req.query.from || '';
    const to = req.query.to || '';
    const limit = Math.min(1000, Math.max(1, parseInt(req.query.limit) || 100));
    const order = req.query.order === 'asc' ? 'asc' : 'desc';

    let query = supabase
      .from('daily_prices')
      .select('*', { count: 'exact' })
      .eq('symbol', symbol.toUpperCase())
      .order('date', { ascending: order === 'asc' })
      .limit(limit);

    if (from) query = query.gte('date', from);
    if (to) query = query.lte('date', to);

    const { data, count, error } = await query;
    if (error) throw error;

    res.json({ data: data || [], total: count || 0 });
  } catch (err) {
    logger.error(`GET /api/prices: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/scrape/cancel ────────────────────────────────────────

app.post('/api/scrape/cancel', (req, res) => {
  if (!scrapeJob.isRunning()) {
    return res.status(400).json({ error: 'No scrape job running' });
  }
  scrapeJob.abort();
  res.json({ message: 'Scrape job cancellation requested' });
});

// ── POST /api/scrape ────────────────────────────────────────────────

app.post('/api/scrape', async (req, res) => {
  try {
    if (scrapeJob.isRunning()) {
      return res.status(409).json({
        status: 'busy',
        message: 'A scrape job is already running',
        ...scrapeJob.getStatus(),
      });
    }

    let symbols = req.body.symbols;
    if (!Array.isArray(symbols) || symbols.length === 0) {
      return res.status(400).json({ error: 'Missing or empty "symbols" array in request body' });
    }

    // If ["*"], fetch all tickers from companies table
    if (symbols.length === 1 && symbols[0] === '*') {
      const { data, error } = await supabase
        .from('companies')
        .select('symbol')
        .order('symbol');
      if (error) throw error;
      symbols = (data || []).map(r => r.symbol).filter(Boolean);
      if (symbols.length === 0) {
        return res.status(400).json({ error: 'No companies found in database' });
      }
    }

    // Normalize symbols
    symbols = symbols.map(s => String(s).trim().toUpperCase()).filter(Boolean);

    // Optional custom date (YYYY-MM-DD)
    const date = req.body.date || undefined;

    // Data source: 'stockbit' (default) or 'tradingview'
    const source = req.body.source || 'stockbit';

    await scrapeJob.start(symbols, date, source);

    res.status(202).json({
      status: 'started',
      symbols,
      total: symbols.length,
    });
  } catch (err) {
    logger.error(`POST /api/scrape: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/scrape/status ──────────────────────────────────────────

app.get('/api/scrape/status', (req, res) => {
  res.json(scrapeJob.getStatus());
});

// ── GET /api/scrape/logs ────────────────────────────────────────────

app.get('/api/scrape/logs', (req, res) => {
  res.json({ logs: scrapeJob.getLogs() });
});

// ── GET /api/scrape/progress (SSE) ──────────────────────────────────

app.get('/api/scrape/progress', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  // Send log history + current status immediately
  const logs = scrapeJob.getLogs();
  if (logs.length > 0) {
    res.write(`event: log-history\ndata: ${JSON.stringify(logs)}\n\n`);
  }
  const status = scrapeJob.getStatus();
  res.write(`event: status\ndata: ${JSON.stringify(status)}\n\n`);

  const onStatus = (data) => res.write(`event: status\ndata: ${JSON.stringify(data)}\n\n`);
  const onSymbolDone = (data) => res.write(`event: symbol-done\ndata: ${JSON.stringify(data)}\n\n`);
  const onSymbolError = (data) => res.write(`event: symbol-error\ndata: ${JSON.stringify(data)}\n\n`);
  const onDone = (data) => res.write(`event: done\ndata: ${JSON.stringify(data)}\n\n`);
  const onError = (data) => res.write(`event: error\ndata: ${JSON.stringify(data)}\n\n`);
  const onCancelled = (data) => res.write(`event: cancelled\ndata: ${JSON.stringify(data)}\n\n`);

  scrapeJob.on('status', onStatus);
  scrapeJob.on('symbol-done', onSymbolDone);
  scrapeJob.on('symbol-error', onSymbolError);
  scrapeJob.on('done', onDone);
  scrapeJob.on('error', onError);
  scrapeJob.on('cancelled', onCancelled);

  // Heartbeat every 30s
  const heartbeat = setInterval(() => {
    res.write(`: heartbeat\n\n`);
  }, 30000);

  req.on('close', () => {
    clearInterval(heartbeat);
    scrapeJob.off('status', onStatus);
    scrapeJob.off('symbol-done', onSymbolDone);
    scrapeJob.off('symbol-error', onSymbolError);
    scrapeJob.off('done', onDone);
    scrapeJob.off('error', onError);
    scrapeJob.off('cancelled', onCancelled);
  });
});

// ── GET /api/auth/status ────────────────────────────────────────────

app.get('/api/auth/status', async (req, res) => {
  try {
    const cookiePath = resolve(process.cwd(), 'cookies.json');
    const raw = await readFile(cookiePath, 'utf-8');
    const cookies = JSON.parse(raw);
    const now = Date.now() / 1000;
    const valid = cookies.filter(c => !c.expires || c.expires > now);

    res.json({
      hasCookies: true,
      cookieCount: cookies.length,
      validCount: valid.length,
      allValid: valid.length > 0 && valid.length === cookies.length,
      nearestExpiry: valid.length > 0
        ? new Date(Math.min(...valid.filter(c => c.expires).map(c => c.expires * 1000))).toISOString()
        : null,
    });
  } catch {
    res.json({ hasCookies: false, cookieCount: 0, validCount: 0, allValid: false, nearestExpiry: null });
  }
});

// ── Start server ────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  logger.info(`Dashboard running at http://localhost:${PORT}`);
});
