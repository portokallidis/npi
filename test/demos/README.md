# Demos

Runnable use cases against **real models**: your local servers from `.env`, plus any cloud keys you set. Each demo prints what happened and records benchmark numbers.

```bash
npm run demo:quick   # the quick ones: 1–4, 7, 8, 10, 11 (minutes on local models)
npm run demo         # everything, including 5 brainstorm, 6 science and 9 review + fix (tens of minutes)
```

| # | Demo | Shows | Needs |
|---|---|---|---|
| 1 | Routing | Keywords first, then the small model classifies everything else; accuracy and latency | `local/small` (or any classifier model) |
| 2a | Tool-output digest | The small model squeezes a ~5k-token log into a few hundred tokens and keeps the buried failure | `local/small` |
| 2b | Paper screening | The small model triages 6 abstracts against a protocol | a local screener |
| 3 | Scout subagent | A real pi session explores this repo read-only and returns only a summary; the full trace goes to an artifact | any scout model |
| 4 | Safety policies | What readonly / ask / auto (± sandbox) do with typical tool calls | nothing |
| 5 | Brainstorm | Two or more models propose pathways; disputes are settled; pathways are ranked | 2+ panel models |
| 6 | Science | Live OpenAlex and PubMed search, dual screening with κ, extraction, GRADE, citation checks | 2 screeners + 1 large model |
| 7 | Model shootout | The same jobs on each local model (structured extraction, routing, log digest), with accuracy and speed side by side | `local/small`, `local/large` |
| 8 | Parallel subagents | Two scouts at once on two devices via `delegate`; wall time vs. the sum of both runs | both local models |
| 9 | Review + fix | Throwaway repo with a buggy commit. The reviewer finds it, the coder fixes it in its own worktree, the tests pass there, and the main checkout is untouched | a local model that can edit code |
| 10 | Handoff | A messy session condensed into a self-contained prompt (decisions, files, next task) | either local model |
| 11 | Router eval | The full labelled set (24 prompts) routed end to end with each local model as the classifier | either local model |

**Benchmarks:** every run writes `.npi/benchmarks/<run>.jsonl` and a Markdown report, also copied to `latest.md`. The report has:
- wall time and quality results per demo;
- per model and device: calls, errors, median and p95 time, time to first token, output and prompt tokens/second, and cost;
- per pipeline stage;
- per agent run.

Merge several runs (e.g. quick demos on one day, slow ones later) into one report:

```bash
npm run bench:report                          # → .npi/benchmarks/combined.md
npm run bench:report -- --last 3 --publish    # also → docs/benchmarks.md
```

Name your machines with `NPI_DEVICE_<PROVIDER>=…` in `.env` (reports never show IPs). Set `NPI_BENCH_PUBLISH=1` to also refresh [docs/benchmarks.md](../../docs/benchmarks.md).
