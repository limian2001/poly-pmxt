// 应用外壳：配置、筛选栏、取数、SSE、状态条
// ---------------------------------------------------------------------------
// 一个页面搞定原来的「全市场大盘」和「跨平台匹配」两页：
// 主区 = 以 Polymarket 为锚的标的（其他平台匹配过来），次要区 = 锚平台没有的标的。
import { html, render, useState, useEffect, useRef, useMemo, Fragment } from './preact.js';
import { api, post, money, untilText, cls, readHash, writeHash, debounce, venueMeta } from './lib.js';
import { Board } from './board.js';
import { Detail } from './detail.js';

const DEFAULTS = {
  q: '', cat: '', tag: '', sort: 'heat', dir: 'desc', end: '', ven: '', mv: '',
  minv: '', ended: '0', sec: 'main', page: '0', limit: '60',
};
const ENDING = [
  { v: '', label: '不限到期' }, { v: '24', label: '24 小时内结算' },
  { v: '72', label: '3 天内结算' }, { v: '168', label: '7 天内结算' }, { v: '720', label: '30 天内结算' },
];
const MINVOL = [
  { v: '', label: '成交额不限' }, { v: '10000', label: '24h ≥ 1 万' },
  { v: '100000', label: '24h ≥ 10 万' }, { v: '1000000', label: '24h ≥ 100 万' },
];
const SORTS = [
  { v: 'heat', label: '热度（推荐）' }, { v: 'vol24h', label: '24h 成交额' },
  { v: 'volume', label: '总成交额' }, { v: 'liquidity', label: '流动性' },
  { v: 'chg', label: '24h 波动' }, { v: 'spread', label: '跨平台价差' },
  { v: 'ending', label: '临近结算' }, { v: 'venues', label: '覆盖平台数' },
];

// ── 把一帧 ticks 打进当前行数据 ─────────────────────────────────────────
// 只克隆被打到的行和单元格：600 行的表每 400ms 全量克隆一次会很肉。
function applyTicks(rows, ticks) {
  if (!ticks?.length) return rows;
  const byRow = new Map();
  for (const t of ticks) {
    if (!byRow.has(t.rowId)) byRow.set(t.rowId, []);
    byRow.get(t.rowId).push(t);
  }
  let changed = false;
  const out = rows.map((r) => {
    const list = byRow.get(r.id);
    if (!list) return r;
    changed = true;
    const row = { ...r };
    const patch = (holder, t) => {
      const cell = holder.cells?.[t.venue];
      if (!cell) return holder;
      return {
        ...holder,
        cells: {
          ...holder.cells,
          [t.venue]: { ...cell, live: { side: t.side, mid: t.pos, bid: t.bid, ask: t.ask, spread: t.spread, ts: t.ts } },
        },
      };
    };
    for (const t of list) {
      if (t.childId) {
        const i = (row.children || []).findIndex((c) => c.id === t.childId);
        if (i < 0) continue;
        const kids = [...row.children];
        kids[i] = patch(kids[i], t);
        row.children = kids;
      } else {
        Object.assign(row, patch(row, t));
      }
    }
    return row;
  });
  return changed ? out : rows;
}

// ── 运维状态条（宿主机 cron 写的 status.json，网关只读透传）────────────
function OpsBar() {
  const [ops, setOps] = useState(null);
  useEffect(() => {
    let dead = false;
    const load = () => fetch('/ops').then((r) => r.json()).then((d) => { if (!dead) setOps(d); }).catch(() => {});
    load();
    const id = setInterval(load, 30_000);
    return () => { dead = true; clearInterval(id); };
  }, []);
  if (!ops || ops.error) return html`<span class="status" title=${ops?.error || ''}>运维 —</span>`;
  const d = ops.disk || {}, p = d.usePct;
  const dcol = p >= 85 ? 'var(--red)' : p >= 70 ? 'var(--amb)' : 'var(--grn)';
  const cs = ops.containers || [];
  const isBad = (c) => {
    const s = c.status || '';
    if (/unhealthy|restarting|dead|paused/i.test(s)) return true;
    return /^Exited/i.test(s) && !/Exited \(0\)/.test(s);
  };
  const bad = cs.filter(isBad);
  const gB = (k) => Math.round((k || 0) / 1048576);
  return html`
    <span class="status ops">
      <span title=${`已用 ${p}% · 可用 ${gB(d.availKB)}G / 共 ${gB(d.totalKB)}G`}>
        <span class="dot" style=${{ background: dcol }}></span>磁盘 ${p == null ? '—' : `${p}%`}
      </span>
      <span title=${bad.length ? `异常: ${bad.map((c) => `${c.name}(${c.status})`).join(', ')}` : '全部正常'}>
        <span class="dot" style=${{ background: bad.length ? 'var(--red)' : 'var(--grn)' }}></span>
        容器 ${cs.length - bad.length}/${cs.length}
      </span>
    </span>`;
}

// ── 同步 / 推送状态 ─────────────────────────────────────────────────────
function SyncBar({ stats, sseState, onRefresh, syncing }) {
  const [, tick] = useState(0);
  useEffect(() => { const id = setInterval(() => tick((n) => n + 1), 10_000); return () => clearInterval(id); }, []);
  const ago = stats?.lastSyncAt ? untilText(Date.now() * 2 - stats.lastSyncAt) : null; // 反推「多久之前」
  const rt = sseState === 'open' ? { c: 'var(--grn)', t: '实时推送已连接' }
    : sseState === 'connecting' ? { c: 'var(--amb)', t: '实时推送连接中' }
    : { c: 'var(--red)', t: '实时推送断开（会自动重连）' };
  return html`
    <span class="status ops">
      <span title=${rt.t}><span class="dot" style=${{ background: rt.c }}></span>实时</span>
      <span title=${stats?.lastSyncAt ? `上次同步 ${new Date(stats.lastSyncAt).toLocaleString('zh-CN')}` : '尚未同步'}>
        目录 ${ago ? `${ago}前` : '—'}${stats?.stale ? '（快照）' : ''}
      </span>
      <button class="btn ghost xs" onClick=${onRefresh} disabled=${syncing}>${syncing ? '同步中…' : '立即同步'}</button>
    </span>`;
}

// ── 根组件 ──────────────────────────────────────────────────────────────
function App() {
  const h0 = readHash();
  const [cfg, setCfg] = useState(null);
  const [facets, setFacets] = useState({ categories: [], tags: [], venues: [] });
  const [stats, setStats] = useState(null);

  const [f, setF] = useState({ ...DEFAULTS, ...h0 });
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [secTotal, setSecTotal] = useState(0); // 该分区未过筛选的总行数，用来分辨「空表」的两种成因
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [expandAll, setExpandAll] = useState(false);
  const [open, setOpen] = useState(h0.open ? { id: h0.open, childId: '' } : null);
  const [sseState, setSseState] = useState('connecting');
  const [syncing, setSyncing] = useState(false);
  const [kw, setKw] = useState(h0.q || '');
  const [lastReq, setLastReq] = useState(''); // 上一次真正发出去的大盘查询，空表时摆给人看

  const set = (patch) => setF((s) => ({ ...s, page: '0', ...patch }));
  const venues = cfg?.venues || facets.venues || [];

  // URL 同步：筛选条件写进 hash，这样一个筛好的视图可以直接收藏/分享
  useEffect(() => {
    writeHash({ ...f, open: open?.id || '' }, DEFAULTS);
  }, [f, open]);

  useEffect(() => {
    api('/config').then(setCfg).catch(() => {});
    api('/api/board/facets').then(setFacets).catch(() => {});
  }, []);

  // 取主表
  const reqId = useRef(0);
  const load = useMemo(() => async (quiet) => {
    const my = ++reqId.current;
    if (!quiet) setLoading(true);
    try {
      const params = {
        section: f.sec, q: f.q, category: f.cat, tag: f.tag,
        sort: f.sort, dir: f.dir,
        endingWithinH: f.end, venues: f.ven, minVenues: f.mv, minVol24h: f.minv,
        hideEnded: f.ended === '1' ? '0' : '1',
        offset: Number(f.page || 0) * Number(f.limit || 60),
        limit: f.limit,
      };
      // 空表的时候把这一串原样摆到页面上。排查「后端有数据、前端 0 行」时，
      // 唯一真正有用的信息就是「浏览器到底问了什么」—— 猜十轮不如看一眼。
      const sent = Object.entries(params)
        .filter(([, v]) => v !== '' && v !== null && v !== undefined && v !== false)
        .map(([k, v]) => `${k}=${v}`).join('&');
      const j = await api('/api/board', params);
      if (my !== reqId.current) return; // 有更新的请求在路上了，丢弃这次
      setLastReq(`/api/board?${sent}`);
      setRows(j.rows || []); setTotal(j.total || 0); setSecTotal(j.sectionTotal || 0); setErr('');
    } catch (e) {
      if (my === reqId.current) setErr(String(e.message || e));
    } finally {
      if (my === reqId.current) setLoading(false);
    }
  }, [f]);

  useEffect(() => { load(); }, [load]);
  // 每 60 秒静默重取一次：成交额、倒计时这些不走推送的字段也得动
  useEffect(() => { const id = setInterval(() => load(true), 60_000); return () => clearInterval(id); }, [load]);
  useEffect(() => {
    const p = () => api('/api/board/stats').then(setStats).catch(() => {});
    p(); const id = setInterval(p, 20_000); return () => clearInterval(id);
  }, []);

  // 搜索框防抖，别按一个字母就打一次接口
  const pushKw = useMemo(() => debounce((v) => set({ q: v }), 300), []);
  useEffect(() => () => pushKw.cancel(), [pushKw]);

  // ── SSE ──────────────────────────────────────────────────────────────
  useEffect(() => {
    if (cfg && cfg.realtime === false) { setSseState('off'); return; }
    let es;
    try { es = new EventSource('/api/stream'); } catch { setSseState('closed'); return; }
    es.onopen = () => setSseState('open');
    es.onerror = () => setSseState('closed'); // EventSource 自己会重连
    es.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.type === 'hello') setSseState('open');
      if (m.type === 'ticks') setRows((rs) => applyTicks(rs, m.ticks));
    };
    return () => es.close();
  }, [cfg?.realtime]);

  const onSort = (key) => setF((s) => ({
    ...s, page: '0', sort: key,
    dir: s.sort === key ? (s.dir === 'desc' ? 'asc' : 'desc') : (key === 'ending' || key === 'title' ? 'asc' : 'desc'),
  }));

  const refresh = async () => {
    setSyncing(true);
    try { await post('/api/board/refresh'); } catch {}
    setTimeout(() => { setSyncing(false); load(true); }, 4000);
  };

  const toggleVenue = (v) => {
    const cur = new Set((f.ven || '').split(',').filter(Boolean));
    cur.has(v) ? cur.delete(v) : cur.add(v);
    set({ ven: [...cur].join(',') });
  };
  const venSel = new Set((f.ven || '').split(',').filter(Boolean));

  const page = Number(f.page || 0), limit = Number(f.limit || 60);
  const pages = Math.max(1, Math.ceil(total / limit));

  // ── 空表的成因诊断 ────────────────────────────────────────────────────
  // 「一条都没有」有两种完全不同的原因，长得却一模一样：
  //   ① 筛选条件太狠 —— 分区里有数据，全被挡掉了（自己点一下就好）
  //   ② 后端没数据 —— 通常是某个平台直连挂了；锚平台一挂，主榜必然全空
  // 上次排查花了两轮才定位到锚平台报 422，就是因为页面只说「没有符合条件的标的」。
  // 现在把 venueHealth 直接摆到空表上，谁挂了、报什么错，一眼可见。
  const anchor = cfg?.anchor || 'polymarket';
  const vh = stats?.venueHealth || {};
  const deadVenues = Object.entries(vh).filter(([, h]) => h && h.ok === false).map(([v, h]) => ({ v, msg: h.msg }));
  const resetFilters = () => setF((s) => ({ ...DEFAULTS, sec: s.sec, limit: s.limit }));
  const filtersActive = f.q || f.cat || f.tag || f.end || f.ven || f.mv || f.minv || f.ended === '1';
  const emptyHint = total > 0 ? null
    : secTotal > 0 ? html`
        <span>这个分区有 <b>${secTotal}</b> 个标的，但当前筛选条件把它们全挡掉了。
          <button class="btn ghost xs" onClick=${resetFilters}>清空筛选</button></span>`
      : deadVenues.length ? html`
        <span>后端这一轮没组装出数据${deadVenues.some((d) => d.v === anchor)
          ? html`：<b>锚定平台 ${venueMeta(anchor).name} 直连失败</b>，主榜必然是空的` : ''}。
          <br/>失败的平台：${deadVenues.map((d) => `${venueMeta(d.v).name}（${d.msg || '未知错误'}）`).join('；')}
          <br/><button class="btn ghost xs" onClick=${refresh} disabled=${syncing}>立即重试同步</button></span>`
      : stats?.lastSyncAt ? html`<span>这个分区暂时没有标的${filtersActive ? '（当前还挂着筛选条件）' : ''}。</span>`
      : html`<span>首轮同步还没跑完，稍等十几秒再看（右上角「目录」会显示同步时间）。</span>`;
  // 不管是哪种成因，都把实际请求附在后面：一张截图就能定位，不用再来回问。
  const emptyBlock = total > 0 ? null : html`
    <${Fragment}>
      ${emptyHint}
      <br/><span class="mut small">本次请求 ${lastReq || '（还没发出）'} · 库存 ${stats?.rowCount ?? '—'} 行</span>
    <//>`;

  return html`
    <${Fragment}>
      <header>
        <h1>全球预测市场行情台</h1>
        <span class="tag">锚定 ${venueMeta(cfg?.anchor || 'polymarket').name}</span>
        <span class="tag">${venues.length} 个平台</span>
        ${cfg && !cfg.matching ? html`<span class="tag warn">未配置匹配 key，只有单平台数据</span>` : null}
        <span class="grow"></span>
        <${SyncBar} stats=${stats} sseState=${sseState} onRefresh=${refresh} syncing=${syncing || stats?.syncing} />
        <${OpsBar} />
      </header>

      <main>
        <div class="filters">
          <div class="segs big">
            <button class=${cls(f.sec === 'main' && 'on')} onClick=${() => set({ sec: 'main' })}
              title=${`以 ${venueMeta(cfg?.anchor || 'polymarket').name} 为核心的标的`}>主榜</button>
            <button class=${cls(f.sec === 'secondary' && 'on')} onClick=${() => set({ sec: 'secondary' })}
              title="锚定平台没有、只在其他平台上线的标的">其他平台独有</button>
          </div>

          <input class="search" type="search" placeholder="搜索标的、分类、候选名…" value=${kw}
            onInput=${(e) => { setKw(e.target.value); pushKw(e.target.value); }} />

          <select value=${f.cat} onChange=${(e) => set({ cat: e.target.value })}>
            <option value="">全部分类</option>
            ${(facets.categories || []).map((c) => html`<option key=${c.key} value=${c.key}>${c.zh || c.key}（${c.count}）</option>`)}
          </select>

          <select value=${f.tag} onChange=${(e) => set({ tag: e.target.value })}>
            <option value="">全部标签</option>
            ${(facets.tags || []).map((t) => html`<option key=${t.key} value=${t.key}>${t.zh || t.key}（${t.count}）</option>`)}
          </select>

          <select value=${f.end} onChange=${(e) => set({ end: e.target.value })}>
            ${ENDING.map((o) => html`<option key=${o.v} value=${o.v}>${o.label}</option>`)}
          </select>

          <select value=${f.minv} onChange=${(e) => set({ minv: e.target.value })}>
            ${MINVOL.map((o) => html`<option key=${o.v} value=${o.v}>${o.label}</option>`)}
          </select>

          <select value=${f.sort} onChange=${(e) => set({ sort: e.target.value })}>
            ${SORTS.map((o) => html`<option key=${o.v} value=${o.v}>按${o.label}</option>`)}
          </select>

          <div class="vchips">
            ${venues.map((v) => html`
              <button key=${v} class=${cls('chip', venSel.has(v) && 'on')} onClick=${() => toggleVenue(v)}
                title=${`只看 ${venueMeta(v).name} 也有的标的`}>
                <span class="vdot" style=${{ background: venueMeta(v).color }}></span>${venueMeta(v).short}
              </button>`)}
            <button class=${cls('chip', f.mv === '2' && 'on')} onClick=${() => set({ mv: f.mv === '2' ? '' : '2' })}
              title="只看至少两个平台都有的标的（能比价）">≥2 平台</button>
            <button class=${cls('chip', f.ended === '1' && 'on')} onClick=${() => set({ ended: f.ended === '1' ? '0' : '1' })}
              title="默认不显示已结算的标的">显示已结束</button>
            <button class=${cls('chip', expandAll && 'on')} onClick=${() => setExpandAll((x) => !x)}
              title="展开所有多候选事件的子行">展开候选</button>
          </div>
        </div>

        <div class="meta">
          <span>共 <b>${total}</b> 个标的${f.sec === 'secondary' ? '（其他平台独有）' : ''}
            ${loading ? ' · 加载中…' : ''}${stats?.stale ? ' · 数据来自上次快照，正在重新同步' : ''}</span>
          <span class="grow"></span>
          <span class="mut small">单击行展开候选 · 双击行看详情 · 价格上悬停看盘口 · 点价格跳转该平台</span>
        </div>

        ${err ? html`<div class="err">取数失败：${err}</div>` : null}

        <${Board} rows=${rows} venues=${venues} sort=${f.sort} dir=${f.dir} onSort=${onSort}
          loading=${loading} expandAll=${expandAll} emptyHint=${emptyBlock}
          onOpen=${(id, childId) => setOpen({ id, childId: childId || '' })} />

        ${pages > 1 ? html`
          <div class="pager">
            <button class="btn ghost" disabled=${page <= 0} onClick=${() => setF((s) => ({ ...s, page: String(page - 1) }))}>上一页</button>
            <span class="mut">第 ${page + 1} / ${pages} 页</span>
            <button class="btn ghost" disabled=${page >= pages - 1} onClick=${() => setF((s) => ({ ...s, page: String(page + 1) }))}>下一页</button>
            <select value=${f.limit} onChange=${(e) => set({ limit: e.target.value })}>
              ${['30', '60', '120', '200'].map((n) => html`<option key=${n} value=${n}>每页 ${n}</option>`)}
            </select>
          </div>` : null}

        <footer class="mut small">
          价格单位为美分（100¢ = 必然发生）。跨平台方向已按锚定平台对齐；标 <b>≈</b> 的格子来自匹配接口兜底，
          标 <b>?</b> 的方向是猜的，标 <b>⇄</b> 的说明该平台 YES/NO 与锚定平台相反已自动翻转。
          目录每 ${cfg?.syncIntervalMin || 15} 分钟同步一次，价格按各平台推送频率实时刷新。
        </footer>
      </main>

      ${open ? html`<${Detail} openId=${open.id} openChildId=${open.childId} onClose=${() => setOpen(null)} />` : null}
    <//>`;
}

render(html`<${App} />`, document.getElementById('app'));
