import { logger } from '../logger.js';

/**
 * Extract OHLCV data from an HTML table.
 * Each row maps to one trading day.
 * Returns an array of objects with raw string values.
 */
export async function extractTable(page, config) {
  const { container, rowSelector, columns } = config;

  try {
    await page.waitForSelector(container, { timeout: 10000 });
  } catch {
    logger.warn(`Table container not found: "${container}"`);
    return [];
  }

  const fullRowSelector = `${container} ${rowSelector || 'tbody tr'}`;

  const rows = await page.$$eval(
    fullRowSelector,
    (trs, cols) => {
      return trs.map(tr => {
        const cells = tr.querySelectorAll('td, th');
        const row = {};
        for (const [field, def] of Object.entries(cols)) {
          const cell = cells[def.index];
          if (!cell) {
            row[field] = null;
            continue;
          }
          const attr = def.attribute || 'textContent';
          if (attr === 'textContent') row[field] = cell.textContent.trim();
          else if (attr === 'innerText') row[field] = cell.innerText.trim();
          else row[field] = cell.getAttribute(attr) || '';
        }
        return row;
      });
    },
    columns
  );

  const filtered = rows.filter(r => r.date);
  logger.info(`Table: extracted ${filtered.length} rows`);
  return filtered;
}
