const express = require('express');
const path = require('path');
const fs = require('fs');

// ── 加载 .env ──────────────────────────────────────────────
try {
  require('dotenv').config({ path: path.join(__dirname, '.env') });
} catch (_) {
  // dotenv 未安装时跳过，下面会提示
}

// ── 解析命令行参数 ──────────────────────────────────────────
function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--key' && args[i + 1]) {
      opts.apiKey = args[++i];
    } else if (args[i] === '--port' && args[i + 1]) {
      opts.port = parseInt(args[++i], 10);
    } else if (args[i].startsWith('--key=')) {
      opts.apiKey = args[i].slice(6);
    }
  }
  return opts;
}

const cli = parseArgs();

// API Key 优先级：命令行参数 > 环境变量 > .env 文件
const API_KEY = cli.apiKey || process.env.DEEPSEEK_API_KEY || '';
const PORT = cli.port || process.env.PORT || 3000;

if (!API_KEY) {
  console.error('❌ 未提供 DeepSeek API Key。请通过以下方式之一传入：');
  console.error('  1. 命令行: node server.js --key sk-xxxxxx');
  console.error('  2. .env 文件: 在 .env 中写入 DEEPSEEK_API_KEY=sk-xxxxxx');
  console.error('  3. 环境变量: set DEEPSEEK_API_KEY=sk-xxxxxx && node server.js');
  process.exit(1);
}

// ── 模拟用量数据（DeepSeek 暂无公开用量 API）────────────────
// 实际使用时每次刷新会略微波动，模拟真实感
function generateUsageData() {
  const now = new Date();
  const monthTotal = 12.47 + Math.random() * 0.1;          // 本月消费 ~$12.50
  const totalRequests = 1247 + Math.floor(Math.random() * 5); // 总请求数
  const totalTokens = 2847392 + Math.floor(Math.random() * 1000);

  // 各模型明细
  const flashTokens = 1523000 + Math.floor(Math.random() * 500);
  const proTokens = 1324392 + Math.floor(Math.random() * 500);
  // V4 Flash: $0.14/1M input, $0.28/1M output → 粗略按 $0.28/1M 混合价估算
  const flashCost = (flashTokens / 1_000_000) * 0.28;
  // V4 Pro: $1.74/1M input, $3.48/1M output → 粗略按 $3.48/1M 混合价估算
  const proCost = (proTokens / 1_000_000) * 3.48;

  // 近 7 天每日 Token 消耗（模拟）
  const daily = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const label = `${d.getMonth() + 1}/${d.getDate()}`;
    const base = 300000 + Math.random() * 200000;
    // 今天还没过完，少一点
    const tokens = i === 0 ? Math.floor(base * 0.7) : Math.floor(base);
    daily.push({ date: label, tokens });
  }

  return {
    monthCost: parseFloat(monthTotal.toFixed(2)),
    totalRequests,
    totalTokens,
    models: [
      {
        name: 'V4 Flash',
        tokens: flashTokens,
        cost: parseFloat(flashCost.toFixed(2)),
      },
      {
        name: 'V4 Pro',
        tokens: proTokens,
        cost: parseFloat(proCost.toFixed(2)),
      },
    ],
    daily,
  };
}

// ── Express 应用 ────────────────────────────────────────────
const app = express();

// 静态文件
app.use(express.static(path.join(__dirname, 'public')));

// API: 获取统计数据
app.get('/api/stats', async (req, res) => {
  try {
    // 1. 调用 DeepSeek 余额 API（真实数据）
    let balance = null;
    let balanceError = null;

    try {
      const resp = await fetch('https://api.deepseek.com/user/balance', {
        headers: { Authorization: `Bearer ${API_KEY}` },
      });
      if (resp.ok) {
        balance = await resp.json();
      } else {
        balanceError = `API 返回 ${resp.status}: ${resp.statusText}`;
      }
    } catch (err) {
      balanceError = err.message;
    }

    // 2. 模拟用量数据
    const usage = generateUsageData();

    res.json({
      balance,
      balanceError,
      usage,
      updatedAt: new Date().toISOString(),
      note: '用量数据为模拟值（DeepSeek 暂无公开用量统计 API）',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 启动
app.listen(PORT, () => {
  console.log(`\n🚀 DeepSeek 用量监控面板已启动`);
  console.log(`📍 地址: http://localhost:${PORT}`);
  console.log(`🔑 API Key: ${API_KEY.slice(0, 12)}...${API_KEY.slice(-4)}`);
  console.log(`🔄 页面每 60 秒自动刷新\n`);
});
