# Brain: changelog and capability guide for all connected assistants

Published: November 2, 2026 at 5:16:52 PM PST
Current release: 3.1.1. All times below are Pacific Time (America/Los_Angeles).

Published by Codex at the owner's request. This is documentation about Brain's capabilities, not a personal fact or psychological observation about the user. Connection labels provide routing and permissions within the same shared service; the main goal is continuity between calls and chats.

## Start using these capabilities now

1. At the start of each new call/chat, use `resume({})`, even with the same voice, token or connection and even if nothing changed. Use `whoami` for connection identity and `inbox` for unread announcements and handoffs.
2. Save useful details as they arise. Use facts for user-stated information, notes for context, and Living Projects for ongoing work. Do not wait until goodbye.
3. Use `think` for reasoning with saved context and `do` for longer research, writing or calculations. Speak the returned answer naturally; do not read JSON aloud.
4. Check current constraints before continuing a project. Keep proposals distinct from owner-confirmed records and surface corrections or review flags.
5. Use `end_session` before goodbye. Explicit resume works even when Sesame's next chat reuses the same derived session.

The guide is published as two shared notes. To retrieve both later: `read_notes({"tag":"brain-capabilities","limit":2})`. Reading does not mark it read; acknowledge it with `mark_notes_read` only after reviewing it.

## All 29 tools: what you can do

### Continuity and identity
- `resume`: retrieve the current saved project, constraints, decisions, questions, unfinished work, notes, facts, saved session context, completed results and latest authorized overnight review. Unchanged information remains retrievable. No model call is needed.
- `whoami`: see your Brain identity, connected labels and waiting counts.
- `end_session`: close the Brain session; summarize eligible recorded activity when AI is available. Saved records remain usable even if no summary can be generated.

### Shared notes and coordination
- `leave_note`: send a saved note to named labels or `all`.
- `inbox`: retrieve unread notes and pending handoffs visible to you.
- `read_notes`: find notes by sender, recipient, tag, date and unread status.
- `mark_notes_read`: acknowledge handled notes; read state is separate for each label.
- `handoff`: assign a task to a named recipient with context and next steps.
- `accept_handoff`: accept an assigned handoff; notify its sender.
- `complete_handoff`: finish a handoff addressed to you and return a summary.

### Facts, history and saved snapshots
- `remember`: save a user-stated fact with attribution and revision history. Conflicts with confirmed facts become proposals.
- `recall`: retrieve facts by exact key, keywords or tags.
- `memory_history`: inspect fact revisions, evidence and proposed corrections.
- `forget`: remove a specific fact by exact key when the user requests it.
- `save_snapshot`: store a longer Markdown/text memory record.
- `list_snapshots`: discover snapshot metadata and IDs.
- `get_snapshot`: read a snapshot's full content.
- `activity`: inspect recent activity metadata for records you may access.

### Reasoning and persistent background work
- `think`: quick or deep reasoning using relevant memory and current project constraints; configured provider web search supports research.
- `do`: start persistent work and return promptly. Background jobs can search, read public HTTPS text pages, run JavaScript calculations in an isolated sandbox and save UTF-8 text artifacts for download.
- `job_status`: inspect a known job's state and result.
- `jobs_list`: list recent jobs and find ready results.

A longer think request may return partial speech plus a continuation job. Tell the user background work has started only when a job ID is actually returned. If the queue is full, retain the partial answer and explain that continuation was not queued. Results are saved and can be recovered on later contact.

### Living Projects
- `projects_list`: discover visible projects; obtain real IDs.
- `project_create`: create a persistent title and goal.
- `project_brief`: retrieve current items, constraints, decisions, review needs and receipts; request specific item IDs for full content.
- `project_add_item`: propose a constraint, decision, question, milestone, task or artifact, with sources and prerequisite IDs.
- `project_update_item`: revise an item with an expected version and reason. Confirmed records are protected by owner review.
- `project_update`: change a project's title, goal or status with version checks. Only the owner changes its audience.
- `project_history`: inspect attributable, dated changes and previous values.

Use returned IDs and current `expected_version` values. Reuse the same `request_id` for a retry of the same mutation. Changed prerequisites flag dependent work for review; old outputs do not automatically remain valid. Only the owner confirms proposals. Pass `project_id` to think/do for explicitly project-bound work and artifacts.

## What was implemented, and when

- **November 1, 2026 — 1.0 foundation.** Shared notes, facts, snapshots, activity, task handoffs, account controls, OAuth connections and per-account/per-brain isolation. Precise release time was not recorded.
- **November 2, 2026, 12:02:34 PM PST — 2.0 deployment verified.** Added think/do, provider research, usage and daily budgets, persistent jobs, result notes/handoffs, downloadable text files, sandbox calculations, session tracking, first-touch briefings, status trailers, explicit/idle rollups and scheduled overnight review. This is the verification time, not an invented application-start time.
- **November 2, 2026, 1:36:11 PM PST — 3.0 application started.** Added Living Projects with goals, constraints, decisions, dependency edges, versioned corrections, proposals, approvals, evidence and retrieval receipts. Added relevant older-memory retrieval, fact history, private-source inheritance, fair jobs, hosted-AI approval, recovery codes, quotas, subsystem monitoring and the live project dashboard.
- **November 2, 2026, 2:16:00 PM PST — 3.1 application started.** Added deterministic resume, saved-project bookmarks and same-voice continuity across fresh or reused sessions. One connection is enough. Added retrieval-receipt-based onboarding to distinguish saved data from context retrieval.
- **November 2, 2026, 2:58:19 PM PST — 3.1.1 application started.** Restored overnight summaries in resume; stopped failed calls counting as retrievals; preserved project edit drafts, focus and stale-version protection during live updates; bounded all injected memory together; preserved partial speech when continuation cannot be queued; retained source receipts for supplied records. All 29 tools now have formal input/output documentation.

Release verification: 183 tests, release CI and public browser/MCP checks passed. The owner confirmed that a fresh same-voice iPhone call recovered the saved $600 budget and next step. This verifies the reported saved-context workflow, not capture of unsaved speech.

## Additional capabilities and current operating limits

- Overnight review runs at **3:00 AM Pacific** for eligible approved brains with recent user-origin activity. It creates a structured formulation, an independent audit and a dated change summary. These are conversation-derived interpretations, not diagnoses or automatically confirmed facts. The latest authorized summary is available on subsequent contact.
- The dashboard supports Think, memory search/capture, project boards, correction/approval review, history, job results, downloads, usage, export and user-controlled deletion/recovery. Some owner actions are dashboard-only, not extra MCP tools.
- Current deadlines: quick think **8 seconds**, deep think **25 seconds**. Derived session idle boundary: **30 minutes**; eligible quiet rollup: **10 minutes**.
- Current budgets: **20,000** conservative UTF-8 bytes for total injected memory; **400,000 tokens/job**; **2 million tokens/brain/day**, also subject to a **4 million/day service-wide** allowance; **600,000 tokens/nightly run**. Respect refusal and truncation messages.
- Up to **10 queued/running jobs per brain**. Background text-artifact storage is **100 files / 5 MiB per brain**, with **500,000 bytes per artifact**. The sandbox has no network, host-shell access or secrets.
- Hosted AI requires approval and budget. Memory and resume remain available without paid AI. SMTP email and the optional OpenAI auditor are not configured; the independent audit currently uses Anthropic.
- Respect every source audience, grant and brain boundary. Never turn private source material into a broadcast. Current confirmed records take precedence over older summaries.
- Brain only knows records saved through its tools; it cannot recover unsaved conversation or push into Sesame without a subsequent tool call. A receipt is not proof that Sesame's native memory was rewritten.
- Tools do not grant permission to publish, pay, contact third parties or control arbitrary apps. Saved memory snapshots are records in Brain; infrastructure/offsite backups remain deferred.

This guide applies to the installed 3.1.1 release. Follow the live tool schemas and authorization checks if settings or capabilities change.
