// 标题中译（腾讯云机器翻译 TMT）
// ---------------------------------------------------------------------------
// 三条设计原则，改之前先读：
//
// 1) **绝不阻塞主链路**。翻译是锦上添花，同步和行情是主业。
//    整个模块是「同步时只查缓存、查不到就丢进队列、后台慢慢翻、翻好了回填」。
//    腾讯云挂了、key 填错了、额度用光了 —— 看板照常出数据，只是中文暂时是空的。
//
// 2) **按原文缓存，不按行缓存**。1200 个标的的标题大部分几周都不变，
//    真正要翻的只有新上的盘。缓存落在 /data 卷里，重启不丢。
//    子行候选名（"Manchester United"、"Yes"）重复度极高，命中率会非常好看。
//
// 3) **限额全部可配、默认取小**。官方文档站是 SPA，抓不到准确的批量条数/QPS，
//    所以这里默认一次 20 条、单批 1800 字符、每秒 1 个请求，撞限流就退避。
//    真实额度比这宽的话，把 PMXT_TR_* 调大就行，代码不用动。
//
// 计费：机器翻译按字符算，有每月免费额度。我们首轮全量约 7 万字符，
// 之后每轮几十到几百条 —— 成本几乎全在第一次。
import { createHmac, createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { log, sleep } from './util.mjs';

const HOST = 'tmt.tencentcloudapi.com';
const SERVICE = 'tmt';
const VERSION = '2018-03-21';
const ACTION = 'TextTranslateBatch';

const CACHE_PATH = process.env.PMXT_I18N_CACHE || '/data/i18n-zh.json';
const REGION = process.env.TENCENT_REGION || 'ap-guangzhou';
const BATCH_N = Number(process.env.PMXT_TR_BATCH || 20);
const BATCH_CHARS = Number(process.env.PMXT_TR_BATCH_CHARS || 1800);
const GAP_MS = Number(process.env.PMXT_TR_GAP_MS || 1000);
// 一轮最多翻多少条。首轮全量 1200 条标题 + 子行候选，按默认节奏要几分钟；
// 设个上限是为了「即使某天平台换了一大批盘」也不会突然烧掉一大截免费额度。
const MAX_PER_ROUND = Number(process.env.PMXT_TR_MAX_PER_ROUND || 3000);

const secretId = () => process.env.TENCENT_SECRET_ID || '';
const secretKey = () => process.env.TENCENT_SECRET_KEY || '';
export const enabled = () => Boolean(secretId() && secretKey());

export const diag = {
  cacheSize: 0, queued: 0, translated: 0, seeded: 0, charsUsed: 0,
  callCount: 0, lastError: null, lastOkAt: null, running: false,
};

// ── 术语表 ───────────────────────────────────────────────────────────
// 机翻对预测市场的行话很生硬（nominee 翻成「被提名者」、shutdown 翻成「关闭」）。
// 译后替换比译前替换好：译前把英文换成中文会让机翻的句法分析乱掉。
// 只放**确定会翻错**的，别把这里堆成词典 —— 每一条都是一次全局字符串替换的开销。
const GLOSSARY = [
  [/被提名人|被提名者/g, '提名人'],
  [/政府关闭/g, '政府停摆'],
  [/利率削减|降低利率/g, '降息'],
  [/利率上调|提高利率/g, '加息'],
  [/年底之前|到年底/g, '年底前'],
  [/民主党初选/g, '民主党党内初选'],
  [/共和党初选/g, '共和党党内初选'],
];

function polish(s) {
  let out = String(s || '');
  for (const [re, to] of GLOSSARY) out = out.replace(re, to);
  return out.trim();
}

// ── 缓存 ─────────────────────────────────────────────────────────────
const cache = new Map();   // 原文 -> 中文
const queue = new Map();   // 原文 -> true（用 Map 去重，顺序也稳定）
let dirty = false;

/** 原文归一化：大小写和首尾空白不同不该算两条，白花两份钱 */
function norm(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }

export function load() {
  try {
    if (!existsSync(CACHE_PATH)) return;
    const j = JSON.parse(readFileSync(CACHE_PATH, 'utf8'));
    for (const [k, v] of Object.entries(j?.map || {})) cache.set(k, v);
    diag.cacheSize = cache.size;
    log.info(`译文缓存已载入 ${cache.size} 条`);
  } catch (e) { log.warn(`译文缓存读取失败（不影响运行）: ${e.message}`); }
}

function save() {
  if (!dirty) return;
  try {
    mkdirSync(dirname(CACHE_PATH), { recursive: true });
    writeFileSync(CACHE_PATH, JSON.stringify({ v: 1, ts: Date.now(), map: Object.fromEntries(cache) }));
    dirty = false;
  } catch (e) { log.warn(`译文缓存写入失败: ${e.message}`); }
}

/** 查缓存。查不到返回 null —— 前端据此回退显示英文，不要返回原文假装翻过了 */
export function zh(text) {
  const k = norm(text);
  if (!k) return null;
  // 纯数字、纯符号、本来就是中文的，不用翻
  if (!/[a-zA-Z]/.test(k)) return null;
  return cache.get(k) || null;
}

/**
 * 塞入外部来源的现成译文（目前是 Polymarket 官方中文）。
 * 白拿的优先于机翻：同一条原文如果 Poly 已经给了中文，就不该再花钱去翻。
 *
 * 覆盖策略：**外部译文覆盖机翻结果**。Poly 的文案是他们自己站上在用的，
 * 和用户在 polymarket.com 看到的一致，比我们的机翻更该被信任。
 * 代价是缓存里那条机翻白花了 —— 一次性的，之后每轮都省。
 * 不过外部译文不再走术语表：那是给机翻擦屁股的，Poly 的文案不该被我们改写。
 */
export function seed(pairs) {
  let added = 0;
  for (const [en, zhText] of pairs || []) {
    const k = norm(en);
    if (!k || !zhText) continue;
    if (cache.get(k) === zhText) continue;
    cache.set(k, String(zhText).trim());
    queue.delete(k);      // 已经有现成的了，别再送去机翻
    added++;
  }
  if (added) { dirty = true; diag.seeded += added; diag.cacheSize = cache.size; diag.queued = queue.size; save(); }
  return added;
}

/** 丢进待翻队列（不发请求，只登记）。同步过程中调用，必须极快。 */
export function want(text) {
  const k = norm(text);
  if (!k || cache.has(k) || queue.has(k)) return;
  if (!/[a-zA-Z]/.test(k)) return;
  // 太长的标题（>500 字符）大概率是描述被当成标题了，翻它不划算
  if (k.length > 500) return;
  queue.set(k, true);
  diag.queued = queue.size;
}

// ── TC3 签名 ─────────────────────────────────────────────────────────
// 没引腾讯云 SDK：这个签名算法四十行就写完了，而 SDK 会把整个云产品列表
// 拖进镜像。要点是每一步都用**规范化**后的字符串，任何一处多个空格都会签失败。
function sign(payload, ts) {
  const date = new Date(ts * 1000).toISOString().slice(0, 10);
  const ct = 'application/json; charset=utf-8';
  const canonicalHeaders = `content-type:${ct}\nhost:${HOST}\nx-tc-action:${ACTION.toLowerCase()}\n`;
  const signedHeaders = 'content-type;host;x-tc-action';
  const hashedPayload = createHash('sha256').update(payload).digest('hex');
  const canonicalRequest = ['POST', '/', '', canonicalHeaders, signedHeaders, hashedPayload].join('\n');

  const scope = `${date}/${SERVICE}/tc3_request`;
  const stringToSign = [
    'TC3-HMAC-SHA256', String(ts), scope,
    createHash('sha256').update(canonicalRequest).digest('hex'),
  ].join('\n');

  const kDate = createHmac('sha256', `TC3${secretKey()}`).update(date).digest();
  const kService = createHmac('sha256', kDate).update(SERVICE).digest();
  const kSigning = createHmac('sha256', kService).update('tc3_request').digest();
  const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');

  return {
    Authorization: `TC3-HMAC-SHA256 Credential=${secretId()}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    'Content-Type': ct,
    Host: HOST,
    'X-TC-Action': ACTION,
    'X-TC-Version': VERSION,
    'X-TC-Timestamp': String(ts),
    'X-TC-Region': REGION,
  };
}

async function translateBatch(texts) {
  const payload = JSON.stringify({ SourceTextList: texts, Source: 'en', Target: 'zh', ProjectId: 0 });
  const ts = Math.floor(Date.now() / 1000);
  const r = await fetch(`https://${HOST}`, {
    method: 'POST', body: payload, headers: sign(payload, ts),
    signal: AbortSignal.timeout(30_000),
  });
  diag.callCount++;
  const j = await r.json().catch(() => null);
  const err = j?.Response?.Error;
  if (err) {
    const e = new Error(`${err.Code}: ${err.Message}`);
    e.code = err.Code;
    throw e;
  }
  const out = j?.Response?.TargetTextList;
  if (!Array.isArray(out)) throw new Error(`响应结构异常: ${JSON.stringify(j).slice(0, 160)}`);
  return out;
}

// ── 后台队列 ─────────────────────────────────────────────────────────
const listeners = new Set();
/** 每翻完一批回调一次，让 board-store 把已经在表上的行就地补上中文 */
export function onBatch(fn) { listeners.add(fn); return () => listeners.delete(fn); }

let looping = false;

/**
 * 把队列翻完。同步结束时调一次即可，重复调用会自动合并（looping 守卫）。
 * 整个函数不 throw —— 调用方不该因为翻译失败而进 catch。
 */
export async function drain() {
  if (looping || !enabled() || !queue.size) return;
  looping = true;
  diag.running = true;
  let done = 0;
  try {
    while (queue.size && done < MAX_PER_ROUND) {
      // 攒一批：条数和字符数谁先到算谁
      const batch = [];
      let chars = 0;
      for (const k of queue.keys()) {
        if (batch.length >= BATCH_N || chars + k.length > BATCH_CHARS) break;
        batch.push(k); chars += k.length;
      }
      if (!batch.length) break;

      let out;
      try {
        out = await translateBatch(batch);
      } catch (e) {
        diag.lastError = e.message;
        if (/RequestLimitExceeded|LimitExceeded|Throttling/i.test(e.code || e.message)) {
          // 撞限流：等一下重来，这一批**不出队**
          log.warn(`翻译限流，10 秒后继续（${e.message}）`);
          await sleep(10_000);
          continue;
        }
        // 鉴权错、额度用尽这类是「重试也没用」，整轮停掉，等下一轮同步再说。
        // 不清空队列 —— key 修好之后不用等新标的出现就能补上。
        log.warn(`翻译失败，本轮停止: ${e.message}`);
        break;
      }

      for (let i = 0; i < batch.length; i++) {
        const zhText = polish(out[i]);
        if (zhText) { cache.set(batch[i], zhText); diag.translated++; }
        queue.delete(batch[i]);
      }
      diag.charsUsed += chars;
      diag.queued = queue.size;
      diag.cacheSize = cache.size;
      diag.lastOkAt = Date.now();
      dirty = true;
      done += batch.length;

      for (const fn of listeners) { try { fn(); } catch { /* 回填失败不该影响翻译 */ } }
      await sleep(GAP_MS);
    }
  } finally {
    save();
    looping = false;
    diag.running = false;
    if (done) log.info(`本轮翻译 ${done} 条，缓存共 ${cache.size} 条，队列剩 ${queue.size}`);
  }
}
