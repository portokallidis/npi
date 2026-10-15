---
description: Ablate the components of a winning experiment
argument-hint: "<experiment-name> [components…]"
---
#code Run an ablation study for experiment `$1`. Components to ablate (optional, otherwise infer them): ${@:2}

1. Load the experiment (`experiment list`) and its command; identify the components that could explain the gain (or use the ones given).
2. Build the matrix: full model, each component removed (one at a time), and the baseline. Use the SAME seeds for every cell so comparisons are paired.
3. Run each cell with `experiment run` (name cells `$1-no-<component>`), then `experiment compare` each against the full model.
4. Report a table: cell, mean ± sd, Δ vs full with 95% CI, p-value. Flag components whose removal changes nothing (CI includes 0) as non-contributing.
5. Record conclusions in the ledger (decisions) and reject cells that failed with `experiment verdict`.
