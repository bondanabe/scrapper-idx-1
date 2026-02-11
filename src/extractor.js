import { extractPanel } from './strategies/panel.js';
import { extractTable } from './strategies/table.js';
import { extractTooltip } from './strategies/tooltip.js';

const strategies = {
  panel: extractPanel,
  table: extractTable,
  tooltip: extractTooltip,
};

/**
 * Extract OHLCV data from the page using the configured strategy.
 * Returns an array of raw row objects: [{ symbol, date, open, high, low, close, volume }]
 */
export async function extractData(page, config, symbol) {
  const strategy = config.strategy;
  const fn = strategies[strategy];
  if (!fn) throw new Error(`Unknown strategy: "${strategy}"`);

  const strategyConfig = config[strategy];
  const raw = await fn(page, strategyConfig);

  // Normalize to array
  const rows = Array.isArray(raw) ? raw : raw ? [raw] : [];

  // Attach symbol to each row
  return rows.map(row => ({ symbol: symbol.toUpperCase(), ...row }));
}
