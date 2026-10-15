---
description: Feature spec with data model, API contract, tenant risks and unit economics
argument-hint: "<feature>"
---
#code #heavy Write a product spec for: $ARGUMENTS

Ask me up to 3 clarifying questions first if the goal, user or success metric is unclear. Then write `docs/prd/<feature-slug>.md` with:
1. Problem, target user, success metric, non-goals.
2. User flows (happy path and the main failure paths).
3. Data model changes (tables/fields, ownership by tenant) as an expand → migrate → contract sequence.
4. API contract (endpoints or functions, request/response shapes, errors, idempotency keys).
5. Tenant isolation and abuse risks (IDOR, quota abuse, PII exposure) and how each is prevented and tested.
6. Unit economics: cost per request/action of every LLM or infra call (use model prices and `/stats` numbers where available), the price tier it fits in, and the margin.
7. Thin vertical slices, each shippable and testable on its own, in order.
Record the key decisions and any open questions with the `ledger` tool.
