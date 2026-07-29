// 行情主表 —— 参照同花顺的密集表格：一行一个标的，右边铺开各方向 × 各平台的价格
// ---------------------------------------------------------------------------
// 表头是两层：
//     标的            |      正向 (YES)      |       反向 (NO)      | 涨跌 成交额 ...
//                     | POLY  KALSHI  LMTLS  | POLY  KALSHI  LMTLS  |
// 平台列是固定的（取自 /config 的启用平台），某个平台没有这个标的就显示 "--"。
// 固定列比「有几个平台就画几列」好扫 —— 眼睛不用每行重新找列。
//
// 多候选事件（世界杯冠军这种）折叠成父行，父行价格位展示「领先候选」的价，
// 点一下展开子行，每个候选一行。
import { html, useState, useEffect, useRef, memo, Fragment } from './preact.js';
import {
  api, cents, chgCents, money, moneyShort, untilText, dateText, trendCls, cls,
  cellPrice, venueMeta,
} from './lib.js';

const SIDES = [
  { key: 'pos', label: '正向', hint: 'YES / 会发生' },
  { key: 'neg', label: '反向', hint: 'NO / 不会发生' },
];

// ── 悬停盘口 ────────────────────────────────────────────────────────────
// 单独提出来做成一个浮层，避免每个单元格都挂一个 DOM。
// 失败是常态（有的平台不给盘口），所以失败就显示一行灰字，不弹错误。
function BookPop({ at }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    let dead = false;
    setData(null); setErr('');
    api('/api/book', { venue: at.venue, outcomeId: at.outcomeId })
      .then((j) => { if (dead) return; if (j.error) setErr(j.error); setData(j); })
      .catch((e) => { if (!dead) setErr(String(e.message || e)); });
    return () => { dead = true; };
  }, [at.venue, at.outcomeId]);

  const bids = (data?.bids || []).slice(0, 5);
  const asks = (data?.asks || []).slice(0, 5).reverse();
  const maxSize = Math.max(1, ...[...bids, ...asks].map((l) => l.s || 0));
  const meta = venueMeta(at.venue);

  // 靠右会超出视口时翻到左边；靠下同理
  const w = 232, hEst = 214;
  const left = Math.min(at.x + 14, window.innerWidth - w - 10);
  const top = at.y + hEst > window.innerHeight - 8 ? Math.max(8, at.y - hEst - 8) : at.y + 14;

  const depth = (l, side) => html`
    <div class="bk-l">
      <span class="bk-bar ${side}" style=${{ width: `${Math.round(((l.s || 0) / maxSize) * 100)}%` }}></span>
      <span class="bk-p ${side}">${cents(l.p)}</span>
      <span class="bk-s">${moneyShort(l.s)}</span>
    </div>`;

  return html`
    <div class="bookpop" style=${{ left: `${left}px`, top: `${top}px`, width: `${w}px` }}>
      <div class="bk-h">
        <span class="vdot" style=${{ background: meta.color }}></span>
        <b>${meta.name}</b>
        <span class="mut">${at.label}</span>
      </div>
      ${!data && !err && html`<div class="bk-empty">加载盘口…</div>`}
      ${data && !bids.length && !asks.length && html`<div class="bk-empty">${err ? '该平台暂无盘口' : '盘口为空'}</div>`}
      ${(bids.length || asks.length) ? html`
        <div class="bk-b">
          ${asks.map((l) => depth(l, 'ask'))}
          <div class="bk-mid">
            <span>中间价 ${data?.mid != null ? cents(data.mid) : '--'}¢</span>
            <span class="mut">价差 ${data?.spread != null ? cents(data.spread, 1) : '--'}</span>
          </div>
          ${bids.map((l) => depth(l, 'bid'))}
        </div>` : null}
      <div class="bk-f mut">点击价格 → 打开 ${meta.name}</div>
    </div>`;
}

// ── 价格单元格 ──────────────────────────────────────────────────────────
const PriceCell = memo(function PriceCell({ cell, side, venue, onHover, onLeave }) {
  const p = cellPrice(cell, side);
  const prev = useRef(p);
  const [flash, setFlash] = useState('');

  useEffect(() => {
    if (prev.current != null && p != null && p !== prev.current) {
      setFlash(p > prev.current ? 'fu' : 'fd');
      const t = setTimeout(() => setFlash(''), 800);
      prev.current = p;
      return () => clearTimeout(t);
    }
    prev.current = p;
  }, [p]);

  // side 也写进 class：CSS 要靠 `.px.pos + .px.neg` 找到正向/反向两组之间的分界线，
  // 好在那里画一道竖线。空格子同样要带 side，否则最后一个正向格恰好为空时分界线就断了。
  if (!cell || p == null) {
    return html`<td class=${cls('px', side, 'empty')} title=${`${venueMeta(venue).name} 没有这个标的`}>--</td>`;
  }

  const oid = side === 'pos' ? cell.posOid : cell.negOid;
  const label = side === 'pos' ? cell.posLabel : cell.negLabel;
  const marks = [];
  if (cell.partial) marks.push({ t: '≈', tip: '该平台的价格来自匹配接口，没有直连行情，可能滞后' });
  if (cell.weak) marks.push({ t: '?', tip: '方向是按结果顺序猜的，跨平台比价请谨慎' });
  if (cell.flipped) marks.push({ t: '⇄', tip: '该平台的 YES/NO 与锚定平台相反，已自动对齐' });
  if (side === 'neg' && cell.negImplied) marks.push({ t: '*', tip: '反向价由 1 − 正向价推算，非平台报价' });

  const go = (e) => {
    e.stopPropagation();
    if (cell.url) window.open(cell.url, '_blank', 'noopener,noreferrer');
  };

  return html`
    <td
      class=${cls('px', side, flash, cell.partial && 'part', cell.live && 'hasLive')}
      onMouseEnter=${(e) => oid && onHover(e, { venue, outcomeId: oid, label: label || side })}
      onMouseLeave=${onLeave}
      onClick=${go}
      title=${cell.url ? `${venueMeta(venue).name} · ${label || ''} · 点击打开` : label || ''}
    >
      <span class="v">${cents(p)}</span>
      ${marks.length ? html`<span class="mk" title=${marks.map((m) => m.tip).join('\n')}>${marks.map((m) => m.t).join('')}</span>` : null}
    </td>`;
});

// ── 标的名称格 ──────────────────────────────────────────────────────────
function TitleCell({ row, child, expanded, onToggle }) {
  if (child) {
    return html`
      <td class="l tt child">
        <span class="ind"></span>
        <span class="nm">${child.label}</span>
        ${child.venues?.length > 1 ? html`<span class="vs">${child.venues.length} 平台</span>` : null}
      </td>`;
  }
  const multi = row.kind === 'multi';
  const ended = row.ended;
  return html`
    <td class="l tt">
      ${multi
        ? html`<button class=${cls('tg', expanded && 'on')} onClick=${(e) => { e.stopPropagation(); onToggle(); }}
              title=${expanded ? '收起候选' : `展开 ${row.childCount} 个候选`}>${expanded ? '▾' : '▸'}</button>`
        : html`<span class="tg ph"></span>`}
      <div class="tw">
        <div class="nm" title=${row.title}>
          ${row.title}
          ${ended ? html`<span class="badge end">已结束</span>` : null}
        </div>
        <div class="sub">
          ${row.category ? html`<span class="badge cat">${row.category}</span>` : null}
          ${(row.tags || []).slice(0, 3).map((t) => html`<span class="badge">${t}</span>`)}
          ${multi && row.leader
            ? html`<span class="lead">领先 · ${row.leader.label} ${cents(row.leader.pos)}¢ · 共 ${row.childCount} 个候选</span>`
            : null}
        </div>
      </div>
    </td>`;
}

// ── 一行（父行 + 展开的子行）────────────────────────────────────────────
function BoardRow({ row, venues, expanded, onToggle, onOpen, onHover, onLeave, selected, onSelect }) {
  // 多候选父行的价格位展示领先候选，让折叠状态也有信息量（Polymarket 事件卡就是这么做的）
  const priceHolder = row.kind === 'multi' ? (row.children?.[0] || { cells: {} }) : row;

  const metricCells = (r) => html`
    <${Fragment}>
      <td class=${cls('num', trendCls(r.chg24h))}>${chgCents(r.chg24h)}</td>
      <td class="num">${money(r.vol24h)}</td>
      <td class="num dim">${money(r.volume)}</td>
      <td class="num dim">${money(r.liquidity)}</td>
      <td class=${cls('num', r.spread != null && r.spread >= 0.03 && 'warn')}
          title=${r.spreadPair ? `${venueMeta(r.spreadPair[0]).name} 最低 / ${venueMeta(r.spreadPair[1]).name} 最高` : '各平台正向价的极差'}>
        ${r.spread != null ? cents(r.spread) : '--'}
      </td>
    <//>`;

  return html`
    <${Fragment}>
      <tr
        class=${cls('r', row.kind === 'multi' && 'multi', selected && 'sel', row.ended && 'ended')}
        onClick=${() => { onSelect(row.id); if (row.kind === 'multi') onToggle(); }}
        onDblClick=${() => onOpen(row.id)}
      >
        <${TitleCell} row=${row} expanded=${expanded} onToggle=${onToggle} />
        ${SIDES.map((s) => venues.map((v) => html`
          <${PriceCell} key=${`${s.key}-${v}`} cell=${priceHolder.cells?.[v]} side=${s.key} venue=${v}
            onHover=${onHover} onLeave=${onLeave} />`))}
        ${metricCells(row)}
        <td class="num when" title=${dateText(row.resolutionDate)}>${untilText(row.resolutionDate) || '--'}</td>
      </tr>
      ${expanded && (row.children || []).map((ch) => html`
        <tr class="r ch" key=${ch.id} onDblClick=${() => onOpen(row.id, ch.id)} onClick=${() => onSelect(row.id)}>
          <${TitleCell} row=${row} child=${ch} />
          ${SIDES.map((s) => venues.map((v) => html`
            <${PriceCell} key=${`${ch.id}-${s.key}-${v}`} cell=${ch.cells?.[v]} side=${s.key} venue=${v}
              onHover=${onHover} onLeave=${onLeave} />`))}
          ${metricCells(ch)}
          <td class="num when">${untilText(ch.resolutionDate) || '--'}</td>
        </tr>`)}
    <//>`;
}

// ── 主表 ────────────────────────────────────────────────────────────────
export function Board({ rows, venues, sort, dir, onSort, onOpen, loading, expandAll }) {
  const [expanded, setExpanded] = useState(() => new Set());
  const [sel, setSel] = useState('');
  const [hover, setHover] = useState(null);
  const timer = useRef(null);

  // 「全部展开」开关翻转时，重置一次展开集合
  useEffect(() => {
    if (expandAll) setExpanded(new Set(rows.filter((r) => r.kind === 'multi').map((r) => r.id)));
    else setExpanded(new Set());
  }, [expandAll]);

  const toggle = (id) => setExpanded((s) => {
    const n = new Set(s);
    n.has(id) ? n.delete(id) : n.add(id);
    return n;
  });

  // 悬停 150ms 才拉盘口：鼠标扫过一整行不该触发十几个请求
  const onHover = (e, at) => {
    const rect = e.currentTarget.getBoundingClientRect();
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setHover({ ...at, x: rect.right, y: rect.bottom }), 150);
  };
  const onLeave = () => { clearTimeout(timer.current); setHover(null); };
  useEffect(() => () => clearTimeout(timer.current), []);

  // 空表提示要横跨整张表：标的(1) + 方向(2) × 平台数 + 指标(5) + 到期(1)。
  // 加错了会把表格撑宽，改列的时候记得同步这里。
  const COLS = 1 + venues.length * 2 + 6;

  const th = (key, label, tip) => html`
    <th rowspan="2" class=${cls('num', 'sortable', sort === key && 'on')} onClick=${() => onSort(key)} title=${tip || ''}>
      ${label}${sort === key ? html`<i>${dir === 'asc' ? '▲' : '▼'}</i>` : null}
    </th>`;

  return html`
    <div class="wrap">
      <table class="board">
        <thead>
          <tr>
            <th rowspan="2" class=${cls('l', 'sortable', sort === 'title' && 'on')} onClick=${() => onSort('title')}>
              标的${sort === 'title' ? html`<i>${dir === 'asc' ? '▲' : '▼'}</i>` : null}
            </th>
            ${SIDES.map((s) => html`
              <th colspan=${venues.length} class=${cls('grp', s.key)} title=${s.hint}>${s.label} <span class="mut">${s.hint}</span></th>`)}
            ${th('chg', '24h', '24h 概率变动，单位美分')}
            ${th('vol24h', '24h 成交额')}
            ${th('volume', '总成交额')}
            ${th('liquidity', '流动性')}
            ${th('spread', '价差', '各平台正向价的极差；≥3¢ 标黄')}
            ${th('ending', '到期')}
          </tr>
          <tr class="h2">
            ${SIDES.map((s) => venues.map((v) => html`
              <th class=${cls('vh', s.key)} key=${`${s.key}-${v}`} title=${venueMeta(v).name}>
                <span class="vdot" style=${{ background: venueMeta(v).color }}></span>${venueMeta(v).short}
              </th>`))}
          </tr>
        </thead>
        <tbody>
          ${rows.map((r) => html`
            <${BoardRow} key=${r.id} row=${r} venues=${venues}
              expanded=${expanded.has(r.id)} onToggle=${() => toggle(r.id)}
              onOpen=${onOpen} onHover=${onHover} onLeave=${onLeave}
              selected=${sel === r.id} onSelect=${setSel} />`)}
          ${!rows.length && !loading && html`
            <tr><td colspan=${COLS} class="none">
              没有符合条件的标的。把筛选放宽一点，或者点右上角「立即同步」拉一轮新数据。
            </td></tr>`}
        </tbody>
      </table>
      ${hover ? html`<${BookPop} at=${hover} />` : null}
    </div>`;
}
