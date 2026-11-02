# Completion audit — Brain 3.1.1

Audited November 2, 2026 against the v2 handoff, Living Projects release contract, the approved full rollout, and the owner's later corrections. Production code revision: 82d009143b47. Source and runtime remain on hermes at /srv/sesame-brain; the Mac is not a runtime dependency.

The owner clarified that the primary outcome is continuity between calls/chats with the same Sesame voice and existing connection. The owner also preserved accounts/credentials and explicitly deferred new backup work while requesting a future design. Those instructions supersede earlier cross-voice onboarding and backup expectations.

## Required v2 verification

| Handoff gate | Authoritative evidence and current coverage |
| --- | --- |
| 1. Bounded context dry-run, oversized input | scripts/context-pack.ts and test/context-sessions.test.ts; current 183-test run includes UTF-8 bounds, CLI output, cache invalidation, source limits across priority groups and aggregate reasoning memory limits in test/engine.test.ts. |
| 2. Real quick think, spoken answer, usage | evidence/v2-live-models.json records 1,189 ms and usage. Current provider/engine/session regressions pass; evidence/v3-public-browser.json retains the actual authenticated public Think result and Brain session proof. |
| 3. Quick timeout, persisted continuation and result | Real 8,016 ms continuation/completion in v2-live-models.json; current engine tests cover partial speech, persisted work and the queue-full refusal without losing the partial answer or bypassing authority. |
| 4. do under one second, job lifecycle | Real acknowledgement 9 ms and completed result in v2-live-models.json; current engine/project/security tests check queued/running/done, result notes/handoffs, audience and artifacts. |
| 5. First-touch briefing and waiting results | Current session/MCP/continuity tests, plus v311-public-continuity.json. Retrieval now restores unchanged saved state without a model; eligible first-touch, explicit reused-session resume, overnight review and successful-only receipts are verified. |
| 6. Idle rollup writes attributed auto snapshot | v2-live-models.json records real idle rollup; current context-sessions tests cover idle claims, empty closure, concurrent activity, revoked grants and no invented summaries. |
| 7. Explicit end_session | Real explicit summary in v2-live-models.json; current tests also close correctly without AI and recover saved state in the next call. |
| 8. Formulation/audit/diff, schema and retries | Real complete 49,759-token cycle in v2-live-models.json. docs/schema/dossier.v1.json and test/nightly.test.ts cover required schema, invalid evidence retry/rejection, chronology, hypotheses, qualitative safeguards, exact 100-word diff, atomic writes, DST and purge. Current continuity tests/public receipt verify saved overnight diff retrieval. |
| 9. Daily budget refusal | Current engine/usage/provider/nightly tests exercise spoken refusal, reservations, global allowance and nightly skipping. Production readiness confirms configured provider access; no new paid request was needed for the deterministic patch. |
| 10. Cross-brain and revoked access | Current accounts-isolation, tools, engine, lifecycle-privacy, memory-evidence, projects-security and continuity suites cover ownership, scopes, source withdrawal, source audiences, nested provenance and grant revocation. |
| 11. Export and purge | Public v2/v3 OAuth receipts exercise exports and exact cleanup across user-owned tables. Current account/web/privacy tests include new collections, project history, session metadata, epoch cancellation and preservation of accounts/connections for memory-only clear. |
| 12. Restart with running job | evidence/v2-restart.json proves the actual restart marked a disposable running job failed and removed the fixture. Current engine tests preserve this behavior; queued work persists. Checkpoint resume was not required. |
| 13. No secrets in source/history | v31-secret-scan.json scans all 440 reachable Git blobs at audit time; v311-secret-scan.json scans the appended candidate source and receipts. No provider/private-key patterns found. Environment remains gitignored, mode 0600; private reports and fingerprint baselines stay ignored. |

The v2 provider receipts are historical live evidence, not claims that paid models were rerun for every patch. Their unchanged provider/orchestration paths have current regression coverage. Changed 3.1.1 context assembly, budget and queue behavior has focused injected-provider verification; deterministic public continuity has fresh production proof.

## Living Projects and user requirements

| Requirement | Evidence |
| --- | --- |
| Persistent goals, constraints, decisions, questions, tasks and artifacts | src/projects/service.ts, test/projects.test.ts, v3-live-models.json and current public continuity receipt. Current constraints take precedence over historical summaries; proposals remain distinguishable. |
| Revision conflicts, retry idempotency, corrections and dependencies | Current project/security tests, real-provider v3 artifact scenario, public v3 browser correction/approval proof, and dense project browser evidence. |
| Evidence history, privacy and relevant retrieval | Current memory-evidence/context/lifecycle/project-security tests. Scope is preserved before a write; successful-delivery counting occurs afterward. Source limits retain receipts for supplied records. |
| Live usable browser, drafts and focus | v311-canvas-draft-browser.json with actual authenticated stale-version 409 plus desktop/mobile previews; v311-public-browser.json proves deployed assets match the tested fixed JavaScript. |
| Sponsored AI approval and user-held recovery | src/auth/access.ts and recovery implementation; auth-access-recovery/web tests verify pending-account refusal, hashed single-use codes, regeneration and session/grant/job invalidation. Public tests use pending accounts without AI usage. |
| Fair jobs and subsystem visibility | Current engine/provider tests cover fairness, per-account concurrency and quotas. v311-deployment.json verifies provider, sandbox, workers and scheduler readiness. |
| Same-voice native call A → B | v31-native-sesame.json records the user's successful $600/next-step retrieval report on 3.1.0, corroborated by new saved-record counts. Current 3.1.1 protocol proof covers the same saved-context path, unchanged records, correction, refresh and idle behavior. No transcript/native-memory synchronization is claimed. |
| Preserve account, credentials, connections and current content | v311-preservation-after-deploy.json and v311-preservation.json: all baseline rows unchanged across 26 tables, including native-test records. Hashes only; no content backup. |
| Isolated Helsinki hosting and operations | AGENTS.md, Compose configuration, v311-deployment.json: hermes, separate sesame-brain project, loopback 3360, no Caddy changes, healthy app/db/sandbox and removed temporary test database. |
| Documentation and delivery | README/credits/vibecoded label preserved, architecture/changelog updated, all 29 input/output contracts validated, source pushed to the existing GitHub repository, release CI 41541324924 succeeded. |

## Explicit deferrals and remaining operating condition

- New backup archives, encryption/offsite setup and restore drills were deferred by the owner. docs/DEFERRED-BACKUPS.md supplies the future plan; no new destination or backup was created. The Brain backup cron is disabled; the watchdog remains enabled.
- The OpenAI auditor and SMTP delivery are optional and require their own configuration. The approved Anthropic fallback audit path has real-provider proof.
- Handoff phase 4's reference-HTML renderer was conditional on an owner-supplied reference, which was not supplied; it is not a required gate.
- Host storage remains above its warning threshold. This is reported honestly by /ready as 503 while functional subsystems are ready. No unrelated shared-server cleanup was performed.

All required rollout gates are satisfied within the approved scope. The record distinguishes user-reported native acceptance, current automated/public verification, historical paid-provider proof and explicitly deferred work.
