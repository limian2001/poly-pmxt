// 集群 ID 对不上探针 · 第二版（一次性排查用，跑完可以删）
// -------------------------------------------------------------------------
// 第一版结论：托管接口的 marketId 是它自己的 UUID，和直连的原生 id 完全不同源。
// 这一版换个问法：**成员身上有没有哪个字段，是能和直连对上的？**
// 把成员的每个候选字段，拿去直连侧的「marketId + slug + ticker」别名表里撞，
// 谁的命中率高，谁就是该用的 join key。
//
//   docker compose exec gateway node /app/deploy/dashboard/_probe-clusters.mjs
import * as hosted from '/app/deploy/gateway/lib/hosted.mjs';
import { getVenue } from '/app/deploy/gateway/lib/venues.mjs';

const VENUES = String(process.env.PMXT_VENUES || 'polymarket,kalshi,limitless')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const line = (s = '') => console.log(s);

// 成员身上所有可能承载「原生 id」的字段
const CAND = ['marketId', 'id', 'slug', 'ticker', 'conditionId', 'contractAddress', 'eventId', 'url'];

// ── 1. 直连侧：为每个平台建一张别名表（和 board-store 的 marketIndex 一致）──
line('===== 1. 直连侧别名表 =====');
const alias = new Map(); // venue -> Map(别名 -> 来源字段)
for (const v of VENUES) {
  const t = new Map();
  try {
    const evs = await getVenue(v).fetchEvents(
      v === 'polymarket' ? { limit: 300 } : { limit: 300, sort: 'volume', status: 'active' },
    );
    let sample = null;
    for (const ev of evs || []) for (const m of ev.markets || []) {
      if (!sample) sample = m;
      const add = (val, from) => { if (val != null && val !== '' && !t.has(String(val))) t.set(String(val), from); };
      add(m.marketId, 'marketId');
      add(m.slug, 'slug');
      add(m.sourceMetadata?.ticker, 'sourceMetadata.ticker');
      add(m.sourceMetadata?.marketTicker, 'sourceMetadata.marketTicker');
      add(m.sourceMetadata?.conditionId, 'sourceMetadata.conditionId');
      add(m.sourceMetadata?.id, 'sourceMetadata.id');
    }
    line(`  ${v}: ${t.size} 条别名`);
    if (sample) {
      line(`    样本 market 的字段: ${Object.keys(sample).join(', ')}`);
      line(`    marketId=${JSON.stringify(sample.marketId)}  slug=${JSON.stringify(sample.slug)}`);
      line(`    sourceMetadata 字段: ${Object.keys(sample.sourceMetadata || {}).join(', ') || '(无)'}`);
    }
  } catch (e) { line(`  ${v}: 抓取失败 ${e.message}`); }
  alias.set(v, t);
}
line('');

// ── 2. 托管侧：多拉几页，逐字段去撞 ────────────────────────────────────
line('===== 2. 逐字段命中率（关键）=====');
const clusters = await hosted.fetchAllMarketClusters({ venues: VENUES, pageSize: 250, maxPages: 1 });
line(`拿到 ${clusters.length} 个集群`);

const stat = {}; // venue -> field -> {hit, total, 命中的直连字段}
let members = 0;
for (const c of clusters) {
  for (const m of hosted.clusterMembers(c)) {
    const v = hosted.memberVenue(m);
    const t = alias.get(v);
    if (!t) continue;
    members++;
    stat[v] ??= {};
    for (const f of CAND) {
      const raw = m[f];
      if (raw == null || raw === '') continue;
      stat[v][f] ??= { 出现: 0, 命中: 0, 对上的是: new Set(), 未命中样本: [] };
      const s = stat[v][f];
      s.出现++;
      // url 这种要取最后一段再撞
      const tries = [String(raw)];
      if (f === 'url') tries.push(String(raw).split('/').filter(Boolean).pop());
      let hitFrom = null;
      for (const x of tries) if (t.has(x)) { hitFrom = t.get(x); break; }
      if (hitFrom) { s.命中++; s.对上的是.add(hitFrom); }
      else if (s.未命中样本.length < 2) s.未命中样本.push(String(raw).slice(0, 60));
    }
  }
}
line(`比对了 ${members} 个集群成员`);
line('');
for (const [v, fields] of Object.entries(stat)) {
  line(`  【${v}】`);
  for (const [f, s] of Object.entries(fields)) {
    const pct = s.出现 ? Math.round((s.命中 / s.出现) * 100) : 0;
    line(`    ${f.padEnd(16)} 出现 ${String(s.出现).padStart(4)}  命中 ${String(s.命中).padStart(4)} (${pct}%)  对上直连的 ${[...s.对上的是].join('/') || '—'}`);
    if (!s.命中 && s.未命中样本.length) line(`        没对上的样本: ${s.未命中样本.join(' | ')}`);
  }
  line('');
}
line('判读：命中率最高的那一行，就是该用的 join key。');
line('     若三家各有各的字段，就在 clusterOf 里把成员的所有候选字段全部登记成别名。');
process.exit(0);
