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
import { readFileSync } from 'node:fs';

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
// pmxt 托管匹配引擎的 API key（跨平台同一市场匹配/套利要用）。仅在服务端持有。
const PMXT_API_KEY = process.env.PMXT_API_KEY || '';
// 运维状态文件：由宿主机 cron 写入（df + docker ps），网关只读透传，避免暴露 docker.sock
const OPS_FILE = process.env.PMXT_OPS_FILE || '/app/ops/status.json';

const app = express();
app.use(express.json({ limit: '2mb' }));

// 前端启动时读取：当前启用了哪些平台，以及跨平台匹配是否可用（有没有配 key）
app.get('/config', (_req, res) => {
  res.json({ venues: VENUES, matching: Boolean(PMXT_API_KEY), ts: Date.now() });
});

// 运维状态条数据源：宿主机 cron 写好的 JSON（磁盘 + 容器健康），网关只读转发
app.get('/ops', (_req, res) => {
  try {
    res.json(JSON.parse(readFileSync(OPS_FILE, 'utf8')));
  } catch {
    res.json({ error: '暂无运维数据（宿主机 cron 未接入或尚未生成）' });
  }
});

// —— 为 pmxt 的 router（跨平台匹配/套利）调用注入托管 API key ——
// 前端只管调 /pmxt/api/router/...，key 由服务端注入为 Bearer，不暴露到浏览器。
app.use((req, _res, next) => {
  if (PMXT_API_KEY && req.path.startsWith('/pmxt/api/router')) {
    req.headers['authorization'] = `Bearer ${PMXT_API_KEY}`;
  }
  next();
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
  if (req.path.startsWith('/pmxt') || req.path.startsWith('/config') || req.path.startsWith('/gw') || req.path.startsWith('/ops')) {
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
