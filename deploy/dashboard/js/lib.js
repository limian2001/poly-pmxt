// 前端公共工具：取数、格式化、URL 状态、平台元信息
// ---------------------------------------------------------------------------
// 这里不放任何业务判断，只放「怎么显示」和「怎么取」。
// 颜色沿用国内行情软件的习惯：红涨绿跌（跟同花顺一致，和欧美股票软件相反）。

export const VENUE_META = {
  polymarket: { name: 'Polymarket', short: 'POLY', color: '#4f8cff' },
  kalshi:     { name: 'Kalshi',     short: 'KALSHI', color: '#31c48d' },
  limitless:  { name: 'Limitless',  short: 'LMTLS', color: '#b388ff' },
  opinion:    { name: 'Opinion',    short: 'OPIN', color: '#e6b53f' },
  probable:   { name: 'Probable',   short: 'PROB', color: '#ff9f6e' },
  myriad:     { name: 'Myriad',     short: 'MYRD', color: '#57d3e0' },
  metaculus:  { name: 'Metaculus',  short: 'METAC', color: '#9aa7bd' },
  smarkets:   { name: 'Smarkets',   short: 'SMKT', color: '#c98bdb' },
};
export const venueMeta = (v) => VENUE_META[v] || { name: v, short: String(v || '').slice(0, 5).toUpperCase(), color: '#8b96a7' };

// ── 取数 ────────────────────────────────────────────────────────────────
/** GET JSON。params 里 null/undefined/'' 的键自动丢掉，省得拼一堆空参数 */
export async function api(path, params) {
  const u = new URL(path, location.origin);
  for (const [k, v] of Object.entries(params || {})) {
    if (v === null || v === undefined || v === '' || v === false) continue;
    u.searchParams.set(k, String(v));
  }
  const r = await fetch(u, { headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return r.json();
}

export async function post(path, body) {
  const r = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  return r.json();
}

// ── 格式化 ──────────────────────────────────────────────────────────────
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** 概率 → 美分。0.325 → "32.5"，没有值 → "--" */
export function cents(p, digits = 1) {
  if (!isNum(p)) return '--';
  return (p * 100).toFixed(digits);
}

/** 24h 变动（概率单位）→ 带符号的美分，0.031 → "+3.1" */
export function chgCents(v, digits = 1) {
  if (!isNum(v) || v === 0) return '0.0';
  const s = (v * 100).toFixed(digits);
  return v > 0 ? `+${s}` : s;
}

/** 金额 → 中文数量级。1_200_000 → "$120万"；3e8 → "$3.00亿" */
export function money(v) {
  if (!isNum(v) || v === 0) return '--';
  const a = Math.abs(v);
  if (a >= 1e8) return `$${(v / 1e8).toFixed(2)}亿`;
  if (a >= 1e4) return `$${(v / 1e4).toFixed(a >= 1e6 ? 0 : 1)}万`;
  return `$${Math.round(v).toLocaleString('en-US')}`;
}

/** 紧凑金额，列宽紧张时用。1_200_000 → "120万" */
export function moneyShort(v) {
  const s = money(v);
  return s === '--' ? s : s.replace('$', '');
}

/** 距离结算还有多久。已过 → "已结束" */
export function untilText(ts) {
  if (!isNum(ts)) return '';
  const d = ts - Date.now();
  if (d < 0) return '已结束';
  const h = d / 3600_000;
  if (h < 1) return `${Math.max(1, Math.round(d / 60_000))} 分钟`;
  if (h < 48) return `${Math.round(h)} 小时`;
  const days = h / 24;
  if (days < 60) return `${Math.round(days)} 天`;
  const mo = days / 30.44;
  if (mo < 24) return `${Math.round(mo)} 个月`;
  return `${(days / 365.25).toFixed(1)} 年`;
}

export function dateText(ts) {
  if (!isNum(ts)) return '未标注';
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function timeText(ts) {
  if (!isNum(ts)) return '--';
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

/** 涨跌配色：红涨绿跌（同花顺习惯）。0 或无值给中性色 */
export function trendCls(v) {
  if (!isNum(v) || v === 0) return 'flat';
  return v > 0 ? 'up' : 'dn';
}

export function cls(...xs) {
  return xs.filter(Boolean).join(' ');
}

// ── 单元格取价 ──────────────────────────────────────────────────────────
/**
 * 单元格的「当前价」：有实时中间价就用实时的，否则用同步时的快照价。
 * side = 'pos' | 'neg'
 *
 * 实时层只订正向（省订阅额度），所以反向价 = 1 - 正向实时价。
 * 这样鼠标看到的两个方向永远是自洽的，不会出现 Yes 跳了 No 没跳。
 */
export function cellPrice(cell, side) {
  if (!cell) return null;
  const live = cell.live;
  if (live && isNum(live.mid)) {
    if (live.side === side) return live.mid;
    return 1 - live.mid;
  }
  return isNum(cell[side]) ? cell[side] : null;
}

/** 该单元格用于跳转的外链 */
export function cellUrl(cell) {
  return cell?.url || '';
}

// ── URL 状态（可收藏的筛选视图）────────────────────────────────────────
// 用 hash 而不是 query：刷新不回服务端，前进后退也自然。
export function readHash() {
  const raw = location.hash.replace(/^#/, '');
  if (!raw) return {};
  const out = {};
  for (const [k, v] of new URLSearchParams(raw)) out[k] = v;
  return out;
}

export function writeHash(obj, defaults = {}) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined || v === '' || v === false) continue;
    if (String(v) === String(defaults[k] ?? '')) continue; // 默认值不写进 URL，保持链接干净
    p.set(k, String(v));
  }
  const s = p.toString();
  const next = s ? `#${s}` : ' ';
  if (location.hash.replace(/^#/, '') !== s) history.replaceState(null, '', next === ' ' ? location.pathname : next);
}

// ── 杂项 ────────────────────────────────────────────────────────────────
export function debounce(fn, ms) {
  let t;
  const wrapped = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  wrapped.cancel = () => clearTimeout(t);
  return wrapped;
}

/** 复制到剪贴板，返回是否成功（http 页面下 clipboard API 不可用要兜底） */
export async function copy(text) {
  try { await navigator.clipboard.writeText(text); return true; }
  catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch { return false; }
  }
}
