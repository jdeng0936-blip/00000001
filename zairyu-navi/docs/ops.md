# 运维手册（部署、备份、压力测试、应急）

适用于第一期：一台虚拟机，`compose.yaml` 起两个容器（应用 `app` + 反向代理 `caddy`），数据库是应用容器里卷上的一个 SQLite 文件。这份手册写于 2026-11-28；这一会话没有真实的云账号，下面的内容在本机的 Docker 上跑过（见各节的“验证过的”），真实上线时按“部署”一节从头走一遍。

## 1. 组成

| 部分 | 说明 |
|---|---|
| `Dockerfile` | `node:22.23.5-bookworm-slim`（固定到具体版本的 tag，升级时改这一行并跑 `npm test`、`npm run e2e`）。只复制 `package.json`、`src/`、`web/`、`data/`、`tools/backup.js`，不跑 `npm install`（没有运行时依赖）。用镜像自带的非 root 用户 `node`（uid 1000）运行；库在 `/data`、备份在 `/backups`（两个卷，目录权限 700）；`HEALTHCHECK` 每 30 秒请求一次 `/api/health`；`CMD ["node", "src/server.js"]`（不经过 npm，SIGTERM 直接到服务器） |
| `compose.yaml` | `app`：根目录只读（`read_only: true`），`/tmp` 挂 64MB 的 tmpfs（SQLite 的临时文件），`cap_drop: ALL`、`no-new-privileges`、`init: true`，不对外开端口，只给 Caddy 连；`TRUST_PROXY=1`、`SHUTDOWN_TIMEOUT_MS=25000`、`stop_grace_period: 35s`（要比前者长）；日志 `json-file` 每份 20MB、留 5 份。`caddy`：`caddy:2.11.9-alpine`，开 80、443（含 HTTP/3 的 443/udp） |
| `deploy/Caddyfile` | 自动申请和续期证书（Let's Encrypt）、80 跳到 443、gzip/zstd、给每个请求加 `X-Request-Id`（应用在 `TRUST_PROXY=1` 时沿用它）、主动健康检查 `/api/ready`（10 秒一次，应用没就绪或在停机收尾时不往那边转）。Caddy 不写访问日志（完整地址里可能有退订令牌），访问日志由应用写 |
| `deploy/env.example` | 环境变量的样板，复制成 `deploy/.env`（`chmod 600`，不要提交；`.gitignore` 已挡 `.env`，`.dockerignore` 挡住 `deploy/.env`） |

### 环境变量

应用的全部变量见 README“运行”。部署相关的几项：

| 名称 | 在哪里设 | 说明 |
|---|---|---|
| `SITE_DOMAIN` | `deploy/.env` | 对外的域名，Caddy 用它申请证书。compose 的变量替换要读它，所以命令一律带 `--env-file deploy/.env`（没带的话 compose 直接报错说明） |
| `APP_URL` | `deploy/.env` | `https://` 加域名，邮件里的链接用。`MAIL_SENDER` 是 `http`、`smtp` 时必填 |
| `ADMIN_TOKENS` | `deploy/.env` | `名字:令牌`，令牌用 `openssl rand -base64 33` 生成；见“轮换管理员令牌” |
| `ANTHROPIC_API_KEY` | `deploy/.env` | 助手用；见“轮换 API key” |
| `MAIL_*`、`SMTP_*`、`BILLING_*`、`REMINDERS_ENABLED` 等 | `deploy/.env` | 见 README。`MAIL_SENDER=http` 时 `APP_URL`、`BILLING_PLANS`、`BILLING_BANK_TEXT` 不填不启动（有意的） |
| `PORT`、`DB_FILE`、`BACKUP_DIR`、`TRUST_PROXY`、`SHUTDOWN_TIMEOUT_MS` | `compose.yaml` | 由部署方式决定，不放进 `.env` |
| `LOG_REQUESTS` | `deploy/.env`（可选） | 请求日志，默认 `1`，`0` 关 |
| `CHAT_DAILY_MAX` | `deploy/.env`（可选） | 助手全站每 24 小时最多回答几句，默认 5000（每句最多调 6 次模型，按模型的价格算出每天的费用上限再定）。用完时标准错误里有一行“助手全站限额已用完”，监控看到就告警 |
| `BACKUP_KEEP` | `deploy/.env`（可选） | 备份留几份，默认 7 |
| `APP_VERSION` | 命令行 | 镜像的 tag（`zairyu-navi:${APP_VERSION}`），回滚用；不设是 `latest` |

## 2. 应用自己做的事

- **安全相关的响应头**（每个响应都带，`test/ops.test.js`）：`Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; manifest-src 'self'; form-action 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'`（没有 `unsafe-inline`：网页的脚本和样式都在 `web/*.js`、`web/*.css` 里，HTML 里没有内联脚本、`<style>`、`style=""` 和 `on…=` 属性；首页原来从 Google Fonts 加载字体，已去掉，改用系统字体，所以页面不再连外站）、`X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`、`X-Frame-Options: DENY`、`Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()`、`Cross-Origin-Opener-Policy` 和 `Cross-Origin-Resource-Policy: same-origin`。`Strict-Transport-Security: max-age=31536000` 只在 `TRUST_PROXY=1` 且 `X-Forwarded-Proto` 的最后一段是 `https` 时带（没加 `includeSubDomains`、`preload`：同一域名下别的子域名的情况不知道，要加时负责人定）。退订页（不带脚本的小页面）用自己的一条 CSP，按样式的哈希放行。`npm run e2e` 的倒数第二步打开每个页面，确认样式和脚本都加载了、控制台没有 CSP 的报错（并先往页面里塞一段内联脚本，确认这项检查真的能发现违规）。
- **静态文件的缓存**：`Cache-Control: no-cache` 加 `ETag`、`Last-Modified`；浏览器带 `If-None-Match` 来问、文件没变时 304。文件名没有带内容的哈希，所以不用长缓存，发布后马上生效。接口一律 `no-store`。
- **存活和就绪**：`GET /api/health`（存活）只要进程还能回答就是 200，不碰数据库，容器的 `HEALTHCHECK` 用它（返回 `{ ok, nodes }`）。`GET /api/ready`（就绪）：读得了表结构（`readable`）、建表和补列都做过（`migrations`：建表语句里的每张表、每个索引都在，`users` 有 `version` 列）、库能写（`writable`：开一个写事务写一行再回滚，什么都不留下），并且没在停机收尾，才是 200 `{ ok: true, failed: [] }`；否则 503 和没过的几项（`readable`、`migrations`、`writable`、`shutting-down`）。Caddy 用它决定往不往应用转。
- **停机收尾**（SIGTERM、SIGINT）：先停定时器（提醒、展示费、发件箱重试），不再接新连接，`/api/ready` 变 503；手上的请求在 `SHUTDOWN_TIMEOUT_MS`（默认 25 秒）之内照常回答（回答后关掉连接），超时的强制断开；等正在发的那一轮邮件发完（同样有时限）；关数据库，以 0 退出。日志里有 `{"msg":"shutdown"}` 和 `{"msg":"stopped","forced":N}`（`forced` 是被强制断开的请求数）。再收到一次信号就不等了（退出码 1）。助手的一轮最长 120 秒，停机时正在回答的会被断开，用户重发即可。
- **请求日志**：标准输出一行一个 JSON：`{"t","msg":"request","rid","method","route","status","ms"}`，`TRUST_PROXY=1` 时另有截短的 `ip`（IPv4 去掉最后一段，IPv6 只留前 3 段）；响应没发完连接就断了的带 `"aborted": true`。`route` 是模板（`/api/users/:id/plan`），不是真实地址：不写查询参数（退订令牌在那里）、账号编号、请求体、令牌、邮箱。成功的 `/api/health`、`/api/ready` 不记（每 10 至 30 秒一次，会淹没别的）。每个响应带 `X-Request-Id`：`TRUST_PROXY=1` 时沿用 Caddy 给的（只收 8 至 128 个字母、数字和 `. _ : -`），否则自己生成。出错时（500）的错误说明照旧写到标准错误。
- 库文件以 600 权限建（服务器启动时 `umask 077`）。
- **限流**（README“写进代码的合规规则”里的“限流”）：次数存在库里的 `rate_events`，重启、发布新版本都不清零，每分钟清掉 24 小时以前的。放在 Caddy 后面要开 `TRUST_PROXY=1`（`compose.yaml` 已开），否则所有人的来源地址都是 Caddy、一起被限。

## 3. 部署

第一次：

1. 准备一台虚拟机（2 vCPU、2GB 内存、20GB 磁盘足够；见“压力测试”），装 Docker Engine 和 compose 插件；防火墙只开 22、80、443。
2. 域名的 A（和 AAAA）记录指向这台机器。
3. 取代码：`git clone … && cd zairyu-navi`（只需要仓库里的这个目录）。
4. `cp deploy/env.example deploy/.env && chmod 600 deploy/.env`，填好（管理员令牌、`APP_URL`、发信、`BILLING_*`、`ANTHROPIC_API_KEY`）。
5. `docker compose --env-file deploy/.env up -d --build`
6. 检查：`docker compose --env-file deploy/.env ps`（`app` 是 healthy）；`curl -sI https://域名/api/ready`（200，带 `strict-transport-security`、`x-request-id`）；浏览器打开首页，开发者工具的控制台没有报错。
7. 设好备份的 cron（见“备份”），并当天跑一次 `npm run backup:verify` 的等价命令。

发布新版本：

1. 在开发机上 `npm test`（`TZ=UTC` 和 `TZ=Asia/Tokyo` 各一次）、`npm run e2e` 都通过。
2. 服务器上先备份：`docker compose --env-file deploy/.env exec -T app node tools/backup.js`
3. `git pull`，然后给这一版起 tag 构建并启动：`APP_VERSION=$(git rev-parse --short HEAD) docker compose --env-file deploy/.env up -d --build app`。旧容器收到 SIGTERM，做完手上的请求再退出；单台机器上新旧容器之间有几秒不可用（Caddy 返回 502/503），选人少的时间。
4. 看 `docker compose --env-file deploy/.env logs --tail=50 app`，有没有“没有启动”的报错；`curl -s https://域名/api/ready`。
5. 记下这一版的 `APP_VERSION`（回滚用）。

回滚：

1. `APP_VERSION=<上一版的 tag> docker compose --env-file deploy/.env up -d --no-build app`（镜像还在本机：`docker images zairyu-navi`）。
2. 库的结构只会加表、加列（`createStore` 打开时补），旧代码能用新库，回滚一般不用动库。新版本改了数据的写法、旧代码读不了时，按“恢复”用发布前的那份备份，并说明这期间的写入会丢。

## 4. 备份

- `npm run backup`（容器里：`docker compose --env-file deploy/.env exec -T app node tools/backup.js`）：SQLite 的 `VACUUM INTO` 在线备份（服务器不用停，备份的是某一刻完整一致的库）到 `BACKUP_DIR`（容器里是 `/backups` 卷）下的 `zairyu-YYYYMMDD-HHMMSSZ.db`（UTC，权限 600），先写临时名、`integrity_check` 通过并落盘后才改名；然后只留最新的 `BACKUP_KEEP` 份（默认 7）。输出一行 JSON（文件名、删掉了哪几份、各表行数，没有内容）。
- `npm run backup:verify [文件]`（容器里：`… exec -T app node tools/backup.js --verify`）：核对最新的一份（或指定的）：只读打开做 `integrity_check`、表和索引一个不少；再复制到临时目录，用现在的代码打开并做就绪检查（恢复演练），副本随后删掉。不过就以退出码 1 结束。
- 主机的 crontab（每天日本时间 4:17 备份并核对；把备份拷到机器外面，例如对象存储，用主机上的工具，不在应用容器里放云凭证）：

  ```
  17 19 * * * cd /srv/zairyu-navi && docker compose --env-file deploy/.env exec -T app node tools/backup.js && docker compose --env-file deploy/.env exec -T app node tools/backup.js --verify || echo "备份失败" | mail -s zairyu-backup ops@…
  ```

  卷在主机上的位置：`docker volume inspect zairyu-navi_backups`。拷到机器外面的副本要用同样的保存期限（见下）。
- 验证过的（2026-11-28，本机 Docker，只读根目录的容器里）：备份、核对、轮换都正常，文件属主 `node`、权限 600。`test/ops.test.js` 覆盖：服务器开着时备份、同一秒两次不覆盖、只留 N 份、不留临时文件、删掉的账号和备注不在备份里、坏掉的备份核对不过、恢复出来的库能被现在的代码打开。

### secure_delete 和备份的保存期限

- 库打开时开着 `secure_delete`：删掉的行在库文件里用零盖掉，不留在空闲页。`VACUUM INTO` 写出的备份是压实的新文件，没有空闲页，所以备份里也没有“已经删掉但还留在空闲页里”的残留。
- 但备份是做备份那一刻的样子：用户删除账号（或解除邮箱）之后，他的数据仍然在之前的每一份备份里，直到那几份被轮换删掉。默认每天一份、留 7 份，所以**删除后最长约 8 天**才从应用机器上的备份里消失；拷到机器外面的副本要按同样的期限删除（对象存储设生命周期规则）。在 SSD 和云盘上删除文件不能保证物理上覆盖，靠的是磁盘加密（云盘默认加密）和期限。
- 隐私政策第 8 条里“【备份的保存期限和清除方法】”还空着，**负责人要定**期限并补上，建议写法：“备份每天一份，最多保存 N 天，到期删除；你删除账号后，你的数据最迟在 N 天后从备份中消失。”`BACKUP_KEEP` 和机器外副本的生命周期要和写上的 N 一致。改了隐私政策的文字要按 README“条款版本”的规则处理版本号。
- 恢复的副作用：用一份旧备份恢复，备份之后删除的账号会“回来”。因为删除时留痕里不留账号编号，恢复后没有办法自动找出这些账号重新删掉。所以只在库坏了、没有更新的备份时才恢复；恢复后在事故记录里写明恢复到哪个时刻，**要不要另外保留一份“已删除账号编号的哈希”（存在库外、不随备份恢复）以便恢复后重新删除，负责人要定**。

## 5. 恢复

1. 停应用：`docker compose --env-file deploy/.env stop app`
2. 选备份并先核对：`docker compose --env-file deploy/.env run --rm --no-deps app node tools/backup.js --verify /backups/zairyu-….db`
3. 换库（在一次性的容器里，用卷）：

   ```
   docker compose --env-file deploy/.env run --rm --no-deps app sh -c 'cp /data/zairyu.db /data/zairyu.db.broken-$(date -u +%Y%m%dT%H%M%SZ) 2>/dev/null; rm -f /data/zairyu.db-journal; cp /backups/zairyu-….db /data/zairyu.db && chmod 600 /data/zairyu.db'
   ```

4. `docker compose --env-file deploy/.env start app`，`curl -s https://域名/api/ready` 是 200。
5. 记下恢复到的时刻；坏掉的库（`zairyu.db.broken-…`）里有个人信息，查完原因后删掉。看上一节“恢复的副作用”。

## 6. 轮换管理员令牌（ADMIN_TOKENS）

令牌有名字，名字记在留痕和审核记录里（谁批准、谁核对、谁确认入账），所以轮换时保留名字、换令牌。

1. 生成新令牌：`openssl rand -base64 33`（至少 24 个字符，不能有空白和逗号）。
2. 改 `deploy/.env` 的 `ADMIN_TOKENS`。要不断地换（两个人交接）时，先加一个新名字（`ops-a:旧,ops-b:新`），确认新的能用后再删掉旧的。
3. `docker compose --env-file deploy/.env up -d app`（读新的环境变量要重建容器；有几秒不可用）。
4. 确认旧令牌是 401：`curl -s -o /dev/null -w '%{http_code}' -H 'Authorization: Bearer 旧令牌' https://域名/api/admin/applications`。
5. 怀疑泄露时立即做，并按“应急”查留痕里那段时间管理员做过什么（`audit` 表，`store.auditRows()`）。旧的单个令牌 `ADMIN_TOKEN` 不要再用（名字只能记成 `admin`）。

## 7. 轮换 API key（ANTHROPIC_API_KEY）

1. 在 Claude Console 新建一个 key（先不删旧的）。
2. 改 `deploy/.env` 的 `ANTHROPIC_API_KEY`，`docker compose --env-file deploy/.env up -d app`。
3. 在页面上问助手一句，确认能回答（日志里 `POST /api/users/:id/chat` 是 200）。
4. 在 Console 里删掉旧的 key。怀疑泄露时先删旧的（这期间助手接口返回错误，其余功能不受影响），再看 Console 的用量有没有异常。
5. 发信的 `MAIL_HTTP_KEY`、`SMTP_PASS` 同样做法（先在服务商那边建新的，换上，确认能发信，再删旧的）。

## 8. 应急（个人信息泄露或可能泄露）

时限（**要律师确认后写进隐私政策**）：隐私政策草案现在**没有写**泄露时通知本人和报告的时限（第 8 条只写了安全措施；服务商条款第 6 条要服务商发生泄露时在【 】小时内报告运营者，也还空着）。按个人信息保护法第 26 条和施行规则第 7、8 条，属于要报告的情形（含要配慮个人信息的、可能造成财产损失的、出于不正当目的的、超过 1000 人的）时：**知道后“速やかに”向个人情报保护委员会作速报（指南的说法是大约 3 至 5 天以内）**，**30 天以内作确报（出于不正当目的的，例如被入侵，60 天以内）**，并通知本人。本站存的在留资格、日期、咨询内容、邮箱，泄露时多数会落在要报告的情形里。下面的清单按这个时限排。

清单：

1. **发现**（记下时刻，这是时限的起点）：谁、从哪里知道的；先不要删日志和库。
2. **止血**（当天）：
   - 入侵或令牌泄露：轮换 `ADMIN_TOKENS`、`ANTHROPIC_API_KEY`、`MAIL_HTTP_KEY`/`SMTP_PASS`（第 6、7 节）；必要时 `docker compose … stop app` 停服（Caddy 返回 502）。
   - 某个服务商的令牌泄露：管理后台把它下架（令牌立即作废），之后让它重新领取。
   - 用户令牌：库里只有哈希；需要时让受影响的账号的全部设备退出（库里删掉 `sessions` 的行、换 `users.token_hash`），用户用邮箱找回。
3. **保全**（当天）：做一份备份（`tools/backup.js`）并拷出；`docker compose … logs app > incident-日期.log`（请求日志里有请求编号、路由、状态、截短的地址，没有内容）；主机的登录记录。
4. **判断范围**（1 至 2 天）：哪些表、多少账号、什么时间段；用请求编号对照日志和留痕（`audit` 表只记动作）。
5. **速报**（知道后 3 至 5 天以内）：个人情报保护委员会的报告表单；同时通知本人（绑定了邮箱的发邮件；没有邮箱的账号是匿名的，在首页公告）。
6. **确报**（30 天以内，入侵等出于不正当目的的 60 天以内）：原因、范围、对策。
7. **复盘**：写进 `docs/`，补测试，必要时改隐私政策（版本号按 README“条款版本”）。

## 9. 压力测试

`npm run loadtest`（`tools/loadtest.js`，零依赖）：不给 `BASE` 时自己起一个和 `npm start` 一样的服务器（子进程，`/tmp` 下的新库，空闲端口，不写请求日志），建 20 个账号（新建账号每个来源地址每小时最多 30 个；记事件每个账号每小时最多 30 条，跑久了撞上的 429 是限流，不算非 2xx，单独记在表里的“限流 429”一列（`JSON=1` 时是每行的 `limited`），耗时的 p50 等不算被限流的请求。下面的数是加限流之前量的，那时记事件一直是 201，表里也还没有“限流 429”这一列），填好概况，然后 `CONCURRENCY` 个并发（默认 20）在 `DURATION` 秒（默认 20）里按权重不停地发：读（首页、`/index.js`、`/api/nodes?full=1`、`/plan`、`/reminders`、`/advice`、`/pr-check`、`/options/phone`）和写（`PUT /state`、`PATCH /profile`、`PUT /tasks/:id/done`、记录事件再删掉）。不调助手（不调用真实的模型）、不发邮件。有非 2xx 时退出码 1。`JSON=1` 输出 JSON；`BASE=…` 打已经起好的服务器（只用自己建的测试账号）。

2026-11-28 在开发用的容器里跑的（4 核 Intel Xeon 2.30GHz，Node v22.23.5，客户端和服务器在同一台机器上，不经过 Caddy；单个 Node 进程、SQLite 同步写）：

并发 20、20 秒：

| 请求 | 次数 | 非 2xx | 每秒 | p50 ms | p95 ms | p99 ms | 最大 ms |
|---|---|---|---|---|---|---|---|
| GET plan | 2382 | 0 | 118.9 | 18.4 | 39.6 | 50 | 85.1 |
| GET reminders | 2367 | 0 | 118.2 | 18.4 | 40.2 | 49.4 | 165.9 |
| GET advice | 1190 | 0 | 59.4 | 18.7 | 41.6 | 50.4 | 98.9 |
| GET pr-check | 1222 | 0 | 61 | 18.7 | 40.6 | 50.1 | 62.4 |
| GET options/phone | 1170 | 0 | 58.4 | 18.5 | 39.8 | 48.1 | 72.2 |
| GET /api/nodes?full=1 | 962 | 0 | 48 | 17.9 | 38.9 | 47.4 | 61.7 |
| GET / | 695 | 0 | 34.7 | 65.3 | 93.7 | 106.5 | 113.1 |
| GET /index.js | 696 | 0 | 34.8 | 84.8 | 114.9 | 131.8 | 161.5 |
| PUT state | 1405 | 0 | 70.2 | 20 | 42.1 | 51.3 | 142.4 |
| PATCH profile | 945 | 0 | 47.2 | 20.3 | 42.9 | 55.5 | 145.1 |
| PUT task done | 998 | 0 | 49.8 | 21.3 | 45.4 | 52.3 | 191.8 |
| POST event | 485 | 0 | 24.2 | 20.8 | 42.1 | 52.5 | 62.2 |
| DELETE event | 485 | 0 | 24.2 | 18.2 | 39.7 | 49.1 | 62.9 |
| 合计 | 15002 | 0 | 749.1 | 20 | 73 | 100.2 | 191.8 |

并发 50、20 秒：合计 13742 次、0 个非 2xx、每秒 685.6 次，p50 52.8 ms、p95 207.2 ms、p99 272.3 ms、最大 626 ms（最慢的是 `/index.js`，p50 239 ms）。

读法：一个进程大约每秒 700 次请求就到顶了（CPU 一个核满），再加并发只是排队，延迟变长、吞吐不涨；没有出错。每次打开首页要 `/`、`/index.js`、`/index.css`、`/merge.js` 加 4 个读接口，按每个活跃用户每分钟十几次请求算，单台单进程撑几百个同时在线的用户。上面的表是静态文件每次从磁盘读、不压缩时量的（当时最慢的是 `/index.js`）。2026-11-28 之后应用自己压缩：网页文件按版本（ETag）放在内存里、文字类的文件存一份 gzip，读接口 1KB 以上的 GET 返回也按 `Accept-Encoding` 压缩（只压 GET，带令牌的 POST 返回不压）；同样的机器、同样的设置再跑一次是合计每秒 699 次、p50 25.5 ms、p95 51.7 ms、p99 67 ms，`/index.js` 的 p50 从最慢降到和读接口一样（25 ms），读接口压缩多花的 CPU 让总吞吐少了约 7%。经过 Caddy 时它不再重复压缩（响应已经带 `Content-Encoding`）；浏览器有 ETag 时是 304。要再快可以让 Caddy 直接发 `web/` 的文件。更多并发要多进程时，先把助手的“一个账号同一时间只答一条”、助手和新建账号的限流从进程内存换成共享的（`docs/TODO.md` 第 10 条）。助手的请求主要是等模型（几秒到几十秒），不占 CPU，没有放进压力测试。

## 10. 验证过的（2026-11-28，本机）

- `docker build`（基础镜像从 `mirror.gcr.io` 拉的同一个 tag；Docker Hub 匿名拉取被限流）：镜像里只有 `package.json`、`src`、`web`、`data`、`tools/backup.js`，以 uid 1000 运行。
- `docker run --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges --init`：启动、`/api/ready` 200、`HEALTHCHECK` 变 healthy、容器里备份和核对通过、`docker stop` 0.2 秒内以 0 退出（日志里 `stopped`、`forced: 0`）。
- `docker compose up`（`SITE_DOMAIN=localhost`，Caddy 用自己的内部证书，端口改到 18080、18443）：HTTPS（HTTP/2）经 Caddy 到应用，响应里有 HSTS 和 Caddy 生成的 `x-request-id`，应用日志里的 `rid` 一样、`ip` 是截短的；80 端口 308 跳到 HTTPS。
- 没有验证的：真实域名的证书申请、云厂商的防火墙和磁盘加密、机器外的备份副本、真实发信。
