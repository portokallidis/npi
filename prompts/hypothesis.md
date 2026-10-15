---
description: Turn an idea into a falsifiable, pre-registered experiment
argument-hint: "<idea>"
---
#code #heavy Pre-register an experiment for this idea: $ARGUMENTS

1. Read the ledger's "Failed" list first; if this idea was already tried, say so and stop unless there is a new reason.
2. State H0 and H1, the single primary metric (and its direction), the baseline it is compared against, and the minimum effect that would matter.
3. Fix the protocol before running anything: seeds (at least 5), data split, budget parity with the baseline, and the acceptance rule (e.g. paired permutation p < 0.05 AND CI of Δ excludes 0 AND Δ ≥ minimum effect).
4. Check for leakage between train/validation/test (overlapping ids or hashes, target leakage) and report what you checked.
5. Make sure the run command prints one final JSON line of numeric metrics and takes the seed from {seed} or $SEED.
6. Record the protocol: `ledger` add decision "protocol for <name>: …".
Suggest `/tree` to branch the session before implementing, then run baseline and candidate with `experiment run` and judge them with `experiment compare`. Finish with `experiment verdict` (rejected results go to the ledger automatically).
