# pmxt 行情台 · 云主机部署手册

和 homerun 同机运行，端口/容器完全隔离，复用同一条 SSH 隧道。带 `$` 的命令在你 **本地电脑终端** 跑，带 `#` 的在 **云主机** 跑。

---

## 0. 它是什么

pmxt 是「预测市场界的 ccxt」——把 Polymarket / Kalshi / Limitless / Opinion 等十几家平台的接口，统一成**一套行情 API**。它本身没有界面，所以本部署包在它外面加了两层：

- **网关 `gateway/`**：一个极薄的 Express 服务。把 pmxt 的统一 API 挂到 `/pmxt`，自己再加一层聚合（`/api/*`），同时托管前端。只对外开一个端口。
- **前端 `dashboard/`**：一张行情大表，参照同花顺的密集表格——一行一个预测标的，右边铺开各方向 × 各平台的价格。

```
浏览器  ──(SSH 隧道 3200)──►  网关:3200
                                 ├── /            行情台前端
                                 ├── /api/*       聚合层（大盘/盘口/K线/成交/SSE）
                                 └── /pmxt/api/*  pmxt 统一行情(挂载 pmxt-core)
```

纯看行情是**公开只读**，不需要任何平台的 API key。

### 这一栈最关键的一条取舍

**结构向托管接口买，价格从直连免费拿。**

`api.pmxt.dev`（托管服务，1 次调用 = 1 credit，免费档 25000/月）只用来回答一个问题：
**「这三家的哪几条，其实是同一个标的？」** —— 也就是只买那张身份对照表。

而**价格、24h 涨跌、成交额、流动性、盘口、K 线、成交明细，全部直连各平台免费接口**，
一个 credit 都不花。所以：

- 15 分钟同步一次目录，一个月大概用掉三四千 credit，免费档绰绰有余；
- 价格该多快就多快 —— Polymarket / Limitless 走公开 WebSocket 真推送，
  Kalshi 的盘口接口要鉴权、推不了，单独走 20 秒轮询；
- 前端鼠标划过价格就拉盘口、双击就看 K 线，**随便点，不心疼**。

改任何参数之前，先分清它动的是「目录」还是「价格」：动目录的才涉及额度。

### 页面长什么样

```
标的                          |    正向 YES     |    反向 NO      | 24h  成交额  ...
                              | POLY KLSH LMTL  | POLY KLSH LMTL  |
──────────────────────────────┼─────────────────┼─────────────────┼──────────────
▸ 2026 世界杯冠军  [体育]      | 22.5  --   23.0 | 77.5  --   77.0 | +1.5  $12.4M
    └ 西班牙                   | 22.5  --   23.0 | 77.5  --   77.0 |
    └ 阿根廷                   | 18.0 17.5  --   | 82.0 82.5  --   |
  川普赢得 2028 大选  [政治]    | 41.0 40.5  42.0 | 59.0 59.5  58.0 | -0.5  $3.1M
```

- **平台列是固定的**：某个平台没有这个标的就显示 `--`，眼睛不用每行重新找列；
- **多候选事件**（世界杯冠军这种）折叠成父行，父行价格位显示领先候选，点一下展开；
- **红涨绿跌**（同花顺口径，和欧美软件相反）；价格跳动会闪一下；
- 鼠标停在价格上 → 浮出盘口；点价格 → 直接跳到那个平台的原页面；双击整行 → 详情抽屉（K 线 / 盘口 / 成交 / F10）；
- 默认按热度排序（成交额 + 盘口厚度 + 波动 + 临近结算 + 平台覆盖的加权）；
- 以 **Polymarket 为锚**，其他平台来匹配它。锚上没有的标的进「次要分区」，页面顶部可切换。

---

## 1. 端口规划（与 homerun 不冲突）

| 项目 | 端口 | 绑定 | 说明 |
|---|---|---|---|
| homerun 前端 | 3000 | 127.0.0.1 | 已占用 |
| homerun 后端 | 8000 | 127.0.0.1 | 已占用 |
| homerun postgres / redis | 5432 / 6379 | 127.0.0.1 | 已占用 |
| **pmxt 行情台** | **3200** | **127.0.0.1** | 本项目，全新端口 |

两套栈的 compose 用了不同的项目名（homerun / pmxt），容器、网络、卷都各自独立，互不影响。pmxt 这套是纯行情代理，**不需要额外数据库**，容器很轻。

---

## 2. 把部署包放到服务器

你服务器上已经有完整的 pmxt 仓库。只需把本部署包（`deploy/` 目录 + 仓库根的 `.dockerignore`）放进那个仓库的**根目录**即可。

我打包了一个 `pmxt_deploy.tar.gz`。在本地把它传上去，然后在服务器仓库根解压：

```bash
# 本地：上传（假设 pmxt 仓库在服务器的 ~/pmxt-main）
$ scp -i ~/Downloads/key1.pem pmxt_deploy.tar.gz poly:~/pmxt-main/

# 服务器：进入仓库根并解压（会生成 deploy/ 和 .dockerignore）
# tar 会解到当前目录
$ ssh poly
# cd ~/pmxt-main && tar xzf pmxt_deploy.tar.gz && ls deploy
```

> 若你的 pmxt 仓库不在 `~/pmxt-main`，把上面路径换成实际路径即可，关键是 `deploy/` 要和 `core/` 同级（在仓库根）。

---

## 3. 配置并启动

```bash
# cd ~/pmxt-main/deploy
# cp .env.example .env          # 默认端口 3200、平台 polymarket,kalshi,limitless
# nano .env                     # 只有一处必填：PMXT_API_KEY
# bash bootstrap.sh             # 一键：build + up + 自测
```

`.env` 里**唯一必须填的是 `PMXT_API_KEY`**（pmxt.dev 免费档即可）。没有它，跨平台匹配失效，
大盘会退化成「只有 Polymarket 一家的价格」——还能看，但这栈的意义就没了。
其余几十个参数都有合理默认值，第一次部署可以一个都不动。

`bootstrap.sh` 会自动构建镜像（首次较久，要装依赖并编译 pmxt-core）、启动、并做本机自测。也可以手动：

```bash
# docker compose build
# docker compose up -d
# docker compose ps
# docker compose logs -f gateway     # 看日志，Ctrl+C 退出不影响运行
```

---

## 4. 服务器上先自测（很重要）

在开隧道前，先确认服务器本机通。**按顺序来，前一条不过不用看后一条**：

```bash
# 1) 网关活着
# curl -s http://127.0.0.1:3200/pmxt/health
#   期望： {"status":"ok","timestamp":...}

# 2) pmxt-core 挂载正常、能取到真实行情
# curl -s 'http://127.0.0.1:3200/pmxt/api/polymarket/fetchMarkets?query=bitcoin&limit=2' | head -c 200
#   期望： {"success":true,"data":[ ...市场... ]}

# 3) 大盘同步完成了没（首轮约 10–60 秒）
# curl -s http://127.0.0.1:3200/api/board/stats | python3 -m json.tool | head -30
#   要看三个数：
#     rowCount        > 0        主区行数，正常几百到一千多
#     matchedRowCount > 0        其中有跨平台匹配的行数；如果是 0，多半是 PMXT_API_KEY 没填对
#     lastError       null       非 null 就照着信息排查

# 4) 主表真能出数据
# curl -s 'http://127.0.0.1:3200/api/board?limit=3' | python3 -m json.tool | head -40

# 5) 实时推送通不通（会一直刷，看到 hello 和 ticks 就 Ctrl+C）
# curl -N -s http://127.0.0.1:3200/api/stream | head -5
#   期望：先一行 {"type":"hello",...}，随后陆续出现 {"type":"ticks",...}
#   只有 hello 没有 ticks，先别急 —— 冷门时段本来就可能几十秒才动一次
```

五条都通，说明「网关 + pmxt 挂载 + 托管匹配 + 直连行情 + 实时推送」全链路 OK。

---

## 5. 共享同一条 SSH 隧道（关键）

**不用另开隧道**——在你现有那条 homerun 隧道命令里，再加一行 `-L 3200:127.0.0.1:3200` 就行，一个窗口同时通两个项目：

```bash
$ ssh -i ~/Downloads/key1.pem -N \
    -L 3000:127.0.0.1:3000 \
    -L 8000:127.0.0.1:8000 \
    -L 3200:127.0.0.1:3200 \
    ubuntu@<你的IP>
```

如果你用了 `~/.ssh/config` 的 `poly` 别名，推荐把转发写进配置，以后一条 `ssh -N poly` 全带上：

```
Host poly
    HostName <你的IP>
    User ubuntu
    IdentityFile ~/Downloads/key1.pem
    LocalForward 3000 127.0.0.1:3000
    LocalForward 8000 127.0.0.1:8000
    LocalForward 3200 127.0.0.1:3200
```

之后：

```bash
$ ssh -N poly        # 隧道，挂着别关
```

浏览器打开：

- **http://localhost:3200** —— pmxt 行情台
- http://localhost:3000 —— homerun 面板（照旧）

> 安全组仍然**只放行 22**，3000/8000/3200 都不对公网开放。

---

## 6. 日常运维

代码走 **本地改 → git push → 服务器 pull** 这一条路，服务器是只读镜像，**不在服务器上直接改文件**。

| 操作 | 命令（在 `deploy/` 目录） |
|---|---|
| 看状态 | `docker compose ps` |
| 看日志 | `docker compose logs -f gateway` |
| 重启 | `docker compose restart` |
| 停止（保留镜像） | `docker compose stop` |
| 改了 `.env` 后生效 | `docker compose up -d`（会重建容器，约 10 秒） |
| **只改了前端** | `cd ~/pmxt-main && git fetch && git reset --hard origin/main` → **刷新浏览器即可**，不用重启 |
| **改了网关或 pmxt 源码** | `git fetch && git reset --hard origin/main && cd deploy && docker compose up -d --build` |

前端能免重启，是因为 compose 把 `./dashboard` 只读挂进了容器；网关不能，原因见下面 ⚠️。

> ⚠️ **不要用 `docker compose down -v`**，也不要 `docker system prune --volumes`。
> 这台机器上还跑着 homerun，它的 postgres 是 bind mount，`-v` 会连它一起端掉。
> pmxt 自己的 `pmxt-data` 卷丢了倒不要紧（只是目录快照缓存，冷启动慢十几秒而已）。

---

## 7. 二开指引

**改前端**（最常见）。前端在 `deploy/dashboard/`，原生 ES module + Preact，**没有构建步骤**：

```
index.html      外壳 + 全部样式（一行业务逻辑都没有）
js/preact.js    CDN 引入收口，换版本只改这一个文件
js/lib.js       纯函数：取价、格式化、URL 状态
js/board.js     行情主表（表头、价格格、悬停盘口、父子行）
js/detail.js    详情抽屉（K 线 / 盘口 / 成交 / F10）
js/app.js       根组件：筛选栏、分页、SSE 接入
```

改完 push、服务器 pull、刷新浏览器就生效。
**换涨跌配色**只需动 `index.html` 里的 `.up` / `.dn` 两条，别去 JS 里改。

**加接口 / 改聚合逻辑**：在 `deploy/gateway/lib/routes.mjs` 加路由，`board-store.mjs` 管目录同步和匹配，
`venues.mjs` 是直连各平台的唯一出口，`realtime.mjs` 管 WebSocket 订阅。
改完必须 `docker compose up -d --build`。

> ⚠️ 别想着给网关也加一条 `./gateway:/app/deploy/gateway:ro` 来热更新。
> 镜像里 `express` 和 `pmxt-core` 就装在 `/app/deploy/gateway/node_modules`，
> 整目录挂载会把它们盖没，容器起来第一行 `import express` 就 `ERR_MODULE_NOT_FOUND`。
> compose 文件里那一段注释写的就是这件事。

**二开 pmxt 本身**：改 `core/src/**` 后 `docker compose up -d --build`（Dockerfile 会从本地源码重新编译）。

### 托管接口的实测事实（别再靠猜）

官方 OpenAPI 里 `/v0/matched-market-clusters` **没有定义响应结构**，所以下面这些全是
`probe.mjs` 打真实接口测出来的。改 `hosted.mjs` 之前先看一眼，能省掉一整轮线上事故：

| 事实 | 影响 |
|---|---|
| 信封是 `{data:[...], pagination:{...}}` | `unwrap()` 认这个形状 |
| **`limit=500` 实际只回 250 条**（服务端页大小上限） | 按 500 请求再用「不满页=到底了」判断，会静默只同步前 250 个集群。`hosted.mjs` 现在按 250 请求，并且会自适应服务端给的真实页大小 |
| `offset` 分页有效 | offset 必须按**已取回条数**递增，不能用 `page × limit` |
| 连打两三次就可能 429 `Rate exceeded`，且先卡十秒再拒 | 已加退避重试（最多 3 次）+ 翻页间隔 350ms。不重试的话第一页一挂，整整 15 分钟都只剩 poly 一列 |
| `venues=` 是「仅限于」不是「至少包含」 | 不传会混进 probable 等没接的平台 |
| 集群级 `volume24h` 是各平台之和，**他站的值可能离谱**（实测某条 probable 报 5314 万，而同一条 `volume=0`、报价全 null） | 热度绝不能用集群里的量，只用直连拿到的 |
| 价格在 `markets[].outcomes[].price`，成员对象上**没有顶层 `price`** | 直连挂掉时的兜底格拿不到价，于是不生成 —— 这是故意的，显示 `--` 好过挂个假价 |
| `outcomes[].metadata.clobTokenId` = Polymarket 直连 WS 要的 token id | 实时推送靠它订阅 |

再跑一次探针：

```
docker compose -f deploy/docker-compose.yml exec gateway node /app/deploy/gateway/probe.mjs
```

约 7 个 credit。日常不用跑，只在怀疑对方改了接口时验证。
另外 `/gw/diag` 会把每轮同步实际观察到的信封形状、页大小、重试次数吐出来，那个是免费的。

**接私有数据**（余额/持仓/我的成交）：在 `.env` 里填对应平台凭据（`.env.example` 底部有示例），
pmxt-core 会自动读取。注意 `PMXT_API_KEY` 只在服务端用，网关注入 Bearer 后转发，**不会到浏览器**。

---

## 8. 排错

**页面打不开**
先在服务器 `curl -I http://127.0.0.1:3200`。服务器通、本地不通 → 隧道断了，检查 `-L 3200` 那条还挂着没。

**页面能开，但表是空的**
看 `/api/board/stats` 的 `rowCount`。刚启动是正常的（首轮同步 10–60 秒）；
一直是 0 就看 `lastError` 和 `docker compose logs gateway`。

**每一行都只有 Polymarket 一列有价**
`PMXT_API_KEY` 没配对或额度用完了。`/api/board/stats` 里 `hosted.enabled` 和 `matchedRowCount` 能确认。
这种情况下大盘照常能用，只是没有跨平台对比。

**某个平台整列都是 `--`**
`/api/board/stats` 的 `venueHealth.<平台>.ok` 会告诉你是那家挂了还是没配。
opinion 直连要它自己的 key，默认就没启用。

**价格不跳**
状态条左上角的「实时」灯：绿=已连接，红=断开（EventSource 会自己重连）。
灯是绿的但不跳，多半是冷门时段真没成交 —— 找个世界杯或大选的行看看。

**价格格右上角有个小蓝点 / 数字旁有 `≈ ? ⇄ *` 符号**
不是 bug，是数据来源标记：小蓝点=这格正在被实时推送盯着；
`≈`=价格来自匹配接口而非直连（可能滞后）；`?`=方向是猜的，跨平台比价要谨慎；
`⇄`=该平台 YES/NO 与锚定平台相反、已自动对齐；`*`=反向价由 `1 − 正向价`推算，不是平台报价。
鼠标停上去有说明。

**首次构建失败**
多为网络拉包超时，重跑 `docker compose up -d --build`。

**前端从 `esm.sh` 加载 Preact（约 20KB）**
浏览器在你本地、有公网，通过隧道访问不受影响。要完全离线可把库下到 `dashboard/js/` 本地引用，
只需改 `js/preact.js` 一个文件。

---

## 9. 验收清单

部署完照着点一遍，全部符合才算这次改造落地了：

- [ ] 打开 http://localhost:3200 ，**一屏就是一张密集行情表**，不是卡片
- [ ] 表头两层：上层「正向 YES / 反向 NO」分组，下层是各平台简称，**滚动时表头钉住不动**
- [ ] 左边「标的」列**横向滚动时钉在左边**，不会丢上下文
- [ ] 第一行是当下最热的标的（世界杯期间应该是比赛场次那类，不是冷门盘）
- [ ] 某平台没有的标的显示 `--`，**不是 0.0 也不是空白**
- [ ] 盯着看十几秒，**有价格在闪**（红涨绿跌）
- [ ] 鼠标停在任意价格上约 0.2 秒 → **浮出盘口**，买盘红、卖盘绿
- [ ] 点某个平台的价格 → **新标签打开那个平台的原页面**，且确实是同一个标的
- [ ] 双击一行 → 抽屉滑出，**K 线画得出来**（不是「暂无历史价格」），盘口、成交、F10 四个页签都有内容
- [ ] F10 里能看到「它凭什么排这么前」的热度拆解
- [ ] 世界杯冠军这类多候选事件，**父行左边有 ▸，点一下展开子行**，每个候选一行
- [ ] 顶部筛选：选「体育」→ 只剩体育；选「3 天内结算」→ 只剩快结算的
- [ ] 筛完之后**地址栏 hash 变了**，复制这个链接重新打开，筛选条件还在（可以收藏）
- [ ] 「已结束」的标的默认不出现在列表里
- [ ] 状态条：「实时」灯是绿的，「目录 N 分钟前」在走，点「立即同步」有反应
- [ ] 切到「次要分区」，能看到只有非 Polymarket 平台才有的标的
- [ ] `docker compose restart` 之后**立刻刷新页面，表里就有数据**（走的是快照），
      状态条先显示「（快照）」，一轮同步后这三个字消失

---

### 附：核心接口速查（`/pmxt/api/{平台}/{方法}`）

| 方法 | 用途 | 示例 |
|---|---|---|
| `fetchMarkets` | 市场列表/搜索 | `?query=fed&limit=20&active=true` |
| `fetchEvents` | 事件列表 | `?query=election` |
| `fetchOrderBook` | 盘口 | `?outcomeId=<id>&limit=6` |
| `fetchOHLCV` | K线 | `?outcomeId=<id>&resolution=1h&limit=48` |
| `fetchArbitrage` | 平台内套利扫描 | `?limit=20` |

平台名可选：`polymarket, kalshi, limitless, opinion, probable, myriad, metaculus, smarkets, baozi, hyperliquid, gemini-titan, suibets, rain, hunch`。
