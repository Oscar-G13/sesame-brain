# Changelog

## 2.0.0 — 2026-11-02

Released November 2, 2026. Core acceptance passed at 8596c89dd415; presentation-copy revision df719d6f2e64 was then deployed. Production and CI receipts are recorded in docs/VERIFY.md.

### Phase 1 — reasoning and context

Added budgeted longitudinal context, synchronous quick/deep reasoning, token usage and daily reservations, short status trailers, and standing assistant instructions. Context retains agent visibility and stops fetching lower-priority collections when its conservative byte budget is full.

### Phase 2 — background work and sessions

Added persistent jobs, restart recovery, job status/list tools, result notes and handoffs, browser dashboard, per-brain workspace files, optional requested email delivery, and isolated code execution without network access. Added persisted call sessions, first-touch briefings, idle/explicit rollups, and browser-session authorization. Memory-purge epochs, current-grant checks, and scoped cache invalidation prevent delayed work from recreating purged memory. Snapshots are retained until explicitly cleared; the former fifty-snapshot pruning rule was removed.

### Phase 3 — nightly review

Added idempotent Los Angeles nightly scheduling, evidence-labeled formulation validation, an independent auditor pass, and formulation/audit/diff snapshot kinds. Optional OpenAI credentials enable a second model lab. Validation rejects unknown evidence/confidence labels and retries once; limits and provider failures remain visible rather than becoming fabricated results.

## 1.0.0 — 2026-11-01

Initial Brain service: shared notes, task handoffs, facts, snapshots, account controls, OAuth, MCP transport, tenant isolation checks, and Helsinki deployment.
