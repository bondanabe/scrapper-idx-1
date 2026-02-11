#!/usr/bin/env node
import { Command } from 'commander';
import { readFile } from 'node:fs/promises';
import { loadSelectors, getStockbitCredentials } from './config.js';
import { launchBrowser, navigateToSymbol, executePreActions } from './browser.js';
import { ensureLoggedIn } from './auth.js';
import { extractData } from './extractor.js';
import { upsertRows, transformRow } from './store.js';
import { logger } from './logger.js';

const program = new Command();
program.name('scrapper-idx').version('1.0.0').description('IDX stock OHLCV scraper');

// ── scrape ──────────────────────────────────────────────────────────

program
  .command('scrape')
  .description('Scrape OHLCV data for given symbols')
  .option('--symbols <list>', 'Comma-separated stock symbols (e.g. BBCA,BBRI)')
  .option('--file <path>', 'File with one symbol per line')
  .option('--dry-run', 'Print extracted data without saving to database')
  .option('--headed', 'Run browser visibly for debugging')
  .option('--slow-mo <ms>', 'Slow down Puppeteer actions (ms)', parseInt, 0)
  .option('--no-login', 'Skip Stockbit login (for public pages only)')
  .action(async (options) => {
    try {
      const config = await loadSelectors();
      const symbols = await resolveSymbols(options);
      if (symbols.length === 0) {
        logger.error('No symbols provided. Use --symbols or --file.');
        process.exit(1);
      }

      logger.info(`Strategy: ${config.strategy}`);
      logger.info(`Symbols: ${symbols.join(', ')}`);

      const browser = await launchBrowser(options);
      const page = await browser.newPage();

      // Build first symbol URL for auth check (avoids double navigation)
      const firstSymbolUrl = config.baseUrl.replace('{symbol}', symbols[0])
        + (config.pageVariant ? `/${config.pageVariant}` : '');

      // Authenticate if login is enabled (default)
      if (options.login !== false) {
        const credentials = getStockbitCredentials();
        await ensureLoggedIn(page, credentials, firstSymbolUrl);
      } else {
        logger.info('Skipping login (--no-login)');
      }

      let totalInserted = 0;
      const failed = [];

      for (let i = 0; i < symbols.length; i++) {
        const symbol = symbols[i];
        logger.info(`[${i + 1}/${symbols.length}] Processing ${symbol}...`);

        try {
          // Skip navigation if page is already on this symbol (first symbol after auth)
          if (page.url().includes(`/symbol/${symbol.toUpperCase()}`)) {
            await executePreActions(page, config.preActions || []);
          } else {
            await navigateToSymbol(page, config, symbol);
          }
          const rows = await extractData(page, config, symbol);

          if (rows.length === 0) {
            logger.warn(`${symbol}: no data extracted`);
            continue;
          }

          if (options.dryRun) {
            const transformed = rows.map(r => transformRow(r, config.dateFormat, config.dateMode));
            logger.info(`${symbol}: ${transformed.length} rows (dry run)`);
            console.log(JSON.stringify(transformed, null, 2));
          } else {
            const { inserted, errors } = await upsertRows(rows, config.dateFormat, config.dateMode);
            totalInserted += inserted;
            logger.info(`${symbol}: ${inserted} rows saved`);
            if (errors.length > 0) {
              logger.warn(`${symbol}: ${errors.length} batch errors`);
            }
          }
        } catch (err) {
          logger.error(`${symbol}: failed - ${err.message}`);
          failed.push(symbol);
        }

        // Delay between symbols
        if (i < symbols.length - 1) {
          await new Promise(r => setTimeout(r, 2000));
        }
      }

      await browser.close();

      logger.info(`Done. Total: ${totalInserted} rows saved.`);
      if (failed.length > 0) {
        logger.warn(`Failed symbols: ${failed.join(', ')}`);
      }
    } catch (err) {
      logger.error(err.message);
      process.exit(1);
    }
  });

// ── probe ───────────────────────────────────────────────────────────

program
  .command('probe <symbol>')
  .description('Open headed browser to inspect DOM for CSS selectors')
  .option('--timeout <ms>', 'How long to keep browser open (ms)', parseInt, 300000)
  .option('--no-login', 'Skip Stockbit login')
  .action(async (symbol, options) => {
    try {
      const config = await loadSelectors();
      const browser = await launchBrowser({ headed: true, slowMo: 100 });
      const page = await browser.newPage();

      const url =
        config.baseUrl.replace('{symbol}', symbol.toUpperCase()) +
        (config.pageVariant ? `/${config.pageVariant}` : '');

      // Authenticate before probing (navigate directly to symbol URL)
      if (options.login !== false) {
        const credentials = getStockbitCredentials();
        await ensureLoggedIn(page, credentials, url);
      } else {
        logger.info('Skipping login (--no-login)');
      }

      logger.info(`Opening ${url} in headed browser...`);
      logger.info('Use DevTools (F12) to inspect elements and find CSS selectors.');
      logger.info(`Browser will stay open for ${options.timeout / 1000}s. Press Ctrl+C to close.`);

      // Skip navigation if already on symbol page (from auth check)
      if (!page.url().includes(`/symbol/${symbol.toUpperCase()}`)) {
        await page.setUserAgent(
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        );
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
      }

      await new Promise(r => setTimeout(r, options.timeout));
      await browser.close();
    } catch (err) {
      logger.error(err.message);
      process.exit(1);
    }
  });

// ── test-selectors ──────────────────────────────────────────────────

program
  .command('test-selectors <symbol>')
  .description('Extract one symbol and print results (no DB write)')
  .option('--headed', 'Show browser window')
  .option('--no-login', 'Skip Stockbit login')
  .action(async (symbol, options) => {
    try {
      const config = await loadSelectors();
      const browser = await launchBrowser(options);
      const page = await browser.newPage();

      const symbolUrl = config.baseUrl.replace('{symbol}', symbol.toUpperCase())
        + (config.pageVariant ? `/${config.pageVariant}` : '');

      // Authenticate before testing selectors
      if (options.login !== false) {
        const credentials = getStockbitCredentials();
        await ensureLoggedIn(page, credentials, symbolUrl);
      } else {
        logger.info('Skipping login (--no-login)');
      }

      logger.info(`Testing selectors for ${symbol.toUpperCase()}...`);
      logger.info(`Strategy: ${config.strategy}`);

      // Skip navigation if already on symbol page (from auth check)
      if (page.url().includes(`/symbol/${symbol.toUpperCase()}`)) {
        await executePreActions(page, config.preActions || []);
      } else {
        await navigateToSymbol(page, config, symbol);
      }
      const rows = await extractData(page, config, symbol);

      if (rows.length === 0) {
        logger.warn('No data extracted. Check your CSS selectors in selectors.json.');
      } else {
        const transformed = rows.map(r => transformRow(r, config.dateFormat, config.dateMode));
        logger.info(`Extracted ${transformed.length} rows:`);
        console.log(JSON.stringify(transformed, null, 2));
      }

      await browser.close();
    } catch (err) {
      logger.error(err.message);
      process.exit(1);
    }
  });

// ── login-test ──────────────────────────────────────────────────────

program
  .command('login-test')
  .description('Test Stockbit login flow without scraping')
  .option('--headed', 'Show browser window')
  .action(async (options) => {
    try {
      const credentials = getStockbitCredentials();
      const browser = await launchBrowser({ ...options, headed: true });
      const page = await browser.newPage();

      logger.info('Testing Stockbit login...');
      await ensureLoggedIn(page, credentials);
      logger.info('Login test passed! Session is authenticated.');

      // Keep browser open briefly so user can verify
      logger.info('Browser will close in 10s...');
      await new Promise(r => setTimeout(r, 10000));
      await browser.close();
    } catch (err) {
      logger.error(`Login test failed: ${err.message}`);
      process.exit(1);
    }
  });

// ── helpers ─────────────────────────────────────────────────────────

async function resolveSymbols(options) {
  if (options.symbols) {
    return options.symbols.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  }
  if (options.file) {
    const content = await readFile(options.file, 'utf-8');
    return content.split('\n').map(s => s.trim().toUpperCase()).filter(Boolean);
  }
  return [];
}

// ── global error handler ────────────────────────────────────────────

process.on('unhandledRejection', (err) => {
  // Log but do NOT exit — during OTP verification, background promises
  // (e.g. navigation, target events) may reject and that should not kill
  // the process while the user is entering an OTP code.
  logger.error('Unhandled rejection:', err?.message || err);
});

program.parse();
