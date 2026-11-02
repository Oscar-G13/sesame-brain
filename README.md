# Brain

Context for your next Sesame call or chat. Save useful details, decisions, projects and open questions in one conversation, then retrieve them in the next with the same voice and connection. Brain also provides reasoning, background work and reviewable evidence.

**Unofficial, not affiliated with or endorsed by Sesame AI Inc.** Sesame is their mark and is used descriptively. This is vibecoded software: a Claude-drafted specification, Codex implementation, and human-owned production deployment. A completed human review is not claimed by automated verification.

[Service](https://brain.arxsable.ai) · [Connect guide](https://brain.arxsable.ai/docs) · [Dashboard](https://brain.arxsable.ai/dashboard) · [Privacy](https://brain.arxsable.ai/privacy) · [Tool contracts](docs/TOOLS.md)

## Connect

In Sesame, open **Agent Hub → Apps**, add an external MCP, and paste **https://brain.arxsable.ai/mcp**. Sign up or sign in, label the connection, and approve. One connection is enough to save and resume context across conversations. The label attributes records and controls access; additional connections are optional. You must be 18 or older.

In one conversation, try “save in Brain that I take the 7:40 train.” Before finishing, ask it to save the key decisions and open questions. In your next call or chat with the same voice, ask “resume from Brain — where did we leave off?” Brain only knows information sent through its tools. It does not automatically capture every spoken word or import your existing Sesame history.

Other OAuth MCP clients can connect to the same endpoint. Client ID Metadata Documents, dynamic registration, and configured fixed clients are supported. The Streamable HTTP endpoint supports modern and compatible legacy requests; it does not provide the separate deprecated HTTP+SSE transport.

## Brain v3: Living Projects

Start a project in one conversation, then resume it in the next using the same connection. Retrieve the saved goal, constraints, decisions, questions, tasks, milestones and artifacts without explaining them again. The dashboard shows real dependency links and which project version each connection last retrieved. Brain cannot inspect or rewrite Sesame's native memory.

An assistant's change to confirmed information becomes a proposal. Owner approval preserves the old value, records its source and reason, and flags dependent work for review. Expected versions prevent silent overwrites; retry IDs prevent duplicate changes. Project jobs attach sourced artifacts and flag assumptions that changed during work.

Brain exposes 29 tools: the original fifteen memory tools, six reasoning/session tools, seven project tools and `memory_history`. The reasoning tools provide:

- **`resume`**: deterministically retrieve current saved context, the last project, open work and waiting results. It works on demand even without a long idle gap and requires no paid model call.
- **`think`**: reason over the current request and this brain's longitudinal context. Quick and deep modes have separate deadlines. A timed-out answer can continue as a background job.
- **`do`**: queue a longer task and return an acknowledgement immediately. Results become a note and handoff restricted to their source audience. `job_status` and `jobs_list` show progress.
- **`end_session`**: close the Brain check-in when the conversation ends. When authorized AI is available, it can save a summary of recorded activity; otherwise it closes without inventing a summary.

Every successful tool response includes a short `trailer`. An initial Brain request can also receive saved continuity context automatically. Ask for `resume` whenever a new call or chat needs its bearings; connection/session heuristics alone cannot identify every native Sesame call boundary. Sesame should use this context naturally rather than reading JSON aloud. Continuity retrieval is deterministic and does not require a paid model call.

This MCP endpoint is stateless, so Brain check-ins derive from the authenticated connection and session rules. Thirty idle minutes normally start a new check-in; explicit `resume` retrieves current saved context even sooner. These check-ins and retrieval receipts are not proof that a native Sesame call started or ended. The sweeper checks every minute; a writing/reasoning session quiet for ten minutes can become an `auto` snapshot. Browser dashboard sessions remain tied to the signed-in browser session. Call summaries recheck grant or browser-session authorization. Account deletion and memory-purge epochs prevent delayed work from recreating removed memory.

Context retrieval scores saved records against the current question, including relevant older notes. It reserves space for current-session changes and waiting results. A conservative UTF-8 byte budget bounds the pack and labels truncation. Permission checks apply before context assembly, search, summaries and result delivery. Reading restricted material narrows subsequent writes in that Brain session. Fact revisions retain prior values, sources, confidence and confirmation status. AI-written facts remain unconfirmed; edits to owner-confirmed facts become proposals.

At 03:00 **America/Los_Angeles**, the nightly scheduler considers approved brains with new user-origin activity during the preceding day. Its own generated records do not trigger another review. It writes a nonclinical, conversation-derived formulation, an independent audit, and a diff as three retained snapshots. Formulations use the versioned [dossier schema](docs/schema/dossier.v1.json), with evidence labels, alternatives, qualitative confidence, dated relationship reports, and no diagnoses or numerical personality scores. An optional OpenAI auditor provides a second model lab; otherwise the configured deep model audits with a separate prompt.

The dashboard lets the account owner browse memory, capture a note or fact, ask Brain to think, start, inspect, or stop jobs, review nightly insights and token usage, download workspace files, export data, and explicitly clear a selected brain. Clearing memory preserves the account, password, and assistant connections. Account deletion remains a separate two-step action. **Snapshots are never automatically pruned.**

New accounts can use memory and projects immediately; hosted AI requires operator approval. Existing accounts retain their AI access. AI requests require server-side credentials. Without an Anthropic key, existing memory and OAuth connections keep working, while AI actions report that reasoning is not connected; no fabricated answer, briefing, or snapshot is substituted. Daily usage limits pause model work until the next Los Angeles calendar day. Jobs persist across restarts; interrupted running work is marked failed rather than left running forever.

Background tools can search memory, write non-destructive memory updates, fetch public URLs, search the web when the configured model supports it, and create per-brain workspace files. Code runs in a separate non-root, resource-limited service reached through a Unix socket, using fresh temporary directories, a minimal environment, and a hard timeout. **Code execution has no network access.** Public URL fetching and provider web search are separate tools; code does not inherit the app's credentials, database access, or workspace mount.

When AI is used, relevant context is sent to Anthropic, and to OpenAI only when that auditor is configured. Requested web lookups contact their destinations; requested email delivery uses configured SMTP. The dashboard reports tokens rather than inventing dollar costs. See [privacy](https://brain.arxsable.ai/privacy) for the current service policy.

The default Sonnet/Opus 5.5 model IDs were checked against the connected Anthropic account on November 2, 2026. Model IDs and web-search tool versions live in configuration. Model availability and provider-backed acceptance checks must be rechecked for a different account; local fake-provider tests do not establish live provider behavior. Deployment and verification evidence belongs in [VERIFY.md](docs/VERIFY.md).

Account recovery uses one-time codes generated in Account after checking the current password; only hashes are stored. Recovery invalidates old logins and assistant connections. Content limits default to 25 MiB and 10,000 content rows per brain; reaching a limit rejects growth without deleting existing memory. Workspace files have a separate 5 MiB / 100-file limit.

## Screenshots

![Saved context retrieved with one connection](evidence/continuity-browser/retrieved-desktop.png)
![Same-voice context continuity on mobile](evidence/continuity-browser/retrieved-mobile.png)

## Self host in five commands

Requires Docker Compose, your own domain, and an HTTPS reverse proxy. Point the domain at your host and proxy it to loopback port 3360.

```sh
git clone https://github.com/Oscar-G13/sesame-brain
cd sesame-brain
cp .env.example .env    # edit the URL, database password, secrets, and optional provider settings
docker compose up -d
docker compose logs -f app
```

Use random 32-byte values for `SESSION_SECRET` and `TOKEN_PEPPER`, put the same database password in `POSTGRES_PASSWORD` and `DATABASE_URL`, and keep `.env` mode 600. Secure production cookies require an HTTPS `BASE_URL`. The Compose app and sandbox are non-root; the database is private; the owner Mac is not a runtime dependency.

## Configuration reference

All keys below are read from the gitignored server `.env`; `.env.example` contains placeholders. API keys and SMTP passwords belong only in that private environment file.

| Variable | Default / purpose |
| --- | --- |
| `BRAIN_MAX_ACCOUNTS` | `100`; admission cap for new accounts. |
| `BASE_URL` | Public HTTPS origin, without a trailing slash. |
| `PORT` | `3000`, application port inside its container. |
| `HOST_PORT` | `3360`, published on host loopback only. |
| `NODE_ENV` | `production`; `development` is for development-only self-hosting. |
| `POSTGRES_PASSWORD` | Required generated database password. |
| `DATABASE_URL` | Required PostgreSQL URI; must match the database password. |
| `SESSION_SECRET` | Required random session/CSRF signing secret. |
| `TOKEN_PEPPER` | Required random confidential-client secret pepper. |
| `E2E_ENABLED` | `false`; temporarily enables public test-client metadata and its callback. |
| `ANTHROPIC_API_KEY` | Required for AI features; memory and OAuth work without it. |
| `ANTHROPIC_WORKSPACE_ID` | Optional provider workspace selector. |
| `OPENAI_API_KEY` | Optional second-lab nightly auditor. |
| `BRAIN_MODEL_QUICK` | `claude-sonnet-5-5`; quick reasoning and optional call rollups. |
| `BRAIN_MODEL_DEEP` | `claude-opus-5-5`; deep reasoning, jobs, and nightly formulation. |
| `BRAIN_MODEL_AUDITOR` | Optional OpenAI model ID; used with `OPENAI_API_KEY`. |
| `BRAIN_CONTEXT_TOKEN_BUDGET` | `20000`; conservative total memory budget, including project and continuity context. |
| `BRAIN_THINK_TIMEOUT_QUICK_MS` | `8000`; quick reasoning deadline. |
| `BRAIN_THINK_TIMEOUT_DEEP_MS` | `25000`; deep reasoning deadline. |
| `BRAIN_SESSION_IDLE_MIN` | `30`; idle gap that starts a new call session. |
| `BRAIN_IDLE_ROLLUP_MIN` | `10`; quiet gap before an eligible session rollup. |
| `BRAIN_JOB_TOKEN_BUDGET` | `400000`; maximum model-token allowance per job. |
| `BRAIN_DAILY_TOKEN_BUDGET` | `2000000`; per-brain daily allowance, all models combined. |
| `BRAIN_GLOBAL_DAILY_TOKEN_BUDGET` | `4000000`; service-wide daily allowance. |
| `BRAIN_NIGHTLY_HOUR` | `3`; nightly hour in America/Los_Angeles. |
| `BRAIN_NIGHTLY_TOKEN_BUDGET` | `600000`; per-brain nightly allowance, also subject to daily limits. |
| `BRAIN_WORKSPACE_DIR` | `/var/lib/brain/workspaces`; persistent per-user/per-brain workspace root. |
| `BRAIN_SANDBOX_URL` | `unix:///run/brain-sandbox/runner.sock`; isolated code-runner socket. |
| `BRAIN_SMTP_HOST` | Optional SMTP host; email delivery also needs a sender. |
| `BRAIN_SMTP_PORT` | `587`; SMTP port, with TLS required. |
| `BRAIN_SMTP_USER` | Optional SMTP username. |
| `BRAIN_SMTP_PASS` | Optional SMTP password. |
| `BRAIN_SMTP_FROM` | Sender for explicitly requested `brain+email` delivery. |

If SMTP is unavailable, `brain+email` behaves as `brain` and says so in the acknowledgement. Workspace files and model-generated records stay scoped to their owning user and brain.

## Development and checks

For this deployment, all development, dependencies, builds, tests, and runtime stay on **hermes** through SSH, in `/srv/sesame-brain`. The Mac is only an operator/export destination. Follow [AGENTS.md](AGENTS.md).

```sh
docker compose --profile dev run --rm dev npm run migrate
docker compose --profile dev run --rm dev npm run typecheck
docker compose --profile dev run --rm dev npm test
```

These commands use a dedicated temporary test database, separate from production. The migration runner serializes numbered migrations; production migrations run on app startup. See [ARCHITECTURE.md](docs/ARCHITECTURE.md) for runtime details and [VERIFY.md](docs/VERIFY.md) for test and deployment evidence.

Inspect exactly what a model would receive, without spending tokens or acknowledging completed jobs:

```sh
docker compose --profile dev run --rm dev npx tsx scripts/context-pack.ts \
  --user TEST_USER_UUID --brain TEST_BRAIN_UUID --agent maya --budget 20000
```

The command intentionally prints that brain's memory, so run it only for an account you are authorized to inspect. It writes no model output and never marks a job surfaced.

The live HTTP/OAuth/MCP check is `npm run e2e` with `BASE_URL` set to the service and `E2E_ENABLED=true` on the server. It creates disposable accounts and removes them afterward. Turn the flag off after verification. Provider-backed reasoning/job/nightly tests require configured keys and budget; mocked provider tests are identified separately.

## Operations

Production lives at `/srv/sesame-brain` on `hermes`. Host-native Caddy fronts `brain.arxsable.ai` and proxies to `127.0.0.1:3360`. PostgreSQL has no host port. The app uses a read-only root filesystem, bounded logs, explicit resource limits, and no Docker socket. Its isolated sandbox has no network or application secrets.

Redeploy with `/srv/sesame-brain/scripts/deploy.sh`: fast-forward source, create a recovery backup when an app already exists, build revision-tagged images, recreate only this project, and wait for health. GitHub SSH push credentials remain on the trusted Mac. `.previous-image` records the preceding immutable app image for a database-compatible rollback.

`scripts/backup.sh` writes database dumps and private configuration archives under `backups/`, with fourteen-day retention. These recovery archives are separate from retained memory snapshots. Protect configuration archives as secrets. Backups are same-host; no offsite recovery is claimed. Removing live memory does not rewrite an existing archive; an operator can remove retained backups separately when explicitly requested.

Test a restore in a fresh isolated database before replacing production:

```sh
gunzip -c backups/brain-TIMESTAMP.sql.gz | docker compose exec -T db psql -U brain -d NEW_DATABASE
```

The five-minute watchdog restarts only Brain after repeated `/health` failures. `/health` reports database readiness, version and uptime; `/ready` separately reports provider, sandbox, job, nightly and storage health without tenant data. Backups and restore drills are deferred at the owner's request. The Brain backup cron is disabled and deploy does not create backups. Existing archives are preserved; [the future backup design](docs/DEFERRED-BACKUPS.md) is a plan, not an active service.

## Credits
The following is the project owner's supplied credits statement; the human-review statement has not been independently verified by Codex:

> **Built by Oscar G.** ([Arx Sable LLC](https://arxsable.ai), Banning, CA). Spec drafted with Claude, implemented by OpenAI Codex, deployed on a Hetzner box in Helsinki. This is vibecoded software: a human with 22 years of systems engineering read it, ran it, and stands behind the architecture, and an AI wrote most of the lines. Read the code before you trust it with anything you would not want on a public forum. Issues and PRs welcome.
>
> Not affiliated with Sesame AI Inc. "Sesame," "Maya," "Miles," "Simone," and "Charlie" are theirs.

Password blocklist: SecLists common-credentials 10k-most-common.txt (MIT). See src/web/PASSWORD-LIST-SOURCE.md. Protocol references: [MCP authorization 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization), [official TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk), [Sesame's connection guide](https://www.sesame.com/journal/getting-started).

MIT © 2026 Oscar G. / Arx Sable LLC.

Provider API keys and SMTP passwords stay only in the private live environment. No offsite backup or successful v3 restore is claimed.
