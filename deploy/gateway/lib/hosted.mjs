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
// 计费：REST 每次调用 1 credit。一次调用覆盖一整页集群，
// 相比已废弃的两两匹配接口（N+1 次调用）便宜两个数量级。
//
// ── 2026-07 生产探针实测结论（probe.mjs 打的真实接口，别再靠猜）──────────────
//  · 信封是 {data:[...], pagination:{...}}
//  · **limit=500 实际只返回 250 条** —— 服务端页大小上限约 250。
//    这条最坑：按 500 请求、拿到 250、再用「不满页 = 到底了」判断，就会静悄悄只同步
//    前 250 个集群，其余全部匹配不上，前端表现为「明明三家都有，却只显示 poly 一列」。
//  · offset 分页有效（offset=5 与首页前 5 条零重合）。
//  · **会 429**：连着打第 2、3 次就可能撞上 "Rate exceeded"，且是先卡 10 秒再拒。
//    所以下面既要退避重试，也要在翻页之间留间隔。
//  · venues= 是「仅限于」而非「至少包含」；不传的话会混进 probable 等我们没接的平台。
//  · 集群级 volume24h 是各平台之和，且他站的值可能离谱（实测 probable 报 5314 万，
//    而同一条 volume=0、报价全 null）。**所以热度绝不能用集群里的量**，只用直连的。
//  · 价格在 markets[].outcomes[].price，成员对象上没有顶层 price 字段。
//  · Polymarket 成员的 outcomes[].metadata.clobTokenId 就是直连 WS 要的 token id。
import { log, sleep } from './util.mjs';

// 每次调用现读，不在模块加载时定死。
// 定死会有两个后果：一是 .env 里改了地址必须重启才生效；
// 二是测试没法在导入之后再把它指向本地假服务端（改了也不认），
// 于是翻页/限流这类只能靠假服务端复现的 bug 就永远测不到。
const base = () => process.env.PMXT_HOSTED_BASE || 'https://api.pmxt.dev';

// 服务端实测页大小上限。按这个数请求，"短页 = 到底了" 才是成立的判断。
const PAGE_SIZE = 250;

// 这些状态码值得重试：限流和服务端抖动。4xx 里其余的（401 key 错、400 参数错）重试没意义。
const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);

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
  retryCount: 0,
  paginationFields: null,   // pagination 对象里到底有什么，跑一轮就知道，不用再花 credit 探
  serverPageCap: null,      // 服务端实际给的页大小（预期 250）
};

function apiKey() { return process.env.PMXT_API_KEY || ''; }
export function hostedEnabled() { return Boolean(apiKey()); }

// 限流重试。探针实测：连打两三次就会撞 429，而且服务端是「先卡十秒再拒」，
// 不是立刻拒。所以一次 429 常常只是运气不好，退避一下重来基本就过了。
// 不重试的代价很大：同步是 15 分钟一轮，第一页一挂整轮就退化成「只有 poly 单平台」，
// 用户会看到整块表突然少两列，要等一刻钟才自己好。
// 代价：每次重试也算 1 credit。最多 3 次，撞满也就多花 3 个，相对月配额可忽略。
async function call(path, params = {}, { retries = 3 } = {}) {
  const key = apiKey();
  if (!key) throw new Error('未配置 PMXT_API_KEY');
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    qs.set(k, String(v));
  }
  const url = `${base()}${path}${qs.toString() ? `?${qs}` : ''}`;

  for (let attempt = 0; ; attempt++) {
    const r = await fetch(url, {
      headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
      signal: AbortSignal.timeout(90_000),
    });
    diag.callCount += 1;
    diag.creditsUsed += 1;
    const rem = r.headers.get('x-ratelimit-remaining');
    if (rem) diag.rateLimitRemaining = rem;
    const text = await r.text();

    if (r.ok) {
      try { return JSON.parse(text); }
      catch { throw new Error(`响应不是 JSON: ${text.slice(0, 120)}`); }
    }

    if (RETRY_STATUS.has(r.status) && attempt < retries) {
      // 服务端给了 Retry-After 就听它的，否则 1s→2s→4s 退避。
      const ra = Number(r.headers.get('retry-after'));
      const waitMs = Number.isFinite(ra) && ra > 0
        ? Math.min(ra * 1000, 60_000)
        : Math.min(1000 * 2 ** attempt, 16_000);
      diag.retryCount += 1;
      log.warn(`托管接口 HTTP ${r.status}，${waitMs}ms 后重试（${attempt + 1}/${retries}）`);
      await sleep(waitMs);
      continue;
    }

    diag.lastError = `HTTP ${r.status}: ${text.slice(0, 200)}`;
    const err = new Error(diag.lastError);
    err.status = r.status;
    throw err;
  }
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
  pageSize = PAGE_SIZE,
  maxPages = 12,
  includeRawMatches = true,
  pauseMs = 350,
} = {}) {
  const out = [];
  const seen = new Set();
  let cursor = null;
  let fetched = 0;      // 服务端已经吐给我们多少条（含重复）——offset 必须按这个走
  let limit = pageSize; // 可能被服务端截短，见下面的自适应

  for (let page = 0; page < maxPages; page++) {
    const params = {
      limit,
      includeRawMatches: includeRawMatches ? 'true' : undefined,
    };
    if (venues?.length) params.venues = venues.join(',');
    if (cursor) params.cursor = cursor;
    // offset 用「已取回条数」而不是 page*limit：limit 被服务端截短过之后，
    // page*limit 会一次跳过一整段，中间那些集群永远同步不到。
    else if (fetched > 0) params.offset = fetched;

    let json;
    try {
      // 翻页之间喘一口气。探针实测连打就撞 429，而这里本来就不赶时间
      // （15 分钟才跑一轮，多花两秒没人感觉得到）。
      if (page > 0 && pauseMs) await sleep(pauseMs);
      json = await call('/v0/matched-market-clusters', params);
    } catch (e) {
      // 第一页就失败 → 整体失败；后续页失败 → 用已拿到的部分继续跑，看板不至于空白
      log.warn(`集群接口第 ${page + 1} 页失败: ${e.message}`);
      if (page === 0) throw e;
      break;
    }

    const u = unwrap(json);
    const n = u.list.length;
    if (page === 0) {
      diag.lastShape = u.shape;
      diag.lastMeta = u.meta ? Object.keys(u.meta) : null;
      diag.pageSizeObserved = n;
      const pg = u.meta?.pagination;
      if (pg && typeof pg === 'object') diag.paginationFields = Object.keys(pg);
      if (u.list[0]) {
        diag.clusterFields = Object.keys(u.list[0]);
        const mem = clusterMembers(u.list[0])[0];
        if (mem) diag.marketFields = Object.keys(mem);
      }
    }

    // 服务端会把 limit 截短（实测 limit=500 只给 250）。
    // 拿观察到的条数当真实页大小，否则下面「不满页 = 到底了」会误判，
    // 一整轮只同步到前 250 个集群，而且完全不报错 —— 这种静默截断最难发现。
    if (page === 0 && n > 0 && n < limit) {
      log.info(`服务端把 limit=${limit} 截成了 ${n} 条，后续按 ${n} 翻页`);
      diag.serverPageCap = n;
      limit = n;
    }
    fetched += n;

    let fresh = 0;
    for (const c of u.list) {
      const id = clusterId(c) || JSON.stringify(clusterMembers(c).map(memberMarketId));
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(c);
      fresh++;
    }
    if (page === 1) diag.offsetWorks = fresh > 0;

    cursor = u.meta?.nextCursor ?? u.meta?.next_cursor ?? u.meta?.cursor ?? null;
    const pg = u.meta?.pagination ?? u.meta ?? {};
    const hasMore = pg.hasMore ?? pg.has_more ?? null;

    // 结束条件，按可靠度从高到低排：
    if (hasMore === false) break;      // 服务端明说没了
    if (n === 0) break;                // 空页
    if (fresh === 0) break;            // 全是重复 → 服务端根本没理会 offset，再翻也是原地踏步
    if (!cursor && n < limit) break;   // 不满页 = 到底了（limit 已经校准过才敢这么判）
  }

  diag.lastOkAt = Date.now();
  diag.lastError = null;
  log.info(`集群接口：拿到 ${out.length} 个集群（翻了 ${Math.ceil(fetched / (limit || 1))} 页），累计 ${diag.creditsUsed} credit，信封=${diag.lastShape}`);
  return out;
}

/**
 * 事件级集群。探针已确认这个接口是通的，返回 {clusterId, canonicalTitle, category,
 * relations, confidence, volume24h, rawMatches, events[]}，events[] 里再挂 markets。
 * 目前主流程不用它（父子行是拿锚平台自己的事件结构搭的，不额外花 credit），
 * 留着是给「锚平台没有、他站才有」的次要区做更好的归组用。
 * 翻页纪律和上面那个函数完全一致 —— 同一个 250 截断坑，别只修一处。
 */
export async function fetchAllEventClusters({
  venues, pageSize = PAGE_SIZE, maxPages = 6, pauseMs = 350,
} = {}) {
  const out = [];
  let fetched = 0;
  let limit = pageSize;

  for (let page = 0; page < maxPages; page++) {
    const params = { limit };
    if (venues?.length) params.venues = venues.join(',');
    if (fetched > 0) params.offset = fetched;

    let json;
    try {
      if (page > 0 && pauseMs) await sleep(pauseMs);
      json = await call('/v0/matched-event-clusters', params);
    } catch (e) {
      log.warn(`事件集群接口不可用（不影响主流程）: ${e.message}`);
      break;
    }

    const u = unwrap(json);
    const n = u.list.length;
    if (page === 0 && n > 0 && n < limit) limit = n;
    fetched += n;
    out.push(...u.list);
    if (n === 0 || n < limit) break;
  }
  return out;
}
