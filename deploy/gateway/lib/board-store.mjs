// BoardStore —— 行情看板的有状态聚合层
// ---------------------------------------------------------------------------
// 一句话架构：**结构向托管接口买，价格从直连免费拿。**
//
//   托管 cluster 接口  →  只用来回答「A 站这个市场 == B 站哪个市场」
//   各平台直连         →  价格、24h 涨跌、成交量、流动性、盘口、K 线（0 credit）
//
// 这样拆的好处是：官方没给 cluster 的响应结构定义，字段可能残缺；但我们根本不依赖
// 它的字段，只依赖它的「对应关系」。就算 cluster 里一个价格字段都没有，看板也是满的。
//
// 行模型（按你选的方案）：
//   事件 = 父行。单市场二元事件 → 父行直接显示价格，没有子行。
//   多候选事件（世界杯冠军、2028 大选人选）→ 父行折叠，展开后每个候选一行子行。
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { log, num, toMs, pickDirections, alignTo, heatScore, mapLimit } from './util.mjs';
import { fetchAllVenueEvents, getHealth } from './venues.mjs';
import * as hosted from './hosted.mjs';

const ANCHOR = (process.env.PMXT_BOARD_ANCHOR || 'polymarket').toLowerCase();

export class BoardStore {
  constructor(opts = {}) {
    this.venues = opts.venues || ['polymarket', 'kalshi', 'limitless'];
    this.eventLimit = Number(process.env.PMXT_BOARD_EVENT_LIMIT || opts.eventLimit || 1200);
    this.syncIntervalMs = Number(process.env.PMXT_BOARD_SYNC_MS || opts.syncIntervalMs || 15 * 60 * 1000);
    this.snapshotPath = process.env.PMXT_BOARD_SNAPSHOT || opts.snapshotPath || '/data/board.json';

    this.rows = [];                 // 主区（以 anchor 为锚）
    this.secondary = [];            // 次要分区（anchor 上没有的标的）
    this.byId = new Map();          // rowId -> row
    this.outcomeRoutes = new Map(); // `${venue}:${outcomeId}` -> [{rowId, childId, side}]
    this.categories = new Map();    // category -> count
    this.tagCounts = new Map();

    this.state = {
      lastSyncAt: null, lastSyncMs: null, lastError: null,
      syncing: false, rowCount: 0, secondaryCount: 0, cellCount: 0,
      matchedRowCount: 0, clusterCount: 0, generation: 0,
    };
    this._timer = null;
  }

  // ── 生命周期 ─────────────────────────────────────────────────────────
  async start() {
    this._loadSnapshot();
    this.sync().catch((e) => log.error('首次同步失败:', e?.message || e));
    this._timer = setInterval(() => {
      this.sync().catch((e) => log.error('定时同步失败:', e?.message || e));
    }, this.syncIntervalMs);
    this._timer.unref?.();
    log.info(`BoardStore 启动：锚=${ANCHOR}，平台=${this.venues.join(',')}，同步间隔=${Math.round(this.syncIntervalMs / 60000)}分钟`);
  }

  stop() { if (this._timer) clearInterval(this._timer); }

  // ── 全量同步 ─────────────────────────────────────────────────────────
  async sync() {
    if (this.state.syncing) { log.debug('上一轮同步还没跑完，跳过'); return; }
    this.state.syncing = true;
    const t0 = Date.now();
    try {
      // ① 直连抓所有平台的事件（免费，且这一步同时把价格刷新了）
      const byVenue = await fetchAllVenueEvents(this.venues, { limit: this.eventLimit });

      // ② 建市场索引：`venue:marketId` -> {market, event, venue}
      const marketIndex = new Map();
      for (const [venue, events] of Object.entries(byVenue)) {
        for (const ev of events) {
          for (const m of ev.markets || []) {
            const key = mkey(venue, m.marketId);
            if (key) marketIndex.set(key, { market: m, event: ev, venue });
            // Kalshi 的 ticker、Limitless 的 slug 也建别名，方便集群里用别的 id 引用
            for (const alt of [m.slug, m.sourceMetadata?.ticker, m.sourceMetadata?.marketTicker]) {
              if (alt && !marketIndex.has(mkey(venue, alt))) marketIndex.set(mkey(venue, alt), { market: m, event: ev, venue });
            }
          }
        }
      }

      // ③ 向托管接口买「对应关系」
      let clusters = [];
      if (hosted.hostedEnabled()) {
        try {
          clusters = await hosted.fetchAllMarketClusters({ venues: this.venues });
        } catch (e) {
          log.warn(`集群接口不可用，本轮退化为「只有 ${ANCHOR} 单平台数据」: ${e.message}`);
        }
      } else {
        log.warn('未配置 PMXT_API_KEY，跨平台匹配不可用（看板仍可用，只是没有他站价格列）');
      }

      // `venue:marketId` -> cluster
      const clusterOf = new Map();
      for (const c of clusters) {
        for (const mem of hosted.clusterMembers(c)) {
          const v = hosted.memberVenue(mem);
          const id = hosted.memberMarketId(mem);
          if (v && id) clusterOf.set(mkey(v, id), c);
        }
      }

      // ④ 组装行
      const built = this._build(byVenue, marketIndex, clusterOf, clusters);

      this.rows = built.rows;
      this.secondary = built.secondary;
      this.byId = built.byId;
      this.outcomeRoutes = built.routes;
      this.categories = built.categories;
      this.tagCounts = built.tagCounts;

      this.state = {
        ...this.state,
        // 这一轮是真数据了，把冷启动时打的「快照」标记摘掉。
        // 忘了摘的话前端状态条会一直挂着「（快照）」，而且 _saveSnapshot 会把
        // stale:true 一起写进文件，下次重启读回来继续 true —— 永远洗不白。
        stale: false,
        lastSyncAt: Date.now(),
        lastSyncMs: Date.now() - t0,
        lastError: null,
        rowCount: built.rows.length,
        secondaryCount: built.secondary.length,
        cellCount: built.cellCount,
        matchedRowCount: built.matchedRowCount,
        clusterCount: clusters.length,
        generation: this.state.generation + 1,
      };
      this._saveSnapshot();
      log.info(`同步完成：主区 ${built.rows.length} 行（其中 ${built.matchedRowCount} 行有跨平台匹配），次要区 ${built.secondary.length} 行，耗时 ${Date.now() - t0}ms`);
    } catch (e) {
      this.state.lastError = String(e?.message || e);
      log.error('同步失败:', this.state.lastError);
      throw e;
    } finally {
      this.state.syncing = false;
    }
  }

  // ── 组装 ─────────────────────────────────────────────────────────────
  _build(byVenue, marketIndex, clusterOf, clusters) {
    const rows = [];
    const byId = new Map();
    const routes = new Map();
    const categories = new Map();
    const tagCounts = new Map();
    const usedMarkets = new Set(); // `venue:marketId` 已经被主区吃掉的
    let cellCount = 0;
    let matchedRowCount = 0;

    const anchorEvents = byVenue[ANCHOR] || [];

    for (const ev of anchorEvents) {
      const markets = (ev.markets || []).filter((m) => Array.isArray(m.outcomes) && m.outcomes.length);
      if (!markets.length) continue;

      const row = baseRow(`${ANCHOR}:${ev.id}`, ev, ANCHOR, 'main');

      // 判定：二元单市场 vs 多候选
      const isMulti = markets.length > 1 || (markets.length === 1 && markets[0].outcomes.length > 2);

      if (!isMulti) {
        const m = markets[0];
        const c = this._buildCell(ANCHOR, m, null);
        if (c) {
          row.cells[ANCHOR] = c;
          row.anchorDir = { posLabel: c.posLabel, negLabel: c.negLabel };
          usedMarkets.add(mkey(ANCHOR, m.marketId));
          this._attachMatches(row, m, clusterOf, marketIndex, usedMarkets, routes, row.id, null);
          registerRoute(routes, ANCHOR, c, row.id, null);
        }
        row.kind = 'binary';
      } else {
        row.kind = 'multi';
        for (const m of markets) {
          const c = this._buildCell(ANCHOR, m, null);
          if (!c) continue;
          const child = {
            id: `${row.id}#${m.marketId}`,
            label: childLabel(m, ev),
            title: m.title || '',
            cells: { [ANCHOR]: c },
            anchorDir: { posLabel: c.posLabel, negLabel: c.negLabel },
            vol24h: num(m.volume24h), volume: num(m.volume), liquidity: num(m.liquidity),
            chg24h: num(c.chg24h),
            resolutionDate: toMs(m.resolutionDate),
            venues: [ANCHOR],
          };
          usedMarkets.add(mkey(ANCHOR, m.marketId));
          this._attachMatches(child, m, clusterOf, marketIndex, usedMarkets, routes, row.id, child.id);
          registerRoute(routes, ANCHOR, c, row.id, child.id);
          row.children.push(child);
        }
        // 父行按候选概率降序，最有希望的排前面（同花顺里「主力」在上）
        row.children.sort((a, b) => (b.cells[ANCHOR]?.pos ?? -1) - (a.cells[ANCHOR]?.pos ?? -1));
      }

      finalizeRow(row, ev);
      if (!hasAnyCell(row)) continue;
      if (row.venues.length > 1) matchedRowCount++;
      cellCount += countCells(row);
      rows.push(row);
      byId.set(row.id, row);
      bump(categories, row.category);
      for (const t of row.tags || []) bump(tagCounts, t);
    }

    // ── 次要分区：anchor 上没有的标的 ──────────────────────────────────
    const secondary = [];
    // (a) 有集群但不含 anchor 的：这些是「他站之间互相匹配上、Poly 没有」的
    const seenCluster = new Set();
    for (const c of clusters) {
      const members = hosted.clusterMembers(c);
      const hasAnchor = members.some((m) => hosted.memberVenue(m) === ANCHOR);
      if (hasAnchor) continue;
      const cid = hosted.clusterId(c);
      if (cid && seenCluster.has(cid)) continue;
      if (cid) seenCluster.add(cid);

      const resolved = members
        .map((m) => marketIndex.get(mkey(hosted.memberVenue(m), hosted.memberMarketId(m))))
        .filter(Boolean);
      if (!resolved.length) continue;

      const head = resolved[0];
      const row = baseRow(`cluster:${cid || head.market.marketId}`, head.event, head.venue, 'secondary');
      row.title = c?.canonicalTitle || c?.title || head.market.title || head.event.title;
      row.category = c?.category || row.category;
      row.confidence = numOrNull(c?.confidence);
      row.matchSource = 'cluster';
      row.rawMatches = pickRawMatches(c);
      row.kind = 'binary';
      let first = null;
      for (const r of resolved) {
        const cell = this._buildCell(r.venue, r.market, first);
        if (!cell) continue;
        if (!first) first = { posLabel: cell.posLabel, negLabel: cell.negLabel };
        row.cells[r.venue] = cell;
        usedMarkets.add(mkey(r.venue, r.market.marketId));
        registerRoute(routes, r.venue, cell, row.id, null);
      }
      finalizeRow(row, head.event);
      if (!hasAnyCell(row)) continue;
      cellCount += countCells(row);
      secondary.push(row);
      byId.set(row.id, row);
    }

    // (b) 完全没匹配上的他站事件
    for (const venue of this.venues) {
      if (venue === ANCHOR) continue;
      for (const ev of byVenue[venue] || []) {
        const markets = (ev.markets || []).filter((m) => Array.isArray(m.outcomes) && m.outcomes.length);
        if (!markets.length) continue;
        if (markets.every((m) => usedMarkets.has(mkey(venue, m.marketId)))) continue;

        const row = baseRow(`${venue}:${ev.id}`, ev, venue, 'secondary');
        row.matchSource = 'venue-only';
        const isMulti = markets.length > 1 || (markets.length === 1 && markets[0].outcomes.length > 2);
        if (!isMulti) {
          const cell = this._buildCell(venue, markets[0], null);
          if (cell) { row.cells[venue] = cell; registerRoute(routes, venue, cell, row.id, null); }
          row.kind = 'binary';
        } else {
          row.kind = 'multi';
          for (const m of markets) {
            const cell = this._buildCell(venue, m, null);
            if (!cell) continue;
            const child = {
              id: `${row.id}#${m.marketId}`, label: childLabel(m, ev), title: m.title || '',
              cells: { [venue]: cell }, anchorDir: { posLabel: cell.posLabel, negLabel: cell.negLabel },
              vol24h: num(m.volume24h), volume: num(m.volume), liquidity: num(m.liquidity),
              chg24h: num(cell.chg24h), resolutionDate: toMs(m.resolutionDate), venues: [venue],
            };
            registerRoute(routes, venue, cell, row.id, child.id);
            row.children.push(child);
          }
          row.children.sort((a, b) => (b.cells[venue]?.pos ?? -1) - (a.cells[venue]?.pos ?? -1));
        }
        finalizeRow(row, ev);
        if (!hasAnyCell(row)) continue;
        for (const m of markets) usedMarkets.add(mkey(venue, m.marketId));
        cellCount += countCells(row);
        secondary.push(row);
        byId.set(row.id, row);
      }
    }

    rows.sort((a, b) => b.heat - a.heat);
    secondary.sort((a, b) => b.heat - a.heat);
    return { rows, secondary, byId, routes, categories, tagCounts, cellCount, matchedRowCount };
  }

  /** 把集群里其它平台的市场挂到目标行/子行上 */
  _attachMatches(target, anchorMarket, clusterOf, marketIndex, usedMarkets, routes, rowId, childId) {
    const c = clusterOf.get(mkey(ANCHOR, anchorMarket.marketId));
    if (!c) return;
    target.confidence = numOrNull(c?.confidence) ?? target.confidence;
    target.matchSource = 'cluster';
    target.clusterId = hosted.clusterId(c);
    const raw = pickRawMatches(c);
    if (raw.length) target.rawMatches = raw;

    for (const mem of hosted.clusterMembers(c)) {
      const v = hosted.memberVenue(mem);
      if (!v || v === ANCHOR || !this.venues.includes(v)) continue;
      if (target.cells[v]) continue; // 一个平台只取一条，取集群里第一条
      const hit = marketIndex.get(mkey(v, hosted.memberMarketId(mem)));
      if (hit) {
        const cell = this._buildCell(v, hit.market, target.anchorDir);
        if (cell) {
          target.cells[v] = cell;
          usedMarkets.add(mkey(v, hit.market.marketId));
          registerRoute(routes, v, cell, rowId, childId);
        }
      } else {
        // 直连没抓到这条（超出抓取条数或已下架）：用集群里带的字段兜底，标记为不完整
        const fallback = cellFromClusterMember(v, mem);
        if (fallback) { target.cells[v] = fallback; }
      }
    }
  }

  /** 把一个统一市场压成一个「平台单元格」 */
  _buildCell(venue, m, anchorDir) {
    let dir = pickDirections(m);
    if (!dir) {
      // 多结果市场被当成二元用时，取概率最高的结果当正向
      const os = [...(m.outcomes || [])].sort((a, b) => num(b.price) - num(a.price));
      if (!os.length) return null;
      dir = { pos: os[0], neg: null, posLabel: os[0].label, negLabel: null, basis: 'top-outcome', weak: true };
    }
    if (anchorDir) dir = alignTo(anchorDir, dir);

    return {
      venue,
      marketId: m.marketId,
      eventId: m.eventId ?? null,
      slug: m.slug || null,       // Limitless 的 WS 按 slug 订阅，这里带上省一次 REST 反查
      url: m.url || '',
      posLabel: dir.posLabel ?? null,
      negLabel: dir.negLabel ?? null,
      pos: numOrNull(dir.pos?.price),
      neg: numOrNull(dir.neg?.price) ?? (numOrNull(dir.pos?.price) != null && dir.neg === null ? round4(1 - dir.pos.price) : null),
      negImplied: dir.neg === null,
      posOid: dir.pos?.outcomeId ?? null,
      negOid: dir.neg?.outcomeId ?? null,
      chg24h: numOrNull(dir.pos?.priceChange24h),
      vol24h: num(m.volume24h),
      volume: num(m.volume),
      liquidity: num(m.liquidity),
      status: m.status ?? null,
      basis: dir.basis,
      weak: Boolean(dir.weak),
      flipped: Boolean(dir.flipped),
      ts: Date.now(),
      live: null,
      partial: false,
    };
  }

  // ── 实时价覆盖（P4 由 realtime.mjs 调用）─────────────────────────────
  /** @returns {Array} 受影响的 {rowId, childId, venue} 列表，供 SSE 广播 */
  applyLive(venue, outcomeId, quote) {
    const routes = this.outcomeRoutes.get(mkey(venue, outcomeId));
    if (!routes?.length) return [];
    const touched = [];
    for (const r of routes) {
      const row = this.byId.get(r.rowId);
      if (!row) continue;
      const holder = r.childId ? row.children?.find((c) => c.id === r.childId) : row;
      const cell = holder?.cells?.[venue];
      if (!cell) continue;
      const prev = cell.live;
      cell.live = {
        side: r.side,
        mid: quote.mid ?? null,
        bid: quote.bestBid ?? null,
        ask: quote.bestAsk ?? null,
        spread: quote.spread ?? null,
        ts: quote.ts || Date.now(),
      };
      // 实时中价直接顶替目录价，前端就能看到跳动
      if (quote.mid != null) {
        if (r.side === 'pos') cell.pos = round4(quote.mid);
        else if (r.side === 'neg') cell.neg = round4(quote.mid);
      }
      cell.ts = cell.live.ts;
      touched.push({ rowId: r.rowId, childId: r.childId, venue, side: r.side, prev: prev?.mid ?? null });
    }
    return touched;
  }

  /**
   * 当前应该订阅哪些结果（按热度取前 N 行的所有平台正向结果）。
   * 返回的每一项都带上实时层需要的三个东西：
   *   outcomeId —— 路由键（applyLive 用它找回单元格）
   *   wsId      —— 真正传给 watchOrderBook 的 id（Limitless 用 slug，避免它内部再发 REST 反查）
   *   invert    —— 该单元格的正向是不是平台自己的反向（跨平台对齐时翻过面），
   *                Limitless 的 WS 只推 Yes 侧盘口，翻过面的要把价格取补数
   */
  topOutcomes(limit = 120) {
    const out = [];
    const seen = new Set();
    const push = (cellHolder, rowId, childId) => {
      for (const [venue, cell] of Object.entries(cellHolder.cells || {})) {
        if (!cell.posOid || cell.partial) continue;
        const k = `${venue}:${cell.posOid}`;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push({
          venue,
          outcomeId: cell.posOid,
          wsId: venue === 'limitless' ? (cell.slug || cell.posOid) : cell.posOid,
          invert: venue === 'limitless' ? Boolean(cell.flipped) : false,
          rowId, childId, side: 'pos',
        });
      }
    };
    for (const row of this.rows) {
      if (out.length >= limit) break;
      if (row.kind === 'multi') {
        for (const ch of row.children.slice(0, 3)) push(ch, row.id, ch.id);
      } else push(row, row.id, null);
    }
    return out.slice(0, limit);
  }

  // ── 查询 ─────────────────────────────────────────────────────────────
  query(q = {}) {
    const section = q.section === 'secondary' ? this.secondary : this.rows;
    const now = Date.now();
    let list = section;

    if (q.ids?.length) {
      const set = new Set(q.ids);
      list = list.filter((r) => set.has(r.id));
    }
    if (q.text) {
      const t = String(q.text).toLowerCase();
      list = list.filter((r) =>
        (r.title || '').toLowerCase().includes(t) ||
        (r.category || '').toLowerCase().includes(t) ||
        (r.tags || []).some((x) => String(x).toLowerCase().includes(t)) ||
        (r.children || []).some((c) => (c.label || '').toLowerCase().includes(t)));
    }
    if (q.category) {
      const cats = String(q.category).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
      list = list.filter((r) => cats.includes(String(r.category || '').toLowerCase()));
    }
    if (q.tag) {
      const tags = String(q.tag).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
      list = list.filter((r) => (r.tags || []).some((x) => tags.includes(String(x).toLowerCase())));
    }
    if (q.venues?.length) {
      list = list.filter((r) => q.venues.every((v) => r.venues.includes(v)));
    }
    if (q.anyVenues?.length) {
      list = list.filter((r) => q.anyVenues.some((v) => r.venues.includes(v)));
    }
    if (q.minVenues) list = list.filter((r) => r.venues.length >= Number(q.minVenues));
    if (q.endingWithinH) {
      const cut = now + Number(q.endingWithinH) * 3600_000;
      list = list.filter((r) => r.resolutionDate && r.resolutionDate >= now - 3600_000 && r.resolutionDate <= cut);
    }
    if (q.minVol24h) list = list.filter((r) => r.vol24h >= Number(q.minVol24h));
    if (q.minVolume) list = list.filter((r) => r.volume >= Number(q.minVolume));
    if (q.minSpread) list = list.filter((r) => (r.spread ?? 0) >= Number(q.minSpread));
    if (q.minConfidence) list = list.filter((r) => r.venues.length < 2 || (r.confidence ?? 1) >= Number(q.minConfidence));
    if (q.hideEnded !== false) list = list.filter((r) => !r.ended);
    if (q.onlyMatched) list = list.filter((r) => r.venues.length > 1);

    const sorters = {
      heat: (a, b) => b.heat - a.heat,
      vol24h: (a, b) => b.vol24h - a.vol24h,
      volume: (a, b) => b.volume - a.volume,
      liquidity: (a, b) => b.liquidity - a.liquidity,
      chg: (a, b) => Math.abs(b.chg24h) - Math.abs(a.chg24h),
      spread: (a, b) => (b.spread ?? -1) - (a.spread ?? -1),
      ending: (a, b) => (a.resolutionDate ?? Infinity) - (b.resolutionDate ?? Infinity),
      venues: (a, b) => b.venues.length - a.venues.length || b.heat - a.heat,
      title: (a, b) => String(a.title).localeCompare(String(b.title)),
    };
    const cmp = sorters[q.sort] || sorters.heat;
    list = [...list].sort(q.dir === 'asc' ? (a, b) => -cmp(a, b) : cmp);

    const total = list.length;
    const offset = Math.max(0, Number(q.offset || 0));
    const limit = Math.min(500, Math.max(1, Number(q.limit || 60)));
    const page = list.slice(offset, offset + limit);
    return { total, offset, limit, rows: page.map((r) => (q.slim ? slim(r) : r)) };
  }

  getRow(id) { return this.byId.get(id) || null; }

  facets() {
    return {
      categories: [...this.categories.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ key: k, count: v })),
      tags: [...this.tagCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 60).map(([k, v]) => ({ key: k, count: v })),
      venues: this.venues,
      anchor: ANCHOR,
    };
  }

  stats() {
    return {
      ...this.state,
      venues: this.venues,
      anchor: ANCHOR,
      syncIntervalMin: Math.round(this.syncIntervalMs / 60000),
      eventLimit: this.eventLimit,
      venueHealth: getHealth(),
      hosted: { enabled: hosted.hostedEnabled(), ...hosted.diag },
      nextSyncAt: this.state.lastSyncAt ? this.state.lastSyncAt + this.syncIntervalMs : null,
    };
  }

  // ── 快照 ─────────────────────────────────────────────────────────────
  _saveSnapshot() {
    try {
      mkdirSync(dirname(this.snapshotPath), { recursive: true });
      // stale / syncing 是「这个进程此刻的状态」，不该跟着文件走，写之前剥掉。
      const { stale: _s, syncing: _y, ...state } = this.state;
      writeFileSync(this.snapshotPath, JSON.stringify({
        v: 2, ts: Date.now(), anchor: ANCHOR, venues: this.venues,
        rows: this.rows, secondary: this.secondary, state,
      }));
      log.debug(`快照已写入 ${this.snapshotPath}`);
    } catch (e) {
      log.warn(`快照写入失败（不影响运行）: ${e.message}`);
    }
  }

  _loadSnapshot() {
    try {
      if (!existsSync(this.snapshotPath)) return;
      const j = JSON.parse(readFileSync(this.snapshotPath, 'utf8'));
      if (j?.v !== 2 || !Array.isArray(j.rows)) return;
      this.rows = j.rows; this.secondary = j.secondary || [];
      this.byId = new Map();
      this.outcomeRoutes = new Map();
      for (const r of [...this.rows, ...this.secondary]) {
        this.byId.set(r.id, r);
        const reg = (holder, childId) => {
          for (const [v, cell] of Object.entries(holder.cells || {})) registerRoute(this.outcomeRoutes, v, cell, r.id, childId);
        };
        reg(r, null);
        for (const ch of r.children || []) reg(ch, ch.id);
        bump(this.categories, r.category);
        for (const t of r.tags || []) bump(this.tagCounts, t);
      }
      this.state = { ...this.state, ...(j.state || {}), syncing: false, stale: true };
      log.info(`已从快照恢复 ${this.rows.length} 行（${Math.round((Date.now() - j.ts) / 60000)} 分钟前的数据），后台正在拉最新`);
    } catch (e) {
      log.warn(`快照读取失败（忽略）: ${e.message}`);
    }
  }
}

// ── 辅助函数 ───────────────────────────────────────────────────────────
function mkey(venue, id) { return venue && id ? `${venue}:${id}` : ''; }
function numOrNull(v) { return typeof v === 'number' && Number.isFinite(v) ? v : null; }
function round4(v) { return Math.round(v * 10000) / 10000; }
function bump(map, k) { if (k) map.set(k, (map.get(k) || 0) + 1); }

function baseRow(id, ev, venue, section) {
  return {
    id, section,
    title: ev.title || '',
    slug: ev.slug || '',
    image: ev.image || null,
    url: ev.url || '',
    category: ev.category || null,
    tags: Array.isArray(ev.tags) ? ev.tags.slice(0, 8) : [],
    anchorVenue: venue,
    kind: 'binary',
    cells: {},
    children: [],
    anchorDir: null,
    venues: [],
    vol24h: 0, volume: 0, liquidity: 0, chg24h: 0,
    resolutionDate: null,
    ended: false,
    spread: null, spreadPair: null,
    heat: 0,
    confidence: null,
    clusterId: null,
    matchSource: 'anchor-only',
    rawMatches: null,
  };
}

function childLabel(m, ev) {
  // Polymarket 多候选事件里，市场标题往往就是候选名；否则退回把事件标题从市场标题里剪掉
  const t = String(m.title || '').trim();
  const e = String(ev.title || '').trim();
  if (t && e && t.toLowerCase().startsWith(e.toLowerCase()) && t.length > e.length) {
    return t.slice(e.length).replace(/^[\s:：\-—]+/, '') || t;
  }
  const g = m.sourceMetadata?.groupItemTitle;
  return (typeof g === 'string' && g.trim()) || t || m.marketId;
}

function registerRoute(routes, venue, cell, rowId, childId) {
  const add = (oid, side) => {
    if (!oid) return;
    const k = `${venue}:${oid}`;
    const arr = routes.get(k) || [];
    arr.push({ rowId, childId, side });
    routes.set(k, arr);
  };
  add(cell.posOid, 'pos');
  add(cell.negOid, 'neg');
}

function hasAnyCell(row) {
  if (Object.keys(row.cells).length) return true;
  return (row.children || []).some((c) => Object.keys(c.cells || {}).length);
}

function countCells(row) {
  let n = Object.keys(row.cells).length;
  for (const c of row.children || []) n += Object.keys(c.cells || {}).length;
  return n;
}

/** 汇总父行的量/价差/热度/到期，子行也补齐 venues */
function finalizeRow(row, ev) {
  const venues = new Set();
  const collect = (holder) => {
    const vs = Object.keys(holder.cells || {});
    for (const v of vs) venues.add(v);
    holder.venues = vs;
    // 跨平台价差：所有平台正向价的极差
    const ps = vs.map((v) => holder.cells[v].pos).filter((p) => typeof p === 'number');
    if (ps.length > 1) {
      const hi = Math.max(...ps), lo = Math.min(...ps);
      holder.spread = round4(hi - lo);
      const hiV = vs.find((v) => holder.cells[v].pos === hi);
      const loV = vs.find((v) => holder.cells[v].pos === lo);
      holder.spreadPair = [loV, hiV];
    } else { holder.spread = null; holder.spreadPair = null; }
  };

  collect(row);
  for (const ch of row.children || []) collect(ch);

  row.venues = [...venues];

  if (row.kind === 'multi' && row.children.length) {
    row.vol24h = num(ev.volume24h) || row.children.reduce((s, c) => s + num(c.vol24h), 0);
    row.volume = num(ev.volume) || row.children.reduce((s, c) => s + num(c.volume), 0);
    row.liquidity = row.children.reduce((s, c) => s + num(c.liquidity), 0);
    row.chg24h = row.children.reduce((a, c) => (Math.abs(num(c.chg24h)) > Math.abs(a) ? num(c.chg24h) : a), 0);
    row.spread = row.children.reduce((a, c) => (c.spread != null && (a == null || c.spread > a) ? c.spread : a), null);
    const dates = row.children.map((c) => c.resolutionDate).filter(Boolean);
    row.resolutionDate = dates.length ? Math.min(...dates) : toMs(ev.endDate) ?? null;
    row.leader = row.children[0] ? { label: row.children[0].label, pos: row.children[0].cells[row.anchorVenue]?.pos ?? null } : null;
    row.childCount = row.children.length;
  } else {
    const anyCell = row.cells[row.anchorVenue] || Object.values(row.cells)[0];
    row.vol24h = num(ev.volume24h) || num(anyCell?.vol24h);
    row.volume = num(ev.volume) || num(anyCell?.volume);
    row.liquidity = num(anyCell?.liquidity);
    row.chg24h = num(anyCell?.chg24h);
    const m0 = (ev.markets || [])[0];
    row.resolutionDate = toMs(m0?.resolutionDate) ?? toMs(ev.endDate) ?? null;
    row.childCount = 0;
  }

  const now = Date.now();
  row.ended = Boolean(row.resolutionDate && row.resolutionDate < now - 3600_000) ||
    Object.values(row.cells).some((c) => /closed|resolved|settled|archived/i.test(String(c.status || '')));
  row.heat = heatScore(row, now);
}

/** 只给列表用的瘦身版本（去掉 rawMatches 这些大字段，前端详情再单独取） */
// 子行也要剥：_attachMatches 是按 target 写 rawMatches 的，target 可能就是某个子行，
// 于是一个 60 行的多候选页能白白多出上千条匹配证据。前端主表一个字段都不读，
// 真要看证据走 /api/board/row/:id（那条不 slim，证据是全的）。
function slim(r) {
  const { rawMatches, ...rest } = r;
  return {
    ...rest,
    children: (r.children || []).map(({ rawMatches: _rm, ...c }) => c),
    hasRawMatches: Array.isArray(rawMatches) && rawMatches.length > 0,
  };
}

/** 从集群里抠出「为什么判定为同一标的」的证据，F10 页面展示 */
function pickRawMatches(c) {
  const raw = c?.rawMatches || c?.raw_matches || c?.matches || null;
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 12).map((m) => ({
    a: m?.sourceMarketId ?? m?.marketA ?? m?.a ?? null,
    b: m?.targetMarketId ?? m?.marketB ?? m?.b ?? null,
    score: numOrNull(m?.score ?? m?.confidence),
    reason: m?.reason ?? m?.method ?? m?.matchType ?? null,
  }));
}

/** 直连没抓到该市场时的兜底单元格（数据不完整，前端会打标） */
function cellFromClusterMember(venue, mem) {
  const price = numOrNull(mem?.price ?? mem?.yesPrice ?? mem?.probability);
  const id = hosted.memberMarketId(mem);
  // 探针实测：集群成员对象上**没有顶层 price**，报价在 markets[].outcomes[].price。
  // 所以这个兜底格实际上永远返回 null —— 这正是我们要的，别「顺手修好」它：
  // 走到这里说明该平台直连挂了，而集群里的报价可能是几分钟前的、甚至是 0
  // （实测他站有 price:0 + bestBid/Ask 全 null 的僵尸盘）。宁可显示 --，不要挂个假价。
  //
  // 没有 id 或没有价格就别造这个格子。
  // 一个没价格的兜底格比「不显示」更糟：页面上会多出一列永远是 "--" 的平台，
  // 让人以为那个平台有这个标的只是暂时没报价；更要命的是它会把 row.venues 撑大一位，
  // 于是「至少 N 个平台」的筛选和热度里的平台覆盖分都跟着失真。
  // 平台直连挂掉时（fetchEvents 抛错），走的正是这条路 —— 此时该缺席就缺席。
  if (!id || price == null) return null;
  return {
    venue, marketId: id, eventId: null,
    url: mem?.url || '',
    posLabel: mem?.outcomeLabel || 'Yes', negLabel: null,
    pos: price, neg: price != null ? round4(1 - price) : null, negImplied: true,
    posOid: mem?.outcomeId ?? null, negOid: null,
    chg24h: numOrNull(mem?.priceChange24h),
    vol24h: num(mem?.volume24h), volume: num(mem?.volume), liquidity: num(mem?.liquidity),
    status: mem?.status ?? null,
    basis: 'cluster-fallback', weak: true, flipped: false,
    ts: Date.now(), live: null, partial: true,
  };
}
