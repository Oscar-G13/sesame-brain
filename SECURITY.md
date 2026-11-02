# Security
Report vulnerabilities privately to oscar@arxsable.ai. Do not include real notes, tokens or passwords in a public issue.

Passwords use Argon2id. Session and OAuth credentials are random, stored as hashes, and expire. Authorization codes require PKCE S256 and exact registered redirects. Refresh tokens rotate; reuse revokes the grant family. Every MCP operation checks its bearer credential and scope. Queries constrain both user and brain, with integration tests exercising every tool and guessed identifiers.

CIMD requests use HTTPS, bounded responses, no redirects, public address validation and a pinned DNS result. Browser forms require CSRF tokens; cookies are Secure, HttpOnly and SameSite=Lax in production. Logs record route templates and status codes, excluding query strings, passwords, bearer credentials and memory content.

One Helsinki host stores the database and private same-host backups. This is not an offsite recovery system. Deleting an account immediately deletes live account data and grants; previously generated backups expire within 14 days. Downloaded exports are under the downloader's control.

No independent security audit or completed human code review is claimed. Sesame's actual mobile client connection is a separate acceptance step. See the deployment report for tested behavior and remaining limits.
