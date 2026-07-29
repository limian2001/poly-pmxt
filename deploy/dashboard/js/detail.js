// 详情抽屉：走势 / 盘口 / F10 / 成交
// ---------------------------------------------------------------------------
// 双击任意一行打开。多候选事件会多一排候选切换，因为曲线和盘口都是按「候选」取的，
// 父行本身没有自己的行情。
import { html, useState, useEffect, useRef, useMemo, Fragment } from './preact.js';
import {
  api, cents, chgCents, money, moneyShort, untilText, dateText, timeText,
  trendCls, cls, cellPrice, venueMeta, copy,
} from './lib.js';

const TABS = [
  { key: 'chart', label: '走势' },
  { key: 'book', label: '盘口' },
  { key: 'f10', label: 'F10 资料' },
  { key: 'trades', label: '成交' },
];
const RESOS = [
  { key: '1h', label: '1 小时', limit: 168 },
  { key: '1d', label: '1 天', limit: 180 },
];

// ── 迷你 K 线（其实是概率折线）──────────────────────────────────────────
// 不引图表库：一条折线 + 网格 + 十字光标，够看趋势了，也省得再拉一个 CDN。
function Chart({ series, height = 260 }) {
  const wrap = useRef(null);
  const [w, setW] = useState(760);
  const [cx, setCx] = useState(null);

  useEffect(() => {
    if (!wrap.current) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(320, e.contentRect.width)));
    ro.observe(wrap.current);
    return () => ro.disconnect();
  }, []);

  const live = series.filter((s) => s.points.length > 1);
  const geom = useMemo(() => {
    if (!live.length) return null;
    const xs = live.flatMap((s) => s.points.map((p) => p.t));
    const ys = live.flatMap((s) => s.points.map((p) => p.v));
    const t0 = Math.min(...xs), t1 = Math.max(...xs);
    let lo = Math.min(...ys), hi = Math.max(...ys);
    const pad = Math.max(0.02, (hi - lo) * 0.15);
    lo = Math.max(0, lo - pad); hi = Math.min(1, hi + pad);
    if (hi - lo < 0.04) { const m = (hi + lo) / 2; lo = Math.max(0, m - 0.02); hi = Math.min(1, m + 0.02); }
    return { t0, t1: t1 === t0 ? t0 + 1 : t1, lo, hi: hi === lo ? lo + 0.01 : hi };
  }, [live]);

  if (!geom) return html`<div class="empty">这个标的暂时没有历史价格（部分平台不提供 K 线接口）</div>`;

  const P = { l: 44, r: 12, t: 12, b: 24 };
  const iw = w - P.l - P.r, ih = height - P.t - P.b;
  const X = (t) => P.l + ((t - geom.t0) / (geom.t1 - geom.t0)) * iw;
  const Y = (v) => P.t + (1 - (v - geom.lo) / (geom.hi - geom.lo)) * ih;

  const yTicks = 4;
  const grid = Array.from({ length: yTicks + 1 }, (_, i) => geom.lo + ((geom.hi - geom.lo) * i) / yTicks);
  const xTicks = 5;
  const xs = Array.from({ length: xTicks + 1 }, (_, i) => geom.t0 + ((geom.t1 - geom.t0) * i) / xTicks);

  // 十字光标：找每条线上离光标最近的点
  const at = cx == null ? null : geom.t0 + ((cx - P.l) / iw) * (geom.t1 - geom.t0);
  const readouts = at == null ? [] : live.map((s) => {
    let best = null, bd = Infinity;
    for (const p of s.points) { const d = Math.abs(p.t - at); if (d < bd) { bd = d; best = p; } }
    return { venue: s.venue, color: s.color, p: best };
  }).filter((r) => r.p);

  const onMove = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - r.left;
    setCx(x >= P.l && x <= P.l + iw ? x : null);
  };

  return html`
    <div class="chart" ref=${wrap}>
      <svg width=${w} height=${height} onMouseMove=${onMove} onMouseLeave=${() => setCx(null)}>
        ${grid.map((v) => html`
          <${Fragment}>
            <line x1=${P.l} x2=${P.l + iw} y1=${Y(v)} y2=${Y(v)} class="gl" />
            <text x=${P.l - 8} y=${Y(v) + 4} class="ax" text-anchor="end">${cents(v, 0)}¢</text>
          <//>`)}
        ${xs.map((t, i) => html`
          <text x=${X(t)} y=${height - 6} class="ax" text-anchor=${i === 0 ? 'start' : i === xTicks ? 'end' : 'middle'}>
            ${new Date(t).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })}
          </text>`)}
        ${live.map((s) => html`
          <path d=${s.points.map((p, i) => `${i ? 'L' : 'M'}${X(p.t).toFixed(1)},${Y(p.v).toFixed(1)}`).join('')}
                fill="none" stroke=${s.color} stroke-width="1.8" stroke-linejoin="round" />`)}
        ${cx != null ? html`<line x1=${cx} x2=${cx} y1=${P.t} y2=${P.t + ih} class="cross" />` : null}
      </svg>
      <div class="legend">
        ${live.map((s) => {
          const r = readouts.find((x) => x.venue === s.venue);
          const last = s.points[s.points.length - 1];
          return html`
            <span class="lg">
              <i style=${{ background: s.color }}></i>${venueMeta(s.venue).name}
              <b>${cents((r?.p || last).v)}¢</b>
              ${r ? html`<span class="mut">${new Date(r.p.t).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>` : null}
            </span>`;
        })}
      </div>
    </div>`;
}

// ── 单个平台的完整盘口 ──────────────────────────────────────────────────
function VenueBook({ venue, cell }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const meta = venueMeta(venue);

  useEffect(() => {
    let dead = false;
    setD(null); setErr('');
    if (!cell?.posOid) { setErr('无正向结果 id'); return; }
    api('/api/book', { venue, outcomeId: cell.posOid })
      .then((j) => { if (dead) return; if (j.error) setErr(j.error); setD(j); })
      .catch((e) => { if (!dead) setErr(String(e.message || e)); });
    return () => { dead = true; };
  }, [venue, cell?.posOid]);

  const bids = (d?.bids || []).slice(0, 10);
  const asks = (d?.asks || []).slice(0, 10).reverse();
  const maxSize = Math.max(1, ...[...bids, ...asks].map((l) => l.s || 0));
  const line = (l, side) => html`
    <div class="bk-l">
      <span class="bk-bar ${side}" style=${{ width: `${Math.round(((l.s || 0) / maxSize) * 100)}%` }}></span>
      <span class="bk-p ${side}">${cents(l.p)}</span>
      <span class="bk-s">${moneyShort(l.s)}</span>
    </div>`;

  return html`
    <div class="vbook">
      <div class="vb-h">
        <span class="vdot" style=${{ background: meta.color }}></span><b>${meta.name}</b>
        ${cell?.url ? html`<a href=${cell.url} target="_blank" rel="noopener noreferrer" class="ext">打开 ↗</a>` : null}
      </div>
      ${!d && !err ? html`<div class="bk-empty">加载中…</div>` : null}
      ${(bids.length || asks.length) ? html`
        <div class="bk-b">
          ${asks.map((l) => line(l, 'ask'))}
          <div class="bk-mid"><span>中间价 ${d?.mid != null ? cents(d.mid) : '--'}¢</span><span class="mut">价差 ${d?.spread != null ? cents(d.spread) : '--'}</span></div>
          ${bids.map((l) => line(l, 'bid'))}
        </div>` : (d || err) ? html`<div class="bk-empty">该平台不提供盘口${err ? `（${err.slice(0, 60)}）` : ''}</div>` : null}
    </div>`;
}

// ── 最近成交 ────────────────────────────────────────────────────────────
// 注意字段名：网关 fetchRecentTrades 吐出来的是紧凑字段 {t,p,s,side}，
// 和 K 线的 {t,o,h,l,c,v} 一个路数（省 SSE/JSON 体积）。
// 下面读的时候 t.t / t.p / t.s 才是真正生效的，后面那串 ?? 只是兜底，别删。
function Trades({ venue, cell }) {
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    let dead = false;
    setRows(null); setErr('');
    if (!cell?.posOid) return;
    api('/api/trades', { venue, outcomeId: cell.posOid, limit: 40 })
      .then((j) => { if (dead) return; setRows(j.trades || []); if (j.error) setErr(j.error); })
      .catch((e) => { if (!dead) setErr(String(e.message || e)); });
    return () => { dead = true; };
  }, [venue, cell?.posOid]);

  const meta = venueMeta(venue);
  return html`
    <div class="vtrades">
      <div class="vb-h"><span class="vdot" style=${{ background: meta.color }}></span><b>${meta.name}</b></div>
      ${rows === null ? html`<div class="bk-empty">加载中…</div>` : null}
      ${rows && !rows.length ? html`<div class="bk-empty">该平台不提供成交明细${err ? `（${err.slice(0, 40)}）` : ''}</div>` : null}
      ${rows?.length ? html`
        <table class="mini">
          <thead><tr><th class="l">时间</th><th>价格</th><th>数量</th><th>方向</th></tr></thead>
          <tbody>${rows.slice(0, 30).map((t, i) => html`
            <tr key=${i}>
              <td class="l mut">${timeText(t.t ?? t.ts ?? t.timestamp)}</td>
              <td class="num">${cents(t.p ?? t.price)}</td>
              <td class="num">${moneyShort(t.s ?? t.size)}</td>
              <td class=${cls('num', t.side === 'buy' ? 'up' : t.side === 'sell' ? 'dn' : 'mut')}>
                ${t.side === 'buy' ? '买' : t.side === 'sell' ? '卖' : '--'}
              </td>
            </tr>`)}
          </tbody>
        </table>` : null}
    </div>`;
}

// ── F10 资料 ────────────────────────────────────────────────────────────
const HEAT_LABEL = {
  vol24h: '24h 成交额', liquidity: '盘口厚度', volume: '累计成交额',
  chg: '24h 波动', near: '临近结算', cover: '平台覆盖',
};

function F10({ row, holder }) {
  const he = row.heatExplain;
  const [copied, setCopied] = useState(false);
  const share = async () => {
    const ok = await copy(`${location.origin}${location.pathname}#open=${encodeURIComponent(row.id)}`);
    setCopied(ok); setTimeout(() => setCopied(false), 1500);
  };

  return html`
    <div class="f10">
      <section>
        <h4>基本信息</h4>
        <dl>
          <dt>标的</dt><dd>${row.title}</dd>
          <dt>分类</dt><dd>${row.category || '未分类'}</dd>
          <dt>标签</dt><dd>${(row.tags || []).join('、') || '无'}</dd>
          <dt>结算日期</dt><dd>${dateText(row.resolutionDate)}${row.resolutionDate ? `（还有 ${untilText(row.resolutionDate)}）` : ''}</dd>
          <dt>锚定平台</dt><dd>${venueMeta(row.anchorVenue).name}</dd>
          <dt>覆盖平台</dt><dd>${(row.venues || []).map((v) => venueMeta(v).name).join('、') || '无'}</dd>
          <dt>类型</dt><dd>${row.kind === 'multi' ? `多候选（${row.childCount} 个）` : '二元'}</dd>
          <dt>行 ID</dt><dd class="mono">${row.id} <button class="mini-btn" onClick=${share}>${copied ? '已复制' : '复制链接'}</button></dd>
        </dl>
      </section>

      <section>
        <h4>跨平台匹配</h4>
        ${row.venues?.length > 1 ? html`
          <dl>
            <dt>匹配来源</dt><dd>${row.matchSource === 'cluster' ? 'pmxt 托管匹配引擎' : row.matchSource === 'anchor-only' ? '仅锚定平台' : row.matchSource}</dd>
            <dt>置信度</dt><dd>${row.confidence != null ? `${(row.confidence * 100).toFixed(0)}%` : '未提供'}</dd>
            <dt>集群 ID</dt><dd class="mono">${row.clusterId || '--'}</dd>
          </dl>
          ${row.rawMatches?.length ? html`
            <table class="mini">
              <thead><tr><th class="l">A 市场</th><th class="l">B 市场</th><th>得分</th><th class="l">依据</th></tr></thead>
              <tbody>${row.rawMatches.map((m, i) => html`
                <tr key=${i}>
                  <td class="l mono">${m.a || '--'}</td><td class="l mono">${m.b || '--'}</td>
                  <td class="num">${m.score != null ? m.score.toFixed(2) : '--'}</td>
                  <td class="l mut">${m.reason || '--'}</td>
                </tr>`)}
              </tbody>
            </table>`
            : html`<p class="mut">托管接口这次没返回匹配明细。</p>`}`
          : html`<p class="mut">目前只有 ${venueMeta(row.anchorVenue).name} 上线了这个标的，没有可比价的对手盘。</p>`}
      </section>

      <section>
        <h4>各平台报价</h4>
        <table class="mini">
          <thead><tr><th class="l">平台</th><th>正向</th><th>反向</th><th>24h</th><th>24h 成交额</th><th>流动性</th><th class="l">数据来源</th></tr></thead>
          <tbody>${Object.entries(holder.cells || {}).map(([v, c]) => html`
            <tr key=${v}>
              <td class="l"><span class="vdot" style=${{ background: venueMeta(v).color }}></span>${venueMeta(v).name}</td>
              <td class="num">${cents(cellPrice(c, 'pos'))}</td>
              <td class="num">${cents(cellPrice(c, 'neg'))}</td>
              <td class=${cls('num', trendCls(c.chg24h))}>${chgCents(c.chg24h)}</td>
              <td class="num">${money(c.vol24h)}</td>
              <td class="num">${money(c.liquidity)}</td>
              <td class="l mut">
                ${c.partial ? '匹配接口兜底' : '直连行情'}${c.live ? ' · 实时' : ''}
                ${c.flipped ? ' · 已翻转对齐' : ''}${c.weak ? ' · 方向存疑' : ''}
              </td>
            </tr>`)}
          </tbody>
        </table>
        <p class="mut small">
          正向 = ${holder.cells?.[row.anchorVenue]?.posLabel || 'YES'}；
          反向 = ${holder.cells?.[row.anchorVenue]?.negLabel || 'NO'}。
          各平台方向已按锚定平台对齐，标「已翻转对齐」的说明它自己的 YES 对应我们的反向。
        </p>
      </section>

      ${he ? html`
        <section>
          <h4>为什么排在这个位置</h4>
          <p class="mut small">综合热度 ${(he.total * 100).toFixed(1)} 分（满分 100）。分项：</p>
          <table class="mini">
            <thead><tr><th class="l">分项</th><th>原始值</th><th>得分</th><th>权重</th><th>贡献</th></tr></thead>
            <tbody>${Object.entries(he.parts).map(([k, p]) => html`
              <tr key=${k}>
                <td class="l">${HEAT_LABEL[k] || k}</td>
                <td class="num mut">${k === 'chg' ? chgCents(p.raw) : k === 'near' ? dateText(p.raw) : k === 'cover' ? `${p.raw} 个` : money(p.raw)}</td>
                <td class="num">${(p.score * 100).toFixed(0)}</td>
                <td class="num mut">${(p.weight * 100).toFixed(0)}%</td>
                <td class="num"><span class="hbar" style=${{ width: `${Math.round(p.contrib * 220)}px` }}></span>${(p.contrib * 100).toFixed(1)}</td>
              </tr>`)}
            </tbody>
          </table>
        </section>` : null}
    </div>`;
}

// ── 抽屉本体 ────────────────────────────────────────────────────────────
export function Detail({ openId, openChildId, onClose }) {
  const [row, setRow] = useState(null);
  const [err, setErr] = useState('');
  const [tab, setTab] = useState('chart');
  const [childId, setChildId] = useState(openChildId || '');
  const [reso, setReso] = useState('1h');
  const [series, setSeries] = useState([]);
  const [loadingChart, setLoadingChart] = useState(false);

  useEffect(() => { setChildId(openChildId || ''); }, [openChildId, openId]);

  useEffect(() => {
    let dead = false;
    setRow(null); setErr('');
    api(`/api/board/row/${encodeURIComponent(openId)}`)
      .then((j) => !dead && setRow(j))
      .catch((e) => !dead && setErr(String(e.message || e)));
    return () => { dead = true; };
  }, [openId]);

  // ESC 关闭
  useEffect(() => {
    const h = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);

  const holder = useMemo(() => {
    if (!row) return null;
    if (row.kind !== 'multi') return row;
    return (row.children || []).find((c) => c.id === childId) || row.children?.[0] || { cells: {} };
  }, [row, childId]);

  // 曲线：每个平台各取一条，失败的平台安静地跳过
  useEffect(() => {
    if (!holder || tab !== 'chart') return;
    let dead = false;
    const cells = Object.entries(holder.cells || {}).filter(([, c]) => c.posOid && !c.partial);
    if (!cells.length) { setSeries([]); return; }
    setLoadingChart(true);
    const r = RESOS.find((x) => x.key === reso) || RESOS[0];
    Promise.all(cells.map(([v, c]) =>
      api('/api/ohlcv', { venue: v, outcomeId: c.posOid, resolution: r.key, limit: r.limit })
        .then((j) => ({
          venue: v, color: venueMeta(v).color,
          // 网关 fetchCandles 输出的是紧凑字段 {t,o,h,l,c,v}（省 SSE/JSON 体积）。
          // 后面的 ?? 只是兜底，别删——真正生效的是 k.t / k.c。
          points: (j.candles || [])
            .map((k) => ({ t: k.t ?? k.ts ?? k.timestamp, v: k.c ?? k.close }))
            .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.v))
            .sort((a, b) => a.t - b.t),
        }))
        .catch(() => ({ venue: v, color: venueMeta(v).color, points: [] }))))
      .then((s) => { if (!dead) { setSeries(s); setLoadingChart(false); } });
    return () => { dead = true; };
  }, [holder, tab, reso]);

  const cellList = Object.entries(holder?.cells || {});

  return html`
    <${Fragment}>
      <div class="scrim" onClick=${onClose}></div>
      <aside class="drawer">
        <header>
          <div class="dt">
            <div class="dtitle">${row?.title || (err ? '加载失败' : '加载中…')}</div>
            <div class="dsub">
              ${row ? html`
                <${Fragment}>
                  <span class="badge cat">${row.category || '未分类'}</span>
                  ${(row.tags || []).slice(0, 4).map((t) => html`<span class="badge">${t}</span>`)}
                  <span class="mut">结算 ${dateText(row.resolutionDate)}${row.resolutionDate ? ` · 还有 ${untilText(row.resolutionDate)}` : ''}</span>
                  <span class="mut">24h ${money(row.vol24h)}</span>
                <//>` : null}
            </div>
          </div>
          <button class="x" onClick=${onClose} title="关闭（Esc）">✕</button>
        </header>

        ${err ? html`<div class="derr">${err}</div>` : null}

        ${row?.kind === 'multi' ? html`
          <div class="chips">
            <span class="mut">候选：</span>
            ${(row.children || []).map((c) => html`
              <button key=${c.id} class=${cls('chip', (childId || row.children[0].id) === c.id && 'on')}
                onClick=${() => setChildId(c.id)}>
                ${c.label} <b>${cents(cellPrice(c.cells?.[row.anchorVenue], 'pos'))}¢</b>
              </button>`)}
          </div>` : null}

        <nav class="dtabs">
          ${TABS.map((t) => html`
            <button key=${t.key} class=${cls(tab === t.key && 'on')} onClick=${() => setTab(t.key)}>${t.label}</button>`)}
          <span class="grow"></span>
          ${tab === 'chart' ? html`
            <div class="segs">
              ${RESOS.map((r) => html`
                <button key=${r.key} class=${cls(reso === r.key && 'on')} onClick=${() => setReso(r.key)}>${r.label}</button>`)}
            </div>` : null}
          ${cellList.map(([v, c]) => c.url ? html`
            <a key=${v} class="vlink" href=${c.url} target="_blank" rel="noopener noreferrer" title=${`在 ${venueMeta(v).name} 打开`}>
              <span class="vdot" style=${{ background: venueMeta(v).color }}></span>${venueMeta(v).short} ↗
            </a>` : null)}
        </nav>

        <div class="dbody">
          ${!row && !err ? html`<div class="empty">加载中…</div>` : null}
          ${row && tab === 'chart' ? html`
            <${Fragment}>
              ${loadingChart ? html`<div class="empty">拉取历史价格…</div>` : html`<${Chart} series=${series} />`}
              <p class="mut small">曲线取各平台「正向」结果的收盘概率。缺线通常是该平台不提供 K 线接口。</p>
            <//>` : null}
          ${row && tab === 'book' ? html`
            <div class="cols">${cellList.map(([v, c]) => html`<${VenueBook} key=${v} venue=${v} cell=${c} />`)}</div>` : null}
          ${row && tab === 'trades' ? html`
            <div class="cols">${cellList.map(([v, c]) => html`<${Trades} key=${v} venue=${v} cell=${c} />`)}</div>` : null}
          ${row && tab === 'f10' ? html`<${F10} row=${row} holder=${holder} />` : null}
        </div>
      </aside>
    <//>`;
}
