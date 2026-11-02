# V3 isolated live acceptance

The authoritative checkout is /srv/sesame-brain on hermes. Run all commands there through SSH. Serialize tests and synthetic verification with .test.lock.

On November 2, 2026, scripts/verify-v3-live.ts passed against the isolated testdb/brain_test database using the configured Anthropic account. Both configured models were available. One Opus generation used 4,452 input tokens and 54 output tokens.

The scenario exercised actual MCP connections labeled Maya and Charlie plus an authenticated owner browser session: project creation; owner-confirmed constraint; assistant-proposed correction without overwriting the confirmed value; owner approval; dependent task review flag; project-aware background work; proposed artifact with source/dependency links; restricted output audience; and current-version retrieval receipts for both assistants. The generated draft contained 23 words within the confirmed 30-word limit. The disposable account, associated rows and workspace were deleted.

The safe receipt is evidence/v3-live-models.json. It includes no credentials, synthetic content or fixture account identifiers. No production account or owner content was read. No backup, upload or restore was performed.

## Repeat the isolated paid scenario

This command authorizes real provider use. The script refuses any database other than testdb/brain_test and requires NODE_ENV=test and --confirm-paid. The development container supplies those database settings; Node's env-file loading preserves the existing development DATABASE_URL override.

    cd /srv/sesame-brain
    flock -w 120 .test.lock docker compose -p sesame-brain --profile dev run --rm dev node --env-file=.env --import tsx scripts/verify-v3-live.ts --confirm-paid

The public OAuth script remains a distinct postdeployment check:

    E2E_REGISTRATION_METHOD=dcr npm run e2e

Run that script on the remote host using the project runtime, with the intended BASE_URL and optional local database access for cascade verification. It uses public signup and synthetic data, asserts the exact 28-tool list and format3 export, checks pending-account refusals through MCP and HTTP403 browser responses, exercises free project continuity/history across Maya and Charlie, and deletes the account. Database access adds deletion verification across 22 tables with user_id, users, and the two grant-owned token tables: 25 tables total. It never approves sponsored AI or requests paid generations.

## Remaining native and operational checks

The official Sesame Inc. iPhone app must still be tested separately. MCP retrieval receipts show what Brain returned through its tools; they do not prove native assistant memory was rewritten or that unseen Sesame transcripts were synchronized.

Nightly scheduling currently runs only during the configured Los Angeles 03:00 hour. An outage spanning that hour does not automatically catch up during the day. Readiness reports missing eligible overnight runs and scheduler failures; an operator must inspect them. Generated project artifacts and other derived-only activity do not keep a brain eligible for another overnight run.

Backups and restore drills remain deferred by the owner's instruction. Existing archives are preserved, the Brain backup cron is commented, and future encrypted offsite recovery is planned in docs/DEFERRED-BACKUPS.md.
