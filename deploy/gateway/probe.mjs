#!/usr/bin/env node
// pmxt 托管匹配接口「生产探针」
// ---------------------------------------------------------------------------
// 为什么需要它：官方 OpenAPI 里 /v0/matched-market-clusters **没有定义响应结构**，
// 文档示例只露了 5 个字段，两个 SDK 却按完整市场解析。不实测就照着设计，等于赌。
// 本脚本用你自己的 key 打一遍真实接口，把「响应长什么样」摊开给你看。
//
// 用法（在服务器上，pmxt 目录里）：
//   docker compose -f deploy/docker-compose.yml exec gateway node /app/deploy/gateway/probe.mjs
// 或者直接带 key 跑：
//   PMXT_API_KEY=pmxt_xxx node deploy/gateway/probe.mjs
//
// 消耗：约 8~10 个 credit（免费档每月 25000，忽略不计）。
// 产物：控制台报告 + /tmp/pmxt-probe-report.json（完整原始样本，方便贴回来给我看）
import { writeFileSync } from 'node:fs';

const KEY = process.env.PMXT_API_KEY || '';
const BASE = process.env.PMXT_HOSTED_BASE || 'https://api.pmxt.dev';
const VENUES = process.env.PMXT_VENUES || 'polymarket,kalshi,limitless';

if (!KEY) {
  console.error('✗ 没有读到 PMXT_API_KEY。请在容器内跑（env_file 会注入），或者 PMXT_API_KEY=xxx node probe.mjs');
  process.exit(1);
}

const report = { base: BASE, ts: new Date().toISOString(), steps: [] };
let credits = 0;

async function call(label, path) {
  const url = `${BASE}${path}`;
  const t0 = Date.now();
  try {
    const r = await fetch(url, {
      headers: { authorization: `Bearer ${KEY}`, accept: 'application/json' },
      signal: AbortSignal.timeout(60_000),
    });
    credits += 1;
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 非 JSON */ }
    const step = {
      label, path, status: r.status, ms: Date.now() - t0,
      rateLimit: {
        limit: r.headers.get('x-ratelimit-limit'),
        remaining: r.headers.get('x-ratelimit-remaining'),
        creditsRemaining: r.headers.get('x-credits-remaining') || r.headers.get('x-ratelimit-credits-remaining'),
      },
      ok: r.ok,
      bodyPreview: json ? null : text.slice(0, 500),
    };
    report.steps.push(step);
    console.log(`\n── ${label}`);
    console.log(`   ${path}`);
    console.log(`   HTTP ${r.status}  ${Date.now() - t0}ms`);
    if (step.rateLimit.remaining) console.log(`   剩余额度: ${step.rateLimit.remaining}/${step.rateLimit.limit}  credits: ${step.rateLimit.creditsRemaining ?? 'n/a'}`);
    if (!r.ok) console.log(`   ✗ 响应体: ${text.slice(0, 400)}`);
    return { ok: r.ok, json, text, step };
  } catch (e) {
    console.log(`\n── ${label}`);
    console.log(`   ✗ 请求失败: ${e.message}`);
    report.steps.push({ label, path, error: String(e.message) });
    return { ok: false, json: null, text: '', step: null };
  }
}

// —— 信封形状判定：裸数组？{data}？{clusters}？{items}？——
function unwrap(json) {
  if (Array.isArray(json)) return { shape: 'bare-array', list: json, meta: null };
  if (!json || typeof json !== 'object') return { shape: 'unknown', list: [], meta: null };
  for (const k of ['data', 'clusters', 'items', 'results', 'markets']) {
    if (Array.isArray(json[k])) {
      const meta = { ...json };
      delete meta[k];
      return { shape: `{${k}: [...]}`, list: json[k], meta };
    }
  }
  // {success, data:{clusters:[]}} 这种两层
  if (json.data && typeof json.data === 'object') {
    for (const k of ['clusters', 'items', 'results']) {
      if (Array.isArray(json.data[k])) return { shape: `{data:{${k}:[...]}}`, list: json.data[k], meta: json.data };
    }
  }
  return { shape: 'object-no-array', list: [], meta: json, keys: Object.keys(json) };
}

// —— 字段普查：某个字段在样本里出现率多少、非空率多少 ——
function census(objs, fields) {
  const out = {};
  for (const f of fields) {
    let present = 0, nonEmpty = 0;
    const samples = [];
    for (const o of objs) {
      if (o && Object.prototype.hasOwnProperty.call(o, f)) {
        present++;
        const v = o[f];
        const empty = v === null || v === undefined || v === '' ||
          (Array.isArray(v) && v.length === 0) ||
          (typeof v === 'number' && !Number.isFinite(v));
        if (!empty) { nonEmpty++; if (samples.length < 2) samples.push(v); }
      }
    }
    out[f] = {
      present: `${present}/${objs.length}`,
      nonEmpty: `${nonEmpty}/${objs.length}`,
      sample: samples.length ? JSON.stringify(samples[0]).slice(0, 90) : null,
    };
  }
  return out;
}

function printCensus(title, c) {
  console.log(`\n   ${title}`);
  const pad = (s, n) => String(s).padEnd(n);
  console.log(`   ${pad('字段', 22)}${pad('存在', 10)}${pad('非空', 10)}示例`);
  for (const [f, v] of Object.entries(c)) {
    const flag = v.nonEmpty.startsWith('0/') ? ' ✗' : '';
    console.log(`   ${pad(f, 22)}${pad(v.present, 10)}${pad(v.nonEmpty, 10)}${v.sample ?? '—'}${flag}`);
  }
}

(async () => {
  console.log('═'.repeat(78));
  console.log('pmxt 托管匹配接口 · 生产探针');
  console.log(`base = ${BASE}   venues = ${VENUES}`);
  console.log('═'.repeat(78));

  // ── 1. 信封形状 + 一条完整样本（这是最关键的一步）──────────────────────
  const a = await call('① 信封形状 & 单条完整样本', `/v0/matched-market-clusters?limit=2&includeRawMatches=true`);
  if (!a.ok) {
    console.log('\n首个请求就失败了，后面不用跑了。常见原因：key 无效 / 免费档不含该接口 / 路径变了。');
    console.log('可以手动试试这几个候选路径：');
    for (const p of ['/v0/matched-market-clusters', '/v0/clusters', '/v0/matched-markets']) {
      await call(`  探路 ${p}`, `${p}?limit=1`);
    }
    writeFileSync('/tmp/pmxt-probe-report.json', JSON.stringify(report, null, 2));
    process.exit(1);
  }

  const u = unwrap(a.json);
  report.envelope = { shape: u.shape, metaKeys: u.meta ? Object.keys(u.meta) : [], topKeys: u.keys };
  console.log(`\n   ▸ 信封形状：${u.shape}`);
  if (u.meta && Object.keys(u.meta).length) console.log(`   ▸ 信封里除列表外还有：${Object.keys(u.meta).join(', ')}`);
  console.log(`   ▸ 本页条数：${u.list.length}`);

  if (u.list[0]) {
    report.fullSample = u.list[0];
    console.log('\n   ▸ 第 1 条集群的**完整原文**（这就是我要的答案）：');
    console.log(JSON.stringify(u.list[0], null, 2).split('\n').map((l) => '     ' + l).join('\n').slice(0, 6000));
  }

  // ── 2. 字段普查（100 条样本）────────────────────────────────────────
  const b = await call('② 字段完整度普查（100 条）', `/v0/matched-market-clusters?limit=100`);
  const ub = unwrap(b.json);
  const clusters = ub.list;
  if (clusters.length) {
    const clusterFields = [...new Set(clusters.flatMap((c) => Object.keys(c || {})))];
    console.log(`\n   ▸ 集群层出现过的全部字段：${clusterFields.join(', ')}`);
    report.clusterFields = clusterFields;
    printCensus('集群层字段普查：', census(clusters, clusterFields));

    const mkts = clusters.flatMap((c) => (Array.isArray(c?.markets) ? c.markets : []));
    report.marketCount = mkts.length;
    if (mkts.length) {
      const mktFields = [...new Set(mkts.flatMap((m) => Object.keys(m || {})))];
      console.log(`\n   ▸ markets[] 层出现过的全部字段：${mktFields.join(', ')}`);
      report.marketFields = mktFields;
      printCensus(`markets[] 字段普查（共 ${mkts.length} 条）—— 决定我们还要不要自己补数据：`, census(mkts, mktFields));
      report.marketSample = mkts[0];

      // 我们设计里强依赖的几个字段，单独结论
      const need = ['volume24h', 'volume', 'liquidity', 'resolutionDate', 'url', 'tags', 'category', 'status', 'outcomes', 'sourceExchange', 'marketId', 'title'];
      console.log('\n   ▸ 设计强依赖字段的结论：');
      const c2 = census(mkts, need);
      for (const f of need) {
        const v = c2[f];
        const has = !v.nonEmpty.startsWith('0/');
        console.log(`     ${has ? '✓' : '✗'} ${f.padEnd(16)} ${v.nonEmpty}${has ? '' : '  → 得靠直连补'}`);
      }
      report.criticalFields = c2;

      // outcomes 结构（方向归一的关键）
      const withOut = mkts.find((m) => Array.isArray(m?.outcomes) && m.outcomes.length);
      if (withOut) {
        console.log('\n   ▸ outcomes 样例（方向归一要看的）：');
        console.log('     ' + JSON.stringify(withOut.outcomes).slice(0, 400));
        report.outcomesSample = withOut.outcomes;
      } else {
        console.log('\n   ✗ 样本里 markets[] 全都没有 outcomes → 价格必须走直连，集群只当「结构/匹配」用。');
      }

      // 平台分布
      const byVenue = {};
      for (const m of mkts) {
        const v = m?.sourceExchange || m?.exchange || m?.venue || 'unknown';
        byVenue[v] = (byVenue[v] || 0) + 1;
      }
      console.log(`\n   ▸ 平台分布：${JSON.stringify(byVenue)}`);
      report.venueDistribution = byVenue;

      // 每个集群几个平台 → 决定「只有 poly 有的标的会不会出现在集群结果里」
      const sizes = {};
      for (const c of clusters) {
        const n = new Set((c.markets || []).map((m) => m?.sourceExchange || m?.exchange || m?.venue)).size;
        sizes[n] = (sizes[n] || 0) + 1;
      }
      console.log(`   ▸ 集群跨平台数分布（key=平台数, value=集群数）：${JSON.stringify(sizes)}`);
      console.log(`     若不存在 "1"，说明单平台标的不进集群 → 必须用「Poly 全量 ∪ 集群」求并集（我们方案正是这么设计的）。`);
      report.clusterVenueCountDist = sizes;
    } else {
      console.log('\n   ✗ 集群里没有 markets[] 数组 —— 响应结构与预期完全不同，见上面的完整原文。');
    }
  }

  // ── 3. venues / minVenues 语义 ───────────────────────────────────────
  const c1 = await call('③ venues 过滤语义（只要 poly+kalshi）', `/v0/matched-market-clusters?venues=polymarket,kalshi&limit=20`);
  const uc1 = unwrap(c1.json);
  if (uc1.list.length) {
    const vset = new Set(uc1.list.flatMap((c) => (c.markets || []).map((m) => m?.sourceExchange || m?.exchange || m?.venue)));
    console.log(`   ▸ 返回集群里出现的平台：${[...vset].join(', ')}`);
    console.log(`     若出现了 limitless → venues 是「至少包含」而非「仅限于」，前端过滤不能只依赖它。`);
    report.venuesFilterResult = [...vset];
  }
  const c2r = await call('④ minVenues=3 语义', `/v0/matched-market-clusters?venues=${VENUES}&minVenues=3&limit=20`);
  const uc2 = unwrap(c2r.json);
  if (uc2.list.length) {
    const sizes = uc2.list.map((c) => new Set((c.markets || []).map((m) => m?.sourceExchange || m?.exchange || m?.venue)).size);
    console.log(`   ▸ 各集群平台数：${sizes.join(',')}  最小=${Math.min(...sizes)}`);
    report.minVenuesResult = { min: Math.min(...sizes), sizes };
  } else {
    console.log(`   ▸ minVenues=3 返回 0 条（可能三家同时有的标的确实很少，也可能参数不支持）。`);
  }

  // ── 4. 分页 & 目录总量（决定 15 分钟同步的 credit 预算）──────────────
  console.log('\n── ⑤ 分页与总量（决定同步成本）');
  const big = await call('   limit=500 第一页', `/v0/matched-market-clusters?limit=500`);
  const ubig = unwrap(big.json);
  console.log(`   ▸ limit=500 实际返回：${ubig.list.length} 条`);
  if (ubig.list.length < 500) console.log(`     ← 说明 500 已到顶，或服务端上限更低（实际上限 ≈ ${ubig.list.length}）。`);
  if (ubig.meta) {
    const totalish = Object.entries(ubig.meta).filter(([k]) => /total|count|next|cursor|offset|page|has/i.test(k));
    if (totalish.length) console.log(`   ▸ 信封里的分页线索：${JSON.stringify(Object.fromEntries(totalish))}`);
  }
  const page2 = await call('   offset 分页是否生效', `/v0/matched-market-clusters?limit=5&offset=5`);
  const up2 = unwrap(page2.json);
  const id = (c) => c?.clusterId || c?.id || JSON.stringify(c).slice(0, 40);
  if (up2.list.length && ubig.list.length) {
    const firstPageIds = new Set(ubig.list.slice(0, 5).map(id));
    const overlap = up2.list.filter((c) => firstPageIds.has(id(c))).length;
    console.log(`   ▸ offset=5 与第一页前 5 条重合 ${overlap}/5 → ${overlap === 0 ? 'offset 生效 ✓' : 'offset 可能被忽略 ✗，得改用 cursor'}`);
    report.offsetWorks = overlap === 0;
  }
  report.pageSizeCap = ubig.list.length;

  // ── 5. 事件集群（父行折叠要用）────────────────────────────────────────
  const ev = await call('⑥ 事件集群接口（父子行要用）', `/v0/matched-event-clusters?limit=2&includeRawMatches=true`);
  if (ev.ok) {
    const uev = unwrap(ev.json);
    console.log(`   ▸ 信封：${uev.shape}，本页 ${uev.list.length} 条`);
    if (uev.list[0]) {
      console.log(`   ▸ 事件集群字段：${Object.keys(uev.list[0]).join(', ')}`);
      report.eventClusterSample = uev.list[0];
      const evm = uev.list[0].events || uev.list[0].markets || [];
      if (evm[0]) console.log(`   ▸ 子对象字段：${Object.keys(evm[0]).join(', ')}`);
    }
  }

  // ── 汇总 ─────────────────────────────────────────────────────────────
  report.creditsUsed = credits;
  writeFileSync('/tmp/pmxt-probe-report.json', JSON.stringify(report, null, 2));
  console.log('\n' + '═'.repeat(78));
  console.log(`探针结束，用掉约 ${credits} 个 credit。`);
  console.log('完整原始样本已写到  /tmp/pmxt-probe-report.json');
  console.log('把上面控制台输出（或那个 json）贴回来，我据此确认聚合层的取数策略。');
  console.log('═'.repeat(78));
})();
