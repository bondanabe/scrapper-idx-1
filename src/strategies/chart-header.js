import { logger } from '../logger.js';

/**
 * Extract OHLCV data from TradingView chart legend/header bar.
 *
 * TradingView legend format (top-left of chart):
 *   Line 1: "Company Name · TF · Exchange  ...  O9,325  H9,325  L9,325  C9,325  +25 (+0.27%)"
 *   Line 2: "Vol 973.2K"
 *
 * TradingView renders each value (O, H, L, C, Vol) and suffix (K, M, B) as
 * separate DOM elements, so we scan individual child elements rather than
 * relying on a single textContent regex.
 */
export async function extractChartHeader(page, config) {
  // Wait for chart legend to be present
  await new Promise(r => setTimeout(r, 2000));

  const result = await page.evaluate(() => {
    const out = { open: null, high: null, low: null, close: null, volume: null, _legendDebug: '' };

    // Collect legend containers
    const legendItems = document.querySelectorAll(
      '[data-name="legend-source-item"], .legendMainSourceWrapper'
    );

    // --- OHLC extraction (from full textContent — works reliably) ---
    const scanTextForOHLC = (text) => {
      const ohlcMatch = text.match(/O\s*([\d,.]+)\s*H\s*([\d,.]+)\s*L\s*([\d,.]+)\s*C\s*([\d,.]+)/);
      if (ohlcMatch) {
        out.open = ohlcMatch[1];
        out.high = ohlcMatch[2];
        out.low = ohlcMatch[3];
        out.close = ohlcMatch[4];
        return true;
      }
      return false;
    };

    if (legendItems.length === 0) {
      // Fallback: scan full page text
      const allText = document.body.innerText;
      scanTextForOHLC(allText);

      // Fallback volume: try full text regex
      const volMatch = allText.match(/Vol\s*([\d,.]+)\s*([KMBT])/i);
      if (volMatch) {
        out.volume = volMatch[1] + volMatch[2];
      } else {
        const volMatch2 = allText.match(/Vol\s*([\d,.]+)/i);
        if (volMatch2) out.volume = volMatch2[1];
      }

      out._legendDebug = 'fallback:body';
      return out;
    }

    // Scan legend items for OHLC (full textContent is fine for OHLC)
    for (const item of legendItems) {
      const text = item.textContent || '';
      if (scanTextForOHLC(text)) break;
    }

    // --- Volume extraction (element-level scan) ---
    // TradingView renders Vol label, number, and suffix (K/M/B) as separate elements.
    // We need to find them individually and reconstruct the full volume string.
    const allChildren = document.querySelectorAll(
      '[data-name="legend-source-item"] *, .legendMainSourceWrapper *'
    );

    for (const el of allChildren) {
      // Get only this element's direct text (not children)
      const directText = Array.from(el.childNodes)
        .filter(n => n.nodeType === 3)
        .map(n => n.textContent.trim())
        .join('');

      const fullText = el.textContent.trim();

      // Pattern 1: Element contains "Vol" + number + suffix all together
      const volFull = fullText.match(/Vol\s*([\d,.]+)\s*([KMBT])/i);
      if (volFull) {
        out.volume = volFull[1] + volFull[2];
        break;
      }

      // Pattern 2: Element's direct text is just "Vol" — number + suffix in siblings
      if (directText.toLowerCase() === 'vol' || fullText.toLowerCase() === 'vol') {
        let sibling = el.nextElementSibling;
        let volStr = '';

        while (sibling) {
          const st = sibling.textContent.trim();

          if (/^[\d,.]+\s*[KMBT]$/i.test(st)) {
            // Number + suffix in one sibling (e.g., "23.84M")
            volStr += st;
            break;
          } else if (/^[\d,.]+$/.test(st)) {
            // Just a number (e.g., "23.84")
            volStr += st;
          } else if (/^[KMBT]$/i.test(st)) {
            // Just a suffix (e.g., "M")
            volStr += st;
            break;
          } else {
            break;
          }

          sibling = sibling.nextElementSibling;
        }

        if (volStr) {
          out.volume = volStr;
          break;
        }
      }
    }

    // If volume still not found, try the old regex approach on full text
    if (!out.volume) {
      for (const item of legendItems) {
        const text = item.textContent || '';
        const volMatch = text.match(/Vol\s*([\d,.]+)\s*([KMBT])?/i);
        if (volMatch) {
          out.volume = volMatch[1] + (volMatch[2] || '');
          break;
        }
      }
    }

    // Debug: capture raw legend text for troubleshooting
    out._legendDebug = [...legendItems]
      .map(el => el.textContent.substring(0, 300).replace(/\s+/g, ' '))
      .join(' | ');

    return out;
  });

  // Log extraction results
  if (result._legendDebug) {
    logger.debug(`Chart header legend raw: ${result._legendDebug}`);
  }
  delete result._legendDebug;

  for (const [field, value] of Object.entries(result)) {
    if (value === null) {
      logger.warn(`Chart header field "${field}" not found`);
    } else {
      logger.debug(`Chart header "${field}" = "${value}"`);
    }
  }

  return result;
}
