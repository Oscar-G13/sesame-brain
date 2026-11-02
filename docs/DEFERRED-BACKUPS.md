# Deferred recovery design

The owner explicitly deferred all backup work during the v3 rollout. This release creates or uploads no new backup archives, provisions no backup service, and does not gate readiness on backup or restore status. Existing archives are preserved. The automatic pre-deploy backup invocation is removed; the project backup cron is separately disabled as part of deployment.

When backup work is resumed, use a dedicated Brain destination and a project-specific encryption identity. Do not borrow another product's repository, credentials or retention policy. Discovery found no configured Brain offsite target and no user rclone configuration. The shared-host reference describes other products' private backup arrangements; those are not Brain authorization.

The future design should produce one authenticated encrypted bundle covering a consistent PostgreSQL dump, sanitized private configuration, model configuration and workspace artifacts. Provider API keys and delivery passwords remain excluded unless the owner deliberately chooses a separate credential recovery process. The encryption private key must have a user-held recovery copy outside the server; routine backups need only its public recipient.

Before transmission, identify the exact authorized storage account, bucket or SSH host, dedicated prefix, retention policy and costs. Verify encryption locally, then upload only within that scope. No destination has been selected or contacted for this release.

A future recovery drill must restore the encrypted bundle into an isolated temporary PostgreSQL container with no public ports, validate all v3 tables and row content, validate workspace hashes and paths, and remove only that temporary instance. Record a sanitized receipt and an independent offsite download/hash proof. Same-host archive integrity alone is not disaster recovery.

This document is a plan, not a claim that encryption, offsite storage or a new v3 restore drill has been deployed.
