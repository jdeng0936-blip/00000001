# Design plan: TODO 2 (email login/recovery) and TODO 6 (email reminders) for zairyu-navi

Read-only: nothing in the repo was changed. `npm test` passes 45/45. Design only, no code written.

## 0. Facts in the current code that shape the design

1. `src/store.js` inserts users positionally (`INSERT INTO users VALUES (?,?,?,?,?,?,?,?,?)`) and only uses `CREATE TABLE IF NOT EXISTS`, so there is no migration mechanism. Adding a column to `users` would break that insert or need `ALTER`. **All new data therefore goes in new tables**; existing DB files upgrade with no migration.
2. There is one token per account (`users.token_hash`). Recovery on a new device cannot return the old token because only its hash is stored, so it must mint a new one. This needs a `sessions` table, or the old device gets logged out.
3. `engine.reminders()` mixes real dated deadlines with pseudo-items dated "today". I ran it on consecutive days under `TZ=Asia/Tokyo`: "现在是年末调整的时期…" (tag 每年) comes back with a new date each day. The same holds for tags 路线, 习惯, 方案 and 邮箱示例, and 每月 rolls monthly. A naive `(text, date)` dedupe key would re-send these daily.
4. Reminder dates are local-midnight `Date` objects. `GET /reminders` serialises them as UTC ISO, so under JST the string shows the previous day (住民登记 due 12-04 comes out as `2026-12-03T15:00:00Z`). The scheduler must build `YYYY-MM-DD` from local getters, never `toISOString()`, and production must run with `TZ=Asia/Tokyo`.
5. `web/index.html` and `src/engine.js` are held identical by `test/web-sync.test.js` (`reminders` is on the compared list). **The design does not touch `engine.js`**; filtering happens in the scheduler.
6. `web/index.html` has no "delete my data" control, although the consent dialog promises one; only the API has `DELETE /api/users/:id`. The account panel below adds it.
7. `deleteUser` leaves old `audit` rows carrying `user_id`, and the privacy policy says retained logs contain no personal information. So an email address must never be written to `audit.detail` (log only `email.bind`, `email.remove`, `session.recover`).
8. `opts.now` is a date string used only by the engine. Expiry and rate-limit tests need a millisecond clock: add `opts.clock` (`() => Date.now()` by default).
9. The server never reads the client IP today. Behind a proxy, rate limiting needs a `TRUST_PROXY` switch.

## 1. DB tables (all new, all in `src/store.js`)

| Table | Columns | Notes |
|---|---|---|
| `sessions` | `token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at TEXT NOT NULL, last_used_at TEXT, via TEXT NOT NULL` | Extra device tokens; `via='recover'`. `checkToken` accepts `users.token_hash` or a session row for that user. Index on `user_id`. |
| `user_emails` | `user_id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, verified_at TEXT NOT NULL, consent_version TEXT NOT NULL, remind_opt_in_at TEXT, unsub_token TEXT NOT NULL UNIQUE, bounced_at TEXT` | Verified addresses only. Stored normalised (trim, lower-case, max 254 chars, simple `x@y.z` check). One email per account, one account per email. `remind_opt_in_at` NULL means no reminder mail. `unsub_token` is 32 random bytes in base64url. |
| `email_challenges` | `id TEXT PRIMARY KEY, purpose TEXT NOT NULL, user_id TEXT, email TEXT NOT NULL, code_hash TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, expires_at TEXT NOT NULL, used_at TEXT, created_at TEXT NOT NULL` | `purpose` is `bind` or `recover`. `code_hash = sha256(id + ':' + code)`. Recover rows for unknown emails are also stored (`user_id` NULL) so both paths behave the same. Purged 24 hours after expiry by the scheduler tick. |
| `rate_events` | `id INTEGER PRIMARY KEY AUTOINCREMENT, bucket TEXT NOT NULL, at INTEGER NOT NULL` | Sliding-window counter. `bucket` is like `req:ip:<sha256 of ip>` or `req:em:<sha256 of email>`, so no raw IP or email sits in this table. Index `(bucket, at)`. Purged after 24 hours. |
| `reminder_sends` | `user_id TEXT NOT NULL, rkey TEXT NOT NULL, stage INTEGER NOT NULL, due TEXT NOT NULL, outbox_id TEXT, created_at TEXT NOT NULL, PRIMARY KEY (user_id, rkey, stage)` | The dedupe ledger. `rkey = sha256(tag + '|' + text + '|' + dueYMD)`. Written with `INSERT OR IGNORE`; only rows with `changes === 1` go into a mail. |
| `outbox` | `id TEXT PRIMARY KEY, user_id TEXT, kind TEXT NOT NULL, to_addr TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL, headers TEXT, status TEXT NOT NULL, tries INTEGER NOT NULL DEFAULT 0, next_try_at TEXT, last_error TEXT, created_at TEXT NOT NULL, sent_at TEXT` | Queue for every outgoing mail. `kind` is `code`, `notice` or `reminder`. `status` is `queued`, `sent` or `failed`. In dev and tests this table is the mailbox. |

`deleteUser(id)` additionally deletes from `sessions`, `user_emails`, `email_challenges`, `reminder_sends` and `outbox` by `user_id`, plus `email_challenges` by the user's email. The whole delete is wrapped in `BEGIN`/`COMMIT`.

Sent `outbox` rows have `body` and `to_addr` blanked 30 days after `sent_at`, and code mails immediately after sending in production, so the queue does not become a second store of personal data.

## 2. Endpoints

| Method and path | Auth | Body | Response | Behaviour |
|---|---|---|---|---|
| `GET /api/users/:id/email` | user token | none | `{ email: "a***@example.com" \| null, verified, remindOptIn }` | Masked address only. |
| `POST /api/users/:id/email` | user token | `{ email, consent: true }` | `202 { challengeId, expiresInSec: 600 }` | Sends a 6-digit code. Same 202 whether the address is free or bound to another account; in the second case the mail says "this address is already linked, use recovery" and no code can succeed. 422 on bad format or missing `consent`. |
| `POST /api/users/:id/email/verify` | user token | `{ challengeId, code, remindOptIn?: bool }` | `200 { email: masked, remindOptIn }` | Binds, replacing any previous address. Generic 422 "验证码不对或已过期" for every failure. |
| `PUT /api/users/:id/email/reminders` | user token | `{ on: bool }` | `200 { remindOptIn }` | 409 if no verified email. Sets or clears `remind_opt_in_at`. |
| `DELETE /api/users/:id/email` | user token | none | `204` | Removes the address, opt-in, pending challenges and queued mail. The account stays. |
| `POST /api/auth/recover` | none | `{ email }` | always `202 { challengeId, expiresInSec: 600 }` | A code is queued only if the email is bound. Unknown emails get the same body and a stored dummy challenge. The transport runs after the response, so timing does not differ. |
| `POST /api/auth/recover/verify` | none | `{ challengeId, code }` | `200 { id, token }` or generic `422` | Mints a session token (shown once, hash stored). Queues a "new device signed in" notice to the address. |
| `GET /api/users/:id/sessions`, `DELETE /api/users/:id/sessions` | user token | none | list of `{ createdAt, lastUsedAt, via }`; `204` | Delete revokes all other tokens ("sign out other devices"). Optional for the first cut. |
| `GET /api/unsubscribe?t=<unsub_token>` | none | none | small HTML confirm page with a POST button | GET changes nothing, so mail scanners that prefetch links cannot unsubscribe anyone. |
| `POST /api/unsubscribe?t=<unsub_token>` | none | none or `List-Unsubscribe=One-Click` | `200` HTML "已退订" | Clears `remind_opt_in_at`. Idempotent; an unknown token gets the same page. RFC 8058 one-click. The route must accept a form-encoded body (today a non-JSON body returns 400). |
| `GET /api/admin/outbox?status=` | admin token | none | rows without body | Operations view; optional. |

**Codes.** 6 digits from `crypto.randomInt`. Expiry 10 minutes. At most 5 wrong attempts per challenge, then it is dead. Single use. A new request invalidates older unused challenges for the same purpose and email. Comparison uses the existing `same()` timing-safe helper.

**Rate limits** (HTTP 429 with `Retry-After`, applied before any lookup so they reveal nothing):

| Action | Limit |
|---|---|
| Request a code, per email | 1 per 60 s, 5 per hour, 10 per day |
| Request a code, per IP | 10 per hour |
| Request a code, per account (bind) | 5 per hour |
| Verify, per IP | 30 per hour |
| Verify, per challenge | 5 attempts |

**Recovery identifies the account by email only.** The client never sends a user id, and the response for an unknown email is byte-identical to a known one.

## 3. Reminder delivery

**Sender interface** (`src/mailer.js`):

```
createSender(env, { store }) -> { name, send({ to, subject, text, headers }) -> Promise<{ id?: string }> }
```

| `MAIL_SENDER` | Behaviour |
|---|---|
| `outbox` (default; forced in tests) | No network. Marks the row `sent`; tests read it with `store.listOutbox()`. |
| `console` | Same, and prints To, Subject and body to stdout for local dev. |
| `http` | One `fetch` POST to `MAIL_HTTP_URL` with `Authorization: Bearer MAIL_HTTP_KEY` and JSON `{ from, to, subject, text, headers }`. A `MAIL_HTTP_PRESET` picks the payload shape for a specific provider later. About 25 lines. |
| `smtp` | Minimal client on `node:tls`: implicit TLS on port 465, EHLO, AUTH PLAIN, MAIL FROM, RCPT TO, DATA with dot-stuffing and base64 UTF-8 body, QUIT. About 80 lines, no STARTTLS in the first cut. |

`createApp` takes `opts.sender` so tests inject a fake that records or throws.

**Delivery worker** (`deliverOutbox()` in `src/scheduler.js`): takes `queued` rows with `next_try_at <= now`, calls `sender.send`, sets `sent`, or on error increments `tries` and backs off 1 min, 5 min, 30 min, 2 h, 12 h; after 5 tries the row is `failed`. Code mails are also kicked off right after the HTTP response via `setImmediate`.

**Scheduler** (`createScheduler({ store, sender, clock, now, baseUrl })`, with `runOnce()` returning `{ users, mails, items }`):

1. Select users having a verified email, `remind_opt_in_at` set and `bounced_at` NULL.
2. For each, build the engine as `engineFor` does in `src/server.js` and call `reminders()`. Completed tasks drop out by themselves because the engine only emits `todo` items.
3. Keep only real deadlines: tag in `法定期限`, `在留`, `事件`, `银行`, `每年`; drop any item whose date equals today together with tags `路线`, `习惯`, `方案`, `每月`, `邮箱示例` and texts matching `/^现在是|示例|订阅/`. This removes every rolling pseudo-item from fact 3.
4. Stages are 7, 1 and 0 days before the due date. An item qualifies for the smallest stage `s` with `daysLeft <= s` and `daysLeft >= 0`. Larger unsent stages are written to the ledger as skipped, so downtime or a late-entered event produces one mail, not a burst.
5. In one transaction per user: `INSERT OR IGNORE` into `reminder_sends`; items that inserted are collected into **one digest mail per user per run** and one `outbox` row is written. Because the ledger insert and the queue insert commit together, a crash cannot send twice or lose a mail.
6. Opt-in is re-checked at delivery time; a `reminder` row for a user who has since unsubscribed, removed the email or deleted the account is dropped.
7. Mail: subject like "【在留导航】3 件事快到期限"; body lists date, text and days left, a link to `BASE_URL/#reminders`, the standing "information only, not individual advice" line, and the unsubscribe link. Headers `List-Unsubscribe: <BASE_URL/api/unsubscribe?t=...>` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click`.
8. Runs from `src/server.js` only under `require.main === module` and `REMINDERS_ENABLED=1`: `setInterval` every `REMINDER_INTERVAL_MIN`, `.unref()`, sending only at or after `REMINDER_HOUR` local time. Also runnable as `node src/scheduler.js --once` for cron. Single process assumed.

If the profile date changes, `rkey` changes and the new deadline is reminded afresh, which is the intended behaviour.

## 4. File-by-file changes

| File | Change |
|---|---|
| `src/store.js` | Six tables above. New methods: `createSession`, `listSessions`, `revokeOtherSessions`; `checkToken` extended to sessions; `getEmail`, `userByEmail`, `bindEmail`, `removeEmail`, `setRemindOptIn`, `unsubscribeByToken`, `remindableUsers`; `createChallenge`, `getChallenge`, `bumpAttempt`, `useChallenge`; `hit(bucket, windowMs, max, nowMs)`; `claimReminder`, `enqueueMail`, `dueOutbox`, `markSent`, `markFailed`, `listOutbox`; `purgeExpired`; `tx(fn)` helper. `deleteUser` extended. Accept a `clock` argument. |
| `src/validate.js` | `normalizeEmail(s)`; throws `HttpError(422)`. |
| `src/mailer.js` (new) | Sender factory, four transports, mail text templates for code, notice and reminder digest. |
| `src/scheduler.js` (new) | `createScheduler`, `runOnce`, `deliverOutbox`, `--once` entry point. |
| `src/server.js` | New routes from section 2. `opts.clock`, `opts.sender`, `opts.baseUrl`. `clientIp(req)` honouring `TRUST_PROXY`. Form-body tolerance and HTML response for the unsubscribe routes. Bump `TERMS_VERSION`. Start the scheduler under `require.main`. |
| `web/index.html` | New "账号和邮箱" panel inside the sync IIFE near line 1160, not in the engine blocks covered by `web-sync.test.js`: bind (email, consent line, code field), reminder opt-in checkbox, remove email, delete all my data (calls the existing `DELETE`, clears `localStorage`). In the consent dialog add a link "已有账号？用邮箱找回" that runs recover and verify, then stores `{ id, token }` under `zairyu-account` and calls `adopt()`. When a stored token returns 401, offer recovery before creating a new account (today it silently creates a new one). Rename the demo checkbox "推送通知" so it is not mistaken for the real opt-in. |
| `web/privacy.html` | See section 6. |
| `web/terms.html` | One clause: reminder mails are a convenience, may be delayed or not arrive, and do not replace checking deadlines yourself. Version bump. |
| `README.md` | Endpoint rows, env vars, test count, `TZ` note. |
| `docs/TODO.md` | Mark 2 and 6 as partly done; leave phone login, App push, real provider account. |
| `docs/compliance-review.md` | Add a row for email as new personal data and for the delivery provider. |
| `test/api.test.js` | Change `V` to the new terms version. |
| `src/engine.js` | No change. |

## 5. Env vars

| Name | Default | Purpose |
|---|---|---|
| `MAIL_SENDER` | `outbox` | `outbox`, `console`, `http`, `smtp` |
| `MAIL_FROM` | none | Required for `http` and `smtp` |
| `MAIL_HTTP_URL`, `MAIL_HTTP_KEY`, `MAIL_HTTP_PRESET` | none | HTTP API sender |
| `SMTP_HOST`, `SMTP_PORT` (465), `SMTP_USER`, `SMTP_PASS` | none | SMTP sender |
| `BASE_URL` | `http://localhost:PORT` | Links in mails |
| `REMINDERS_ENABLED` | off | Starts the in-process scheduler |
| `REMINDER_INTERVAL_MIN` | 60 | Tick interval |
| `REMINDER_HOUR` | 9 | Earliest local hour to send |
| `TRUST_PROXY` | off | Use the last `X-Forwarded-For` hop as the client IP |
| `TZ` | must be `Asia/Tokyo` in production | Engine dates are local time |

If `MAIL_SENDER` is `http` or `smtp` with missing settings, the server refuses to start with a clear message.

## 6. Privacy-policy text that must change (`web/privacy.html`)

- **§2 table**, new row: "邮箱地址（你自己选择绑定时）" with purpose "换设备时找回账号；在你另外同意的情况下发送期限提醒邮件". Binding is optional.
- **§2 访问记录**: add that IP addresses are used briefly, in hashed form, to limit verification attempts.
- **§5 委托处理**: new bullet for the mail delivery provider, 【邮件发送服务商名称和所在地】. Reminder mails contain the deadline text, which can indicate residence status matters; if the provider is abroad, the same foreign-transfer disclosure as the Anthropic bullet applies.
- **§6 保存多久**: email is deleted when the user removes it or deletes the account; verification codes are kept 10 minutes; sent-mail records are kept 30 days without content; "which reminder was already sent" records are deleted with the account.
- **§7 你的权利**: can remove the email, turn reminders off in the app, or unsubscribe from any mail with one click.
- **§8 安全**: codes are stored hashed, expire in 10 minutes, are limited to 5 attempts; the service does not disclose whether an address is registered; a sign-in on a new device triggers a notice mail.
- Version line and the consent-dialog bullet list in `web/index.html` get the same additions. The bind form itself shows a one-line consent, and `user_emails.consent_version` records it, because existing users have not seen the new policy and the re-consent flow (TODO 8) does not exist yet.

## 7. Tests to add

`test/auth-email.test.js`
1. Bind: request code, read it from the outbox, verify; `GET /email` returns the masked address.
2. Wrong code five times kills the challenge; the right code then fails.
3. Code expires after 10 minutes (injected clock).
4. A code is single use; a newer request invalidates the older challenge.
5. Recover on a "new device": returns `{ id, token }`, the new token reads the profile, the old token still works.
6. Recover for an unregistered email returns the same status and body shape, queues no mail, and verify fails with the same generic 422.
7. Binding an email already bound elsewhere returns the same 202, no usable code, and the first account is unchanged.
8. Rate limits: second request within 60 s gives 429; sixth in an hour gives 429; per-IP limit; limits apply equally to unknown emails.
9. `DELETE /email` removes address, opt-in and pending challenges; recover no longer works.
10. `DELETE /api/users/:id` removes rows in all six new tables; the same email can then be bound to a fresh account.
11. Email format validation and normalisation (case, whitespace, over-length).
12. No email text in `audit.detail` after bind, recover and delete.
13. Bind without `consent: true` gives 422.
14. `DELETE /sessions` revokes recovered tokens.

`test/reminders.test.js`
15. No mail without a verified email; no mail with email but no opt-in.
16. A 14-day legal deadline produces mails at 7, 1 and 0 days, once each.
17. Running `runOnce` twice at the same time produces one mail.
18. Running on consecutive days does not re-send the "today" pseudo-items (the case reproduced in fact 3).
19. Catch-up after downtime: one mail at the smallest stage, earlier stages recorded as skipped.
20. Marking the task done stops further stages.
21. Changing the date creates a new reminder; the old key is not re-sent.
22. Several items due the same day arrive as one digest.
23. Unsubscribe: GET changes nothing, POST clears opt-in, repeat POST is harmless, unknown token gets the same page, later runs send nothing.
24. Mail carries `List-Unsubscribe` and `List-Unsubscribe-Post` headers and the unsubscribe link.
25. Sender failure: row retried with backoff, `failed` after 5 tries, ledger not duplicated on retry.
26. A queued reminder is dropped if the user unsubscribes or deletes the account before delivery.
27. Due dates use local dates under `TZ=Asia/Tokyo` (a deadline on 12-04 is not treated as 12-03).

`test/mailer.test.js`
28. `outbox` and `console` senders make no network call.
29. `http` sender posts the expected payload and auth header to a local `http.createServer` stub; a 5xx reply rejects.
30. `smtp` sender against a local `tls.createServer` stub with a self-signed test certificate generated in the test: correct command sequence, dot-stuffing, UTF-8 subject encoding.
31. Missing settings for `http` or `smtp` fail at startup.

`e2e/browser.js`: one added path, bind then clear `localStorage` then recover, reading the code from `GET /api/admin/outbox`.

## 8. Open decisions for the owner

| # | Decision | Recommended default |
|---|---|---|
| 1 | 6-digit code, magic link, or both | Code only. It works when the mail is read on another device and is not consumed by mail scanners that prefetch links. A link can be added to the same mail later with no schema change. |
| 2 | On recovery, keep the old device signed in or rotate the token | Keep it signed in (the `sessions` table), send a "new device" notice, and offer "sign out other devices". Rotation is simpler but logs out a user who merely opened a second browser. |
| 3 | Email stored as plain text or encrypted at rest | Plain text in its own table for now, since the scheduler must read it to send. Encrypting with an `EMAIL_KEY` adds a key-management duty; decide before launch together with the cloud provider choice. |
| 4 | Which reminders are mailed, when, and how much the mail says | Legal deadlines, residence renewal, events, bank and yearly tax dates; at 7 days, 1 day and the day itself; full reminder text in the mail. The alternative is a content-free "you have 3 deadlines, open the app" mail, which tells the mail provider less but is far less useful. The demo UI text says "30 天、7 天、当天", so one of the two must change. |
| 5 | First real transport | HTTP API sender, because it is one `fetch` call and providers handle SPF, DKIM and bounces. Keep SMTP as the second option. Bounce handling (`bounced_at`) stays manual until a provider is chosen. |

## Files read

- /home/user/00000001/zairyu-navi/README.md
- /home/user/00000001/zairyu-navi/docs/TODO.md
- /home/user/00000001/zairyu-navi/src/store.js
- /home/user/00000001/zairyu-navi/src/server.js
- /home/user/00000001/zairyu-navi/src/validate.js
- /home/user/00000001/zairyu-navi/src/engine.js (the `reminders` function, lines 74-96)
- /home/user/00000001/zairyu-navi/web/index.html (sync block from line 1160, reminders panel near line 264)
- /home/user/00000001/zairyu-navi/web/privacy.html
- /home/user/00000001/zairyu-navi/test/api.test.js
- /home/user/00000001/zairyu-navi/test/web-sync.test.js