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

// Polymarket 单独限流：Gamma /events 现在有 offset 上限，超了直接 422
// （实测 offset 0/100/500/1100 都是 200，5000 返回
//  {"type":"validation error","error":"offset too large, use /events/keyset for deeper pagination"}），
// 而 core 里的 paginateParallel 还按老的 MAX_OFFSET=10000 算页数，并且用 Promise.all ——
// 一页 422 整个抓取就 reject。1000 条事件 = offset 最深 900，落在实测安全区里。
const POLY_MAX_EVENTS = Number(process.env.PMXT_POLY_MAX_EVENTS || 1000);

/**
 * 各平台的 fetchEvents 入参。**这个函数是 Polymarket 422 空看板事故的正解，别顺手"统一"掉。**
 *
 * BaseExchange.fetchEvents 里有个陷阱：
 *     const { limit, offset, ...venueParams } = fetchParams;
 *     const hasVenueParams = Object.keys(venueParams).length > 0;
 *     const shouldForwardSimpleLimit = limit !== undefined && offset === undefined && !hasVenueParams;
 *     await this.fetchEventsImpl(shouldForwardSimpleLimit ? { limit } : venueParams);
 * 也就是说：**只要多传一个 limit/offset 之外的参数，limit 就不会下传给平台实现**，
 * 只会在拿到全部结果后做一次 slice。对 Polymarket 来说 limit 丢了 ⇒
 * fetchRawEventsDefault 用 25000 兜底 ⇒ paginateParallel 一路翻到 offset 9900 ⇒ Gamma 422 ⇒
 * 抓取整体失败 ⇒ 锚平台 0 事件 ⇒ 主区 0 行（页面全空）。
 *
 * 所以 Polymarket 只传 { limit }：它内部默认就是 status=active + order=volume&ascending=false，
 * 跟我们想要的完全一致，一个字都不用多说。
 *
 * Kalshi 反过来必须继续传 sort/status：它的 hasBoundedDefaultRead 快路径条件是
 * status==='active' && limit!==undefined && sort===undefined && ...，命中后只返回一页，
 * 那才是真的会让 Kalshi 只剩几十个市场。Limitless 无所谓，跟 Kalshi 走同一条。
 */
function eventParams(venue, limit, sort) {
  if (venue === 'polymarket') return { limit: Math.min(limit, POLY_MAX_EVENTS) };
  return { limit, sort, status: 'active' };
}

/** 抓取失败时的降级梯度：宁可少几百个标的，也不要整块空白 */
function limitLadder(limit) {
  const xs = [limit, 500, 200].filter((n) => Number.isFinite(n) && n > 0);
  return [...new Set(xs)].sort((a, b) => b - a);
}

/**
 * 抓一个平台的全部活跃事件（含市场与结果价格）。
 * 失败不抛，返回 []，并在 health 里留痕（/api/board/stats 的 venueHealth 能看到）。
 */
export async function fetchVenueEvents(venue, { limit = 1200, sort = 'volume' } = {}) {
  const t0 = Date.now();
  const ex = (() => { try { return getVenue(venue); } catch (e) { markErr(venue, e); log.warn(`未知平台 ${venue}: ${e.message}`); return null; } })();
  if (!ex) return [];

  let lastErr = null;
  for (const n of limitLadder(limit)) {
    const params = eventParams(venue, n, sort);
    try {
      const events = await ex.fetchEvents(params);
      const list = Array.isArray(events) ? events : [];
      const mkts = list.reduce((s, e) => s + (e.markets?.length || 0), 0);
      markOk(venue, { events: list.length, markets: mkts, ms: Date.now() - t0, limit: params.limit });
      const degraded = params.limit !== limit ? `（降级到 limit=${params.limit}）` : '';
      log.info(`直连 ${venue}: ${list.length} 事件 / ${mkts} 市场, ${Date.now() - t0}ms${degraded}`);
      return list;
    } catch (e) {
      lastErr = e;
      log.warn(`直连 ${venue} limit=${params.limit} 失败: ${e?.message || e}`);
    }
  }
  markErr(venue, lastErr);
  log.warn(`直连 ${venue} 全部降级尝试都失败，本轮该平台缺席`);
  return [];
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
