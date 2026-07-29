// 通用工具：日志、方向归一、热度评分、数值安全处理
// ---------------------------------------------------------------------------
// 这里最重要的是 pickDirections()：它修的是你之前抓到的那个「5.0¢ vs 93.5¢」方向反转 bug。
// 根因是各平台对 outcomes 的排序/命名不一致，直接取 outcomes[0] 会把 YES 和 NO 比在一起。

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const LEVEL = LEVELS[String(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? 20;

export const log = {
  debug: (...a) => LEVEL <= 10 && console.log('[board:debug]', ...a),
  info: (...a) => LEVEL <= 20 && console.log('[board]', ...a),
  warn: (...a) => LEVEL <= 30 && console.warn('[board:warn]', ...a),
  error: (...a) => LEVEL <= 40 && console.error('[board:error]', ...a),
};

export const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
export const nz = (v) => (typeof v === 'number' && Number.isFinite(v) && v !== 0 ? v : null);

/** 时间戳归一：Date / ISO 字符串 / 秒 / 毫秒 → 毫秒数或 null */
export function toMs(v) {
  if (v == null) return null;
  if (v instanceof Date) { const t = v.getTime(); return Number.isFinite(t) ? t : null; }
  if (typeof v === 'number') {
    if (!Number.isFinite(v) || v <= 0) return null;
    return v < 1e12 ? v * 1000 : v; // 秒 → 毫秒
  }
  const t = Date.parse(String(v));
  if (!Number.isFinite(t)) return null;
  // Polymarket 有一批市场把 resolutionDate 填成 1970 或 2100 这种哨兵值，视为「没有」
  const y = new Date(t).getUTCFullYear();
  if (y < 2000 || y > 2099) return null;
  return t;
}

// ---------------------------------------------------------------------------
// 方向归一 —— 跨平台比价的地基
// ---------------------------------------------------------------------------
const RE_YES = /^\s*(yes|是|会)\s*$/i;
const RE_NO = /^\s*(no|否|不会)\s*$/i;
// Polymarket 多候选市场会把 outcomes 改写成 "<候选名>" / "Not <候选名>"（groupItemTitle）
const RE_NEGATED = /^\s*(not|no)\b[\s:_-]+/i;

/**
 * 从一个统一市场里挑出「正向 / 反向」两个结果，并把实际用到的标签带出来。
 * 返回 null 表示这是多候选市场（>2 个结果），应该走父子行展开而不是二元行。
 *
 * 判定顺序（越靠前越可信）：
 *   1. venue 自己给的 market.yes / market.no 便捷访问器
 *   2. 标签精确等于 yes / no
 *   3. 只有一个标签形如 "Not X" / "No X" → 它是反向，另一个是正向
 *   4. 兜底 outcomes[0] / outcomes[1]，并标记 weak=true（前端可提示「方向存疑」）
 */
export function pickDirections(market) {
  const os = Array.isArray(market?.outcomes) ? market.outcomes.filter(Boolean) : [];
  if (os.length === 0) return null;

  if (market.yes && market.no) {
    return { pos: market.yes, neg: market.no, posLabel: market.yes.label || 'Yes', negLabel: market.no.label || 'No', basis: 'accessor', weak: false };
  }
  if (market.up && market.down) {
    return { pos: market.up, neg: market.down, posLabel: market.up.label || 'Up', negLabel: market.down.label || 'Down', basis: 'accessor', weak: false };
  }

  if (os.length === 1) {
    const p = os[0];
    return { pos: p, neg: null, posLabel: p.label || 'Yes', negLabel: null, basis: 'single', weak: false };
  }

  if (os.length === 2) {
    const yes = os.find((o) => RE_YES.test(o.label || ''));
    const no = os.find((o) => RE_NO.test(o.label || ''));
    if (yes && no) return { pos: yes, neg: no, posLabel: yes.label, negLabel: no.label, basis: 'label-yes-no', weak: false };

    const negated = os.filter((o) => RE_NEGATED.test(o.label || ''));
    if (negated.length === 1) {
      const neg = negated[0];
      const pos = os.find((o) => o !== neg);
      return { pos, neg, posLabel: pos.label, negLabel: neg.label, basis: 'label-negation', weak: false };
    }

    return { pos: os[0], neg: os[1], posLabel: os[0].label, negLabel: os[1].label, basis: 'positional', weak: true };
  }

  return null; // 多候选：交给父子行
}

/**
 * 跨平台对齐：把 B 平台的方向对到 A 平台的「正向」上。
 * 二元市场里，如果两边正向标签语义相反（一个 "Yes" 一个 "No X"），要翻面。
 * 返回 {pos, neg, flipped}
 */
export function alignTo(anchorDir, dir) {
  if (!anchorDir || !dir) return dir;
  const a = normLabel(anchorDir.posLabel);
  const p = normLabel(dir.posLabel);
  const n = dir.negLabel ? normLabel(dir.negLabel) : '';
  if (!a || !p) return { ...dir, flipped: false };
  if (a === p) return { ...dir, flipped: false };
  if (n && a === n) {
    return { pos: dir.neg, neg: dir.pos, posLabel: dir.negLabel, negLabel: dir.posLabel, basis: dir.basis + '+flip', weak: dir.weak, flipped: true };
  }
  return { ...dir, flipped: false };
}

function normLabel(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9一-龥]+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// 热度评分
// ---------------------------------------------------------------------------
/**
 * 区间对数归一：把 [lo, hi] 这段量级映射到 0..1。
 *
 * 为什么不用 log(v)/log(cap)：那样分母是从 0 开始算的，头部会被压得太平。
 * 实测过 24h 成交额 200 万和 800 万（4 倍差距）只差 6 分，
 * 结果「临近结算 +10 分」这种配菜能把 4 倍的成交额差距翻盘 —— 排序就不对了。
 * 改成从 lo 起算之后，同样这两个数差 16 分，成交额重新成为主导项。
 */
function logRange(v, lo, hi) {
  const x = Math.max(0, num(v));
  const a = Math.log1p(lo), b = Math.log1p(hi);
  return Math.min(1, Math.max(0, (Math.log1p(x) - a) / (b - a)));
}

// 各分项的权重与量级区间。想调排序，改这里就够了。
export const HEAT_WEIGHTS = {
  vol24h: 0.50,   // 24h 成交额 —— 主导项，对齐 Polymarket 默认排序的直觉
  liquidity: 0.15, // 盘口厚度
  volume: 0.12,   // 累计成交额 —— 让长期大盘子不会因为今天冷清就掉出首屏
  chg: 0.10,      // 24h 概率波动
  near: 0.08,     // 临近结算（另有专门的筛选项，这里不必给太重）
  cover: 0.05,    // 几个平台都在跑
};
const RANGE = {
  vol24h: [1e4, 5e7],
  liquidity: [1e3, 1e7],
  volume: [1e5, 5e8],
};

/** 拆开的热度分项，供 /api/board/row 详情和调参时看 */
export function heatParts(row, now = Date.now()) {
  let near = 0;
  if (row.resolutionDate) {
    const days = (row.resolutionDate - now) / 86_400_000;
    if (days >= 0) near = days <= 1 ? 1 : days <= 3 ? 0.75 : days <= 7 ? 0.5 : days <= 30 ? 0.2 : 0;
  }
  return {
    vol24h: logRange(row.vol24h, ...RANGE.vol24h),
    liquidity: logRange(row.liquidity, ...RANGE.liquidity),
    volume: logRange(row.volume, ...RANGE.volume),
    chg: Math.min(1, Math.abs(num(row.chg24h)) / 0.15), // 24h 概率变动 15 个点记满分
    near,
    cover: Math.min(1, (row.venues?.length || 1) / 3),
  };
}

/** 综合热度：成交额主导，流动性/波动/临期/平台覆盖做修正 */
export function heatScore(row, now = Date.now()) {
  const p = heatParts(row, now);
  let s = 0;
  for (const k of Object.keys(HEAT_WEIGHTS)) s += HEAT_WEIGHTS[k] * p[k];
  return s;
}

/** 详情页用：告诉用户这一行为什么排在这儿 */
export function explainHeat(row, now = Date.now()) {
  const p = heatParts(row, now);
  return {
    total: heatScore(row, now),
    parts: Object.fromEntries(Object.keys(HEAT_WEIGHTS).map((k) => [k, {
      raw: k === 'chg' ? num(row.chg24h) : k === 'near' ? row.resolutionDate : k === 'cover' ? (row.venues?.length || 0) : num(row[k]),
      score: p[k],
      weight: HEAT_WEIGHTS[k],
      contrib: HEAT_WEIGHTS[k] * p[k],
    }])),
  };
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 限制并发的 map，避免一次性把几百个请求砸给交易所 */
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      try { out[idx] = await fn(items[idx], idx); }
      catch (e) { out[idx] = { __error: String(e?.message || e) }; }
    }
  });
  await Promise.all(workers);
  return out;
}

/** 带 TTL 的 promise 去重缓存：同一个 key 在途时不重复发请求 */
export function makeCache(ttlMs) {
  const done = new Map();   // key -> {v, exp}
  const inflight = new Map(); // key -> promise
  return {
    async get(key, loader) {
      const hit = done.get(key);
      if (hit && hit.exp > Date.now()) return hit.v;
      const cur = inflight.get(key);
      if (cur) return cur;
      const p = (async () => {
        try {
          const v = await loader();
          done.set(key, { v, exp: Date.now() + ttlMs });
          return v;
        } finally { inflight.delete(key); }
      })();
      inflight.set(key, p);
      return p;
    },
    peek(key) {
      const hit = done.get(key);
      return hit && hit.exp > Date.now() ? hit.v : undefined;
    },
    set(key, v) { done.set(key, { v, exp: Date.now() + ttlMs }); },
    size: () => done.size,
    sweep() {
      const now = Date.now();
      for (const [k, v] of done) if (v.exp <= now) done.delete(k);
    },
  };
}
