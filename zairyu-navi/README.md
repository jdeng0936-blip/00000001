# 在留导航（第一期）

面向在日本生活和准备来日本的中国人：从旅游签、在留卡到永驻，每一步要办什么、什么时候办、多少钱、找谁帮忙。

第一期范围：闯关路线、提醒、选方案、助手、对接咨询。同城板块在第三期。

## 运行

需要 Node 22.5 以上，不需要安装任何依赖。

```
npm test          # 45 个测试
npm start         # http://localhost:8787 ，网页在根路径，接口在 /api
```

环境变量：`PORT`、`DB_FILE`（SQLite 文件位置）、`ADMIN_TOKEN`（管理服务商用，不配则管理接口返回 503）、`ANTHROPIC_API_KEY`（助手用，不配则助手接口返回 503）、`MODEL`。

## 目录

| 位置 | 内容 |
|---|---|
| `data/nodes.json` | 26 个节点的资料。每条数据带核实标记（1 已对照官网，0 待核实）和来源链接 |
| `src/engine.js` | 规则引擎：路线和期限、提醒、永驻体检、七个选方案主题、高度人才积分、人民币折算。纯逻辑 |
| `src/validate.js` | 用户概况的校验，接口和助手共用 |
| `src/store.js` | 持久化（SQLite）。换数据库只改这个文件 |
| `src/assistant.js` | 助手的提示词、工具和对话循环 |
| `src/server.js` | HTTP 接口和静态网页 |
| `web/index.html` | 网页端。在本服务器上打开时，概况和进度存到服务器，助手走服务器接口 |
| `e2e/browser.js` | 真实浏览器的端到端检查（需要 playwright） |
| `eval/questions.json` | 68 道边界测试题，其中 35 道必须全部通过才能上线 |
| `eval/run.js` | 跑题脚本 |
| `docs/` | 合规自查记录、待办 |

## 接口

| 方法和路径 | 作用 |
|---|---|
| `POST /api/users` | 新建账号，body `{ "accept": "条款版本" }`（版本从 `GET /api/terms` 取），返回 id 和令牌（令牌只返回这一次）。之后的 `/api/users/:id/...` 都要带 `Authorization: Bearer 令牌` |
| `PUT /api/users/:id/state` | 网页端整体同步概况和完成记录 |
| `GET /api/users/:id`、`DELETE /api/users/:id` | 读取、删除自己的全部数据 |
| `PATCH /api/users/:id/profile` | 修改概况（身份、日期、出国记录等） |
| `PUT /api/users/:id/tasks/:nodeId/done` | 标记任务完成或撤销，body `{ "done": true }` |
| `GET /api/users/:id/plan`、`/reminders`、`/advice`、`/pr-check` | 路线、提醒、判断、永驻体检 |
| `POST /api/users/:id/chat` | 和助手对话，body `{ "message": "...", "history": [] }` |
| `GET`、`POST /api/users/:id/inquiries` | 发给服务商的咨询。必须带 `consent: true` 和 `providerIds`（最多三家） |
| `GET /api/nodes`、`/api/nodes/:id` | 节点资料 |
| `GET /api/options/:topic` | 选方案。topic：route、degree、points、phone、drive、company、budget |
| `GET /api/providers/categories` | 服务类别和收费方式 |
| `GET /api/providers?category=` | 已入驻的服务商名单 |
| `GET`、`POST /api/users/:id/events`，`DELETE .../events/:eid` | 会产生期限的事件 |
| `POST /api/admin/providers`、`PUT /api/admin/providers/:id/active` | 管理员入驻和下架服务商（带管理员令牌） |
| `GET /api/provider/me`、`/api/provider/inquiries`，`POST .../inquiries/:id/reply`，`PUT .../inquiries/:id/status` | 服务商查看和回复咨询（带服务商令牌） |

## 写进代码的合规规则

- 不收集个人编号、护照号、银行账号：接口遇到这类字段直接拒绝，咨询摘要里出现12位数字也拒绝。
- 发给服务商的咨询必须有用户的明确同意。
- 士业（行政书士、税理士、社会保险劳务士、司法书士）只收固定展示费，不按成交抽成；非士业的推广要标明。
- 助手不制作交给官方的文书，不对个别的在留和税务情况下结论，不作任何保证。
- 用户可以删除自己的全部数据；每次写入都有留痕。

## 还没做的

见 `docs/TODO.md`。
