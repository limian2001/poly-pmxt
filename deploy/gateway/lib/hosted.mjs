// pmxt 托管匹配引擎客户端（api.pmxt.dev）
// ---------------------------------------------------------------------------
// 只做一件事：拿「跨平台同一标的」的对应关系（cluster）。
//
// 两个刻意的设计决定：
// 1) **只当映射表用**。集群响应在官方 OpenAPI 里没有定义结构，字段是否齐全不可知。
//    所以我们只从里面取 (venue, marketId) 的对应关系 + 分类 + 置信度，
//    价格/成交量/盘口一律走直连。这样即使集群字段残缺，看板照样是全的。
// 2) **防御式解包**。裸数组、{data:[]}、{clusters:[]}、{data:{clusters:[]}} 都能吃下，
//    并把实际观察到的形状记录下来（/gw/diag 可看），线上跑一次就知道真相。
//
// 计费：REST 每次调用 1 credit。limit=500 时一次调用覆盖 500 个集群，
// 相比已废弃的两两匹配接口（N+1 次调用）便宜约 500 倍。
import { log } from './util.mjs';

const BASE = process.env.PMXT_HOSTED_BASE || 'https://api.pmxt.dev';

export const diag = {
  lastShape: null,
  lastMeta: null,
  lastError: null,
  lastOkAt: null,
  callCount: 0,
  creditsUsed: 0,
  pageSizeObserved: null,
  offsetWorks: null,
  clusterFields: null,
  marketFields: null,
  rateLimitRemaining: null,
};

function apiKey() { return process.env.PMXT_API_KEY || ''; }
export function hostedEnabled() { return Boolean(apiKey()); }

async function call(path, params = {}) {
  const key = apiKey();
  if (!key) throw new Error('未配置 PMXT_API_KEY');
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    qs.set(k, String(v));
  }
  const url = `${BASE}${path}${qs.toString() ? `?${qs}` : ''}`;
  const r = await fetch(url, {
    headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
    signal: AbortSignal.timeout(90_000),
  });
  diag.callCount += 1;
  diag.creditsUsed += 1;
  const rem = r.headers.get('x-ratelimit-remaining');
  if (rem) diag.rateLimitRemaining = rem;
  const text = await r.text();
  if (!r.ok) {
    diag.lastError = `HTTP ${r.status}: ${text.slice(0, 200)}`;
    const err = new Error(diag.lastError);
    err.status = r.status;
    throw err;
  }
  try { return JSON.parse(text); }
  catch { throw new Error(`响应不是 JSON: ${text.slice(0, 120)}`); }
}

/** 防御式解包：不管服务端用哪种信封，都取出列表和元信息 */
export function unwrap(json) {
  if (Array.isArray(json)) return { shape: 'bare-array', list: json, meta: null };
  if (!json || typeof json !== 'object') return { shape: 'unknown', list: [], meta: null };
  for (const k of ['data', 'clusters', 'items', 'results']) {
    if (Array.isArray(json[k])) {
      const meta = { ...json }; delete meta[k];
      return { shape: `{${k}:[]}`, list: json[k], meta };
    }
  }
  if (json.data && typeof json.data === 'object' && !Array.isArray(json.data)) {
    for (const k of ['clusters', 'items', 'results', 'data']) {
      if (Array.isArray(json.data[k])) {
        const meta = { ...json.data }; delete meta[k];
        return { shape: `{data:{${k}:[]}}`, list: json.data[k], meta };
      }
    }
  }
  return { shape: 'object-no-array', list: [], meta: json };
}

/** 从一个集群成员里认出它属于哪个平台 —— 字段名各版本可能不同，全都试一遍 */
export function memberVenue(m) {
  const v = m?.sourceExchange ?? m?.exchange ?? m?.venue ?? m?.platform ?? m?.source;
  return v ? String(v).toLowerCase() : null;
}

/** 从一个集群成员里认出市场 id —— 同样多字段兜底 */
export function memberMarketId(m) {
  return m?.marketId ?? m?.id ?? m?.market_id ?? m?.ticker ?? m?.slug ?? null;
}

/** 从一个集群里取集群 id */
export function clusterId(c) {
  return c?.clusterId ?? c?.id ?? c?.cluster_id ?? null;
}

/** 集群成员数组：markets / members / marketList 都兼容 */
export function clusterMembers(c) {
  for (const k of ['markets', 'members', 'marketList', 'items']) {
    if (Array.isArray(c?.[k])) return c[k];
  }
  return [];
}

/**
 * 翻页拉取全部市场集群。
 * @returns {Promise<Array>} 原始集群数组（不做字段假设，交给调用方按需取）
 */
export async function fetchAllMarketClusters({
  venues,
  pageSize = 500,
  maxPages = 12,
  includeRawMatches = true,
} = {}) {
  const out = [];
  const seen = new Set();
  let cursor = null;

  for (let page = 0; page < maxPages; page++) {
    const params = {
      limit: pageSize,
      includeRawMatches: includeRawMatches ? 'true' : undefined,
    };
    if (venues?.length) params.venues = venues.join(',');
    if (cursor) params.cursor = cursor;
    else if (page > 0) params.offset = page * pageSize;

    let json;
    try {
      json = await call('/v0/matched-market-clusters', params);
    } catch (e) {
      // 第一页就失败 → 整体失败；后续页失败 → 用已拿到的部分继续跑，看板不至于空白
      log.warn(`集群接口第 ${page + 1} 页失败: ${e.message}`);
      if (page === 0) throw e;
      break;
    }

    const u = unwrap(json);
    if (page === 0) {
      diag.lastShape = u.shape;
      diag.lastMeta = u.meta ? Object.keys(u.meta) : null;
      diag.pageSizeObserved = u.list.length;
      if (u.list[0]) {
        diag.clusterFields = Object.keys(u.list[0]);
        const mem = clusterMembers(u.list[0])[0];
        if (mem) diag.marketFields = Object.keys(mem);
      }
    }

    let fresh = 0;
    for (const c of u.list) {
      const id = clusterId(c) || JSON.stringify(clusterMembers(c).map(memberMarketId));
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(c);
      fresh++;
    }
    if (page === 1) diag.offsetWorks = fresh > 0;

    // 结束条件：本页不满、没有新数据、或服务端明确说没有下一页
    cursor = u.meta?.nextCursor ?? u.meta?.next_cursor ?? u.meta?.cursor ?? null;
    const hasMore = u.meta?.hasMore ?? u.meta?.has_more ?? null;
    if (u.list.length < pageSize && !cursor) break;
    if (fresh === 0) break;
    if (hasMore === false) break;
    if (!cursor && u.list.length < pageSize) break;
  }

  diag.lastOkAt = Date.now();
  diag.lastError = null;
  log.info(`集群接口：拿到 ${out.length} 个集群，累计消耗 ${diag.creditsUsed} credit，信封=${diag.lastShape}`);
  return out;
}

/** 事件级集群（父子行的更好来源，若不可用则回退到市场级集群聚合） */
export async function fetchAllEventClusters({ venues, pageSize = 500, maxPages = 6 } = {}) {
  const out = [];
  for (let page = 0; page < maxPages; page++) {
    const params = { limit: pageSize };
    if (venues?.length) params.venues = venues.join(',');
    if (page > 0) params.offset = page * pageSize;
    let json;
    try { json = await call('/v0/matched-event-clusters', params); }
    catch (e) {
      log.warn(`事件集群接口不可用（不影响主流程）: ${e.message}`);
      break;
    }
    const u = unwrap(json);
    out.push(...u.list);
    if (u.list.length < pageSize) break;
  }
  return out;
}
