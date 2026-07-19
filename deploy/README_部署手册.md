# pmxt 行情台 · 云主机部署手册

和 homerun 同机运行，端口/容器完全隔离，复用同一条 SSH 隧道。带 `$` 的命令在你 **本地电脑终端** 跑，带 `#` 的在 **云主机** 跑。

---

## 0. 它是什么

pmxt 是「预测市场界的 ccxt」——把 Polymarket / Kalshi / Limitless / Opinion 等十几家平台的接口，统一成**一套行情 API**。它本身没有界面，所以本部署包在它外面加了两层：

- **网关 `gateway/`**：一个极薄的 Express 服务。把 pmxt 的统一 API 挂到 `/pmxt`，同时托管前端。只对外开一个端口。
- **前端 `dashboard/`**：单文件行情台，三个视图——**比价·套利 / 市场浏览 / 实时盯盘**。

```
浏览器  ──(SSH 隧道 3200)──►  网关:3200
                                 ├── /            前端行情台
                                 └── /pmxt/api/*  pmxt 统一行情(挂载 pmxt-core)
```

纯看行情是**公开只读**，不需要任何平台的 API key。

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
$ scp -i ~/Downloads/polystrategy.pem pmxt_deploy.tar.gz poly:~/pmxt-main/

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
# cp .env.example .env          # 默认端口 3200、平台 polymarket,kalshi,limitless,opinion
# bash bootstrap.sh             # 一键：build + up + 自测
```

`bootstrap.sh` 会自动构建镜像（首次较久，要装依赖并编译 pmxt-core）、启动、并做本机自测。也可以手动：

```bash
# docker compose build
# docker compose up -d
# docker compose ps
# docker compose logs -f gateway     # 看日志，Ctrl+C 退出不影响运行
```

---

## 4. 服务器上先自测（很重要）

在开隧道前，先确认服务器本机通：

```bash
# curl http://127.0.0.1:3200/pmxt/health
#   期望： {"status":"ok","timestamp":...}

# curl 'http://127.0.0.1:3200/pmxt/api/polymarket/fetchMarkets?query=bitcoin&limit=2'
#   期望： {"success":true,"data":[ ...市场... ]}
```

两条都通，说明网关 + pmxt 挂载 + 取真实行情全链路 OK。

---

## 5. 共享同一条 SSH 隧道（关键）

**不用另开隧道**——在你现有那条 homerun 隧道命令里，再加一行 `-L 3200:127.0.0.1:3200` 就行，一个窗口同时通两个项目：

```bash
$ ssh -i ~/Downloads/polystrategy.pem -N \
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
    IdentityFile ~/Downloads/polystrategy.pem
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

| 操作 | 命令（在 `deploy/` 目录） |
|---|---|
| 看状态 | `docker compose ps` |
| 看日志 | `docker compose logs -f gateway` |
| 重启 | `docker compose restart` |
| 停止（保留镜像） | `docker compose stop` |
| 改了配置后重启 | 编辑 `.env` → `docker compose up -d` |
| 更新 pmxt 源码后重建 | `docker compose build && docker compose up -d` |

---

## 7. 二开指引

- **改前端**（最常见）：编辑 `deploy/dashboard/index.html`（单文件，Preact + htm，免构建）。因为镜像里是打包进去的，改完 `docker compose build && up -d` 生效。若想改前端时**热更新**、免重建，可在 compose 里给 gateway 加一行挂载：
  ```yaml
      volumes:
        - ./dashboard:/app/deploy/dashboard:ro
  ```
  之后改 HTML 刷新浏览器即可（网关直接读挂载目录）。
- **加自定义接口 / 聚合缓存**：在 `deploy/gateway/server.mjs` 里注册新路由（那里已经拿到了 pmxt-core，可直接 `new pmxtCore.Polymarket()` 等）。
- **二开 pmxt 本身**：改 `core/src/**` 后 `docker compose build`（Dockerfile 会从本地源码重新编译 pmxt-core），改动即生效。
- **接私有数据**（余额/持仓/我的成交）：在 `.env` 里填对应平台凭据（`.env.example` 底部有示例），pmxt-core 会自动读取；前端可再扩展账户视图。

## 8. 前端说明 & 排错

- 前端从 `esm.sh` CDN 加载 Preact（约 20KB）。你的浏览器在本地、有公网，通过隧道访问不受影响；若要**完全离线**，可把这几个库下载到 `dashboard/` 本地引用。
- **打不开**：先在服务器 `curl -I http://127.0.0.1:3200`；本地通说明是隧道问题，检查 `-L 3200` 那条是否还挂着。
- **某平台报错/501**：个别平台的盘口或K线未必支持，前端会就地显示错误，不影响其他平台。
- **某平台超时**：venue 官方 API 偶发慢；换个平台或稍后重试。
- **首次构建失败**：多为网络拉包超时，重跑 `docker compose build` 即可。

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
