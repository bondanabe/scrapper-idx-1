import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { logger } from './logger.js';

const LOGIN_URL = 'https://stockbit.com/login';
const COOKIES_PATH = resolve(process.cwd(), 'cookies.json');

// Maximum wait time per verification step (5 minutes per OTP step)
const VERIFICATION_TIMEOUT_SEC = 300;

/**
 * Attempt to restore cookies from a previous session.
 * Returns true if cookies were loaded, false otherwise.
 */
export async function tryLoadCookies(page) {
  try {
    const raw = await readFile(COOKIES_PATH, 'utf-8');
    const cookies = JSON.parse(raw);
    if (!Array.isArray(cookies) || cookies.length === 0) return false;

    // Filter out expired cookies
    const now = Date.now() / 1000;
    const valid = cookies.filter(c => !c.expires || c.expires > now);
    if (valid.length === 0) return false;

    await page.setCookie(...valid);
    logger.info(`Loaded ${valid.length} cookies from cache`);
    return true;
  } catch {
    logger.debug('No cached cookies found');
    return false;
  }
}

/**
 * Save current page cookies to disk for reuse.
 */
export async function saveCookies(page) {
  try {
    // Get cookies for all Stockbit domains (not just current page URL)
    const cookies = await page.cookies(
      'https://stockbit.com',
      'https://www.stockbit.com',
      'https://api.stockbit.com',
    );
    await writeFile(COOKIES_PATH, JSON.stringify(cookies, null, 2), 'utf-8');
    logger.debug(`Saved ${cookies.length} cookies to ${COOKIES_PATH}`);
  } catch (err) {
    logger.warn(`Failed to save cookies: ${err.message}`);
  }
}

/**
 * Check if the current page/session is logged in.
 * Navigates to a symbol page and checks for logged-in indicators.
 */
export async function isLoggedIn(page, checkUrl) {
  try {
    // Navigate to a known page to check session
    const currentUrl = page.url();
    if (!currentUrl || currentUrl === 'about:blank') {
      const targetUrl = checkUrl || 'https://stockbit.com/symbol/BBCA';
      await page.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      );
      await page.goto(targetUrl, {
        waitUntil: 'networkidle2',
        timeout: 60000,
      });
    }

    // Wait a bit for dynamic content
    await new Promise(r => setTimeout(r, 2000));

    // Check 1 (most reliable): URL-based — if redirected to /login, definitely not logged in
    const finalUrl = page.url();
    if (finalUrl.includes('/login') || finalUrl.includes('/register') || finalUrl.includes('/signin')) {
      logger.debug('Login check: redirected to login page → not logged in');
      return false;
    }

    // Check 2: DOM-based — look for logged-in indicators
    const loggedIn = await page.evaluate(() => {
      // Positive signals: avatar, profile elements, or user menu
      const avatarSelectors = [
        '[class*="avatar"]', '[class*="Avatar"]',
        '[class*="UserMenu"]', '[class*="user-menu"]',
        '[class*="profile-pic"]', '[class*="ProfilePic"]',
      ];
      for (const sel of avatarSelectors) {
        if (document.querySelector(sel)) return true;
      }

      // Negative signals: login/register buttons or forms anywhere on page
      const allLinks = Array.from(document.querySelectorAll('a, button'));
      const hasLoginButton = allLinks.some(el => {
        const text = (el.textContent || '').trim().toLowerCase();
        return text === 'login' || text === 'masuk' || text === 'register' || text === 'daftar';
      });

      // Check for login form
      const hasLoginForm = document.querySelector('input[type="password"]') !== null;

      if (hasLoginButton || hasLoginForm) return false;

      return true;
    });

    logger.debug(`Login check: ${loggedIn ? 'logged in' : 'not logged in'} (url: ${finalUrl})`);
    return loggedIn;
  } catch (err) {
    logger.warn(`Login check failed: ${err.message}`);
    return false;
  }
}

// ── Multi-step verification helpers ─────────────────────────────────

/**
 * Scan the page DOM to detect if it's a verification/OTP page.
 * Returns an object describing what was found, or null if no verification UI detected.
 */
async function detectVerificationUI(page) {
  await new Promise(r => setTimeout(r, 1000));

  return page.evaluate(() => {
    const bodyText = document.body.innerText.toLowerCase();
    const url = window.location.href;

    // Check for OTP input fields (most reliable signal)
    const otpInputs = document.querySelectorAll(
      'input[type="tel"], input[type="number"], input[inputmode="numeric"], ' +
      'input[maxlength="1"], input[maxlength="4"], input[maxlength="6"], ' +
      'input[autocomplete="one-time-code"]'
    );
    const hasOTPInput = otpInputs.length > 0;

    // Check for verification keywords (tighter matching — no bare "code")
    const hasVerificationText =
      bodyText.includes('verif') ||
      bodyText.includes('otp') ||
      bodyText.includes('kode verifikasi') ||
      bodyText.includes('verification code') ||
      bodyText.includes('masukkan kode') ||
      bodyText.includes('enter code') ||
      bodyText.includes('enter the code');

    // Check URL patterns
    const hasVerificationUrl =
      url.includes('/verification') ||
      url.includes('/otp') ||
      url.includes('/2fa') ||
      url.includes('/verify');

    // Must have OTP input OR (verification text + verification URL)
    if (!hasOTPInput && !hasVerificationText && !hasVerificationUrl) {
      return null;
    }

    // Need at least OTP input OR verification URL to be confident
    if (!hasOTPInput && !hasVerificationUrl) {
      return null;
    }

    // Determine OTP type
    const hasWhatsApp = bodyText.includes('whatsapp') || bodyText.includes('wa ');
    const hasEmail = bodyText.includes('email') && hasVerificationText;
    const hasPhone = bodyText.includes('phone') || bodyText.includes('sms') || bodyText.includes('telepon');

    let type = 'generic';
    if (hasWhatsApp) type = 'whatsapp';
    else if (hasEmail) type = 'email';
    else if (hasPhone) type = 'phone';

    return {
      type,
      hasOTPInput,
      url,
      snippet: document.body.innerText.substring(0, 500).replace(/\s+/g, ' ').trim(),
    };
  }).catch(() => null);
}

/**
 * Wait for a single verification step to complete.
 * Uses OTP type tracking instead of content snapshots (immune to countdown timers).
 * When OTP UI disappears, retries 3x with 3s intervals before confirming completion.
 */
async function waitForVerificationStep(page, stepName, timeoutSec) {
  const maxWait = timeoutSec * 1000;
  const pollInterval = 2000;
  let elapsed = 0;

  // Capture initial OTP type for this step
  const initialState = await detectVerificationUI(page);
  const initialType = initialState?.type || 'generic';

  logger.debug(`${stepName}: initial type="${initialType}", polling every ${pollInterval}ms`);

  while (elapsed < maxWait) {
    await new Promise(r => setTimeout(r, pollInterval));
    elapsed += pollInterval;

    const currentState = await detectVerificationUI(page);

    // Case 1: OTP UI disappeared — might be loading transition or truly done
    if (!currentState) {
      logger.debug(`${stepName}: OTP UI disappeared, verifying with retries...`);
      let confirmed = true;

      for (let retry = 1; retry <= 3; retry++) {
        await new Promise(r => setTimeout(r, 3000));
        const recheck = await detectVerificationUI(page);

        if (recheck) {
          // OTP UI came back
          if (recheck.type !== initialType) {
            // New OTP step appeared (e.g. email → whatsapp)
            logger.info(`${stepName}: Completed → next step detected (${recheck.type})`);
            return;
          }
          // Same type re-appeared — was just a brief flicker
          logger.debug(`${stepName}: OTP UI re-appeared (retry ${retry}), continuing...`);
          confirmed = false;
          break;
        }
        logger.debug(`${stepName}: Retry ${retry}/3 — still no OTP UI`);
      }

      if (confirmed) {
        logger.info(`${stepName}: Completed (no verification UI after 3 retries)`);
        return;
      }
      continue; // OTP UI came back, keep polling
    }

    // Case 2: OTP type changed → current step done, next step started
    if (currentState.type !== initialType) {
      logger.info(`${stepName}: Completed → next step: ${currentState.type}`);
      return;
    }

    // Case 3: Same OTP type → user hasn't entered code yet, keep waiting
    if (elapsed % 30000 === 0) {
      logger.info(`${stepName}: Still waiting... (${elapsed / 1000}s elapsed)`);
    }
  }

  throw new Error(`${stepName}: Timeout — code was not entered within ${timeoutSec} seconds`);
}

/**
 * Handle multi-step verification after login.
 *
 * Stockbit login flow:
 *   1. Email + Password → submit
 *   2. Email OTP verification (manual input)
 *   3. WhatsApp OTP verification (manual input)
 *   4. Redirected to dashboard/home
 *
 * Detection is DOM-based (checks for OTP input fields & verification text)
 * rather than URL-based, so it works even when Stockbit doesn't change the URL.
 */
async function handleVerificationSteps(page) {
  let step = 1;
  const maxSteps = 5;

  while (step <= maxSteps) {
    const verification = await detectVerificationUI(page);

    // No verification UI found → we're authenticated
    if (!verification) {
      if (step > 1) {
        logger.info('All verification steps completed successfully');
      }
      return;
    }

    const typeLabels = {
      whatsapp: 'WhatsApp OTP',
      email: 'Email OTP',
      phone: 'Phone/SMS OTP',
      generic: 'Verification',
    };
    const stepName = `Step ${step}: ${typeLabels[verification.type] || 'Verification'}`;

    logger.warn('══════════════════════════════════════════════════════');
    logger.warn(`${stepName}: Manual input required in the browser window`);
    logger.warn('══════════════════════════════════════════════════════');

    await waitForVerificationStep(page, stepName, VERIFICATION_TIMEOUT_SEC);
    step++;
  }

  // Final safety check
  const finalCheck = await detectVerificationUI(page);
  if (finalCheck) {
    throw new Error(`Verification incomplete after ${maxSteps} steps.`);
  }
}

/**
 * Login to Stockbit using email and password.
 */
export async function loginToStockbit(page, credentials) {
  const { email, password } = credentials;

  logger.info('Navigating to Stockbit login page...');
  await page.goto(LOGIN_URL, { waitUntil: 'networkidle2', timeout: 60000 });

  // Wait for the login form to be ready
  await new Promise(r => setTimeout(r, 2000));

  // Find and fill email input
  logger.debug('Filling email...');
  const emailFilled = await page.evaluate(() => {
    const inputs = Array.from(document.querySelectorAll('input'));
    const emailInput = inputs.find(i =>
      i.type === 'email' ||
      i.name === 'username' ||
      i.name === 'email' ||
      (i.placeholder && (i.placeholder.toLowerCase().includes('email') || i.placeholder.toLowerCase().includes('username')))
    );
    if (emailInput) {
      emailInput.focus();
      return true;
    }
    return false;
  });

  if (!emailFilled) {
    throw new Error('Could not find email input on login page');
  }

  // Type email using keyboard (more reliable than page.type with selector)
  await page.keyboard.type(email, { delay: 50 });

  // Tab to password field or click it directly
  logger.debug('Filling password...');
  const passwordFilled = await page.evaluate(() => {
    const inputs = Array.from(document.querySelectorAll('input'));
    const pwInput = inputs.find(i =>
      i.type === 'password' ||
      i.name === 'password' ||
      (i.placeholder && i.placeholder.toLowerCase().includes('password'))
    );
    if (pwInput) {
      pwInput.focus();
      return true;
    }
    return false;
  });

  if (!passwordFilled) {
    throw new Error('Could not find password input on login page');
  }

  await page.keyboard.type(password, { delay: 50 });

  // Find and click login button
  logger.debug('Clicking login button...');
  const loginClicked = await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button'));
    const loginBtn = buttons.find(b => {
      const text = (b.textContent || '').trim().toLowerCase();
      return text === 'login' || text === 'log in' || text === 'masuk' || text === 'sign in';
    });
    if (loginBtn) {
      loginBtn.click();
      return true;
    }
    // Fallback: submit button
    const submitBtn = document.querySelector('button[type="submit"]');
    if (submitBtn) {
      submitBtn.click();
      return true;
    }
    return false;
  });

  if (!loginClicked) {
    throw new Error('Could not find login button');
  }

  // Wait for navigation after login
  logger.info('Waiting for login response...');
  try {
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 });
  } catch {
    // Navigation might not trigger if SPA routing — wait and check
    await new Promise(r => setTimeout(r, 5000));
  }

  // Handle multi-step verification (Email OTP → WhatsApp OTP → etc.)
  await handleVerificationSteps(page);

  // Final check: verify login succeeded
  const currentUrl = page.url();
  if (currentUrl.includes('/login')) {
    // Still on login page — check for error messages
    const errorMsg = await page.evaluate(() => {
      const errorEls = document.querySelectorAll('[class*="error"], [class*="Error"], [role="alert"], .alert');
      for (const el of errorEls) {
        const text = el.textContent.trim();
        if (text) return text;
      }
      return null;
    });
    throw new Error(`Login failed${errorMsg ? `: ${errorMsg}` : ' — still on login page'}`);
  }

  logger.info('Login successful');
  await saveCookies(page);
  return true;
}

/**
 * Ensure the page has an authenticated session.
 * Tries cookies first, then falls back to login form.
 */
export async function ensureLoggedIn(page, credentials, checkUrl) {
  // Step 1: Try loading cached cookies
  const cookiesLoaded = await tryLoadCookies(page);

  if (cookiesLoaded) {
    // Navigate to check if session is valid
    const valid = await isLoggedIn(page, checkUrl);
    if (valid) {
      logger.info('Authenticated via cached cookies');
      return;
    }
    logger.info('Cached cookies expired, performing fresh login...');
  }

  // Step 2: Login via form
  await loginToStockbit(page, credentials);
}
