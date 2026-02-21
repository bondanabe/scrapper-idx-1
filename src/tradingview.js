import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { logger } from './logger.js';

const TV_LOGIN_URL = 'https://www.tradingview.com/accounts/signin/';
const TV_COOKIES_PATH = resolve(process.cwd(), 'cookies-tradingview.json');

/**
 * Load TradingView cookies from disk.
 */
export async function tryLoadTVCookies(page) {
  try {
    const raw = await readFile(TV_COOKIES_PATH, 'utf-8');
    const cookies = JSON.parse(raw);
    if (!Array.isArray(cookies) || cookies.length === 0) return false;

    const now = Date.now() / 1000;
    const valid = cookies.filter(c => !c.expires || c.expires > now);
    if (valid.length === 0) return false;

    await page.setCookie(...valid);
    logger.info(`Loaded ${valid.length} TradingView cookies from cache`);
    return true;
  } catch {
    logger.debug('No cached TradingView cookies found');
    return false;
  }
}

/**
 * Save TradingView cookies to disk.
 */
export async function saveTVCookies(page) {
  try {
    const cookies = await page.cookies(
      'https://www.tradingview.com',
      'https://www.tradingview.com/chart',
    );
    await writeFile(TV_COOKIES_PATH, JSON.stringify(cookies, null, 2), 'utf-8');
    logger.debug(`Saved ${cookies.length} TradingView cookies`);
  } catch (err) {
    logger.warn(`Failed to save TradingView cookies: ${err.message}`);
  }
}

/**
 * Check if the user is logged in to TradingView.
 */
export async function isLoggedInTV(page) {
  try {
    const finalUrl = page.url();
    if (finalUrl.includes('/accounts/signin') || finalUrl.includes('/accounts/login')) {
      return false;
    }

    const loggedIn = await page.evaluate(() => {
      // TradingView shows a user avatar/menu button when logged in
      const userMenu = document.querySelector(
        '[data-name="header-user-menu-button"], ' +
        'button[aria-label="Open user menu"], ' +
        '[class*="userButton"], ' +
        '[class*="avatar"]'
      );
      if (userMenu) return true;

      // Check for sign-in button (means NOT logged in)
      const buttons = Array.from(document.querySelectorAll('button, a'));
      const hasSignIn = buttons.some(el => {
        const text = (el.textContent || '').trim().toLowerCase();
        return text === 'sign in' || text === 'get started';
      });
      if (hasSignIn) return false;

      // Default: assume logged in if on chart page
      return finalUrl.includes('/chart/');
    });

    logger.debug(`TradingView login check: ${loggedIn ? 'logged in' : 'not logged in'}`);
    return loggedIn;
  } catch (err) {
    logger.warn(`TradingView login check failed: ${err.message}`);
    return false;
  }
}

/**
 * Login to TradingView using email and password.
 */
export async function loginToTradingView(page, credentials) {
  const { email, password } = credentials;

  logger.info('Navigating to TradingView login page...');
  await page.goto(TV_LOGIN_URL, { waitUntil: 'networkidle2', timeout: 60000 });
  await new Promise(r => setTimeout(r, 2000));

  // Click "Email" tab in the login dialog
  const emailTabClicked = await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button, span, div'));
    const emailTab = buttons.find(el => {
      const text = (el.textContent || '').trim().toLowerCase();
      return text === 'email';
    });
    if (emailTab) {
      emailTab.click();
      return true;
    }
    return false;
  });

  if (emailTabClicked) {
    logger.debug('Clicked Email tab');
    await new Promise(r => setTimeout(r, 1000));
  }

  // Fill email
  logger.debug('Filling email...');
  const emailFilled = await page.evaluate(() => {
    const inputs = Array.from(document.querySelectorAll('input'));
    const emailInput = inputs.find(i =>
      i.type === 'email' ||
      i.name === 'username' ||
      i.name === 'email' ||
      i.id === 'id_username' ||
      (i.placeholder && i.placeholder.toLowerCase().includes('email'))
    );
    if (emailInput) {
      emailInput.focus();
      emailInput.value = '';
      return true;
    }
    return false;
  });

  if (!emailFilled) throw new Error('Could not find email input on TradingView login page');
  await page.keyboard.type(email, { delay: 50 });

  // Fill password
  logger.debug('Filling password...');
  const passwordFilled = await page.evaluate(() => {
    const inputs = Array.from(document.querySelectorAll('input'));
    const pwInput = inputs.find(i =>
      i.type === 'password' ||
      i.name === 'password' ||
      i.id === 'id_password'
    );
    if (pwInput) {
      pwInput.focus();
      pwInput.value = '';
      return true;
    }
    return false;
  });

  if (!passwordFilled) throw new Error('Could not find password input on TradingView login page');
  await page.keyboard.type(password, { delay: 50 });

  // Click Sign In button
  logger.debug('Clicking Sign In button...');
  const signInClicked = await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button'));
    const signInBtn = buttons.find(b => {
      const text = (b.textContent || '').trim().toLowerCase();
      return text === 'sign in' || text === 'log in';
    });
    if (signInBtn) {
      signInBtn.click();
      return true;
    }
    const submitBtn = document.querySelector('button[type="submit"]');
    if (submitBtn) {
      submitBtn.click();
      return true;
    }
    return false;
  });

  if (!signInClicked) throw new Error('Could not find Sign In button');

  // Wait for login to complete
  logger.info('Waiting for TradingView login response...');
  try {
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 });
  } catch {
    await new Promise(r => setTimeout(r, 5000));
  }

  // Check if we're still on login page (possible error)
  const currentUrl = page.url();
  if (currentUrl.includes('/accounts/signin') || currentUrl.includes('/accounts/login')) {
    const errorMsg = await page.evaluate(() => {
      const errorEls = document.querySelectorAll('[class*="error"], [class*="Error"], [role="alert"], .alert');
      for (const el of errorEls) {
        const text = el.textContent.trim();
        if (text) return text;
      }
      return null;
    });
    throw new Error(`TradingView login failed${errorMsg ? `: ${errorMsg}` : ' — still on login page'}`);
  }

  logger.info('TradingView login successful');
  await saveTVCookies(page);
  return true;
}

/**
 * Wait until the TradingView chart is fully rendered.
 */
async function waitForChartReady(page, timeout = 30000) {
  try {
    await page.waitForSelector(
      '[data-name="legend-source-item"], .chart-markup-table, canvas.tv-chart',
      { timeout }
    );
    // Extra wait for dynamic content to settle
    await new Promise(r => setTimeout(r, 2000));
    logger.debug('TradingView: chart is ready');
  } catch {
    logger.warn('TradingView: chart ready timeout — proceeding anyway');
  }
}

/**
 * Navigate to TradingView Supercharts via the Products menu.
 * This is required because the chart URL is dynamic — we must go through the menu.
 */
async function navigateToSupercharts(page) {
  logger.info('TradingView: navigating to Supercharts via Products menu...');

  // Step 1: Hover "Products" in the navbar to open dropdown
  const productsHovered = await page.evaluate(() => {
    const navItems = Array.from(document.querySelectorAll('button, a, [role="menuitem"], [class*="menuItem"]'));
    const productsBtn = navItems.find(el => {
      const text = (el.textContent || '').trim().toLowerCase();
      return text === 'products';
    });
    if (productsBtn) {
      // Trigger mouseenter to open dropdown
      productsBtn.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
      productsBtn.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      return true;
    }
    return false;
  });

  if (productsHovered) {
    await new Promise(r => setTimeout(r, 1000));

    // Step 2: Click "Supercharts" in the dropdown
    const superchartsClicked = await page.evaluate(() => {
      const items = Array.from(document.querySelectorAll('a, button, [role="menuitem"]'));
      const supercharts = items.find(el => {
        const text = (el.textContent || '').trim().toLowerCase();
        return text.includes('superchart');
      });
      if (supercharts) {
        supercharts.click();
        return true;
      }
      return false;
    });

    if (superchartsClicked) {
      logger.debug('TradingView: clicked Supercharts menu item');
    } else {
      // Fallback: direct navigation
      logger.warn('TradingView: could not find Supercharts in dropdown, navigating directly');
      await page.goto('https://www.tradingview.com/chart/', { waitUntil: 'networkidle2', timeout: 60000 });
    }
  } else {
    // Fallback: direct navigation
    logger.warn('TradingView: could not find Products menu, navigating directly');
    await page.goto('https://www.tradingview.com/chart/', { waitUntil: 'networkidle2', timeout: 60000 });
  }

  // Step 3: Wait for chart page to load
  await waitForChartReady(page);
  logger.info(`TradingView: Supercharts loaded at ${page.url()}`);
}

/**
 * Ensure the page has an authenticated TradingView session.
 * Flow: homepage → cek login → login jika perlu → Products → Supercharts.
 */
export async function ensureLoggedInTV(page, credentials, chartUrl) {
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  );

  // Step 1: Load cookies jika ada (tidak wajib berhasil)
  await tryLoadTVCookies(page);

  // Step 2: Navigate ke homepage → cek apakah sudah login
  logger.info('TradingView: navigating to homepage to check session...');
  await page.goto('https://www.tradingview.com/', { waitUntil: 'networkidle2', timeout: 60000 });
  await new Promise(r => setTimeout(r, 2000));

  if (await isLoggedInTV(page)) {
    logger.info('TradingView: already logged in, skipping login');
  } else {
    // Step 3: Belum login → login via form
    logger.info('TradingView: not logged in, performing login...');
    await loginToTradingView(page, credentials);

    // Setelah login, navigate kembali ke homepage (login mungkin redirect ke tempat lain)
    await page.goto('https://www.tradingview.com/', { waitUntil: 'networkidle2', timeout: 60000 });
    await new Promise(r => setTimeout(r, 2000));
  }

  // Step 4: Navigasi ke chart via Products → Supercharts
  await navigateToSupercharts(page);
}

/**
 * Ensure the TradingView chart is set to Daily (1D) timeframe.
 * Clicks the timeframe button in the toolbar if not already 1D.
 */
export async function ensureDaily(page) {
  const currentTF = await page.evaluate(() => {
    // The active timeframe button in the toolbar
    const btn = document.querySelector('#header-toolbar-intervals [class*="isActive"], #header-toolbar-intervals .active');
    return btn ? btn.textContent.trim() : '';
  });

  if (currentTF === '1D' || currentTF === 'D') {
    logger.debug('TradingView: already on 1D timeframe');
    return;
  }

  logger.info(`TradingView: switching timeframe from "${currentTF}" to 1D...`);

  // Try clicking 1D button in the timeframe toolbar
  const clicked = await page.evaluate(() => {
    // Method 1: Look for timeframe buttons in the toolbar
    const buttons = document.querySelectorAll('#header-toolbar-intervals button, [data-name="date-ranges-tabs"] button');
    for (const btn of buttons) {
      const text = btn.textContent.trim();
      if (text === '1D' || text === 'D') {
        btn.click();
        return true;
      }
    }

    // Method 2: Look in the bottom timeframe bar
    const bottomBtns = document.querySelectorAll('button');
    for (const btn of bottomBtns) {
      const text = btn.textContent.trim();
      if (text === '1D') {
        btn.click();
        return true;
      }
    }

    return false;
  });

  if (!clicked) {
    logger.warn('TradingView: could not find 1D timeframe button, using keyboard shortcut');
    // Fallback: use keyboard shortcut to open timeframe dialog
    await page.keyboard.press(',');
    await new Promise(r => setTimeout(r, 500));
    await page.keyboard.type('D', { delay: 50 });
    await page.keyboard.press('Enter');
  }

  // Wait for chart to reload with new timeframe
  await new Promise(r => setTimeout(r, 3000));
  logger.info('TradingView: switched to 1D timeframe');
}

/**
 * Change the active symbol in TradingView chart via the symbol search.
 * Clicks the symbol name area in the top-left toolbar, types the new symbol,
 * and selects the IDX result.
 */
export async function changeSymbolTV(page, symbol, config = {}) {
  const waitAfter = config.waitAfterSymbolChange || 3000;

  logger.info(`TradingView: changing symbol to ${symbol}...`);

  // Click the symbol search button (top-left of toolbar)
  const searchOpened = await page.evaluate(() => {
    // Method 1: Click the symbol search button by ID
    const searchBtn = document.querySelector('#header-toolbar-symbol-search');
    if (searchBtn) {
      searchBtn.click();
      return true;
    }

    // Method 2: Click the symbol name text area
    const symbolEl = document.querySelector('[data-name="symbol-search"] button, .tv-symbol-header__symbol');
    if (symbolEl) {
      symbolEl.click();
      return true;
    }

    return false;
  });

  if (!searchOpened) {
    logger.warn('TradingView: could not find symbol search button, trying keyboard shortcut');
  }

  // Wait for search dialog to open
  await new Promise(r => setTimeout(r, 1000));

  // Clear existing text and type the new symbol
  await page.keyboard.down('Control');
  await page.keyboard.press('a');
  await page.keyboard.up('Control');
  await page.keyboard.type(symbol, { delay: 80 });

  // Wait for search results to appear
  await new Promise(r => setTimeout(r, 2000));

  // Click the first IDX result (or first result if no IDX match)
  const selected = await page.evaluate((sym) => {
    // Look for search result items
    const selectors = [
      '[data-name="symbol-search-items-dialog"] [class*="itemRow"]',
      '.tv-search-dialog__results .tv-search-dialog__item',
      '[class*="listContainer"] [class*="symbolRow"]',
      '[class*="itemRow"]',
    ];

    for (const sel of selectors) {
      const items = document.querySelectorAll(sel);
      if (items.length === 0) continue;

      // Prefer IDX exchange match
      for (const item of items) {
        const text = item.textContent.toLowerCase();
        if (text.includes('idx') && text.includes(sym.toLowerCase())) {
          item.click();
          return `IDX: ${sym}`;
        }
      }

      // Fallback: click first result
      items[0].click();
      return `first result for ${sym}`;
    }

    return null;
  }, symbol);

  if (selected) {
    logger.debug(`TradingView: selected "${selected}"`);
  } else {
    // Fallback: press Enter to select first result
    logger.debug('TradingView: no result clicked, pressing Enter');
    await page.keyboard.press('Enter');
  }

  // Wait for chart to load the new symbol
  await new Promise(r => setTimeout(r, waitAfter));
  logger.info(`TradingView: symbol changed to ${symbol}`);
}
