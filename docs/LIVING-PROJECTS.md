# Brain Living Projects release contract

The authoritative implementation and runtime are /srv/sesame-brain on hermes. This release preserves accounts, passwords, connections and existing content. It implements the full review: correct dashboard reasoning, truthful and private memory derivation, evidence and correction history, relevant retrieval, useful live UI, controlled sponsored AI, user-held recovery, a documented future offsite recovery design, subsystem monitoring and fair jobs.

## Living Projects
A project persists its goal, visibility, constraints, decisions, questions, milestones, tasks and artifacts across real assistant tool calls. Browser changes and jobs update the same project. Every mutation increments a project version and records before/after evidence, actor and reason. Expected-version checks prevent silent overwrites. A request UUID makes retries idempotent.

Source records distinguish user statements, assistant summaries, inferences and tool results. No transcript access or verbatim quote is invented. Model proposals require owner confirmation; a changed prerequisite flags all downstream dependents for review, preserving history. Confirmation clears only the item the owner reviewed. Restricted sources cannot be published into a wider project audience. The project owner can restrict project access; agents cannot expand it.

The browser has a live canvas of real dependency edges, a decision/review queue, readable outputs and timeline/source receipts. Updates must preserve focused controls and drafts. Tool delivery receipts describe what Brain returned, never claim a native Sesame memory was rewritten.

## Acceptance
- Real authenticated browser Think POST returns a model answer, records a Brain session, and does not confuse login identity.
- Nightly eligibility requires new user-origin activity; derived content preserves audience.
- Corrections retain earlier fact/project versions and sources; retrieval finds relevant old records without starving current work.
- Project creation, revision conflict, idempotent retries, dependency invalidation, approval/dispute, source verification, timeline, scoped receipt and live browser update are exercised.
- Cross-brain/account/project access and revoked grants cannot read or mutate project state. Purge cancels late writes and clears derived records/workspaces while preserving accounts.
- Project jobs include the applicable goal/constraints, create versioned artifact results, and flag changed assumptions rather than overwrite reviewed work.
- Sponsored AI is gated for new users; existing authorized owner remains enabled. Recovery codes are one-time and hashed. New backup work is explicitly deferred by the owner; document the future encrypted offsite and isolated-restore design without creating or uploading archives.
- Operational readiness distinguishes database, providers, sandbox and workers; queued work is fair across accounts.
- Actual Sesame conversation acceptance must be recorded separately from protocol/provider/browser tests. If native app access is unavailable, leave this gate incomplete and request the specific missing access.
