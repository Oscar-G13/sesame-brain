# Brain development
The authoritative project is /srv/sesame-brain on Helsinki host hermes. Run all dependency installation, builds, tests, Docker, databases and runtime through SSH on that host. Never start a local app server or depend on the Mac. Verify hostname and cwd before building. Use only Compose project sesame-brain, isolated data and loopback port 3360. Preserve unrelated workloads and shared Caddy routes; coordinate shared changes with both existing Caddy locks. No secrets or private data in Git.

Current agent-facing capabilities and dated release history: [docs/AGENT-CHANGELOG.md](docs/AGENT-CHANGELOG.md). Confirm live tool schemas and configuration before relying on versioned operating limits.
