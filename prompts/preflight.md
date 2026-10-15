---
description: Read-only pre-release audit of the current changes
argument-hint: "[base-branch]"
---
#plan Run a read-only pre-release audit of the changes against ${1:-main} (use `git diff ${1:-main}...HEAD` and `git status`). Delegate the deep review to the reviewer agent if available. Check and report, each with a verdict (ok / risk / blocker) and file:line evidence:

1. Tenant scoping: every new query, cache key, storage path and search namespace is scoped by tenant; any route that loads by id checks ownership (IDOR).
2. Secrets and PII: nothing secret in the diff, logs, error messages or prompts.
3. Migrations: no destructive or locking change in a single step; a rollback path exists.
4. Webhooks/jobs: idempotent, safe under retries and out-of-order delivery.
5. Dependencies: new or upgraded packages and their licenses (flag GPL/AGPL/unknown in proprietary code).
6. Contracts: API/schema changes are reflected in clients, types and docs.
7. Tests: what covers the change, what is untested; run the narrowest test commands that are read-only.
End with a go / no-go and the blockers to fix first.
