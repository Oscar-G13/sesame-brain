# Changelog

Agent-facing guide: [all current capabilities and dated release history](docs/AGENT-CHANGELOG.md).

## 3.1.1 — 2026-11-02 — final acceptance fixes

- Restored saved overnight review summaries to first-touch and explicit resume, with provenance checks and historical labels.
- Record saved-context delivery only after a tool succeeds; failed calls cannot complete onboarding.
- Preserve item correction/review drafts and focus during live project updates, including stale-version protection and an explicit discard action.
- Bound the complete reasoning memory, including projects and continuity, under the configured conservative UTF-8 budget.
- Preserve partial spoken reasoning when the background queue is full, with an honest notice that continuation was not queued.
- Completed formal input/output documentation for all 29 MCP tools.

## 3.1.0 — 2026-11-02 — context between conversations

- Centered the home page, guide, dashboard and projects on saving context in one Sesame conversation and resuming it in the next with the same voice and connection. Additional connections are optional.
- Added deterministic `resume` retrieval and automatic eligible first-touch continuity, including unchanged records and explicit retrieval within a reused session. These paths require no sponsored AI or provider call.
- Migration 0011 adds a scoped last-project bookmark and nonempty retrieval count/timestamp. Onboarding recognizes one connection plus saved-context delivery, with no claim that a native call was verified.
- Explicit session closure works when AI summaries are unavailable; saved records remain available and no summary is fabricated.
- Preserved current evidence, revision history, source audiences, account/grant authorization and purge boundaries. The native Sesame call A → call B check remains separate from protocol and browser verification.

## 3.0.0 — Living Projects

- Versioned cross-assistant projects with sources, reviewable corrections, dependency review and retrieval receipts.
- Private-source inheritance, fact history, relevant older-memory retrieval and project-aware nightly review without self-trigger loops.
- Fixed dashboard reasoning; readable nightly insights, live project views and full task results.
- Hosted-AI approval, one-time recovery, content quotas, fair workers and subsystem readiness.
- Backup work deferred by the owner; existing archives preserved and future recovery documented.


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
