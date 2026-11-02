# Deployment acceptance — November 1, 2026 (Los Angeles)

| Check | Result |
|---|---|
| Strict TypeScript typecheck | PASS |
| Unit/integration suite | PASS — 33 tests, 0 failures, 0 skips |
| PKCE, SHA-256 token hashing, audience and redirect checks | PASS |
| CIMD validation, private-address blocking, size and timeout limits | PASS |
| Refresh rotation, replay revocation and client authentication | PASS |
| Every tool with token A against user B, including guessed IDs | PASS — all 15 tools; B unchanged |
| Browser account/CSRF/isolation and signout lifecycle | PASS |
| Full public DCR OAuth/MCP flow | PASS |
| Full public CIMD OAuth/MCP flow | PASS |
| Shared notes/facts/snapshots, handoff lifecycle and activity | PASS |
| Export, two-step deletion, all 12 user-owned tables removed | PASS |
| Official Inspector CLI with real browser OAuth | PASS — loopback callback; all 15 tools |
| Both PRM paths, both AS paths, exact 401 challenge, health | PASS |
| Browser OAuth and MCP CORS | PASS |
| Seven mobile pages at 390px | PASS — no overflow or JavaScript exceptions |
| Known secrets and memory markers absent from application/database logs | PASS |
| Backup file, gzip integrity and isolated restore | PASS — 14 tables; owner restored |
| Backup/watchdog cron and watchdog success path | PASS |
| Real deploy.sh pull/build/recreate/health run | PASS |
| Non-root read-only app, loopback binding, healthy app/database | PASS |
| Shared Caddy fragments and strict Docker publication audit | PASS — 27 fragments preserved; 0 publication violations |
| Temporary E2E endpoints disabled, disposable accounts removed | PASS — both routes 404; only owner remains |
| Sesame phone connection | HUMAN STEP — cannot be completed here |

Production application revision: c5f7ef7bde85. Later evidence/documentation commits do not change runtime code.

[Successful CI](https://github.com/Oscar-G13/sesame-brain/actions/runs/41403424457).

Limits: the actual Sesame phone client is unverified; independent human review and offsite recovery are not claimed. Legacy SSE is omitted because the current core SDK no longer includes that transport. Retained same-host backups expire after 14 days.
