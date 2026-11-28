# 在留导航：单个容器跑 npm start 的服务器。零运行时依赖（只用 Node 自带的模块），所以不跑 npm install。
# 版本固定到具体的 tag（升级 Node 时改这一行，并跑一遍 npm test、npm run e2e）。node:sqlite 要 22.13 以上才不用开实验开关。
FROM node:22.23.5-bookworm-slim

ENV NODE_ENV=production \
    PORT=8787 \
    DB_FILE=/data/zairyu.db \
    BACKUP_DIR=/backups \
    NODE_OPTIONS=--no-warnings

WORKDIR /app
# 只放运行要用的文件（.dockerignore 另外挡住库文件、.env、测试结果等）
COPY package.json ./
COPY src ./src
COPY web ./web
COPY data ./data
COPY tools/backup.js ./tools/backup.js

# 库和备份放在卷上；根目录可以只读（compose.yaml 里 read_only: true，/tmp 另挂 tmpfs）
RUN mkdir -p /data /backups && chown node:node /data /backups && chmod 700 /data /backups
VOLUME ["/data", "/backups"]

# 镜像自带的非 root 用户（uid 1000）
USER node
EXPOSE 8787

# 存活检查：进程还能回答就算健康（不碰数据库）；就绪检查 /api/ready 给反向代理或部署脚本用
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

# 直接跑 node（不经过 npm），docker stop 的 SIGTERM 直接到服务器，服务器做完手上的请求再退出
CMD ["node", "src/server.js"]
