# V3 Living Projects acceptance

All builds, runtime and tests execute on hermes in `/srv/sesame-brain`. The historical v2 results below do not certify v3. Synthetic fixtures preserve owner content. Backups and restore drills are deferred by the owner.

- Final full regression suite: 145/145 passed, zero skipped; strict TypeScript check passed. Receipt: evidence/v3-tests.json.
- Browser: populated outcome dashboard and project graph, all six types, desktop and iPhone widths, authenticated Think POST, complete job-result rendering.
- Real Anthropic project acceptance passed; see evidence/v3-live-models.json. Public OAuth/MCP acceptance is recorded separately after deployment.
- Native Sesame: pending user verification in the official Sesame Inc. iPhone app. Protocol/provider/browser tests do not substitute for this gate.

# Brain v2 verification

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
