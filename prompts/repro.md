---
description: Artifact-evaluation style reproducibility audit
argument-hint: "[path]"
---
#plan Audit ${1:-this repository} for reproducibility, the way an artifact-evaluation committee would (Available / Functional / Reproduced). For each item give ok / missing / broken with evidence:

1. Environment: a lockfile (uv.lock, poetry.lock, conda env with pins, package-lock, flake.lock) and the exact runtime versions.
2. One command reproduces the main results (e.g. `reproduce_all.sh` or a Makefile target), with expected runtime and hardware.
3. Randomness: every source of randomness is seeded; results report the seeds and the number of runs.
4. Data: how to obtain every dataset, its license, version/hash, and the exact splits.
5. Results mapping: each table/figure in the paper maps to a script and an output file; check `.npi/experiments.jsonl` for the recorded runs.
6. Metadata: README with usage, LICENSE, CITATION.cff, and archival (Zenodo/Software Heritage) readiness.
List the smallest set of changes that would earn the Reproduced badge, in priority order.
