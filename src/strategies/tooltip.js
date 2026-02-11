import { logger } from '../logger.js';

/**
 * Extract OHLCV data by hovering across a chart canvas and reading tooltip values.
 * TradingView charts render on canvas, so DOM elements only update on hover.
 * Returns an array of objects with raw string values, deduplicated by date.
 */
export async function extractTooltip(page, config) {
  const {
    chartCanvas,
    tooltipContainer,
    fields,
    scanStep = 5,
    scanStart,
    scanEnd,
  } = config;

  try {
    await page.waitForSelector(chartCanvas, { timeout: 15000 });
  } catch {
    logger.warn(`Chart canvas not found: "${chartCanvas}"`);
    return [];
  }

  const canvasBox = await page.$eval(chartCanvas, el => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });

  const yPos = Math.round(canvasBox.y + canvasBox.height / 2);
  const start = scanStart || Math.round(canvasBox.x + 10);
  const end = scanEnd || Math.round(canvasBox.x + canvasBox.width - 10);

  const results = new Map();

  logger.info(`Tooltip: scanning chart x=${start} to ${end}, step=${scanStep}px`);

  for (let xPos = start; xPos <= end; xPos += scanStep) {
    await page.mouse.move(xPos, yPos);
    await new Promise(r => setTimeout(r, 50));

    const visible = await page.$(tooltipContainer);
    if (!visible) continue;

    const row = {};
    for (const [field, def] of Object.entries(fields)) {
      const fullSelector = `${tooltipContainer} ${def.selector}`;
      try {
        row[field] = await page.$eval(fullSelector, (el, a) => {
          if (a === 'textContent') return el.textContent.trim();
          if (a === 'innerText') return el.innerText.trim();
          return el.getAttribute(a) || '';
        }, def.attribute || 'textContent');
      } catch {
        row[field] = null;
      }
    }

    if (row.date && !results.has(row.date)) {
      results.set(row.date, row);
    }
  }

  const data = Array.from(results.values());
  logger.info(`Tooltip: extracted ${data.length} unique records`);
  return data;
}
