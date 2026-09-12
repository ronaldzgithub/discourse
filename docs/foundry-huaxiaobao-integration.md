# Foundry–Huaxiaobao integration boundary

## Status and source record

This is an integration design record, not evidence that Discourse is running,
publicly deployed, connected to email, used by real members, or approved to send
anything. This documentation change performed no runtime, account, external-
action, or production validation.

| Item | Pinned value |
| --- | --- |
| Upstream project | `discourse/discourse` |
| Upstream remote | `https://github.com/discourse/discourse.git` |
| Fork owner / remote | `ronaldzgithub` / `https://github.com/ronaldzgithub/discourse.git` |
| Integration branch | `codex/foundry-huaxiaobao-integration` |
| Baseline commit | `c89b1a0506a3ec0a249b7f23ac86763b358dc177` |

Keep `upstream` on the original project and `origin` on the fork. Record every
upstream merge and compatibility run explicitly; never push integration work to
the upstream project.

## Ownership boundary

- Foundry owns the community objective, service-package linkage, lead and
  opportunity semantics, answer/engagement plan, approvals, customer acceptance
  and accounting. A deployed forum, created topic, accepted answer, user count or
  page view is not proof of member growth, revenue or net value.
- Huaxiaobao owns the Discourse connection, instance/account binding, API key and
  webhook secrets, admin/login assistance, capability activation and typed
  execution receipts. Foundry must not retain these credentials or create a
  second forum connector.
- Discourse remains the native community workspace and record for users, groups,
  categories, topics, posts, review items and notifications. Its UI, automation,
  plugins and staff privileges do not confer commercial approval.
- VolvenceDeploy owns approved Linux deployment, persistence, health, upgrade
  and recovery.

Discourse covers an owned forum/community. It does not by itself provide WeChat
group operation, third-party community access, customer identity proof, or a
member-acquisition channel.

## Capability decomposition

Register small versioned Huaxiaobao capabilities with the least API-key scope.

| Capability | Native surface | Side effect and gate | Verification |
| --- | --- | --- | --- |
| Read categories/topics/posts/users/groups | Discourse JSON API | Read-only but may expose personal/private community data | Re-read by instance and stable object ID; enforce category/group scope |
| List unanswered/pending work | Topic/search/review APIs | Review-queue reads may expose moderated content | Bind query/review item IDs and observed revision/time |
| Prepare answer/moderation draft | Foundry/Huaxiaobao draft artifact | No post or moderation action | Hash target, body, uploads, visibility and task version |
| Create topic or reply | Posts API / native composer | External public/private communication; exact unexpired approval required | Re-read created post/topic, author, cooked/raw hash and visibility |
| Edit/delete/recover post | Posts/moderation APIs | Changes or hides community content; separately approved scope | Re-read revision, deleted/hidden state and staff action log where applicable |
| Review queued post | Review queue APIs/UI | Governance action; reviewer must be an authorized moderator, not the delivering worker | Verify reviewable status and resulting post/action |
| Assign or route community work | Assign/plugin/native staff UI when installed | Internal staff routing; plugin availability must be proven | Re-read assignee/group and target status |
| Receive event webhook | Discourse webhooks | Trigger only; no business acceptance | Verify HMAC, event headers and instance binding, then re-query current object |
| Configure API key, webhook, mail or site settings | Admin UI/API | Administrator action and potentially enables broad outbound effects | Admin review plus setting/key-scope read-back and safe smoke test |

`app/models/api_key.rb` supports global, read-only and granular API keys, hashes
stored keys, applies optional IP restrictions, and exposes the raw key only at
creation. `app/models/api_key_scope.rb` contains granular topic/post operations.
Use a dedicated granular or read-only key whenever possible and keep its raw
value only in Huaxiaobao's credential boundary. Configure automatic unused/max-
life revocation from `config/site_settings.yml` as part of key rotation policy.

For idempotent new-topic creation, the Posts controller supports a unique
`external_id` lookup. Preserve a Foundry/Huaxiaobao stable identity there when
appropriate. The controller's short memoization of identical create-post calls
for the same user/parameters is not a durable idempotency or restart contract.

## Review and approval separation

The queued-post flow is implemented by `lib/new_post_manager.rb` and
`app/models/reviewable_queued_post.rb`. Staff can be exempt from review, and
approving a reviewable creates the post and enqueues follow-on work. Therefore a
staff API identity must not be used to bypass the intended external-action gate.
The ordinary worker who prepares an answer cannot approve their own delivery;
an authorized moderator may make a community-governance decision, while the
named Foundry approver independently authorizes the exact outward action where
required.

## Account and HITL entry

Foundry stores opaque instance, category, topic, post, review-item and account
references. Huaxiaobao resolves a short-lived identity-bound route at task-open
time, such as `/review`, `/t/<slug>/<topic_id>`, or the applicable admin API-key/
webhook settings page. Do not store API keys, cookies, passwords, email/SMTP
credentials, webhook secrets or reusable authenticated links in the task,
receipt, ledger or normal logs.

| Identity | Allowed intervention | Completion condition |
| --- | --- | --- |
| Account/instance owner | Supply or authorize the owned forum and complete login/reauthorization | Adapter verifies instance, user identity and permitted scope |
| Huaxiaobao/tool administrator | Create scoped API key/webhook, configure connection and activate reviewed capability | Configuration read-back and authenticated non-sending probe |
| Ordinary worker | Prepare an answer, triage topics, tag/classify content, or operate a bounded community task | Adapter re-reads the target and verifies scope; no owner/admin/approval rights are acquired |
| Authorized moderator | Decide a review/moderation item within forum governance | Review item and resulting post/action are re-read |
| Named approver | Authorize the exact topic/reply/edit or other required external action | Approval binds target, content/upload hash, visibility, purpose and expiry |

Each persistent dependency identifies the blocked goal/checkpoint, reason,
required identity, allowed scope, opaque entry, completion test, deadline,
budget when applicable, and cancel/failure/expiry route. Operations blocked by
one invalid instance/account/key share one dependency and pause retries/spend.

## Webhook verification, ACK, and resume

`app/models/web_hook_event_type.rb` enumerates categories of webhook events.
`app/jobs/regular/emit_web_hook_event.rb` signs the payload, supplies Discourse
event headers including an event ID, and can retry failures up to four times on a
1/5/25/125-minute schedule when `retry_web_hook_events` is enabled. The setting
is disabled by default in `config/site_settings.yml` at this baseline. Each retry
creates a new `WebHookEvent`, so do not assume the event header alone is stable
across all retry attempts. Any 2xx is transport acknowledgement only.

The Huaxiaobao adapter must:

1. Verify the HMAC against the raw body, expected instance and webhook secret;
   enforce an allowed event/type/resource set and timestamp freshness.
2. Derive a durable deduplication key from instance, event type, stable object
   ID/revision and payload hash, while retaining delivery IDs as provenance.
3. Treat the callback as a wake-up hint and re-query the current post/topic/
   review state. Late callbacks cannot overwrite a newer task version.
4. Emit the current versioned typed outcome with command/event identity, attempt,
   opaque lineage, content hash, approval reference when applicable, observed
   time, evidence class and provenance.
5. Resume the frozen Foundry checkpoint only after the original component
   durably ACKs consumption. Duplicate delivery returns the stored result; an
   identity/content conflict fails closed.

An API 2xx or webhook receipt is not independent acceptance. For a create/edit,
read the current resource back and compare target, author, revision, visibility,
body/upload hash and moderation state. On timeout or unknown result, query before
retry. If still ambiguous, create a bounded manual-check task. Wrong tenant,
revoked key/scope, cancelled or expired task and permission loss produce typed
non-success outcomes and keep the checkpoint paused or enter the declared
fallback.

## Hidden outbound-action inventory

Discourse can contact people without a direct API post call. Before activating
an instance, audit and constrain at least:

- mentions, replies, quotes, watched topics/categories, live notifications and
  push behavior in `app/services/post_alerter.rb`;
- after-commit notification email behavior in `app/models/notification.rb` and
  mail selection/delay in `app/services/notification_emailer.rb`;
- scheduled digest mail in `app/jobs/scheduled/enqueue_digest_emails.rb`;
- welcome messages and trust-level messages from `app/models/user.rb` and their
  defaults in `config/site_settings.yml`;
- group SMTP handling in `PostAlerter`, invitations, password/account mail, and
  plugin-provided notifications.

At this baseline `disable_emails` defaults to `no`; a safe isolated environment
must use a sink or disabled outbound mail until explicitly reviewed. Publishing,
editing/deleting, invites, welcome/private messages, email, push and webhook-
driven outbound actions require the appropriate explicit gate. A human clicking
the native UI is not a bypass.

## Deployment, upgrade, and rollback

- Follow the official supported Linux Docker path in `docs/INSTALL.md` under an
  approved VolvenceDeploy spec. Pin the Discourse source revision, image and
  plugin revisions; do not use a floating tag as release identity.
- Isolate PostgreSQL, Redis, uploads/backups, mail credentials, API/webhook
  secrets and plugin state. Keep credential material inside the Huaxiaobao/
  deployment boundary, not Foundry.
- Before promotion, verify boot, database migrations, Sidekiq, authenticated API
  read, webhook signing/delivery, upload access and mail-sink/no-mail behavior.
  Then run contract tests for restart, duplicate/late callback, revoked scope,
  wrong instance and unknown post result without contacting real members.
- Back up database and uploads before upgrade and test the exact plugin set
  against the target revision. Preserve the prior compatible artifact and
  recovery instructions.
- Roll back only through an approved VolvenceDeploy change and only when schema,
  jobs and plugins remain compatible; otherwise restore the approved snapshot or
  perform a reviewed forward fix. Do not restart or migrate a live instance as
  part of integration validation.

## License, trademark, and third-party boundary

`LICENSE.txt` is GNU GPL version 2 or later. `COPYRIGHT.md` records copyright,
trademark and third-party details, and `.licensed.yml` supports dependency
license checking. Plugins, themes, fonts, mail/push providers and other bundled
components retain separate terms. Review the exact deployed distribution and
commercial/community usage; a root license does not establish rights to every
third-party component, hosted service or trademark. Preserve all notices.

## Executable offline contract boundary

`script/foundry_huaxiaobao_contract.mjs` is a no-network planner and native
webhook verifier for contract version
`foundry.huaxiaobao.discourse.command.v1`. It contains no API client or secret.
The boundary can be exercised locally with:

```sh
node --test script/foundry_huaxiaobao_contract.test.mjs
node script/foundry_huaxiaobao_contract.mjs \
  --plan docs/foundry-huaxiaobao-discourse-command.example.json
```

The planner exposes GET-only topic, unanswered, review-queue and notification
inventory. Notification reads set `silent=true`, preventing the native
`recent=true` code path from marking notifications seen. The only mutation plan
is a versioned review-queue `approve_post` or `reject_post`: it requires a fresh
read of the pending reviewable and its actions, the exact `version`, a distinct
preparer and reviewer, an unexpired approval binding the object/version/action,
then native review execution and GET read-back. It never emits a direct create-
post call, so staff status cannot be used to bypass the queue or independent
review.

The `outbound_inventory` operation emits no request and fails the activation
design closed unless the isolated instance is freshly verified with mail,
invites, welcome and trust-level messages, digests, desktop push and push prompts
off. This is intentionally stricter than current upstream defaults. A live
Huaxiaobao executor must independently read or attest those current settings;
the caller-provided snapshot is not deployment proof.

Native Discourse webhooks are verified over the exact raw body with the
`X-Discourse-Event-Signature` HMAC, expected instance, allowed event/resource
type and stable object identity. Retries can have new event IDs, so deduplication
uses the instance, event type, object identity/revision and payload hash while
retaining the delivery ID only as provenance. Every accepted event produces a
GET read-back plan; webhook 2xx is transport ACK only and never resumes Foundry
by itself.

## Current truth and blockers

| Milestone | State at this baseline |
| --- | --- |
| Source/fork/branch record | Recorded above; source present locally |
| Integration design | Documented; no live integration claimed |
| Offline planner/verifier | Implemented and covered by local contract tests; it performs no HTTP requests |
| Huaxiaobao live adapter/capability activation | Not present or proven by this change |
| Isolated Linux deployment and health | Not run or proven |
| Webhook/restart/duplicate/revocation tests | Not run or proven |
| Real instance/account validation | Blocked pending an authorized forum and scoped account/key |
| Approved topic/reply validation | Blocked pending an exact named approval |
| Member growth or commercial result | No field evidence and not claimed |
| Production deployment | Not approved and not claimed |

The minimum implementation is read-only topic/post/review inventory with a
granular key and verified webhook ingestion, followed by draft-only answer tasks.
Enable a single topic/reply action only after scoped-key, exact approval,
read-back verification, typed ACK and restart-resume tests pass with outbound
mail/push safely controlled.
