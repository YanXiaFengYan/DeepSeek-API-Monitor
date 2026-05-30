const puppeteer = require('puppeteer');
const path = require('path');
try { require('dotenv').config({ path: path.join(__dirname, '.env') }); } catch (_) {}

let cachedData = null;
let lastFetchTime = 0;
const CACHE_TTL = 10 * 60 * 1000;

async function scrapeUsage() {
  if (cachedData && Date.now() - lastFetchTime < CACHE_TTL) {
    return { ...cachedData, fromCache: true };
  }

  const phone = process.env.DEEPSEEK_EMAIL;
  const password = process.env.DEEPSEEK_PASSWORD;
  if (!phone || !password) {
    return { error: true, reason: '未配置 DEEPSEEK_EMAIL / DEEPSEEK_PASSWORD' };
  }

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'],
    });
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1366, height: 900 });
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      window.chrome = { runtime: {} };
    });

    // 拦截所有 API 响应
    const apiResponses = {};
    page.on('response', async (response) => {
      const url = response.url();
      try {
        const ct = response.headers()['content-type'] || '';
        if (ct.includes('json')) {
          const json = await response.json();
          // 只保留有用的 API
          if (/usage|billing|summary|login|current/i.test(url)) {
            apiResponses[url] = json;
          }
        }
      } catch (_) {}
    });

    // ── 登录 ─────────────────────────────────────────
    console.log('[scraper] 登录中...');
    await page.goto('https://platform.deepseek.com/sign_in', { waitUntil: 'networkidle0', timeout: 30000 });
    await new Promise(r => setTimeout(r, 4000));

    // 点"密码登录"
    const pwBtn = await page.evaluateHandle(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      return btns.find(b => b.textContent.trim() === '密码登录' && b.offsetHeight > 0) || null;
    });
    if (pwBtn) { await pwBtn.asElement().click(); await new Promise(r => setTimeout(r, 2000)); }

    // 填表
    const accountSel = 'input[placeholder*="手机号"], input[placeholder*="邮箱"], input[type="text"]:not([readonly])';
    await page.type(accountSel, phone, { delay: 50 });
    const pwFields = await page.$$('input[type="password"]');
    if (pwFields.length > 0) await pwFields[0].type(password, { delay: 50 });

    // 点登录
    const loginBtn2 = await page.evaluateHandle(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      return btns.find(b => b.textContent.trim() === '登录' && b.type === 'submit' && b.offsetHeight > 0) || null;
    });
    if (loginBtn2) await loginBtn2.asElement().click();

    await new Promise(r => setTimeout(r, 8000));

    // 检查是否登录成功
    if (page.url().includes('sign_in')) {
      await new Promise(r => setTimeout(r, 5000));
    }
    console.log('[scraper] 登录后URL:', page.url());

    // ── 跳转用量页 ────────────────────────────────────
    await page.goto('https://platform.deepseek.com/usage', { waitUntil: 'networkidle0', timeout: 30000 });
    await new Promise(r => setTimeout(r, 8000));

    // 用量页面已自带 days 数组，无需额外请求
    const now = new Date();
    const month = now.getMonth() + 1;
    const year = now.getFullYear();

    await browser.close();
    browser = null;

    const result = {
      error: false, fromCache: false,
      scrapedAt: new Date().toISOString(),
      apiResponses,
      month, year,
    };

    cachedData = result;
    lastFetchTime = Date.now();
    return result;

  } catch (err) {
    console.error('[scraper] 异常:', err.message);
    return { error: true, reason: err.message };
  } finally {
    if (browser) { try { await browser.close(); } catch (_) {} }
  }
}

module.exports = { scrapeUsage };
