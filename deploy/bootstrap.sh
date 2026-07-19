#!/usr/bin/env bash
# pmxt 行情栈一键启动（在云主机上、deploy/ 目录内运行）
# 前提：homerun 部署时已装好 Docker（若没有，请先按 homerun 手册装 Docker）
set -euo pipefail
cd "$(dirname "$0")"

echo "==> 检查 Docker"
if ! command -v docker >/dev/null 2>&1; then
  echo "!! 未检测到 docker。pmxt 与 homerun 同机运行，请先用 homerun 的 bootstrap 装好 Docker。"; exit 1
fi
DC="docker compose"; docker compose version >/dev/null 2>&1 || DC="docker-compose"

echo "==> 准备 .env"
[ -f .env ] || { cp .env.example .env; echo "   已从 .env.example 生成 .env（可按需修改端口/平台）"; }

echo "==> 构建镜像（首次较久：要装依赖并编译 pmxt-core）"
$DC build

echo "==> 启动"
$DC up -d

echo "==> 等待健康检查"
sleep 8
$DC ps

echo
echo "==> 本机自测（服务器上）："
if curl -fsS http://127.0.0.1:"${PMXT_PORT:-3200}"/pmxt/health >/dev/null 2>&1; then
  echo "   ✅ /pmxt/health 通"
else
  echo "   ⏳ 还没就绪，稍等几秒后重试： curl http://127.0.0.1:${PMXT_PORT:-3200}/pmxt/health"
fi
echo "   行情自测： curl 'http://127.0.0.1:${PMXT_PORT:-3200}/pmxt/api/polymarket/fetchMarkets?query=bitcoin&limit=2'"
echo
echo "完成。回本地电脑，在你的 SSH 隧道里加一行  -L 3200:127.0.0.1:3200  即可打开 http://localhost:3200"
