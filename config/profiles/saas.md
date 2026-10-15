## Profile: saas (production discipline)
- Multi-tenancy: every query, cache key, file path and vector/search namespace is scoped by tenant; flag any that is not (IDOR risk).
- Schema changes follow expand → migrate → contract; never a destructive change (DROP, NOT NULL on a live column, blocking lock) in one step.
- Webhooks and background jobs are idempotent and tolerate out-of-order and duplicate delivery.
- No secrets or PII in logs, errors, analytics or prompts; logs are structured.
- Think in unit economics: note the cost per request of any new LLM or infra call.
- Keep API contracts (OpenAPI/types) and clients in sync in the same change.
