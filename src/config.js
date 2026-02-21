import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import 'dotenv/config';

let _selectors = null;

export async function loadSelectors(source = 'stockbit') {
  const filename = source === 'tradingview' ? 'selectors-tradingview.json' : 'selectors.json';
  const filepath = resolve(process.cwd(), filename);
  const raw = await readFile(filepath, 'utf-8');
  const config = JSON.parse(raw);
  validateConfig(config);
  _selectors = config;
  return config;
}

export function getSelectors() {
  if (!_selectors) throw new Error('Selectors not loaded. Call loadSelectors() first.');
  return _selectors;
}

export function getSupabaseConfig() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;
  if (!url || !key) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY/SUPABASE_KEY in .env file.');
  }
  return { url, key };
}

export function getStockbitCredentials() {
  const email = process.env.STOCKBIT_EMAIL;
  const password = process.env.STOCKBIT_PASSWORD;
  if (!email || !password) {
    throw new Error('Missing STOCKBIT_EMAIL or STOCKBIT_PASSWORD in .env file.');
  }
  return { email, password };
}

export function getTradingViewCredentials() {
  const email = process.env.TRADINGVIEW_EMAIL;
  const password = process.env.TRADINGVIEW_PASSWORD;
  if (!email || !password) {
    throw new Error('Missing TRADINGVIEW_EMAIL or TRADINGVIEW_PASSWORD in .env file.');
  }
  return { email, password };
}

function validateConfig(config) {
  if (!config.baseUrl) throw new Error('selectors.json: missing "baseUrl"');
  if (!config.strategy) throw new Error('selectors.json: missing "strategy"');

  const validStrategies = ['panel', 'table', 'tooltip', 'chart-header'];
  if (!validStrategies.includes(config.strategy)) {
    throw new Error(`selectors.json: invalid strategy "${config.strategy}". Must be one of: ${validStrategies.join(', ')}`);
  }

  if (!config[config.strategy]) {
    throw new Error(`selectors.json: strategy "${config.strategy}" selected but no "${config.strategy}" config section found.`);
  }
}
