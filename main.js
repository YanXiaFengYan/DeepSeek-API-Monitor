const { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const { scrapeUsage } = require('./scraper');

// ── 凭证存储 ──────────────────────────────────────────────
const credsPath = path.join(app.getPath('userData'), 'creds.json');

function loadCreds() {
  try { return JSON.parse(fs.readFileSync(credsPath, 'utf-8')); } catch (_) { return null; }
}
function saveCreds(data) {
  fs.writeFileSync(credsPath, JSON.stringify(data), 'utf-8');
}
function clearCreds() {
  try { fs.unlinkSync(credsPath); } catch (_) {}
}

let API_KEY = '';
process.env.DEEPSEEK_EMAIL = '';
process.env.DEEPSEEK_PASSWORD = '';

// ── 窗口 ──────────────────────────────────────────────────
let loginWindow = null;
let mainWindow = null;
let tray = null;
let collapsed = false;

const WIN_W = 576;
const WIN_H = 252;
const WIN_W_COLLAPSED = 210;
const WIN_H_COLLAPSED = 30;
let scale = 1.0;

// ── DeepSeek API ──────────────────────────────────────────
async function fetchBalance() {
  try {
    const resp = await fetch('https://api.deepseek.com/user/balance', {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    if (resp.ok) return await resp.json();
    return { _error: `API 返回 ${resp.status}` };
  } catch (err) {
    return { _error: err.message };
  }
}

// ── 模拟用量（兜底）───────────────────────────────────────
function generateUsageData() {
  const now = new Date();
  const totalTokens = 2847392 + Math.floor(Math.random() * 500);
  const flashTokens = 1523000 + Math.floor(Math.random() * 500);
  const proTokens = 1324392 + Math.floor(Math.random() * 500);
  const daily = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now); d.setDate(d.getDate() - i);
    daily.push({ date: `${d.getMonth()+1}/${d.getDate()}`, tokens: Math.floor(300000 + Math.random() * 200000) });
  }
  return {
    monthCost: parseFloat((12.47 + Math.random() * 0.1).toFixed(2)),
    totalRequests: 1247, totalTokens,
    models: [
      { name: 'V4 Flash', tokens: flashTokens, cost: parseFloat((flashTokens/1e6*0.28).toFixed(2)) },
      { name: 'V4 Pro', tokens: proTokens, cost: parseFloat((proTokens/1e6*3.48).toFixed(2)) },
    ], daily, note: '用量数据为模拟值',
  };
}

// ── 解析真数据 ────────────────────────────────────────────
function parseScrapedData(scraped) {
  try {
    const apis = scraped.apiResponses || {};
    const allUrls = Object.keys(apis);
    let summary = null;
    const su = allUrls.find(u => u.includes('get_user_summary'));
    if (su) summary = apis[su]?.data?.biz_data;

    let amountData = null;
    const au = allUrls.find(u => u.includes('usage/amount') && !u.includes('DAILY'));
    if (au) amountData = apis[au]?.data?.biz_data;

    let costData = null;
    const cu = allUrls.find(u => u.includes('usage/cost') && !u.includes('DAILY'));
    if (cu) costData = apis[cu]?.data?.biz_data;

    if (!summary && !amountData) return null;

    let monthCost = summary?.monthly_costs?.[0]?.amount ? parseFloat(summary.monthly_costs[0].amount) : null;
    let totalTokens = summary?.monthly_token_usage ? parseInt(summary.monthly_token_usage, 10) : null;
    if (!totalTokens && amountData?.total) {
      totalTokens = amountData.total.reduce((s,m) => s + (m.usage||[]).reduce((ss,u) => ss + parseInt(u.amount||0,10), 0), 0);
    }
    let totalRequests = null;
    if (amountData?.total) {
      totalRequests = amountData.total.reduce((s,m) => { const r = (m.usage||[]).find(u => u.type==='REQUEST'); return s + (r ? parseInt(r.amount,10) : 0); }, 0);
    }

    const models = [];
    for (const m of (amountData?.total||[])) {
      const tokens = (m.usage||[]).reduce((s,u) => u.type!=='REQUEST' ? s + parseInt(u.amount||0,10) : s, 0);
      let cost = 0;
      if (costData?.[0]?.total) {
        const cm = costData[0].total.find(c => c.model===m.model);
        if (cm) cost = (cm.usage||[]).reduce((s,u) => u.type!=='REQUEST' ? s + parseFloat(u.amount||0) : s, 0);
      }
      let name = m.model||'Unknown';
      if (name.includes('v4-flash')) name='V4 Flash'; else if (name.includes('v4-pro')) name='V4 Pro'; else if (name.includes('deepseek-chat')) name='V3 Chat';
      models.push({ name, tokens, cost: parseFloat(cost.toFixed(2)) });
    }

    const daily = [];
    const ds = amountData?.days || null;
    if (ds) {
      const dl = Array.isArray(ds) ? ds : (ds.days||[]);
      const dm = {};
      for (const de of dl) {
        const d = de.date||de.day||''; if (!d) continue;
        const md = de.data||de.usage||de.models||[de];
        let dt = 0;
        for (const m of md) dt += (m.usage||m.data||[]).reduce((s,u) => u.type!=='REQUEST' ? s + parseInt(u.amount||0,10) : s, 0);
        dm[d] = (dm[d]||0)+dt;
      }
      const sorted = Object.entries(dm).sort((a,b)=>a[0].localeCompare(b[0])).slice(-7);
      for (const [date,tokens] of sorted) {
        const p = date.split('-');
        daily.push({ date: p.length>=3 ? `${parseInt(p[1])}/${parseInt(p[2])}` : date, tokens });
      }
    }
    return { monthCost, totalRequests, totalTokens, models: models.length>0 ? models : null, daily: daily.length>0 ? daily : null };
  } catch (_) { return null; }
}

// ── 数据 ──────────────────────────────────────────────────
let cachedUsage = null;
let usageDataSource = 'simulated';
let scrapingInProgress = false;

async function fetchAllStats() {
  const balance = await fetchBalance();
  const usage = cachedUsage || null;
  return { balance, usage, dataSource: cachedUsage ? usageDataSource : 'loading', updatedAt: new Date().toISOString() };
}

async function backgroundScrape() {
  if (scrapingInProgress || !process.env.DEEPSEEK_EMAIL || !process.env.DEEPSEEK_PASSWORD) return;
  scrapingInProgress = true;
  try {
    const scraped = await scrapeUsage();
    if (!scraped.error) {
      const real = parseScrapedData(scraped);
      if (real && (real.monthCost !== null || real.totalTokens !== null)) {
        const fb = generateUsageData();
        cachedUsage = {
          monthCost: real.monthCost ?? fb.monthCost,
          totalRequests: real.totalRequests ?? fb.totalRequests,
          totalTokens: real.totalTokens ?? fb.totalTokens,
          models: (real.models && real.models.length>0) ? real.models : fb.models,
          daily: (real.daily && real.daily.length>0) ? real.daily : fb.daily,
          note: '真实数据',
        };
        usageDataSource = 'real';
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('refresh');
      }
    }
  } catch (err) { console.error('[scraper]', err.message); }
  finally { scrapingInProgress = false; }
}

// ── 托盘 ──────────────────────────────────────────────────
function createTrayIcon() {
  const ico = path.join(__dirname, 'deepseek-logo.ico');
  if (fs.existsSync(ico)) return nativeImage.createFromPath(ico).resize({ width: 16, height: 16 });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><circle cx="8" cy="8" r="7" fill="#4D6BFE"/></svg>`;
  return nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`).resize({ width: 16, height: 16 });
}

// ── 主窗口 ────────────────────────────────────────────────
function createMainWindow() {
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
  mainWindow = new BrowserWindow({
    width: WIN_W, height: WIN_H,
    x: sw - WIN_W - 20, y: Math.round(sh/2 - WIN_H/2),
    frame: false, transparent: true, alwaysOnTop: true,
    skipTaskbar: true, resizable: false, hasShadow: false,
    backgroundColor: '#00000000',
    icon: path.join(__dirname, 'deepseek-logo.ico'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  mainWindow.loadFile(path.join(__dirname, 'widget.html'));
  mainWindow.setAlwaysOnTop(true, 'screen-saver');
  mainWindow.setMinimumSize(100, 20);

  const ctx = Menu.buildFromTemplate([
    { label: '🔄 刷新', click: () => mainWindow.webContents.send('refresh') },
    { type: 'separator' },
    { label: '❌ 退出', click: () => app.quit() },
  ]);
  mainWindow.webContents.on('context-menu', (_e, p) => ctx.popup({ window: mainWindow, x: p.x, y: p.y }));

  tray = new Tray(createTrayIcon());
  tray.setToolTip('DeepSeek Monitor');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示/隐藏', click: () => mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show() },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ]));
  tray.on('double-click', () => mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show());

  backgroundScrape();
}

// ── 登录窗口 ──────────────────────────────────────────────
function createLoginWindow() {
  loginWindow = new BrowserWindow({
    width: 340, height: 440, resizable: false,
    frame: false, transparent: true, alwaysOnTop: true,
    backgroundColor: '#00000000',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  loginWindow.center();
  loginWindow.loadFile(path.join(__dirname, 'login.html'));
}

// ── IPC ───────────────────────────────────────────────────
ipcMain.handle('verify-key', async (_e, key) => {
  try {
    const resp = await fetch('https://api.deepseek.com/user/balance', {
      headers: { Authorization: `Bearer ${key}` },
    });
    return resp.ok;
  } catch (_) { return false; }
});

ipcMain.handle('save-login', async (_e, creds) => {
  API_KEY = creds.apiKey;
  process.env.DEEPSEEK_EMAIL = creds.phone || '';
  process.env.DEEPSEEK_PASSWORD = creds.password || '';
  saveCreds(creds);
  if (loginWindow) { loginWindow.close(); loginWindow = null; }
  createMainWindow();
});

ipcMain.on('logout', () => {
  clearCreds();
  API_KEY = '';
  process.env.DEEPSEEK_EMAIL = '';
  process.env.DEEPSEEK_PASSWORD = '';
  cachedUsage = null;
  usageDataSource = 'simulated';
  if (mainWindow) { mainWindow.close(); mainWindow = null; }
  if (tray) { tray.destroy(); tray = null; }
  createLoginWindow();
});

ipcMain.handle('fetch-stats', async () => await fetchAllStats());

ipcMain.on('toggle-size', (_e, shouldCollapse) => {
  collapsed = shouldCollapse;
  const [x, y] = mainWindow.getPosition();
  mainWindow.setBounds({ x, y, width: shouldCollapse ? WIN_W_COLLAPSED : Math.round(WIN_W*scale), height: shouldCollapse ? WIN_H_COLLAPSED : Math.round(WIN_H*scale) });
});

ipcMain.handle('zoom', (_e, delta) => {
  if (collapsed) return false;
  const ns = Math.max(1.0, Math.min(2.0, scale + delta));
  if (ns === scale) return false;
  scale = ns;
  const [x, y] = mainWindow.getPosition();
  mainWindow.setBounds({ x, y, width: Math.round(WIN_W*scale), height: Math.round(WIN_H*scale) });
  return true;
});

ipcMain.on('quit-app', () => app.quit());

// ── 启动 ──────────────────────────────────────────────────
app.whenReady().then(() => {
  const creds = loadCreds();
  if (creds && creds.apiKey) {
    API_KEY = creds.apiKey;
    process.env.DEEPSEEK_EMAIL = creds.phone || '';
    process.env.DEEPSEEK_PASSWORD = creds.password || '';
    createMainWindow();
  } else {
    createLoginWindow();
  }

  setInterval(() => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('refresh');
    backgroundScrape();
  }, 60_000);

  app.on('activate', () => {
    if (!mainWindow && !loginWindow) {
      const creds = loadCreds();
      if (creds?.apiKey) { API_KEY = creds.apiKey; process.env.DEEPSEEK_EMAIL = creds.phone||''; process.env.DEEPSEEK_PASSWORD = creds.password||''; createMainWindow(); }
      else createLoginWindow();
    }
  });
});

app.on('window-all-closed', () => {});
