# Demos

Runnable use cases against **real models**: your local servers from `.env`, plus any cloud keys you set. Each demo prints what happened and records benchmark numbers.

```bash
npm run demo:quick   # 1–4: routing, small-model jobs, scout subagent, safety policies (~3 min on local models)
npm run demo         # all, including 5 brainstorm and 6 science (tens of minutes on local models)
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

**Benchmarks:** every run writes `.harness/benchmarks/<run>.jsonl` and a Markdown report, also copied to `latest.md`. The report has:
- wall time and quality results per demo;
- per model and device: calls, errors, median and p95 time, time to first token, output and prompt tokens/second, and cost;
- per pipeline stage;
- per agent run.

Merge several runs (e.g. quick demos on one day, slow ones later) into one report:

```bash
npm run bench:report                          # → .harness/benchmarks/combined.md
npm run bench:report -- --last 3 --publish    # also → docs/benchmarks.md
```

Name your machines with `HARNESS_DEVICE_<PROVIDER>=…` in `.env` (reports never show IPs). Set `HARNESS_BENCH_PUBLISH=1` to also refresh [docs/benchmarks.md](../../docs/benchmarks.md).
