// pmxt 行情网关 (gateway)
// -------------------------------------------------------------
// 一个极薄的 Express 服务，做两件事：
//   1. 把 pmxt-core 的统一行情 API 挂载到 /pmxt（官方推荐的无 token 挂载方式）
//   2. 托管行情前端仪表盘（dashboard/index.html）静态文件
// 只绑定容器内 0.0.0.0:3200，宿主机只映射到 127.0.0.1（配合 SSH 隧道访问，不暴露公网）。
//
// 二开提示：所有行情能力都来自 pmxt-core，这里只是「网关 + 托管前端」。
// 想加自定义聚合/缓存接口，直接在下面注册路由即可。
import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// pmxt-core 是 CommonJS，用默认导入再解构，避免 ESM 命名导入的互操作问题
import pmxtCore from 'pmxt-core';
const { createApp: createPmxtCoreApp } = pmxtCore;

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PMXT_GATEWAY_PORT || 3200);
const HOST = process.env.PMXT_GATEWAY_HOST || '0.0.0.0';
const VENUES = String(process.env.PMXT_VENUES || 'polymarket,kalshi,limitless,opinion')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
const DASHBOARD_DIR = process.env.PMXT_DASHBOARD_DIR || join(__dirname, '..', 'dashboard');

const app = express();
app.use(express.json({ limit: '2mb' }));

// 前端启动时读取：当前启用了哪些平台
app.get('/config', (_req, res) => {
  res.json({ venues: VENUES, ts: Date.now() });
});

// 网关自身健康检查（与 /pmxt/health 区分）
app.get('/gw/health', (_req, res) => {
  res.json({ status: 'ok', service: 'pmxt-gateway', venues: VENUES, ts: Date.now() });
});

// —— 核心：挂载 pmxt-core 统一 API ——
// 挂载后路由变为 /pmxt/api/{exchange}/{method}、/pmxt/api/feeds/...、/pmxt/health
// 不传 accessToken => 无鉴权（本服务只在 127.0.0.1 内网 + SSH 隧道访问）
app.use('/pmxt', createPmxtCoreApp());

// —— 托管前端 ——
app.use(express.static(DASHBOARD_DIR));
// SPA 兜底：非 /pmxt、非静态资源的路径都回首页
// 用 middleware 而非 app.get('*')，规避 Express 5 的通配路径解析限制
app.use((req, res, next) => {
  if (req.method !== 'GET') return next();
  if (req.path.startsWith('/pmxt') || req.path.startsWith('/config') || req.path.startsWith('/gw')) {
    return next();
  }
  res.sendFile(join(DASHBOARD_DIR, 'index.html'));
});

app.listen(PORT, HOST, () => {
  console.log(`[pmxt-gateway] listening http://${HOST}:${PORT}`);
  console.log(`[pmxt-gateway] pmxt-core mounted at /pmxt  (try /pmxt/health)`);
  console.log(`[pmxt-gateway] venues = ${VENUES.join(', ')}`);
  console.log(`[pmxt-gateway] dashboard dir = ${DASHBOARD_DIR}`);
});
