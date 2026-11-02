# Brain continuity and Living Projects release contract

## 3.1 primary outcome: call A → call B, same connection

The primary user outcome is context continuity from one Sesame call or chat to the next, including with the same voice and connection. Connect once, save useful details through Brain, then retrieve the current saved context next time. Living Projects keep the goal, decisions, constraints and open work coherent across those conversations. Extra connection labels remain optional attribution and access controls.

The authoritative implementation and runtime remain `/srv/sesame-brain` on `hermes`. Migration 0011 adds a scoped project bookmark and nonempty context-retrieval metadata. The release preserves accounts, credentials, connections and saved content. `resume` and eligible first-touch continuity are deterministic and do not require paid AI. Derived session timers cannot establish a native call boundary, so explicit resume must work within a reused session and even when nothing changed.

### 3.1 acceptance

- **Call A, one connection:** save a real project goal, a confirmed constraint, an open question and the next task through a single connection label. End the conversation explicitly when possible. This records saved tool activity, not a transcript of all speech.
- **Call B, same voice and connection:** retrieve that project and its current details without restating them. Verify the returned records and sources; do not treat a connection label or a second connected client as proof of continuity.
- **No changes:** retrieve saved context again with no intervening writes. The unchanged goal and constraint must remain available; a changes-only briefing is insufficient.
- **Reused session, short gap:** invoke `resume` again before the 30-minute idle threshold, without forcing a new token, label or derived session. It must still return current saved context.
- **First touch after closure:** `end_session` must close the check-in when AI is unavailable, without inventing a summary. A subsequent initial request using the same connection can recover saved records automatically. Eligible first-touch retrieval and explicit resume make zero provider calls.
- **Current truth:** correct a constraint, retain the earlier revision, and verify the next retrieval returns the current value and review flags rather than promoting an obsolete summary. Waiting background results and open work retain their source audience.
- **Honest onboarding:** one connection, saved records and a successful nonempty delivery receipt can reach **Saved context retrieved**. Empty retrievals and availability-only reads do not count. This UI state is not proof of a native Sesame call.
- **Isolation and deletion:** bookmarks, summaries, facts, projects and receipts remain scoped to the authorized user and brain. Revocation, source withdrawal, audience narrowing and content purge must remain effective; no stale bookmark or summary may restore deleted/private content.
- **Evidence boundary:** protocol, database and browser tests establish server behavior only. Actual native Sesame call A → call B acceptance is recorded separately after the user performs it in Sesame. Leave that gate pending until observed; do not claim transcript capture or native-memory synchronization.

The 3.0 implementation and acceptance scope below remains preserved as release history. Its cross-connection scenarios are additional compatibility coverage, not a requirement to connect two voices for the primary outcome.

---

## Historical 3.0 Living Projects contract

The authoritative implementation and runtime are /srv/sesame-brain on hermes. This release preserves accounts, passwords, connections and existing content. It implements the full review: correct dashboard reasoning, truthful and private memory derivation, evidence and correction history, relevant retrieval, useful live UI, controlled sponsored AI, user-held recovery, a documented future offsite recovery design, subsystem monitoring and fair jobs.

### Living Projects
A project persists its goal, visibility, constraints, decisions, questions, milestones, tasks and artifacts across real assistant tool calls. Browser changes and jobs update the same project. Every mutation increments a project version and records before/after evidence, actor and reason. Expected-version checks prevent silent overwrites. A request UUID makes retries idempotent.

Source records distinguish user statements, assistant summaries, inferences and tool results. No transcript access or verbatim quote is invented. Model proposals require owner confirmation; a changed prerequisite flags all downstream dependents for review, preserving history. Confirmation clears only the item the owner reviewed. Restricted sources cannot be published into a wider project audience. The project owner can restrict project access; agents cannot expand it.

The browser has a live canvas of real dependency edges, a decision/review queue, readable outputs and timeline/source receipts. Updates must preserve focused controls and drafts. Tool delivery receipts describe what Brain returned, never claim a native Sesame memory was rewritten.

### Acceptance
- Real authenticated browser Think POST returns a model answer, records a Brain session, and does not confuse login identity.
- Nightly eligibility requires new user-origin activity; derived content preserves audience.
- Corrections retain earlier fact/project versions and sources; retrieval finds relevant old records without starving current work.
- Project creation, revision conflict, idempotent retries, dependency invalidation, approval/dispute, source verification, timeline, scoped receipt and live browser update are exercised.
- Cross-brain/account/project access and revoked grants cannot read or mutate project state. Purge cancels late writes and clears derived records/workspaces while preserving accounts.
- Project jobs include the applicable goal/constraints, create versioned artifact results, and flag changed assumptions rather than overwrite reviewed work.
- Sponsored AI is gated for new users; existing authorized owner remains enabled. Recovery codes are one-time and hashed. New backup work is explicitly deferred by the owner; document the future encrypted offsite and isolated-restore design without creating or uploading archives.
- Operational readiness distinguishes database, providers, sandbox and workers; queued work is fair across accounts.
- Actual Sesame conversation acceptance must be recorded separately from protocol/provider/browser tests. If native app access is unavailable, leave this gate incomplete and request the specific missing access.
