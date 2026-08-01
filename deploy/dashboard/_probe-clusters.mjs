// 集群 ID 对不上探针（一次性排查用，跑完可以删）
// -------------------------------------------------------------------------
// 现象：托管接口给了 842 个集群，但 matchedRowCount=0，次要区里一条 matchSource
// 也不是 'cluster'。也就是说 clusterOf / marketIndex 这两张表的 key 一个都没撞上。
// board-store 的 key 是 `平台:marketId`，两边的 marketId 只要格式不同就全盘皆输。
// 这个脚本把两边的 id 原样打出来，肉眼一比就知道差在哪。
//
// 跑法（容器内，约花 1 个 credit）：
//   docker compose exec gateway node /app/deploy/dashboard/_probe-clusters.mjs
import * as hosted from '/app/deploy/gateway/lib/hosted.mjs';
import { getVenue } from '/app/deploy/gateway/lib/venues.mjs';

const VENUES = String(process.env.PMXT_VENUES || 'polymarket,kalshi,limitless')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

const line = (s = '') => console.log(s);
const idFields = ['marketId', 'id', 'market_id', 'ticker', 'slug', 'conditionId', 'condition_id', 'tokenId', 'externalId'];

line('平台列表: ' + VENUES.join(', '));
line('');

// ── 1. 托管接口给的集群长什么样 ────────────────────────────────────────
line('===== 1. 托管接口返回的集群 =====');
const clusters = await hosted.fetchAllMarketClusters({ venues: VENUES, pageSize: 5, maxPages: 1 });
line(`拿到 ${clusters.length} 个集群`);
if (!clusters.length) { line('一个都没有，后面不用看了'); process.exit(0); }

const c0 = clusters[0];
line('第一个集群的顶层字段: ' + Object.keys(c0).join(', '));
line('clusterId = ' + hosted.clusterId(c0));
line('canonicalTitle = ' + (c0.canonicalTitle || c0.title || '(无)'));
line('');
line('--- 它的成员 ---');
for (const m of hosted.clusterMembers(c0)) {
  const ids = idFields.filter((k) => m[k] != null).map((k) => `${k}=${JSON.stringify(m[k])}`);
  line(`  平台=${hosted.memberVenue(m)}`);
  line(`    memberMarketId() 取到的 = ${JSON.stringify(hosted.memberMarketId(m))}`);
  line(`    所有像 id 的字段: ${ids.join('  ') || '(一个都没有！)'}`);
  line(`    全部字段名: ${Object.keys(m).join(', ')}`);
}
line('');

// ── 2. 直连各平台拿到的 marketId 长什么样 ──────────────────────────────
line('===== 2. 直连各平台的 marketId =====');
const direct = new Map(); // venue -> Set(marketId)
for (const v of VENUES) {
  try {
    const evs = await getVenue(v).fetchEvents(
      v === 'polymarket' ? { limit: 300 } : { limit: 300, sort: 'volume', status: 'active' },
    );
    const set = new Set();
    for (const ev of evs || []) for (const m of ev.markets || []) if (m.marketId != null) set.add(String(m.marketId));
    direct.set(v, set);
    line(`  ${v}: ${set.size} 个市场，样本 = ${[...set].slice(0, 3).map((s) => JSON.stringify(s)).join(', ')}`);
  } catch (e) {
    line(`  ${v}: 抓取失败 ${e.message}`);
    direct.set(v, new Set());
  }
}
line('');

// ── 3. 正面对撞：集群成员的 id 在直连结果里找得到吗 ────────────────────
line('===== 3. 对撞结果（这是关键）=====');
const stat = {};
let checked = 0;
for (const c of clusters) {
  for (const m of hosted.clusterMembers(c)) {
    const v = hosted.memberVenue(m);
    if (!v || !direct.has(v)) continue;
    checked++;
    stat[v] ??= { 命中: 0, 未命中: 0, 未命中样本: [] };
    const id = hosted.memberMarketId(m);
    if (id != null && direct.get(v).has(String(id))) stat[v].命中++;
    else {
      stat[v].未命中++;
      if (stat[v].未命中样本.length < 3) stat[v].未命中样本.push(String(id));
    }
  }
}
line(`一共比对了 ${checked} 个集群成员`);
for (const [v, s] of Object.entries(stat)) {
  line(`  ${v}: 命中 ${s.命中} / 未命中 ${s.未命中}`);
  if (s.未命中样本.length) {
    line(`     托管给的 id : ${s.未命中样本.map((x) => JSON.stringify(x)).join(', ')}`);
    line(`     直连的 id   : ${[...direct.get(v)].slice(0, 3).map((x) => JSON.stringify(x)).join(', ')}`);
  }
}
line('');
line('判读：某个平台「未命中」占压倒多数，就说明两边 id 不同源 ——');
line('     对比上面两行的格式，就能定出该用成员里的哪个字段（或者要做什么换算）。');
process.exit(0);
