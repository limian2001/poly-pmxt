// 实时价格层 —— 把各平台的盘口变动推到前端
// ---------------------------------------------------------------------------
// 三个平台三种性格，不能一视同仁：
//
//   polymarket  单条 WS 连接多路复用（subscribedAssets 是个 Set），订几百个结果也只有一条连接。
//               我们在 venues.mjs 里把它的 REST 快照兜底关掉了，所以这里是纯推送：
//               watchOrderBook() resolve 一次 = 盘口真的动了一次。
//   limitless   公开 WS，按 slug 订阅。首次调用会拉一次快照，之后是推送。
//               注意它只推 Yes 侧盘口，如果这个单元格在跨平台对齐时翻过面（invert），
//               价格要取补数再用。
//   kalshi      watchOrderBook 内部第一行就是 ensureAuth()，没有 API 凭据根本连不上。
//               所以 Kalshi 走批量轮询，节奏放慢，够用即可。
//
// 全部走直连，**不消耗任何 pmxt credit**。
//
// 对外只有两件事：start(board, broadcast) 和 stats()。
// broadcast(payload) 由 routes.mjs 提供，负责把变动扇出给所有 SSE 订阅者。
import { log, mapLimit, sleep } from './util.mjs';
import { canStream, watchBook, unwatchBook, fetchBook } from './venues.mjs';

const MAX_SUBS = Number(process.env.PMXT_RT_MAX_SUBS || 160);         // 同时盯多少个结果
const POLL_MS = Number(process.env.PMXT_RT_POLL_MS || 20_000);         // Kalshi 轮询间隔
const POLL_CONC = Number(process.env.PMXT_RT_POLL_CONCURRENCY || 4);   // Kalshi 轮询并发
const RESUB_MS = Number(process.env.PMXT_RT_RESUB_MS || 60_000);       // 多久对一次订阅表
const FLUSH_MS = Number(process.env.PMXT_RT_FLUSH_MS || 400);          // 前端合帧间隔
const BACKOFF_MAX = 60_000;

export class Realtime {
  constructor(board, broadcast) {
    this.board = board;
    this.broadcast = broadcast;
    this.enabled = String(process.env.PMXT_RT_ENABLED ?? '1') !== '0';

    this.subs = new Map();     // `${venue}:${outcomeId}` -> {venue, outcomeId, wsId, invert, stop, mode}
    this.pending = new Map();  // 待推送的变动，按 cellKey 去重（同一格 100ms 内动 10 次只发最后一次）
    this.stats_ = {
      started: false, subCount: 0, streamSubs: 0, pollSubs: 0,
      updates: 0, errors: 0, lastUpdateAt: null, lastErrorMsg: null,
      broadcasts: 0, byVenue: {},
    };
    this._flushTimer = null;
    this._resubTimer = null;
    this._pollTimer = null;
    this._closing = false;
  }

  start() {
    if (!this.enabled) { log.info('实时推送已关闭（PMXT_RT_ENABLED=0）'); return; }
    this.stats_.started = true;

    this._flushTimer = setInterval(() => this._flush(), FLUSH_MS);
    this._flushTimer.unref?.();

    // 每轮同步之后订阅表会变（热度排序变了、新标的进来了），定期对一次
    this._resubTimer = setInterval(() => this.resubscribe(), RESUB_MS);
    this._resubTimer.unref?.();

    this._pollTimer = setInterval(() => this._pollOnce(), POLL_MS);
    this._pollTimer.unref?.();

    this.resubscribe();
    log.info(`实时层启动：最多 ${MAX_SUBS} 个订阅，Kalshi 轮询 ${POLL_MS / 1000}s`);
  }

  async stop() {
    this._closing = true;
    clearInterval(this._flushTimer);
    clearInterval(this._resubTimer);
    clearInterval(this._pollTimer);
    for (const s of this.subs.values()) s.stop = true;
    await Promise.allSettled([...this.subs.values()]
      .filter((s) => s.mode === 'ws')
      .map((s) => unwatchBook(s.venue, s.wsId)));
    this.subs.clear();
  }

  // ── 订阅表对账 ───────────────────────────────────────────────────────
  /** 按当前热度重算「该盯哪些结果」，多退少补，已经在盯的不动 */
  resubscribe() {
    if (this._closing) return;
    const want = this.board.topOutcomes(MAX_SUBS);
    const wantKeys = new Set();

    for (const t of want) {
      const key = `${t.venue}:${t.outcomeId}`;
      wantKeys.add(key);
      if (this.subs.has(key)) {
        // 已在盯：只更新可能变化的元信息（对齐翻面状态会随同步变）
        const s = this.subs.get(key);
        s.invert = t.invert;
        s.wsId = t.wsId;
        continue;
      }
      const sub = { ...t, key, stop: false, mode: canStream(t.venue) ? 'ws' : 'poll', errors: 0 };
      this.subs.set(key, sub);
      if (sub.mode === 'ws') this._runWs(sub);
    }

    // 掉出热度榜的：停掉，把连接资源让给更热的
    for (const [key, s] of this.subs) {
      if (wantKeys.has(key)) continue;
      s.stop = true;
      this.subs.delete(key);
      if (s.mode === 'ws') unwatchBook(s.venue, s.wsId);
    }

    this.stats_.subCount = this.subs.size;
    this.stats_.streamSubs = [...this.subs.values()].filter((s) => s.mode === 'ws').length;
    this.stats_.pollSubs = this.stats_.subCount - this.stats_.streamSubs;
    log.debug(`订阅表：${this.stats_.streamSubs} 推送 / ${this.stats_.pollSubs} 轮询`);
  }

  // ── WS 续订循环 ──────────────────────────────────────────────────────
  /** 一个结果一个循环。resolve 一次就吃一次，然后立刻续订；出错指数退避。 */
  async _runWs(sub) {
    let backoff = 1000;
    while (!sub.stop && !this._closing) {
      try {
        const book = await watchBook(sub.venue, sub.wsId);
        if (sub.stop) break;
        backoff = 1000;
        sub.errors = 0;
        this._onQuote(sub, book);
      } catch (e) {
        if (sub.stop || this._closing) break;
        sub.errors++;
        this.stats_.errors++;
        this.stats_.lastErrorMsg = `${sub.venue}/${sub.wsId}: ${String(e?.message || e).slice(0, 160)}`;
        log.debug(`WS ${sub.venue}/${sub.wsId} 出错，${backoff}ms 后重试: ${e?.message}`);
        // 连错 8 次多半是这个 id 本身有问题（下架/不存在），别再耗着
        if (sub.errors >= 8) {
          log.warn(`放弃订阅 ${sub.venue}/${sub.wsId}（连续 ${sub.errors} 次失败）`);
          this.subs.delete(sub.key);
          break;
        }
        await sleep(backoff);
        backoff = Math.min(BACKOFF_MAX, backoff * 2);
      }
    }
  }

  // ── Kalshi 轮询 ──────────────────────────────────────────────────────
  async _pollOnce() {
    if (this._closing) return;
    const list = [...this.subs.values()].filter((s) => s.mode === 'poll' && !s.stop);
    if (!list.length) return;
    await mapLimit(list, POLL_CONC, async (sub) => {
      if (sub.stop || this._closing) return;
      try {
        const book = await fetchBook(sub.venue, sub.outcomeId, 5);
        this._onQuote(sub, book);
      } catch (e) {
        this.stats_.errors++;
        this.stats_.lastErrorMsg = `${sub.venue}/${sub.outcomeId}: ${String(e?.message || e).slice(0, 160)}`;
      }
    });
  }

  // ── 报价落地 ─────────────────────────────────────────────────────────
  _onQuote(sub, book) {
    if (!book) return;
    const q = sub.invert ? invertBook(book) : book;
    if (q.mid == null) return;

    const touched = this.board.applyLive(sub.venue, sub.outcomeId, q);
    if (!touched.length) return;

    this.stats_.updates++;
    this.stats_.lastUpdateAt = Date.now();
    this.stats_.byVenue[sub.venue] = (this.stats_.byVenue[sub.venue] || 0) + 1;

    for (const t of touched) {
      // 同一个单元格在合帧窗口内只留最后一次，前端不会被刷屏
      this.pending.set(`${t.rowId}|${t.childId || ''}|${t.venue}|${t.side}`, {
        rowId: t.rowId, childId: t.childId, venue: t.venue, side: t.side,
        pos: q.mid, bid: q.bestBid, ask: q.bestAsk, spread: q.spread,
        prev: t.prev, ts: q.ts || Date.now(),
      });
    }
  }

  _flush() {
    if (!this.pending.size) return;
    const ticks = [...this.pending.values()];
    this.pending.clear();
    this.stats_.broadcasts++;
    // 一帧最多 400 条，超了说明订阅太多，截断比卡死前端好
    this.broadcast({ type: 'ticks', ts: Date.now(), ticks: ticks.slice(0, 400) });
  }

  stats() {
    return {
      ...this.stats_,
      enabled: this.enabled,
      maxSubs: MAX_SUBS,
      pollMs: POLL_MS,
      flushMs: FLUSH_MS,
      venues: [...new Set([...this.subs.values()].map((s) => `${s.venue}:${s.mode}`))],
    };
  }
}

/** Yes 侧盘口 → No 侧：价格取补数，买卖两边互换 */
function invertBook(b) {
  const flip = (arr) => (arr || []).map((l) => ({ p: 1 - l.p, s: l.s }));
  const bids = flip(b.asks).sort((x, y) => y.p - x.p);
  const asks = flip(b.bids).sort((x, y) => x.p - y.p);
  const bestBid = bids.length ? bids[0].p : null;
  const bestAsk = asks.length ? asks[0].p : null;
  return {
    bids, asks, bestBid, bestAsk,
    mid: bestBid != null && bestAsk != null ? (bestBid + bestAsk) / 2 : (bestBid ?? bestAsk ?? null),
    spread: bestBid != null && bestAsk != null ? bestAsk - bestBid : null,
    ts: b.ts,
    last: b.last != null ? 1 - b.last : null,
  };
}
