/**
 * Parse Indonesian-formatted number string.
 *
 * Indonesian locale: dot = thousands separator, comma = decimal separator.
 * Examples:
 *   "7.675"      → 7675
 *   "1.234,56"   → 1234.56
 *   "176,35 M"   → 176350000
 *   "0,5 K"      → 500
 *   "7675"        → 7675
 */
export function parseNumber(raw, locale) {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (!s) return null;

  const suffixes = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 };
  let multiplier = 1;
  const suffixMatch = s.match(/([KMBT])\s*$/i);
  if (suffixMatch) {
    multiplier = suffixes[suffixMatch[1].toUpperCase()];
    s = s.replace(/[KMBT]\s*$/i, '').trim();
  }

  // Remove non-numeric chars except dot, comma, minus
  s = s.replace(/[^\d.,-]/g, '');

  if (!s) return null;

  // If locale is explicitly Indonesian (Stockbit format)
  if (locale === 'id-ID') {
    if (multiplier > 1) {
      // With suffix (K/M/B/T): comma = thousands (remove), dot = decimal (keep)
      s = s.replace(/,/g, '');
    } else {
      // Without suffix: both comma and dot = thousands (remove all)
      s = s.replace(/[.,]/g, '');
    }
    const num = parseFloat(s);
    return isNaN(num) ? null : num * multiplier;
  }

  // English format (TradingView): comma = thousands, dot = decimal
  if (locale === 'en-US') {
    s = s.replace(/,/g, '');
    const num = parseFloat(s);
    return isNaN(num) ? null : num * multiplier;
  }

  // Auto-detect format (fallback when no locale specified)
  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');

  if (lastComma > lastDot) {
    // Indonesian: dots are thousands, comma is decimal
    s = s.replace(/\./g, '').replace(',', '.');
  } else if (lastDot > lastComma && lastComma !== -1) {
    // English: commas are thousands, dot is decimal
    s = s.replace(/,/g, '');
  } else if (lastComma !== -1 && lastDot === -1) {
    // Only comma present → treat as decimal
    s = s.replace(',', '.');
  }

  const num = parseFloat(s);
  return isNaN(num) ? null : num * multiplier;
}

/**
 * Parse a date string into ISO format (YYYY-MM-DD).
 *
 * Supports:
 *   DD/MM/YYYY, DD-MM-YYYY, YYYY-MM-DD
 *   DD MMM YYYY, DD MMMM YYYY (Indonesian month names)
 */
export function parseDate(raw, format = 'DD/MM/YYYY') {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;

  const months = {
    jan: '01', januari: '01',
    feb: '02', februari: '02',
    mar: '03', maret: '03',
    apr: '04', april: '04',
    mei: '05', may: '05',
    jun: '06', juni: '06',
    jul: '07', juli: '07',
    agu: '08', agustus: '08', aug: '08',
    sep: '09', september: '09',
    okt: '10', oktober: '10', oct: '10',
    nov: '11', november: '11',
    des: '12', desember: '12', dec: '12',
  };

  // Try named month: "7 Feb 2025" or "7 Februari 2025"
  const namedMatch = s.match(/(\d{1,2})\s+(\w{3,})\s+(\d{4})/);
  if (namedMatch) {
    const day = namedMatch[1].padStart(2, '0');
    const mon = months[namedMatch[2].toLowerCase()];
    if (mon) return `${namedMatch[3]}-${mon}-${day}`;
  }

  // Split by / - or .
  const parts = s.split(/[/\-.]/);
  if (parts.length === 3) {
    if (format.startsWith('DD')) {
      return `${parts[2]}-${parts[1].padStart(2, '0')}-${parts[0].padStart(2, '0')}`;
    }
    if (format.startsWith('YYYY')) {
      return `${parts[0]}-${parts[1].padStart(2, '0')}-${parts[2].padStart(2, '0')}`;
    }
  }

  // Fallback: try ISO directly
  const isoMatch = s.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) return isoMatch[0];

  return null;
}
