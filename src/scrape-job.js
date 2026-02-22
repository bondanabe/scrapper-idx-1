import { EventEmitter } from 'node:events';
import { loadSelectors } from './config.js';
import { launchBrowser, navigateToSymbol, executePreActions } from './browser.js';
import { ensureLoggedIn } from './auth.js';
import { getStockbitCredentials } from './config.js';
import { extractData } from './extractor.js';
import { upsertRows } from './store.js';
import { ensureDaily, changeSymbolTV, ensureLoggedInTV } from './tradingview.js';
import { getTradingViewCredentials } from './config.js';
import { logger } from './logger.js';

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms)
    ),
  ]);
}

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
    this._aborted = false;
    this._browser = null;
    this._logs = [];
    this._lastOHLCV = null;
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

  _addLog(message, level = '') {
    this._logs.push({ ts: new Date().toISOString(), message, level });
    if (this._logs.length > 500) this._logs.shift();
  }

  getLogs() {
    return [...this._logs];
  }

  abort() {
    if (this.state !== 'running') return;
    this._aborted = true;
    logger.info('Scrape job abort requested');
    if (this._browser) {
      this._browser.close().catch(() => {});
    }
  }

  async start(symbols, customDate, source = 'stockbit') {
    if (this.isRunning()) throw new Error('Job already running');

    this._aborted = false;
    this.state = 'running';
    this.symbols = symbols;
    this.customDate = customDate || null;
    this.source = source;
    this.completed = 0;
    this.total = symbols.length;
    this.currentSymbol = null;
    this.failed = [];
    this.totalInserted = 0;
    this._startTime = Date.now();
    this._logs = [];
    this._lastOHLCV = null;

    // Run async — don't block the HTTP response
    this._run().catch(err => {
      this.state = 'error';
      this.currentSymbol = null;
      this._addLog(`Job crashed: ${err.message}`, 'error');
      this.emit('error', { state: 'error', message: err.message });
      logger.error(`Scrape job crashed: ${err.message}`);
    });
  }

  async _run() {
    let browser;
    try {
      const config = await loadSelectors(this.source);
      const headed = process.env.NODE_ENV !== 'production';
      browser = await launchBrowser({ headed });
      this._browser = browser;
      let page = await browser.newPage();

      this._addLog(`Initializing (${this.source})...`);
      this.emit('status', {
        state: 'running',
        message: `Initializing (${this.source})...`,
        completed: 0,
        total: this.total,
      });

      // Prepare credentials before the loop so they're available for re-auth
      const tvCredentials = this.source === 'tradingview' ? getTradingViewCredentials() : null;
      const credentials = this.source !== 'tradingview' ? getStockbitCredentials() : null;

      // ── Source-specific initialization ──
      if (this.source === 'tradingview') {
        this._addLog('Authenticating to TradingView...');
        this.emit('status', {
          state: 'running',
          message: 'Authenticating to TradingView...',
          completed: 0,
          total: this.total,
        });

        await ensureLoggedInTV(page, tvCredentials, config.baseUrl);
        await ensureDaily(page);
      } else {
        const firstSymbolUrl = config.baseUrl.replace('{symbol}', this.symbols[0])
          + (config.pageVariant ? `/${config.pageVariant}` : '');

        this._addLog('Authenticating...');
        this.emit('status', {
          state: 'running',
          message: 'Authenticating...',
          completed: 0,
          total: this.total,
        });

        await ensureLoggedIn(page, credentials, firstSymbolUrl);
      }

      this._addLog('Ready, starting scrape...');
      this.emit('status', {
        state: 'running',
        message: 'Ready, starting scrape...',
        completed: 0,
        total: this.total,
      });

      // ── Symbol loop ──
      for (let i = 0; i < this.symbols.length; i++) {
        if (this._aborted) break;

        const symbol = this.symbols[i];
        this.currentSymbol = symbol;

        this._addLog(`Processing ${symbol}... (${i + 1}/${this.total})`);
        this.emit('status', {
          state: 'running',
          currentSymbol: symbol,
          completed: this.completed,
          total: this.total,
          message: `Processing ${symbol}... (${i + 1}/${this.total})`,
        });

        try {
          await withTimeout((async () => {
            // ── Navigate to symbol ──
            const symbolUrl = config.baseUrl.replace('{symbol}', symbol.toUpperCase())
              + (config.pageVariant ? `/${config.pageVariant}` : '');

            if (this.source === 'tradingview') {
              await changeSymbolTV(page, symbol, config['chart-header'] || {});
            } else {
              await navigateToSymbol(page, config, symbol);
              // Verify URL contains the correct symbol
              const currentUrl = page.url();
              if (!currentUrl.includes(`/symbol/${symbol.toUpperCase()}`)) {
                logger.warn(`${symbol}: URL mismatch (${currentUrl}) — retrying navigation`);
                await page.goto(symbolUrl, { waitUntil: 'networkidle2', timeout: 60000 });
                await executePreActions(page, config.preActions || []);
              }
            }

            // ── Extract data ──
            let rows = await extractData(page, config, symbol);

            // ── Duplicate detection — stale page guard ──
            if (rows.length > 0 && this._lastOHLCV) {
              const r = rows[0];
              const key = `${r.open}|${r.high}|${r.low}|${r.close}|${r.volume}`;
              if (key === this._lastOHLCV) {
                logger.warn(`${symbol}: data identical to previous symbol — retrying`);
                this._addLog(`${symbol}: stale data detected, retrying...`, 'warn');

                if (this.source === 'tradingview') {
                  // Re-do symbol change via search dialog
                  await changeSymbolTV(page, symbol, config['chart-header'] || {});
                } else {
                  // Stockbit: hard reload page
                  await page.goto(symbolUrl, { waitUntil: 'networkidle2', timeout: 60000 });
                  await new Promise(r => setTimeout(r, 5000));
                  if (config.preActions) await executePreActions(page, config.preActions);
                }
                rows = await extractData(page, config, symbol);

                // Check again after retry
                if (rows.length > 0) {
                  const r2 = rows[0];
                  const key2 = `${r2.open}|${r2.high}|${r2.low}|${r2.close}|${r2.volume}`;
                  if (key2 === this._lastOHLCV) {
                    // Data still identical — verify if chart shows correct symbol
                    // Two illiquid stocks CAN have the same OHLCV legitimately
                    let symbolVerified = false;
                    if (this.source === 'tradingview') {
                      symbolVerified = await page.evaluate((sym) => {
                        const btn = document.querySelector('#header-toolbar-symbol-search');
                        return btn && btn.textContent.toUpperCase().includes(sym.toUpperCase());
                      }, symbol);
                    }
                    if (symbolVerified) {
                      logger.info(`${symbol}: OHLCV same as previous but symbol verified — accepting data`);
                      this._addLog(`${symbol}: same OHLCV as previous (legitimate)`, 'warn');
                      // Fall through to upsert below
                    } else {
                      this.failed.push(symbol);
                      this._addLog(`${symbol}: FAILED - Stale data after retry`, 'error');
                      this.emit('symbol-error', {
                        symbol, error: 'Stale data (identical to previous symbol)',
                        completed: this.completed + 1, total: this.total,
                      });
                      return; // skip upsert
                    }
                  }
                }
              }
            }

            if (rows.length === 0) {
              this.failed.push(symbol);
              this._addLog(`${symbol}: FAILED - No data extracted`, 'error');
              this.emit('symbol-error', {
                symbol, error: 'No data extracted',
                completed: this.completed + 1, total: this.total,
              });
            } else {
              // Update last OHLCV fingerprint
              const r = rows[0];
              this._lastOHLCV = `${r.open}|${r.high}|${r.low}|${r.close}|${r.volume}`;

              const { inserted, errors } = await upsertRows(rows, config.dateFormat, config.dateMode, config.numberLocale, this.customDate);
              this.totalInserted += inserted;
              this._addLog(`${symbol}: ${inserted} row(s) saved`, 'success');
              this.emit('symbol-done', {
                symbol, rows: inserted,
                completed: this.completed + 1, total: this.total,
              });
              if (errors.length > 0) {
                logger.warn(`${symbol}: ${errors.length} batch errors during upsert`);
              }
            }
          })(), 90_000, symbol);
        } catch (err) {
          this.failed.push(symbol);
          this._addLog(`${symbol}: FAILED - ${err.message}`, 'error');
          this.emit('symbol-error', {
            symbol, error: err.message,
            completed: this.completed + 1, total: this.total,
          });
          logger.error(`${symbol}: ${err.message}`);

          // After protocol/timeout errors the page may be in a broken state.
          if (err.message.includes('timed out') || err.message.includes('Protocol') || err.message.includes('detached')) {
            // If browser disconnected entirely, relaunch and re-authenticate
            if (!browser.connected) {
              logger.warn('Browser disconnected — relaunching...');
              try {
                browser = await launchBrowser({ headed });
                this._browser = browser;
                page = await browser.newPage();
                if (this.source === 'tradingview') {
                  await ensureLoggedInTV(page, tvCredentials, config.baseUrl);
                  await ensureDaily(page);
                } else {
                  const nextSymbol = this.symbols[i + 1] || symbol;
                  const reAuthUrl = config.baseUrl.replace('{symbol}', nextSymbol)
                    + (config.pageVariant ? `/${config.pageVariant}` : '');
                  await ensureLoggedIn(page, credentials, reAuthUrl);
                }
              } catch (relaunchErr) {
                logger.error(`Failed to relaunch browser: ${relaunchErr.message}`);
              }
            } else {
              // Browser still alive — just reset the page
              try {
                await page.goto('about:blank', { timeout: 10000 });
                await new Promise(r => setTimeout(r, 1000));
                if (this.source === 'tradingview') {
                  await page.goto(config.baseUrl, { waitUntil: 'networkidle2', timeout: 60000 });
                  await new Promise(r => setTimeout(r, 3000));
                }
              } catch {
                logger.warn('Failed to reset page after timeout — continuing anyway');
              }
            }
          }
        }

        this.completed++;

        // Delay between symbols
        if (i < this.symbols.length - 1) {
          await new Promise(r => setTimeout(r, 2000));
        }
      }

      try { await browser.close(); } catch { /* ignore */ }
      browser = null;
      this._browser = null;

      this.currentSymbol = null;
      this.lastRun = new Date().toISOString();
      const elapsed = Date.now() - this._startTime;

      if (this._aborted) {
        this.state = 'idle';
        this._addLog(`Cancelled after ${this.completed}/${this.total} symbols (${Math.round(elapsed / 1000)}s)`, 'warn');
        this.emit('cancelled', {
          state: 'idle',
          message: `Cancelled after ${this.completed}/${this.total} symbols`,
          completed: this.completed,
          total: this.total,
          totalInserted: this.totalInserted,
          elapsed,
        });
        logger.info(`Scrape job cancelled (${this.completed}/${this.total} done)`);
      } else {
        this.state = 'idle';
        this._addLog(`Completed: ${this.totalInserted} rows inserted, ${this.failed.length} failed (${Math.round(elapsed / 1000)}s)`, 'success');
        this.emit('done', {
          state: 'idle',
          totalInserted: this.totalInserted,
          failed: [...this.failed],
          elapsed,
        });
      }

    } catch (err) {
      if (browser) {
        try { await browser.close(); } catch { /* ignore */ }
      }
      this._browser = null;
      this.state = 'error';
      this.currentSymbol = null;
      throw err;
    }
  }
}
