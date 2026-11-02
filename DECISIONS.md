# Decisions

**2026-11-01 — Authoritative host and isolation.** Build, dependency installation, tests, database and runtime run at /srv/sesame-brain on hermes through SSH. The project owns Compose sesame-brain, loopback port 3360 and its PostgreSQL volume; the Mac is only a control and artifact-transfer machine. Existing host Caddy supplies HTTPS through an additive fragment, preserving unrelated routes.

**2026-11-01 — Runtime and SDK.** Node 22, strict TypeScript, Express 5, EJS and plain pg keep the service small. Registry verification found the stable SDK split into @modelcontextprotocol/server and /client 2.4.0 plus /node 2.1.2. The old aggregate SDK remains v1, so use the current packages. OAuth is implemented independently. Zod 4.6.7 avoids the vulnerability reported for older versions; the resolved production dependency audit is clean.

**2026-11-01 — Identity and tokens.** One brain is created with each account. Grant identity is authoritative so renaming and revocation apply immediately. Data queries additionally constrain both user and brain. Credentials are opaque and hashed; CSRF protects browser writes. Read and write scopes are checked on each tool call.

**2026-11-01 — DNS and publication.** Brain has its own DNS-only A record brain.arxsable.ai to 37.27.67.215. There was no wildcard. The authenticated Cloudflare connector created only this record. No tunnel, sibling domain or shared firewall policy is changed. Public repository publication uses the Mac's existing GitHub authentication; the server fetches the public repository without copying a private GitHub key.

**2026-11-01 — Privacy and recovery.** Logs contain route templates and response status, never query strings or memory bodies. Daily compressed SQL and private configuration backups stay on the same host for 14 days; offsite storage is not configured. Live deletion is immediate, while retained backups expire on that schedule. This distinction is disclosed on the privacy page.

**2026-11-01 — Review and compatibility claims.** The supplied credits paragraph is retained as an attributed project-owner statement. Automated verification does not establish a completed human review. Actual Sesame phone connection cannot be exercised from this environment; protocol compatibility is tested with HTTP and independent MCP clients. The report distinguishes these facts.

**2026-11-01 — Transport compatibility.** Streamable HTTP uses the stable v2 per-request stateless handler. Core v2 no longer includes the legacy SSE server transport; it lives in a separately deprecated legacy package, so /sse is omitted under the brief's conditional requirement. GET and DELETE use SDK-defined unsupported-method responses.

**2026-11-01 — Browser and token lifecycle corrections.** Live Chromium verification identified that a global no-referrer policy causes a null Origin on form POSTs, so pages use same-origin referrer policy: same-site forms remain valid and cross-origin OAuth navigation sends no referrer. Node 22's DNS lookup options are handled explicitly for CIMD. User-row locks serialize consent, issuance and account-wide signout; unused authorization codes are removed on password change and signout. Public OAuth endpoints allow browser CORS without credentials. JSON and proxy body limits admit full-size Unicode snapshots.
