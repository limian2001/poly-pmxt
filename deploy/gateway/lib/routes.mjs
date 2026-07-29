// 看板 API 路由
// ---------------------------------------------------------------------------
// 全部只读，没有一个写接口。前端要的东西都在这儿：
//
//   GET /api/board            主表（筛选/排序/分页）
//   GET /api/board/facets     筛选项（分类、标签、平台）
//   GET /api/board/stats      同步状态、各平台健康、托管接口诊断
//   GET /api/board/row/:id    单行详情（含 rawMatches 匹配证据）
//   GET /api/book             盘口（悬停用，5 秒缓存 + 在途去重）
//   GET /api/ohlcv            历史价格曲线
//   GET /api/trades           最近成交
//   GET /api/stream           SSE 实时推送
//   POST /api/board/refresh   手动触发一次全量同步
//
// 盘口/K线/成交都是直连各平台，**不消耗 pmxt credit**，所以可以放心让前端随便点。
import express from 'express';
import { makeCache, log, explainHeat } from './util.mjs';
import { fetchBook, fetchCandles, fetchRecentTrades, venueNames } from './venues.mjs';

const bookCache = makeCache(Number(process.env.PMXT_BOOK_TTL_MS || 5000));
const candleCache = makeCache(Number(process.env.PMXT_CANDLE_TTL_MS || 60_000));
const tradeCache = makeCache(Number(process.env.PMXT_TRADE_TTL_MS || 15_000));

/** query 里的逗号分隔参数 → 小写数组 */
function list(v) {
  if (!v) return [];
  return String(v).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

export function createBoardRouter(board, getRealtime) {
  const r = express.Router();

  // ── 主表 ───────────────────────────────────────────────────────────
  r.get('/board', (req, res) => {
    const q = req.query;
    try {
      const out = board.query({
        section: q.section === 'secondary' ? 'secondary' : 'main',
        ids: q.ids ? String(q.ids).split(',').filter(Boolean) : null,
        text: q.q || q.text || '',
        category: q.category || '',
        tag: q.tag || '',
        venues: list(q.venues),
        anyVenues: list(q.anyVenues),
        minVenues: q.minVenues,
        endingWithinH: q.endingWithinH,
        minVol24h: q.minVol24h,
        minVolume: q.minVolume,
        minSpread: q.minSpread,
        minConfidence: q.minConfidence,
        hideEnded: q.hideEnded !== '0',
        onlyMatched: q.onlyMatched === '1',
        sort: q.sort || 'heat',
        dir: q.dir === 'asc' ? 'asc' : 'desc',
        offset: q.offset,
        limit: q.limit,
        slim: q.slim !== '0',
      });
      res.json({ ...out, ts: Date.now(), stale: Boolean(board.state.stale), syncing: board.state.syncing });
    } catch (e) {
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  r.get('/board/facets', (_req, res) => res.json(board.facets()));

  r.get('/board/stats', (_req, res) => {
    const rt = getRealtime?.();
    res.json({ ...board.stats(), realtime: rt ? rt.stats() : { enabled: false } });
  });

  // 注意：/board/row/:id 必须放在 /board 之后注册，但因为路径不同不会冲突。
  // rowId 里含冒号和 # （形如 polymarket:12345#67890），前端要 encodeURIComponent。
  r.get('/board/row/:id', (req, res) => {
    const row = board.getRow(decodeURIComponent(req.params.id));
    if (!row) return res.status(404).json({ error: '未找到该标的（可能刚被同步淘汰，刷新试试）' });
    // 详情里附上热度拆解：F10 页面要能回答「它凭什么排这么前」
    res.json({ ...row, heatExplain: explainHeat(row) });
  });

  r.post('/board/refresh', async (_req, res) => {
    if (board.state.syncing) return res.json({ ok: true, already: true, msg: '同步正在进行中' });
    board.sync()
      .then(() => getRealtime?.()?.resubscribe())
      .catch((e) => log.error('手动同步失败:', e?.message));
    res.json({ ok: true, msg: '已触发后台同步，约需 10–60 秒' });
  });

  // ── 盘口 / K线 / 成交（直连，免费）────────────────────────────────
  r.get('/book', async (req, res) => {
    const { venue, outcomeId } = req.query;
    if (!venue || !outcomeId) return res.status(400).json({ error: '缺少 venue 或 outcomeId' });
    if (!venueNames().includes(String(venue).toLowerCase())) return res.status(400).json({ error: `未知平台: ${venue}` });
    try {
      const book = await bookCache.get(`${venue}:${outcomeId}`, () => fetchBook(String(venue), String(outcomeId), 12));
      res.json({ venue, outcomeId, ...book });
    } catch (e) {
      // 这里刻意返回 200 + error 字段：悬停盘口失败是常态（部分平台不给盘口），
      // 前端只要显示「该平台无盘口」即可，不该弹错误
      res.json({ venue, outcomeId, error: String(e?.message || e).slice(0, 200), bids: [], asks: [] });
    }
  });

  r.get('/ohlcv', async (req, res) => {
    const { venue, outcomeId, resolution = '1h', limit = 168 } = req.query;
    if (!venue || !outcomeId) return res.status(400).json({ error: '缺少 venue 或 outcomeId' });
    try {
      const key = `${venue}:${outcomeId}:${resolution}:${limit}`;
      const rows = await candleCache.get(key, () => fetchCandles(String(venue), String(outcomeId), {
        resolution: String(resolution), limit: Math.min(1000, Number(limit) || 168),
      }));
      res.json({ venue, outcomeId, resolution, candles: rows });
    } catch (e) {
      res.json({ venue, outcomeId, candles: [], error: String(e?.message || e).slice(0, 200) });
    }
  });

  r.get('/trades', async (req, res) => {
    const { venue, outcomeId, limit = 40 } = req.query;
    if (!venue || !outcomeId) return res.status(400).json({ error: '缺少 venue 或 outcomeId' });
    try {
      const key = `${venue}:${outcomeId}:${limit}`;
      const rows = await tradeCache.get(key, () => fetchRecentTrades(String(venue), String(outcomeId), Math.min(200, Number(limit) || 40)));
      res.json({ venue, outcomeId, trades: rows });
    } catch (e) {
      res.json({ venue, outcomeId, trades: [], error: String(e?.message || e).slice(0, 200) });
    }
  });

  return r;
}

// ---------------------------------------------------------------------------
// SSE：一条长连接把所有价格变动推给前端
// ---------------------------------------------------------------------------
export function createSse() {
  const clients = new Set();
  let seq = 0;

  function broadcast(payload) {
    if (!clients.size) return;
    seq++;
    const frame = `id: ${seq}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const res of clients) {
      try { res.write(frame); } catch { clients.delete(res); }
    }
  }

  function handler(req, res) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no', // 万一前面挂了 nginx，别让它缓冲住
    });
    res.write(`retry: 3000\n\n`);
    res.write(`data: ${JSON.stringify({ type: 'hello', ts: Date.now() })}\n\n`);
    clients.add(res);
    log.debug(`SSE 客户端接入，当前 ${clients.size} 个`);

    // 心跳：注释帧，防止中间代理把闲置连接掐掉
    const hb = setInterval(() => {
      try { res.write(`: ping ${Date.now()}\n\n`); } catch { /* 下面的 close 会收拾 */ }
    }, 25_000);
    hb.unref?.();

    req.on('close', () => {
      clearInterval(hb);
      clients.delete(res);
      log.debug(`SSE 客户端断开，剩余 ${clients.size} 个`);
    });
  }

  return { broadcast, handler, count: () => clients.size };
}
