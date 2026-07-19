# pmxt 行情栈镜像
# 从「你下载的这份 pmxt 仓库」构建 pmxt-core（这样你二开 pmxt 源码后重建即生效），
# 再装上极薄网关（挂载 pmxt-core + 托管行情前端）。
#
# 构建上下文 = 仓库根目录（见 docker-compose.yml 的 context: ..）
FROM node:22

WORKDIR /app

# 拷贝整个仓库（.dockerignore 已排除 node_modules/.git 等）
COPY . .

# 1) 安装并构建 pmxt-core（含 tsc 等构建依赖）
RUN npm install --workspace=pmxt-core \
 && npm --workspace=pmxt-core run build

# 2) 安装网关依赖：express + 以 file: 方式链接刚构建好的本地 pmxt-core
RUN npm install --prefix deploy/gateway --omit=dev

WORKDIR /app/deploy/gateway

ENV PMXT_GATEWAY_PORT=3200 \
    PMXT_GATEWAY_HOST=0.0.0.0

EXPOSE 3200

CMD ["node", "server.mjs"]
