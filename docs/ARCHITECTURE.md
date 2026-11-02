# V3 architecture additions

Migrations 0005–0010 add fact evidence/history, explicit source audiences, sponsored-AI approval and recovery codes, versioned projects, staged proposals and incremental content quotas. Existing credentials and content remain. Legacy generated artifacts without reliable provenance become owner-visible only, retaining their original bytes.

Project dependency edges point from dependent work to prerequisites. Assistant edits to confirmed items stage changes; owner approval applies a correction and flags transitive dependents for review. Mutations serialize under brain/project locks, compare versions and retain before/after events. Retry UUIDs bind an action and payload fingerprint. Restricted audiences can narrow but cannot expand over historical private content. Saved sources are checked for ownership, visibility and exact excerpts when supplied. Receipts describe tool delivery, not native memory synchronization.

Context and search filter evidence before retrieval. Sessions inherit audiences of delivered evidence, including briefings, so subsequent memory writes cannot broaden a private read. Jobs carry initial audience and source provenance; completion rechecks authority, epoch and source permissions. Two workers share the service, at most one per account, preferring the account least recently served. Interrupted running jobs fail explicitly on restart; queued jobs survive. This release does not claim checkpoint resume.

Provider budget reservations require account approval. Recovery codes are single-use hashes; recovery revokes old logins/grants and stops queued work. Database triggers bound content growth at 25 MiB / 10,000 logical rows per brain by default; deletions, shrinking and bookkeeping remain possible at quota. Session/usage/activity metadata is rate limited but excluded from that content quota. Export format3 includes all five project collections, fact revisions and AI access history.

`/ready` reports sanitized provider, sandbox, workers, nightly and disk status. `/health` retains database-only restart semantics. Backups and restore are explicitly deferred.

V3 migrations introduce privacy semantics that v2 code does not enforce. Build and test before migration, and do not blindly roll back to a v2 image afterward; assess compatibility or fix forward. Prior image metadata is retained for investigation, not a promise of safe automatic rollback.

The original implementation background follows; version-specific release results belong in VERIFY.md.

# Brain architecture

This is an independent Arx Sable product on the shared Helsinki host **hermes**. Its authoritative checkout, development tools, tests, builds and runtime live at `/srv/sesame-brain`; the Mac supplies SSH and account access, and is not an application dependency.

## Discovery baseline

The v2 handoff describes some stale v1 facts. The repository already exists publicly at [Oscar-G13/sesame-brain](https://github.com/Oscar-G13/sesame-brain). An unauthenticated GitHub API read confirmed `private: false`. The existing service is a deployed OAuth MCP application, with one automatically created default brain per account. Every content row already carries both user and brain ownership.

The production container inspected during v2 discovery was the v1 image `sesame-brain:c5f7ef7bde85`, running as `node` with a read-only root filesystem. Discovery and the initial v2 source work did not replace that runtime. Release acceptance and the final deployed revision belong in [VERIFY.md](VERIFY.md), rather than being inferred from source files.

| Component | Discovered implementation |
| --- | --- |
| Runtime and language | Node.js 22, strict TypeScript; installed compiler 7.0.2 |
| HTTP and rendering | Express 5.3.0, EJS, one CSS asset and small first-party JavaScript |
| MCP server and client | `@modelcontextprotocol/server` and `@modelcontextprotocol/client` 2.4.0 |
| HTTP adapter | `@modelcontextprotocol/node` 2.1.2 |
| Database | PostgreSQL 16 in its own Compose service and named volume |
| SQL client and migrations | `pg` 8.23.1; numbered SQL files and the small migration runner in `scripts/migrate.ts` |
| Formulation validation | JSON Schema 2020-12, AJV 8.20.0 and `ajv-formats` |
| Authentication | Independent OAuth authorization server; argon2id passwords and database-backed browser sessions |

The migration runner holds a PostgreSQL advisory lock, applies each pending numbered file transactionally, and records its name in `schema_migrations`. Container startup runs migrations before listening. An application rollback must remain compatible with the current database schema.

## Hosting and private configuration

Docker Compose project `sesame-brain` runs the application, PostgreSQL, and an isolated code-execution sandbox. Docker restart policies provide boot persistence; no separate application systemd service or pm2 process is involved. Host-native Caddy imports `/etc/caddy/sesame-brain.caddy`, obtains public TLS, and routes only `brain.arxsable.ai` to `127.0.0.1:3360`. PostgreSQL has no host port. The MCP URL is [https://brain.arxsable.ai/mcp](https://brain.arxsable.ai/mcp).

Compose loads secrets from `/srv/sesame-brain/.env`. That server-owned file is gitignored and must remain mode 0600. The application runs as the non-root `node` user; the environment is supplied by Docker, not embedded in its image. Model IDs are configured in `config/ai-models.json` and overridden with the documented environment values. API credentials never belong in model configuration, SQL fixtures, logs, screenshots or Git history.

The five-minute Brain watchdog remains enabled. The project-only backup cron is disabled at the owner's request; deploy creates no archives. Existing archives are preserved. DEFERRED-BACKUPS.md describes future encrypted offsite storage and restore verification. Nightly reasoning uses **America/Los_Angeles**.

A service-owned workspace is required for background-job files. Its configured path must be mounted persistently into the otherwise read-only application. Code-execution isolation and job tool access are documented with their acceptance evidence in `VERIFY.md`; configuration alone does not prove a sandbox.

## MCP identity and the two kinds of session

`src/mcp/routes.ts` registers tools from the central definitions table. The HTTP bearer middleware hashes the presented opaque token, joins its live grant, and supplies an `AuthContext`: `user_id`, `brain_id`, `agent_label`, `client_id`, `grant_id`, `scopes` and `token_hash`. Handlers use that context; request arguments cannot choose their tenant. A grant rename or revocation changes the next token check. OAuth discovery, client registration, PKCE and token rotation remain the existing authorization boundary.

The transport creates a request-scoped MCP handler and closes it after handling the request. It supports Streamable HTTP and compatible stateless requests; it does not retain an MCP session ID or an SSE connection that represents a voice call. Sesame receives results only when it invokes a tool. No server-initiated notification or sampling path is assumed.

The original SQL table named `sessions` is **browser authentication**. Migration 0002 preserves it and adds **`brain_sessions`** for voice-call lifecycle state. A derived call-session key hashes the access-token hash and agent label; an actual transport session identifier can be used if one is supplied later. The default new-session boundary is 30 idle minutes. Quiet roll-up uses a separate ten-minute threshold and a 60-second sweeper.

The first tool response in a derived session can carry a short spoken briefing. Every successful response carries an accurate status trailer. Think/do use deterministic first-touch headlines to preserve voice latency. Session writes, reasoning calls and jobs feed the roll-up material; explicit `end_session` requests the same roll-up immediately. Generated output is persisted only after rechecking ownership, connection state and the brain's content epoch.

## Context, reasoning and background work

`src/brain/context.ts` assembles ordered text blocks from facts, the latest snapshot, earlier snapshot headlines, open handoffs, unsurfaced job results, recent visible notes, compact activity and current-session writes. A conservative UTF-8 byte bound keeps the pack within its configured token allowance. Truncation is labeled. The cache is tied to the brain's database-maintained `memory_version`, so writes invalidate cached packs.

The dry-run CLI is `scripts/context-pack.ts`. It accepts an explicit user and brain and prints the same bounded context without making a model request. Job results are marked surfaced only when their result material is actually delivered, rather than merely fetched for an internal preview.

`think` uses a configured quick or deep model, a bounded wall clock and a small nondestructive tool loop. If reasoning reaches its voice deadline, the response can retain partial text and queue the remaining work. `do` persists a job before returning, so the caller can leave the conversation. Job state and result references are database records; startup recovery marks interrupted running jobs failed, preserves queued work, and completes before accepting requests.

The provider wrapper reserves the conservative request allowance against the brain's local-day budget, then settles actual usage. Usage is scoped by user, brain, local date and model. Neither a model request nor a worker may bypass the shared daily allowance. Scoped database activity retains model, token, and latency metadata plus some request/write summaries. Activity and session material are included in export and purge. Application/container stdout excludes prompt and memory contents.

A missing API key disables model work while leaving memory and OAuth available. Availability must be checked with the provider's authenticated models endpoint before live acceptance. Official documentation can establish a published model ID; it cannot establish that a specific account has access. Final authenticated discovery and live results are recorded in `VERIFY.md`.

## Nightly formulation, audit and deterministic diff

`src/brain/nightly.ts` exposes `runNightlyBrain`, `runDueNightlies` and startup recovery for interrupted claims. The service scheduler calls the due-run helper during the configured hour, default 03:00 America/Los_Angeles. It selects approved brains with new user-origin activity in the preceding 24 hours, excluding its own outputs and automatic summaries/artifacts. A unique `nightly_runs(user_id, brain_id, local_date)` claim makes repeated ticks, DST clock repetition and concurrent attempts idempotent. A failed or skipped claim is not silently rerun that same day. A full outage during the scheduled hour is shown as overdue; this release does not automatically catch up later that day.

A run reads the previous validated formulation, its matching audit, a bounded longitudinal context pack and recent source material filtered by both ownership columns. Source text is untrusted evidence, not instructions. The configured deep model produces a formulation conforming to [dossier.v1.json](schema/dossier.v1.json). Schema or semantic failure is returned to the model for one correction attempt; a second failure leaves no snapshot artifacts.

The schema covers every requested dossier section. Its taxonomy retains the requested legacy section names, while its content is explicitly nonclinical and qualitative. Evidence types and confidence values are closed enums. Hypotheses require alternatives and qualified confidence. Relationship status must copy the latest dated report, preserving conflicting older reports. Role-play and unverified claims have explicit labels. Numeric assessment fields and extra diagnosis fields are rejected; qualitative safeguards do not substitute for human review of every possible prose claim.

A separate auditor pass receives the formulation and source evidence. It uses the configured OpenAI auditor only when that provider and model are configured; otherwise it uses the Anthropic deep model with an independent auditor prompt. It flags chronology conflicts, observation/inference confusion, stale status, manufactured precision, unsupported claims, bias and overreach. It cannot silently rewrite the formulation.

The final diff is deterministic JSON. It records added and dropped themes, confidence changes, dated relationship-status changes, new audit flags and resolved flags. Its spoken summary is exactly 100 words and states the limitations of the comparison. Formulation, audit and diff are committed together as three snapshots attributed to `brain-nightly`, with matching activity entries. No nightly retention task deletes memory.

The adapter supplies model requests through the same daily-budget wrapper. A run also counts all formulation, correction and audit tokens against its own cap. Exhaustion skips the run and records only a safe error code. Logs include run IDs, ownership IDs, token totals and provider identity; no source content is logged. Dry-run mode previews the formulation request without claiming a run, invoking a model or writing snapshots.

A purge increments `brains.content_epoch` and removes its owned runs. Before the three-snapshot transaction, the nightly runner locks the brain and verifies both the original epoch and its surviving run claim. A model response arriving after purge therefore cannot recreate deleted memory. Restart recovery marks an abandoned running claim failed instead of leaving it running forever.

## Export and user-initiated deletion

`GET /account/export` builds a repeatable-read JSON export in `src/web/routes.ts`. The v1 content collections are fetched by the authenticated account. The v2 extension adds `brain_sessions`, jobs, usage, usage reservations, and nightly run metadata; snapshot kinds are ordinary exported fields. Browser authentication sessions remain private infrastructure and are not confused with conversational session history.

Account deletion still cascades from the user through its brains and all owned collections. The separate clear-memory action belongs to the user and keeps their account and OAuth connections. It clears brain content, new v2 state and that brain's workspace while advancing the epoch that guards in-flight work. Models have no purge or account-deletion tool.

## Tests and verification

Run development checks over SSH on hermes:

~~~sh
cd /srv/sesame-brain
docker compose --profile dev run --rm dev npm run typecheck
docker compose --profile dev run --rm dev npm test
~~~

The dev profile uses a dedicated temporary `brain_test` PostgreSQL service, separate from production data. Tests use injected provider responses; their results prove orchestration and safety properties, not provider availability or live answer quality. Existing OAuth/MCP/browser checks remain part of acceptance.

The targeted nightly suite is `npx tsx --test test/nightly.test.ts` inside the dev container. It checks strict schema labels, hypotheses, latest dated relationships, deterministic changes, the 100-word summary, DST scheduling, one validation retry, atomic writes, duplicate claims, provider selection, budget refusal, purge during generation, dry-run behavior and tenant isolation. Release-wide and authenticated live verification are recorded separately in `VERIFY.md`.


## Production release

Brain 2.0.0 core acceptance passed at 8596c89dd415; final presentation-copy revision df719d6f2e64 was deployed afterward with app, database, and sandbox healthy. The persistent workspaces volume is mounted at /var/lib/brain/workspaces; a separate named volume carries the isolated sandbox Unix socket. Browser call sessions remain tied to a live browser authentication session. Export omits internal session keys, transport identifiers, hashes, and lease identifiers. See [VERIFY.md](VERIFY.md) for CI, public OAuth/browser, restart, preservation, and final deployment receipts.
