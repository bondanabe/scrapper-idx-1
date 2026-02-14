import { logger } from '../logger.js';

/**
 * Extract OHLCV data from a summary/stats panel.
 *
 * Supports two modes:
 *   - "css"   → each field uses a direct CSS selector (legacy, fragile with hashed classes)
 *   - "label" → finds values by matching nearby label text (e.g. "Open", "High")
 *                This is much more resilient to Styled Components class name changes.
 *
 * Set `selectorMode` in selectors.json panel config. Defaults to "css".
 */
export async function extractPanel(page, config) {
  const mode = config.selectorMode || 'css';

  if (mode === 'label') {
    return extractByLabel(page, config);
  }
  return extractByCSS(page, config);
}

/**
 * CSS-based extraction (original approach).
 * Each field has its own CSS selector.
 */
async function extractByCSS(page, config) {
  const { container, fields } = config;

  if (container) {
    try {
      await page.waitForSelector(container, { timeout: 10000 });
    } catch {
      logger.warn(`Panel container not found: "${container}"`);
      return null;
    }
  }

  const result = {};
  for (const [field, def] of Object.entries(fields)) {
    const selector = container ? `${container} ${def.selector}` : def.selector;
    const attr = def.attribute || 'textContent';

    try {
      result[field] = await page.$eval(selector, (el, a) => {
        if (a === 'textContent') return el.textContent.trim();
        if (a === 'innerText') return el.innerText.trim();
        return el.getAttribute(a) || '';
      }, attr);
    } catch {
      logger.warn(`Panel field "${field}" not found: "${selector}"`);
      result[field] = null;
    }
  }

  return result;
}

/**
 * Label-based extraction — resilient to class name changes.
 *
 * For each field, searches the DOM for an element containing the label text
 * (e.g. "Open", "High", "Low", "Volume") and then extracts the value from
 * a sibling, parent, or nearby element.
 *
 * Config format in selectors.json:
 *   "fields": {
 *     "open":   { "label": "Open",   "valuePosition": "sibling" },
 *     "high":   { "label": "High",   "valuePosition": "sibling" },
 *     "close":  { "label": "Close",  "valuePosition": "heading" },
 *     "volume": { "label": "Volume", "valuePosition": "sibling" }
 *   }
 *
 * valuePosition options:
 *   - "sibling"  → value is in the next sibling element
 *   - "parent"   → value is in the parent's textContent minus the label
 *   - "child"    → value is in a child element of the label's parent
 *   - "heading"  → special: find the first large heading (h1-h3) with a number
 *   - "adjacent" → value is directly adjacent in the same container
 */
async function extractByLabel(page, config) {
  const { fields } = config;

  const result = await page.evaluate((fieldsConfig) => {
    const out = {};

    /**
     * Walk the DOM to find elements containing the given label text.
     * Returns an array of matching elements.
     */
    function findByLabel(labelText) {
      const walker = document.createTreeWalker(
        document.body,
        NodeFilter.SHOW_ELEMENT,
        null,
        false
      );
      const matches = [];
      let node;
      while ((node = walker.nextNode())) {
        // Only match leaf-level or near-leaf elements
        const directText = Array.from(node.childNodes)
          .filter(n => n.nodeType === Node.TEXT_NODE)
          .map(n => n.textContent.trim())
          .join(' ');

        if (directText.toLowerCase() === labelText.toLowerCase()) {
          matches.push(node);
        }
      }
      return matches;
    }

    /**
     * Extract a numeric-looking value from element text.
     * Returns null if no digit found.
     */
    function extractValue(el) {
      if (!el) return null;
      const text = el.textContent.trim();
      if (!text || !/\d/.test(text)) return null;
      // Match numbers with dots, commas, spaces and optional suffix (K, M, B, T)
      const match = text.match(/[\d.,\s]+[KMBT]?/i);
      return match ? match[0].trim() : null;
    }

    for (const [field, def] of Object.entries(fieldsConfig)) {
      try {
        // Direct CSS selector — bypass label search entirely
        if (def.valuePosition === 'direct' && def.selector) {
          const el = document.querySelector(def.selector);
          out[field] = el ? extractValue(el) : null;
          continue;
        }

        // Special handling for "close" (current price) — usually the main heading
        if (def.valuePosition === 'heading') {
          const headings = document.querySelectorAll('h1, h2, h3');
          for (const h of headings) {
            const text = h.textContent.trim();
            // Match a price-like pattern (numbers with dots/commas)
            if (/^[\d.,]+$/.test(text.replace(/\s/g, ''))) {
              out[field] = text;
              break;
            }
          }
          if (!out[field]) out[field] = null;
          continue;
        }

        const labelElements = findByLabel(def.label);
        if (labelElements.length === 0) {
          out[field] = null;
          continue;
        }

        let value = null;
        for (const labelEl of labelElements) {
          switch (def.valuePosition) {
            case 'sibling': {
              // Try next element sibling
              let sib = labelEl.nextElementSibling;
              if (sib) {
                value = extractValue(sib);
                if (value) break;
              }
              // Try previous element sibling (value above label)
              sib = labelEl.previousElementSibling;
              if (sib) {
                value = extractValue(sib);
                if (value) break;
              }
              // Fallback: parent's siblings
              const parent = labelEl.parentElement;
              if (parent) {
                sib = parent.nextElementSibling;
                if (sib) {
                  value = extractValue(sib);
                  if (value) break;
                }
                sib = parent.previousElementSibling;
                if (sib) {
                  value = extractValue(sib);
                  if (value) break;
                }
                // Fallback 2: grandparent's next sibling
                const grandparent = parent.parentElement;
                if (grandparent) {
                  sib = grandparent.nextElementSibling;
                  if (sib) value = extractValue(sib);
                }
              }
              break;
            }
            case 'parent': {
              const parent = labelEl.parentElement;
              if (parent) {
                // Get all text that's not the label
                const allText = parent.textContent.trim();
                const stripped = allText.replace(def.label, '').trim();
                value = stripped || null;
              }
              break;
            }
            case 'child': {
              const parent = labelEl.parentElement;
              if (parent) {
                // Find child elements with numeric content
                const children = parent.querySelectorAll('*');
                for (const child of children) {
                  if (child === labelEl) continue;
                  const text = child.textContent.trim();
                  if (/[\d]/.test(text) && text !== labelEl.textContent.trim()) {
                    value = extractValue(child);
                    break;
                  }
                }
              }
              break;
            }
            case 'adjacent':
            default: {
              // Walk through parent's children to find adjacent value
              const parent = labelEl.parentElement;
              if (parent) {
                const siblings = Array.from(parent.children);
                const idx = siblings.indexOf(labelEl);
                // Check next sibling
                if (idx >= 0 && idx < siblings.length - 1) {
                  value = extractValue(siblings[idx + 1]);
                }
              }
              break;
            }
          }
          if (value) break; // Found a value, stop searching
        }

        out[field] = value;
      } catch (e) {
        out[field] = null;
      }
    }

    return out;
  }, fields);

  // Log extraction results
  for (const [field, value] of Object.entries(result)) {
    if (value === null) {
      logger.warn(`Panel field "${field}" not found via label-based extraction`);
    } else {
      logger.debug(`Panel "${field}" = "${value}"`);
    }
  }

  return result;
}
