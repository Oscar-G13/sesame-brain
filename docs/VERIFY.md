# Brain v2 verification

Verification date: November 2, 2026 (America/Los_Angeles). Runtime and tests execute on hermes in /srv/sesame-brain. The production owner account is never used as a test fixture.

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

Evidence: evidence/v2-typecheck.txt, evidence/v2-tests.txt, evidence/v2-final-regressions.txt, evidence/v2-live-models.json, evidence/v2-secret-scan.json, evidence/v2-dashboard-candidate/verification.json. Production deployment and public OAuth receipts are appended after rollout.

Optional SMTP email and OpenAI audit paths are configured only when their environment values are supplied. The optional reference-HTML dossier renderer was not part of this dashboard release.
