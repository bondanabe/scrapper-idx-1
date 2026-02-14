import { createClient } from '@supabase/supabase-js';
import { getSupabaseConfig } from './config.js';
import { parseNumber, parseDate } from './parser.js';
import { logger } from './logger.js';

const TABLE = 'daily_prices';
const BATCH_SIZE = 500;

let _client = null;

function getClient() {
  if (!_client) {
    const { url, key } = getSupabaseConfig();
    _client = createClient(url, key, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }
  return _client;
}

/**
 * Get today's date as ISO string (YYYY-MM-DD).
 */
function todayISO() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Transform a raw extracted row (string values) into DB-ready typed values.
 * If dateMode is "today", uses current date instead of parsing from DOM.
 */
export function transformRow(raw, dateFormat, dateMode, numberLocale) {
  const date = dateMode === 'today' ? todayISO() : parseDate(raw.date, dateFormat);
  return {
    symbol: String(raw.symbol).toUpperCase().trim(),
    date,
    open: parseNumber(raw.open, numberLocale),
    high: parseNumber(raw.high, numberLocale),
    low: parseNumber(raw.low, numberLocale),
    close: parseNumber(raw.close, numberLocale),
    volume: Math.round(parseNumber(raw.volume, numberLocale) || 0),
  };
}

/**
 * Upsert rows to Supabase daily_prices table.
 * Uses onConflict on (symbol, date) composite unique constraint.
 */
export async function upsertRows(rows, dateFormat, dateMode, numberLocale) {
  const supabase = getClient();

  const transformed = rows
    .map(r => transformRow(r, dateFormat, dateMode, numberLocale))
    .filter(r => r.date && r.symbol);

  if (transformed.length === 0) {
    return { inserted: 0, errors: [] };
  }

  const errors = [];
  let inserted = 0;

  for (let i = 0; i < transformed.length; i += BATCH_SIZE) {
    const batch = transformed.slice(i, i + BATCH_SIZE);
    const { data, error } = await supabase
      .from(TABLE)
      .upsert(batch, { onConflict: 'symbol,date' })
      .select();

    if (error) {
      logger.error(`Batch ${Math.floor(i / BATCH_SIZE)} upsert failed`, error.message);
      errors.push({ batch: Math.floor(i / BATCH_SIZE), error: error.message });
    } else {
      inserted += data.length;
    }
  }

  return { inserted, errors };
}
