import puppeteer from 'puppeteer';
import { logger } from './logger.js';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/120.0.0.0 Safari/537.36';

export async function launchBrowser(options = {}) {
  const browser = await puppeteer.launch({
    headless: options.headed ? false : 'new',
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    slowMo: options.slowMo || 0,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--window-size=1400,900',
    ],
    defaultViewport: { width: 1400, height: 900 },
    protocolTimeout: 0,  // unlimited — browser only closes when we call browser.close()
  });

  // Set default timeouts on all new pages (wrapped in try/catch to avoid
  // unhandled rejections when Stockbit opens/closes tabs during OTP flow)
  browser.on('targetcreated', async (target) => {
    try {
      if (target.type() === 'page') {
        const page = await target.page();
        if (page) {
          page.setDefaultTimeout(300_000);
          page.setDefaultNavigationTimeout(300_000);
        }
      }
    } catch {
      // Target may have been destroyed before we could access it — safe to ignore
    }
  });

  // Log browser disconnection for debugging
  browser.on('disconnected', () => {
    logger.warn('Browser disconnected unexpectedly');
  });

  return browser;
}

export async function navigateToSymbol(page, config, symbol) {
  const url =
    config.baseUrl.replace('{symbol}', symbol.toUpperCase()) +
    (config.pageVariant ? `/${config.pageVariant}` : '');

  logger.info(`Navigating to ${url}`);
  await page.setUserAgent(USER_AGENT);
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
  await executePreActions(page, config.preActions || []);
}

export async function executePreActions(page, actions) {
  for (let i = 0; i < actions.length; i++) {
    const action = actions[i];
    const desc = action.description || `${action.action} ${action.selector || ''}`;
    try {
      switch (action.action) {
        case 'waitForSelector':
          logger.debug(`PreAction[${i}]: waiting for "${action.selector}"`);
          await page.waitForSelector(action.selector, {
            timeout: action.timeout || 10000,
          });
          break;
        case 'click':
          logger.debug(`PreAction[${i}]: clicking "${action.selector}"`);
          await page.click(action.selector);
          break;
        case 'wait':
          logger.debug(`PreAction[${i}]: waiting ${action.ms}ms`);
          await new Promise(r => setTimeout(r, action.ms || 1000));
          break;
        case 'hover':
          logger.debug(`PreAction[${i}]: hovering "${action.selector}"`);
          await page.hover(action.selector);
          break;
        case 'scroll':
          logger.debug(`PreAction[${i}]: scrolling to "${action.selector}"`);
          await page.$eval(action.selector, el => el.scrollIntoView());
          break;
        case 'assertLoggedIn': {
          logger.debug(`PreAction[${i}]: checking login status`);
          const hasLogin = await page.evaluate(() => {
            const navLinks = Array.from(document.querySelectorAll('header a, nav a, [class*="nav"] a, [class*="Nav"] a'));
            return navLinks.some(el => {
              const text = (el.textContent || '').trim().toLowerCase();
              return text === 'login' || text === 'register';
            });
          });
          if (hasLogin) {
            throw new Error('Page indicates user is not logged in. OHLCV data requires authentication.');
          }
          break;
        }
        default:
          logger.warn(`PreAction[${i}]: unknown action "${action.action}"`);
      }
    } catch (err) {
      if (action.optional) {
        logger.warn(`PreAction[${i}] skipped (optional): ${desc} - ${err.message}`);
      } else {
        throw new Error(`PreAction[${i}] failed: ${desc} - ${err.message}`);
      }
    }
  }
}
