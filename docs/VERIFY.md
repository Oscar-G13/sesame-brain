# Brain verification

## 3.1.1 — completion audit fixes, live November 2, 2026

Production revision 82d009143b47 is live. The final full suite passed **183/183**, with zero skips, strict TypeScript and build success. [Release CI](https://github.com/Oscar-G13/sesame-brain/actions/runs/41541324924) passed migrations, tests and both images.

The completion audit found and fixed five concrete gaps: missing overnight summaries in continuity, early retrieval counts on failed calls, inner project drafts lost during live updates, aggregate reasoning context exceeding its configured budget, and partial timeout answers lost when the queue was full. Source receipt limits now omit excess records instead of silently dropping their references. All 29 tools have formal input/output documentation; 59 JSON blocks and shared references were validated.

Public 3.1.1 acceptance passed unchanged same-connection recovery, a failed first call recording zero deliveries, a successful resume recording exactly one, a seeded authorized overnight review in first-touch/resume, current confirmed corrections, refresh and idle recovery. Public desktop/mobile checks passed; the served app.js hash matches the fixed source. Actual browser regression also preserved correction/review drafts and focus, retained the stale-version guard, verified a 409 response preserving the submitted draft, and exercised explicit discard. These patch checks made zero provider calls.

The owner confirmed the same-voice iPhone test on 3.1.0: “It recalls $600 and choosing where to go.” Saved-record metadata independently shows new Brain sessions, a project, a note and snapshots. This is user-reported native acceptance with activity corroboration, not direct device inspection. The same core continuity path was regression-tested publicly on 3.1.1.

Hash-only preservation passed across 26 tables before and after final public cleanup, including the newly saved native-test records. Both synthetic public accounts were deleted; the temporary test database was removed. App, database and sandbox are healthy. Provider, workers and scheduler are ready. Overall /ready remains 503 only for the existing host storage advisory; no shared cleanup was performed.

Backup work remains explicitly deferred: active Brain backup cron entries are zero, watchdog entries are one, and no new backups or offsite resources were created. Optional SMTP, an OpenAI auditor and the optional reference-HTML renderer remain conditional features, not required deployment gates.

Receipts: evidence/v311-tests.json, v311-public-continuity.json, v311-public-browser.json, v311-canvas-draft-browser.json, v311-preservation-after-deploy.json, v311-preservation.json, v311-secret-scan.json and v311-deployment.json. Native acceptance: evidence/v31-native-sesame.json. Requirement-by-requirement completion mapping: [COMPLETION-AUDIT.md](COMPLETION-AUDIT.md).

## 3.1 — continuity between calls, live November 2, 2026

Production revision b1b0906c488c, version 3.1.0, is live at https://brain.arxsable.ai. The primary scenario is one existing Sesame connection across separate calls or chats with the same voice. The owner clarified that context loss between conversations, rather than changing assistant identities, is the problem to solve.

| Check | Result |
| --- | --- |
| Regression/build | 172/172 tests passed, zero skips; strict TypeScript and build passed on hermes. [Release CI](https://github.com/Oscar-G13/sesame-brain/actions/runs/41535476769) passed tests, clean migrations and both Docker builds. |
| Public continuity | Actual signup, OAuth DCR/PKCE/consent and 29-tool discovery passed. A fresh client using the same voice/grant recovered unchanged project constraints, open questions and next work without a project ID. Explicit resume within a reused session, current owner corrections, refresh and a 31-minute idle gap passed. |
| Retrieval behavior | Deterministic resume uses no model and works for pending AI accounts. Tests cover own saved snapshots, note-only and think-only material, unchanged state, read-only grants, source restrictions, revoked grants, byte bounds and exact nonempty retrieval counts. Generic reasoning receives the current bookmarked project. An explicit new project can start a fresh scope after ending a private session. |
| Browser | Nine isolated desktop/mobile captures plus the public desktop/mobile check passed. One connection is sufficient, saved data is distinct from a retrieval receipt, and assets use version 3.1.0. No horizontal overflow or browser/server errors in the successful public run. |
| Preservation | Hash-only original-column comparisons across 26 tables passed immediately after migration 0011 and after both public test accounts were deleted. Accounts, credentials, OAuth connections and existing saved content were unchanged. No content backup was created. |
| Deployment | App, PostgreSQL and sandbox are healthy; migrations 0001–0011 applied. Loopback port 3360 remains. Temporary test database removed after checks. Shared Caddy configuration was not changed. |
| Operations | Provider, sandbox, workers and scheduler ready. Overall /ready remains 503 only because host storage exceeds its warning threshold. No shared-server cleanup was performed. |
| Backups | Deferred by the owner; no archives, uploads, offsite resources or restore drills. Future recovery remains documented in DEFERRED-BACKUPS.md. |
| Native Sesame iPhone | Passed by user report on deployed 3.1.0: the same voice in a fresh call recalled the $600 budget and choosing where to go. This is user-reported app acceptance, not direct device inspection or a transcript/native-memory synchronization claim. See evidence/v31-native-sesame.json. |

Evidence: evidence/v31-tests.json, v31-secret-scan.json, v31-public-continuity.json, continuity-public-browser.json, v31-preservation-after-migration.json, v31-preservation.json and v31-deployment.json. Browser evidence is under evidence/continuity-browser/ and evidence/continuity-public-browser/.

Native acceptance uses the existing Brain connection and the same voice. In call A: “Use Brain to save a Weekend Escape project with a $600 budget; our next step is choosing where to go.” End the call, then start a fresh call/chat and ask: “Use Brain to pick up where we left off. What's the budget and next step?” The owner reported success: “It recalls $600 and choosing where to go.” No second connection is required. If the native chat reuses the derived session, explicit resume must still retrieve unchanged saved context.

The 3.0 and v2 results below are historical; the original cross-voice native suggestion is superseded by this same-connection acceptance.

## V3 Living Projects — live November 2, 2026

Production revision 86b4a2ea8962, version 3.0.0, is live at https://brain.arxsable.ai. App, database and sandbox are healthy. All runtime/development work ran on hermes in /srv/sesame-brain.

| Check | Result |
| --- | --- |
| Regression and CI | 147/147 passed, zero skips; strict TypeScript passed. Final asset change passed 12 focused browser-route tests. [Release CI](https://github.com/Oscar-G13/sesame-brain/actions/runs/41529794738) passed. |
| Real provider | Isolated project correction/approval/artifact scenario passed. Public authenticated Think used the real quick model and recorded a real Brain session. |
| Public OAuth/MCP | DCR, PKCE, consent, 28 tools, Maya/Charlie project continuity/history/receipts, pending-AI refusal, refresh reuse, format 3 export and 25-table account cleanup passed. |
| Browser | Isolated dense 16-item, 21-edge project and public desktop/mobile workflows passed. Versioned CSS/JS loaded; no overflow, browser errors or server errors in successful checks. |
| Preservation | Original-column fingerprints across 16 tables passed immediately after migration and after public fixture cleanup, including account, password/session/token rows and saved content. Hashes only; no backup was created. |
| Infrastructure | Same three persistent Brain services; loopback 3360 and existing Caddy hashes unchanged. Three unrelated workload container IDs changed independently during the observation window; no commands targeted those workloads. |
| Operations | Database, provider, sandbox, jobs and scheduler ready. Host disk 86% used (about 123 GB free) raises a visible storage warning and keeps overall /ready degraded. No shared cleanup was performed. |
| Backups | Explicitly deferred by the owner; no new archives, uploads or restore drills. Future design is in DEFERRED-BACKUPS.md. |
| Native Sesame iPhone | Pending user verification in Sesame Inc.'s official iPhone app. No native success or transcript synchronization is claimed. |

Evidence: evidence/v3-tests.json, v3-live-models.json, v3-public-oauth.json, v3-public-browser.json, v3-preservation-after-migration.json, v3-preservation.json and v3-deployment.json. Dense browser evidence is under evidence/living-projects-browser/.

Two public verifier mistakes were corrected without changing the deployed runtime: recovery hashes were wrongly expected in export (they are intentionally omitted), and a test closed an already-open correction disclosure. The successful public browser receipt retains the real Think proof from its first synthetic account and the project/mobile proof from a second memory-only account. Both accounts were independently confirmed deleted.

Historical native suggestion superseded: the owner clarified that calls share infrastructure. The current 3.1 acceptance above uses the same voice and existing connection across calls.

The v2 results below are historical and do not certify v3.

## Historical v2 verification

Verification date: November 2, 2026 (America/Los_Angeles). Runtime and tests execute on hermes in /srv/sesame-brain. The production owner account is never used as a test fixture. Phase 1–3 model timings below are real-provider tests against an isolated test instance; public production acceptance is recorded separately.

## Phase 1 — context, reasoning and budgets

- Context/session isolation, visibility, oversized UTF-8 input, cache invalidation and dry-run CLI: passed.
- Official Models API validated the configured Sonnet 5.5 and Opus 5.5 IDs and server web-search support. This account requires ANTHROPIC_WORKSPACE_ID, stored with the key in the private environment file.
- Real OAuth MCP client using a disposable test brain: quick spoken answer in 1,189 ms; token usage recorded.
- Exhausted daily budget refuses think/do without calling a provider. Concurrent global reservations are bounded and cannot be refunded by purging or deleting an account.
- Scope checks, guessed foreign IDs and mismatched user/brain tuples: passed.
- Working tree and Git object scan: zero provider-secret matches. Environment mode 0600, gitignored.

## Phase 2 — jobs and call lifecycle

- Live do acknowledgement: 9 ms. Persisted job completed, with a result note and shared handoff.
- Live research reached the quick deadline at 8,016 ms including response overhead, returned a continuation job, then completed in the background.
- First-touch live briefing appeared once; subsequent calls omitted it.
- Live end_session and idle sweeper both wrote auto snapshots.
- Interrupted running jobs are marked failed on boot; queued work persists. Recovery runs before the listener accepts requests.
- Purge during generation prevents late facts, notes, job results, usage rows and artifacts from returning.
- Waiting results are acknowledged after successful foreground delivery, never merely because an internal worker assembled context.
- User-requested stop controls are protected by CSRF and user/brain checks.
- Docker sandbox verification: calculation succeeded; outside-file access and child processes were denied; an infinite loop was terminated. The container has no network, host mounts, provider keys, database credentials or Docker socket. Node permission checks are a supplementary boundary.

## Phase 3 — overnight review

- Live formulation, independent audit pass and deterministic diff completed using Anthropic, consuming 49,759 reported tokens for the cycle.
- JSON Schema and semantic validation passed; malformed evidence labels retry once and are rejected on a second failure.
- Cross-lab audit selection is covered by an injected OpenAI provider test; no OpenAI key is configured, so the deployed audit uses a separate Anthropic pass.
- Los Angeles DST, unique daily claims, budget refusal and purge cancellation: passed.
- Scheduler checks during the configured 03:00 hour only. A daytime deployment does not immediately run an overnight review.

## Dashboard and compatibility

- Responsive browser verification: 23 captures at 1440, 390 and 360 pixels, including empty/populated states, search, capture, downloads and reduced motion. No JavaScript errors or horizontal overflow; tested primary text contrast exceeds 7:1 and secondary text exceeds 4.5:1.
- Candidate DCR OAuth: discovery, all 20 tools, two-assistant collaboration, refresh-token reuse revocation, export and deletion across 17 user-owned tables passed.
- Account passwords, sessions, grants and tokens are preserved by content reset. Account deletion remains a separate explicit action.
- Downloads are attachments, tenant/epoch scoped, and reject symlinks and traversal.

## Commands and evidence

Run through SSH on hermes:

```sh
cd /srv/sesame-brain
docker compose -p sesame-brain --profile dev run --rm dev npm run typecheck
docker compose -p sesame-brain --profile dev run --rm dev npm test
docker compose -p sesame-brain --profile dev run --rm dev node --env-file=.env --import tsx scripts/verify-v2-live.ts --nightly
```

The live-model command refuses a non-test database and deletes its disposable account. It makes paid provider requests. Routine tests inject providers and do not require a key.

Evidence: evidence/v2-typecheck.txt, evidence/v2-tests.txt, evidence/v2-final-regressions.txt, evidence/v2-live-models.json, evidence/v2-secret-scan.json, evidence/v2-dashboard-candidate/verification.json. Public production receipts are listed below.

Optional SMTP email and OpenAI audit paths are configured only when their environment values are supplied. The optional reference-HTML dossier renderer was not part of this dashboard release.


## Production acceptance — November 2, 2026

Brain 2.0.0 passed core acceptance at revision 8596c89dd415. Presentation-copy revision df719d6f2e64 was then deployed; app, database, and sandbox were healthy.

| Check | Result and receipt |
| --- | --- |
| Core CI | [Run 41514244897](https://github.com/Oscar-G13/sesame-brain/actions/runs/41514244897): 91 tests passed, zero failed, zero skipped. |
| Final copy CI | [Run 41515238295](https://github.com/Oscar-G13/sesame-brain/actions/runs/41515238295): succeeded. |
| Runtime | All three services registered; prior shared-host entries preserved. See evidence/runtime-registration.json and evidence/v2-deployment.json. |
| Public OAuth/MCP | HTTPS discovery, DCR, PKCE, consent, all 20 tools, collaboration, refresh reuse revocation, export, and deletion across 17 user-owned tables passed. Sanitized output: evidence/v2-public-oauth.txt. |
| Restart recovery | Running disposable job marked failed after restart; fixture deleted. See evidence/v2-restart.json. |
| Existing data | Original rows across 11 checked tables unchanged, including one user, one brain, two browser sessions, one grant, four access tokens, four refresh tokens, one snapshot, and one activity row. See evidence/v2-preservation.json. |
| Public browser | 23 captures passed: no JavaScript/server errors or horizontal overflow; synthetic data only, no owner data accessed, zero provider requests, fixture deleted. See evidence/v2-public-browser/verification.json. |
| Recovery backup | See evidence/v2-backup.json. |

These production receipts are separate from the isolated real-provider model timings above. Three mobile captures were visually reviewed for publication: dashboard-empty-mobile.png, dashboard-with-synthetic-content-mobile.png, and memory-empty-mobile.png under evidence/v2-public-browser/. Desktop captures containing truncated synthetic account identifiers were excluded from the representative selection.
