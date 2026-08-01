// pmxt 行情网关 (gateway)
// -------------------------------------------------------------
// 做四件事：
//   1. 把 pmxt-core 的统一行情 API 挂载到 /pmxt（官方推荐的无 token 挂载方式）
//   2. 跑一个有状态的聚合层 BoardStore：15 分钟一轮全量同步，产出「全球预测市场大盘」
//   3. 提供看板 API（/api/board、/api/book、/api/ohlcv、/api/stream ...）
//   4. 托管行情前端仪表盘（dashboard/）静态文件
//
// 只绑定容器内 0.0.0.0:3200，宿主机只映射到 127.0.0.1（配合 SSH 隧道访问，不暴露公网）。
//
// 成本模型（很重要，改代码前先看这段）：
//   打 api.pmxt.dev = 花 credit；直连各交易所 = 不花钱。
//   所以 BoardStore 只向托管接口买「跨平台同一标的的对应关系」，
//   价格、成交量、盘口、K线全部直连拿。一轮同步大约 1–3 credit。
import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';

// pmxt-core 是 CommonJS，用默认导入再解构，避免 ESM 命名导入的互操作问题
import pmxtCore from 'pmxt-core';
const { createApp: createPmxtCoreApp } = pmxtCore;

import { BoardStore } from './lib/board-store.mjs';
import { Realtime } from './lib/realtime.mjs';
import { createBoardRouter, createSse } from './lib/routes.mjs';
import { closeAll, getHealth } from './lib/venues.mjs';
import * as hosted from './lib/hosted.mjs';
import { log } from './lib/util.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PMXT_GATEWAY_PORT || 3200);
const HOST = process.env.PMXT_GATEWAY_HOST || '0.0.0.0';
const VENUES = String(process.env.PMXT_VENUES || 'polymarket,kalshi,limitless')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
const DASHBOARD_DIR = process.env.PMXT_DASHBOARD_DIR || join(__dirname, '..', 'dashboard');
// pmxt 托管匹配引擎的 API key（跨平台同一标的匹配要用）。仅在服务端持有，绝不下发浏览器。
const PMXT_API_KEY = process.env.PMXT_API_KEY || '';
// 运维状态文件：由宿主机 cron 写入（df + docker ps），网关只读透传，避免暴露 docker.sock
const OPS_FILE = process.env.PMXT_OPS_FILE || '/app/ops/status.json';

const app = express();
app.use(express.json({ limit: '2mb' }));

// ── 访问口令（只在把端口开到公网时才需要）──────────────────────────────
// 绑 127.0.0.1 走 SSH 隧道时，隧道本身就是认证，这里留空即可。
// 一旦 PMXT_BIND=0.0.0.0，这个端口对全网可见，而网关上有两个不该白送的东西：
//   · POST /api/board/refresh —— 每次都真的去打托管接口，烧的是你的 credit
//   · /pmxt/*                —— pmxt-core 的完整 REST，等于一台免费行情代理
// 所以用最笨但最有效的办法：HTTP Basic。浏览器原生弹框、会自动带上后续的
// fetch 和 EventSource 请求，前端一行都不用改。
// 格式：PMXT_AUTH=用户名:密码
const AUTH = String(process.env.PMXT_AUTH || '').trim();
const AUTH_HEADER = AUTH ? 'Basic ' + Buffer.from(AUTH).toString('base64') : '';

/** 逐字节比较，别用 === —— 那个会因为提前返回而泄漏口令长度和前缀 */
function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  if (x.length !== y.length) return false;
  return timingSafeEqual(x, y);
}

if (AUTH_HEADER) {
  app.use((req, res, next) => {
    // healthcheck 从容器内部打 127.0.0.1，别让它也去凑口令
    const ip = req.socket.remoteAddress || '';
    if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') return next();
    const got = req.headers.authorization || '';
    if (got && safeEqual(got, AUTH_HEADER)) return next();
    res.set('WWW-Authenticate', 'Basic realm="pmxt", charset="UTF-8"');
    res.status(401).send('需要口令');
  });
  log.info('已启用访问口令（PMXT_AUTH）');
} else if (String(process.env.PMXT_BIND || '') && process.env.PMXT_BIND !== '127.0.0.1') {
  log.warn(`⚠️ 端口绑在 ${process.env.PMXT_BIND} 却没设 PMXT_AUTH —— 这个看板现在对全网开放`);
}

// ── 聚合层 + 实时层 ──────────────────────────────────────────────────
const board = new BoardStore({ venues: VENUES });
const sse = createSse();
const realtime = new Realtime(board, sse.broadcast);

// 前端启动时读取：启用了哪些平台、跨平台匹配是否可用、锚定平台是谁
app.get('/config', (_req, res) => {
  res.json({
    venues: VENUES,
    anchor: board.facets().anchor,
    matching: Boolean(PMXT_API_KEY),
    realtime: realtime.enabled,
    syncIntervalMin: Math.round(board.syncIntervalMs / 60000),
    ts: Date.now(),
  });
});

// 运维状态条数据源：宿主机 cron 写好的 JSON（磁盘 + 容器健康），网关只读转发
app.get('/ops', (_req, res) => {
  try {
    res.json(JSON.parse(readFileSync(OPS_FILE, 'utf8')));
  } catch {
    res.json({ error: '暂无运维数据（宿主机 cron 未接入或尚未生成）' });
  }
});

// —— 为 pmxt 的 router（跨平台匹配）调用注入托管 API key ——
// 前端只管调 /pmxt/api/router/...，key 由服务端注入为 Bearer，不暴露到浏览器。
app.use((req, _res, next) => {
  if (PMXT_API_KEY && req.path.startsWith('/pmxt/api/router')) {
    req.headers['authorization'] = `Bearer ${PMXT_API_KEY}`;
  }
  next();
});

// 网关自身健康检查（与 /pmxt/health 区分）
app.get('/gw/health', (_req, res) => {
  res.json({
    status: 'ok', service: 'pmxt-gateway', venues: VENUES,
    board: { rows: board.state.rowCount, lastSyncAt: board.state.lastSyncAt, syncing: board.state.syncing },
    ts: Date.now(),
  });
});

// 诊断：托管接口到底返回了什么形状、各平台直连是否正常、实时层订了多少
app.get('/gw/diag', (_req, res) => {
  res.json({
    hosted: { enabled: hosted.hostedEnabled(), base: process.env.PMXT_HOSTED_BASE || 'https://api.pmxt.dev', ...hosted.diag },
    venueHealth: getHealth(),
    board: board.stats(),
    realtime: realtime.stats(),
    sseClients: sse.count(),
    env: {
      eventLimit: board.eventLimit,
      syncIntervalMs: board.syncIntervalMs,
      snapshotPath: board.snapshotPath,
    },
    ts: Date.now(),
  });
});

// ── 看板 API ─────────────────────────────────────────────────────────
app.use('/api', createBoardRouter(board, () => realtime));
app.get('/api/stream', sse.handler);

// —— 核心：挂载 pmxt-core 统一 API ——
// 挂载后路由变为 /pmxt/api/{exchange}/{method}、/pmxt/api/feeds/...、/pmxt/health
// 不传 accessToken => 无鉴权（本服务只在 127.0.0.1 内网 + SSH 隧道访问）
app.use('/pmxt', createPmxtCoreApp());

// —— 托管前端 ——
app.use(express.static(DASHBOARD_DIR));
// SPA 兜底：非 API 路径都回首页
// 用 middleware 而非 app.get('*')，规避 Express 5 的通配路径解析限制
const API_PREFIXES = ['/pmxt', '/config', '/gw', '/ops', '/api'];
app.use((req, res, next) => {
  if (req.method !== 'GET') return next();
  if (API_PREFIXES.some((p) => req.path === p || req.path.startsWith(p + '/'))) return next();
  res.sendFile(join(DASHBOARD_DIR, 'index.html'));
});

const server = app.listen(PORT, HOST, async () => {
  console.log(`[pmxt-gateway] listening http://${HOST}:${PORT}`);
  console.log(`[pmxt-gateway] pmxt-core mounted at /pmxt  (try /pmxt/health)`);
  console.log(`[pmxt-gateway] venues = ${VENUES.join(', ')}`);
  console.log(`[pmxt-gateway] dashboard dir = ${DASHBOARD_DIR}`);
  console.log(`[pmxt-gateway] 托管匹配 = ${PMXT_API_KEY ? '已配置' : '未配置（只能看单平台数据）'}`);
  await board.start();
  realtime.start();
});

// SSE 是长连接，别让 Node 默认的 keep-alive 超时把它掐了
server.keepAliveTimeout = 0;
server.headersTimeout = 0;

// ── 优雅退出 ─────────────────────────────────────────────────────────
let shuttingDown = false;
async function shutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`收到 ${sig}，正在关闭…`);
  board.stop();
  const t = setTimeout(() => process.exit(0), 8000);
  t.unref?.();
  try {
    await realtime.stop();
    await closeAll();
    server.close(() => process.exit(0));
  } catch { process.exit(0); }
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (e) => log.error('未处理的 Promise 拒绝:', e?.message || e));
