# ---- 第 1 阶段：安装依赖 ----
FROM node:22-alpine AS deps
# 加装原生编译工具链：better-sqlite3 在国内下载不到预编译包时需本地编译
RUN apk add --no-cache git python3 make g++
RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY .git ./.git
RUN pnpm install --frozen-lockfile

# ---- 第 2 阶段：构建项目 ----
FROM node:22-alpine AS builder
RUN apk add --no-cache git python3 make g++
RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .
COPY --from=deps /app/.git ./.git

ENV DOCKER_ENV=true
RUN pnpm run build

# ---- 第 3 阶段：生成运行时镜像 ----
FROM node:22-alpine AS runner
RUN apk add --no-cache git libc6-compat sqlite
RUN addgroup -g 1001 -S nodejs && adduser -u 1001 -S nextjs -G nodejs

WORKDIR /app
ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
ENV DOCKER_ENV=true
ENV SQLITE_PATH=/app/data/tv.db

RUN mkdir -p /app/data && chown -R nextjs:nodejs /app/data

COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/scripts ./scripts
COPY --from=builder --chown=nextjs:nodejs /app/start.js ./start.js
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs
EXPOSE 3000
CMD ["node", "start.js"]
