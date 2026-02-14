import { EventEmitter } from 'node:events';
import { loadSelectors } from './config.js';
import { launchBrowser, navigateToSymbol, executePreActions } from './browser.js';
import { ensureLoggedIn } from './auth.js';
import { getStockbitCredentials } from './config.js';
import { extractData } from './extractor.js';
import { upsertRows } from './store.js';
import { logger } from './logger.js';

export class ScrapeJob extends EventEmitter {
  constructor() {
    super();
    this.state = 'idle';
    this.symbols = [];
    this.completed = 0;
    this.total = 0;
    this.currentSymbol = null;
    this.failed = [];
    this.totalInserted = 0;
    this.lastRun = null;
    this._startTime = null;
  }

  isRunning() {
    return this.state === 'running';
  }

  getStatus() {
    return {
      state: this.state,
      currentSymbol: this.currentSymbol,
      completed: this.completed,
      total: this.total,
      failed: [...this.failed],
      totalInserted: this.totalInserted,
      lastRun: this.lastRun,
    };
  }

  async start(symbols) {
    if (this.isRunning()) throw new Error('Job already running');

    this.state = 'running';
    this.symbols = symbols;
    this.completed = 0;
    this.total = symbols.length;
    this.currentSymbol = null;
    this.failed = [];
    this.totalInserted = 0;
    this._startTime = Date.now();

    // Run async — don't block the HTTP response
    this._run().catch(err => {
      this.state = 'error';
      this.currentSymbol = null;
      this.emit('error', { state: 'error', message: err.message });
      logger.error(`Scrape job crashed: ${err.message}`);
    });
  }

  async _run() {
    let browser;
    try {
      const config = await loadSelectors();
      browser = await launchBrowser({ headed: true });
      const page = await browser.newPage();

      // Authenticate: try cookies first, fallback to login form + OTP
      const firstSymbolUrl = config.baseUrl.replace('{symbol}', this.symbols[0])
        + (config.pageVariant ? `/${config.pageVariant}` : '');
      const credentials = getStockbitCredentials();

      this.emit('status', {
        state: 'running',
        message: 'Authenticating...',
        completed: 0,
        total: this.total,
      });

      await ensureLoggedIn(page, credentials, firstSymbolUrl);

      this.emit('status', {
        state: 'running',
        message: 'Authenticated, starting scrape...',
        completed: 0,
        total: this.total,
      });

      for (let i = 0; i < this.symbols.length; i++) {
        const symbol = this.symbols[i];
        this.currentSymbol = symbol;

        this.emit('status', {
          state: 'running',
          currentSymbol: symbol,
          completed: this.completed,
          total: this.total,
          message: `Processing ${symbol}... (${i + 1}/${this.total})`,
        });

        try {
          if (page.url().includes(`/symbol/${symbol.toUpperCase()}`)) {
            await executePreActions(page, config.preActions || []);
          } else {
            await navigateToSymbol(page, config, symbol);
          }

          const rows = await extractData(page, config, symbol);
          if (rows.length === 0) {
            this.failed.push(symbol);
            this.emit('symbol-error', {
              symbol, error: 'No data extracted',
              completed: this.completed + 1, total: this.total,
            });
          } else {
            const { inserted, errors } = await upsertRows(rows, config.dateFormat, config.dateMode, config.numberLocale);
            this.totalInserted += inserted;
            this.emit('symbol-done', {
              symbol, rows: inserted,
              completed: this.completed + 1, total: this.total,
            });
            if (errors.length > 0) {
              logger.warn(`${symbol}: ${errors.length} batch errors during upsert`);
            }
          }
        } catch (err) {
          this.failed.push(symbol);
          this.emit('symbol-error', {
            symbol, error: err.message,
            completed: this.completed + 1, total: this.total,
          });
          logger.error(`${symbol}: ${err.message}`);
        }

        this.completed++;

        // Delay between symbols
        if (i < this.symbols.length - 1) {
          await new Promise(r => setTimeout(r, 2000));
        }
      }

      await browser.close();
      browser = null;

      this.state = 'idle';
      this.currentSymbol = null;
      this.lastRun = new Date().toISOString();
      const elapsed = Date.now() - this._startTime;

      this.emit('done', {
        state: 'idle',
        totalInserted: this.totalInserted,
        failed: [...this.failed],
        elapsed,
      });

    } catch (err) {
      if (browser) {
        try { await browser.close(); } catch { /* ignore */ }
      }
      this.state = 'error';
      this.currentSymbol = null;
      throw err;
    }
  }
}
