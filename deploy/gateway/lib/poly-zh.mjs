// 从 Polymarket 白拿中文标题
// ---------------------------------------------------------------------------
// Polymarket 官网本来就有中文版，中文是 Gamma 接口自己给的：
//   GET /events?locale=zh   →  title / markets[].question / markets[].groupItemTitle
//                              / tags[].label 全部换成中文
// 免费、不烧 credit、和用户在 polymarket.com 上看到的文案完全一致。
//
// 2026-08 实测（按 24h 成交额取前 50 个事件）：
//   事件标题        46/50   92%
//   markets.question 768/1339  57%
//   groupItemTitle   511/1337  38%
//   标签             252/276  91%
// 也就是说**覆盖不全**，越冷门的盘越可能还是英文，Kalshi / Limitless 独有的标的更是一条都没有。
// 所以这个模块的定位是「先白嫖，剩下的再花钱」：
//   Poly 给了中文 → 直接塞进 translate 的缓存
//   Poly 没给     → 走腾讯云机翻
//
// 为什么要 en / zh 各拉一遍：
//   translate 的缓存**按英文原文做 key**（见 translate.mjs 的设计说明），
//   而 locale=zh 的响应里已经没有英文了。所以必须拉两遍，按 Gamma 自己的
//   id 把两边配对，才能得到「英文原文 → 中文」这一对。两次都是免费直连调用。
//
// 为什么不直接给 pmxt-core 的 fetchEvents 传 locale：
//   core 的参数转发有个坑（见 venues.mjs 里那一大段注释）——
//   只要多传一个 limit/offset 之外的参数，limit 就不会下传给平台实现，
//   Polymarket 会一路翻页翻到 offset 9900 撞上 Gamma 的 422。
//   与其去跟那个启发式搏斗，不如自己直连 Gamma，反正只用得上标题。
import { log } from './util.mjs';

const BASE = process.env.PMXT_GAMMA_BASE || 'https://gamma-api.polymarket.com';
const LOCALE = process.env.PMXT_POLY_LOCALE || 'zh';
const PAGE = 100;
// Gamma 的 offset 有上限（实测 2000 过、3000 挂），这里跟 venues.mjs 保持同一个口径
const MAX_EVENTS = Number(process.env.PMXT_POLY_ZH_MAX || 1200);

export const diag = { pairs: 0, pages: 0, lastMs: null, lastError: null, lastAt: null };

const hasCJK = (s) => /[一-龥]/.test(String(s || ''));

async function page(offset, locale) {
  const p = new URLSearchParams({
    limit: String(PAGE), offset: String(offset),
    closed: 'false', active: 'true', order: 'volume24hr', ascending: 'false',
  });
  if (locale) p.set('locale', locale);
  const r = await fetch(`${BASE}/events?${p}`, { signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`Gamma ${r.status}`);
  const j = await r.json();
  return Array.isArray(j) ? j : [];
}

/**
 * 拉一遍中英对照，返回 [英文, 中文] 数组。
 * 任何一步出错都只是「这轮白嫖失败」，返回已经配上的部分，绝不抛给同步链路。
 */
export async function fetchPairs(limit = MAX_EVENTS) {
  const t0 = Date.now();
  const out = [];
  try {
    for (let off = 0; off < Math.min(limit, MAX_EVENTS); off += PAGE) {
      // en / zh 同一页并行拉：两次请求参数除 locale 外完全一致，
      // 排序也一样（order=volume24hr），所以同一页的 id 集合是对得上的。
      // 但**不能按下标配对** —— 中间有盘结算掉的话整页就错位了，必须按 id。
      const [en, zh] = await Promise.all([page(off, null), page(off, LOCALE)]);
      diag.pages += 2;
      if (!en.length) break;

      const zhEv = new Map(zh.map((e) => [String(e.id), e]));
      for (const e of en) {
        const z = zhEv.get(String(e.id));
        if (!z) continue;
        const pair = (a, b) => { if (a && b && a !== b && hasCJK(b)) out.push([String(a), String(b)]); };
        pair(e.title, z.title);

        const zhMk = new Map((z.markets || []).map((m) => [String(m.id), m]));
        for (const m of e.markets || []) {
          const zm = zhMk.get(String(m.id));
          if (!zm) continue;
          pair(m.groupItemTitle, zm.groupItemTitle);
          pair(m.question, zm.question);
        }

        const zhTag = new Map((z.tags || []).map((t) => [String(t.id), t]));
        for (const t of e.tags || []) {
          const zt = zhTag.get(String(t.id));
          if (zt) pair(t.label, zt.label);
        }
      }
      if (en.length < PAGE) break;
    }
    diag.pairs = out.length;
    diag.lastMs = Date.now() - t0;
    diag.lastAt = Date.now();
    diag.lastError = null;
    log.info(`Polymarket 官方中文：配对 ${out.length} 条（${diag.lastMs}ms）`);
  } catch (e) {
    diag.lastError = String(e?.message || e);
    log.warn(`Polymarket 官方中文抓取失败（不影响运行，改走机翻）: ${diag.lastError}`);
  }
  return out;
}
