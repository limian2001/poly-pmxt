// 交易所实例管理 + 直连取数
// ---------------------------------------------------------------------------
// 关键成本认知：**直连各平台（fetchEvents / fetchOrderBook / fetchOHLCV / watch*）
// 走的是我们自己的容器，不消耗任何 pmxt credit**。只有打 api.pmxt.dev 才计费。
// 所以策略是：结构与匹配关系向托管接口买（便宜且只买一次），价格/成交量/盘口全部直连拿。
import pmxtCore from 'pmxt-core';
import { log, mapLimit } from './util.mjs';

const REG = {
  polymarket: pmxtCore.Polymarket,
  kalshi: pmxtCore.Kalshi,
  limitless: pmxtCore.Limitless,
  opinion: pmxtCore.Opinion,
  probable: pmxtCore.Probable,
  myriad: pmxtCore.Myriad,
  metaculus: pmxtCore.Metaculus,
  smarkets: pmxtCore.Smarkets,
  baozi: pmxtCore.Baozi,
  hyperliquid: pmxtCore.Hyperliquid,
  'gemini-titan': pmxtCore.GeminiTitan,
  suibets: pmxtCore.SuiBets,
  rain: pmxtCore.Rain,
  hunch: pmxtCore.Hunch,
  polymarket_us: pmxtCore.PolymarketUS,
};

// 构造参数：只有 Polymarket 需要特别关照 —— 它的 watchOrderBook 默认在 3 秒内没收到
// 推送就自动去打一次 REST 快照。我们要同时盯上百个结果并且循环续订，那会变成每秒几十次
// REST 打到 CLOB 上，必然被限流。把 snapshotFallbackMs 关掉，让它退化成「纯推送」：
// 有变动才 resolve，没变动就一直挂着（watchTimeoutMs=0 表示不超时）。
// 冷启动的初始价格我们本来就从 fetchEvents 拿到了，不需要这个快照兜底。
const OPTS = {
  polymarket: { websocket: { snapshotFallbackMs: 0, watchTimeoutMs: 0 } },
};

const instances = new Map();
const health = new Map(); // venue -> {ok, lastOk, lastErr, msg, events, markets, ms}

export function venueNames() { return Object.keys(REG); }

export function getVenue(name) {
  const k = String(name || '').toLowerCase();
  if (instances.has(k)) return instances.get(k);
  const Klass = REG[k];
  if (!Klass) throw new Error(`未知平台: ${name}`);
  const inst = OPTS[k] ? new Klass(OPTS[k]) : new Klass();
  instances.set(k, inst);
  return inst;
}

/** 这个平台能不能推送？Kalshi 的 WS 走 ensureAuth()，没凭据就只能轮询。 */
export function canStream(venue) {
  const v = String(venue || '').toLowerCase();
  if (v === 'kalshi') return Boolean(process.env.KALSHI_API_KEY_ID && process.env.KALSHI_PRIVATE_KEY);
  return v === 'polymarket' || v === 'limitless';
}

/** 续订式监听：resolve 一次就是一次盘口变动，调用方拿到后立刻再调一次（CCXT Pro 模式） */
export async function watchBook(venue, wsId) {
  const ex = getVenue(venue);
  const book = await ex.watchOrderBook(wsId);
  return normalizeBook(book);
}

export async function unwatchBook(venue, wsId) {
  try { await getVenue(venue).unwatchOrderBook?.(wsId); }
  catch (e) { log.debug(`unwatchOrderBook ${venue}/${wsId}: ${e?.message}`); }
}

export function getHealth() {
  return Object.fromEntries(health);
}

function markOk(v, extra) {
  health.set(v, { ok: true, lastOk: Date.now(), lastErr: health.get(v)?.lastErr ?? null, msg: null, ...extra });
}
function markErr(v, e) {
  const prev = health.get(v) || {};
  health.set(v, { ...prev, ok: false, lastErr: Date.now(), msg: String(e?.message || e).slice(0, 200) });
}

/**
 * 抓一个平台的全部活跃事件（含市场与结果价格）。
 * 注意 Polymarket 的坑：fetchMarkets 传 active:true + limit 会让 limit 被丢掉，
 * 进而翻页越过 Gamma 的 offset 10000 上限报 422。走 fetchEvents 路径不踩这个坑
 * （paginateParallel 内部已经把 MAX_OFFSET 卡死在 10000）。
 */
export async function fetchVenueEvents(venue, { limit = 1200, sort = 'volume' } = {}) {
  const t0 = Date.now();
  try {
    const ex = getVenue(venue);
    const events = await ex.fetchEvents({ limit, sort, status: 'active' });
    const list = Array.isArray(events) ? events : [];
    const mkts = list.reduce((s, e) => s + (e.markets?.length || 0), 0);
    markOk(venue, { events: list.length, markets: mkts, ms: Date.now() - t0 });
    log.info(`直连 ${venue}: ${list.length} 事件 / ${mkts} 市场, ${Date.now() - t0}ms`);
    return list;
  } catch (e) {
    markErr(venue, e);
    log.warn(`直连 ${venue} 失败: ${e?.message || e}`);
    return [];
  }
}

/** 并发抓多个平台，单个平台失败不影响其它平台 */
export async function fetchAllVenueEvents(venues, opts) {
  const res = await mapLimit(venues, 3, async (v) => [v, await fetchVenueEvents(v, opts)]);
  const out = {};
  for (const r of res) {
    if (Array.isArray(r)) out[r[0]] = r[1];
  }
  return out;
}

/** 单个结果的盘口（直连，免费） */
export async function fetchBook(venue, outcomeId, limit = 10) {
  const ex = getVenue(venue);
  const book = await ex.fetchOrderBook(outcomeId, limit);
  return normalizeBook(book);
}

export function normalizeBook(book) {
  const bids = (book?.bids || []).slice(0, 12).map((l) => ({ p: l.price, s: l.size }));
  const asks = (book?.asks || []).slice(0, 12).map((l) => ({ p: l.price, s: l.size }));
  const bestBid = bids.length ? Math.max(...bids.map((b) => b.p)) : null;
  const bestAsk = asks.length ? Math.min(...asks.map((a) => a.p)) : null;
  const mid = bestBid != null && bestAsk != null ? (bestBid + bestAsk) / 2 : (bestBid ?? bestAsk ?? null);
  return {
    bids, asks, bestBid, bestAsk, mid,
    spread: bestBid != null && bestAsk != null ? bestAsk - bestBid : null,
    ts: book?.timestamp || Date.now(),
    last: book?.lastTradePrice ?? null,
  };
}

/** K 线（直连，免费）。不同平台支持的 resolution 不同，失败就返回空数组。 */
export async function fetchCandles(venue, outcomeId, { resolution = '1h', limit = 168 } = {}) {
  try {
    const ex = getVenue(venue);
    const rows = await ex.fetchOHLCV(outcomeId, { resolution, limit });
    return (rows || []).map((c) => ({ t: c.timestamp, o: c.open, h: c.high, l: c.low, c: c.close, v: c.volume ?? null }));
  } catch (e) {
    log.debug(`fetchOHLCV ${venue}/${outcomeId} 失败: ${e?.message}`);
    return [];
  }
}

/** 最近成交（直连，免费） */
export async function fetchRecentTrades(venue, outcomeId, limit = 40) {
  try {
    const ex = getVenue(venue);
    const rows = await ex.fetchTrades(outcomeId, { limit });
    return (rows || []).slice(0, limit).map((t) => ({
      t: t.timestamp ?? null, p: t.price ?? null, s: t.size ?? null, side: t.side ?? null,
    }));
  } catch (e) {
    log.debug(`fetchTrades ${venue}/${outcomeId} 失败: ${e?.message}`);
    return [];
  }
}

/** 关闭所有 WS/连接（进程退出时调用） */
export async function closeAll() {
  for (const [name, inst] of instances) {
    try { await inst.close?.(); } catch (e) { log.debug(`close ${name}: ${e?.message}`); }
  }
}
