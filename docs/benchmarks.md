# Benchmark report

Runs: 2026-10-14T16-07-42-814Z, 2026-10-14T16-12-53-926Z, 2026-10-14T16-21-07-989Z, 2026-10-14T16-51-16-480Z, 2026-10-14T17-40-56-820Z, 2026-10-15T19-02-41-972Z, 2026-10-15T19-16-26-637Z, 2026-10-15T19 · 2026-10-14T16:07:44.491Z
Client: os: win32 10.0.26200 · cpu: 13th Gen Intel(R) Core(TM) i7-13700H · cores: 20 · memoryGB: 34 · freeMemoryGB: 8 · node: v22.20.0

## Demos
| Demo | Wall time | Model calls (incl. agent turns) | Tokens in / out | Cost | Results |
|---|---|---|---|---|---|
| ✅ scout subagent | 50.4s | 3 | 13,805 / 712 | $0 | model: local/small; turns: 3; summary tokens: 136; found policy.ts: yes |
| ✅ router | 17.9s | 6 | 3,845 / 251 | $0 | accuracy: 8/8; classified: 5; classifier: local/small; median classify s: 2.96 |
| ✅ guard | 0.00s | 0 | 0 / 0 | $0 | decisions: 40 |
| ✅ science | 1157.3s | 9 | 26,178 / 14,518 | $0 | found: 30; screened: 12; included: 2; kappa: 0.18; quotes verified: 2/2; citations supported: 5/19 |
| ✅ brainstorm | 876.4s | 4 | 6,519 / 11,474 | $0 | panel: local+local-alt1; orchestrator: local/large; pathways: 5; disputes: 2; resolved: 2; recommended: yes |
| ✅ review + fix | 258.1s | 11 | 9,316 / 3,032 | $0 | model: local/large; review caught bug: yes; review s: 171.0; fix s: 86.5; tests pass in worktree: yes; main checkout untouched: yes |
| ✅ handoff: local/small | 21.9s | 1 | 409 / 408 | $0 | facts kept: 3/4; transcript tokens: 222; handoff tokens: 443 |
| ✅ handoff: local/large | 47.3s | 1 | 409 / 627 | $0 | facts kept: 4/4; transcript tokens: 222; handoff tokens: 632 |
| ✅ parallel subagents | 84.2s | 8 | 33,944 / 1,509 | $0 | wall s: 84.1; sum of runs s: 144.7; speedup: 1.72x; found router.ts: yes; found papers.ts: yes |
| ✅ router eval: local/small | 17.8s | 6 | 3,837 / 252 | $0 | accuracy: 24/24; classifier accuracy: 5/5; median classify s: 2.99 |
| ✅ router eval: local/large | 23.9s | 6 | 3,837 / 251 | $0 | accuracy: 24/24; classifier accuracy: 5/5; median classify s: 4.01 |
| ✅ shootout: local/small | 58.7s | 11 | 8,230 / 749 | $0 | extraction: 16/16 fields; extraction s: 19.3; routing: 6/6; routing s: 17.7; model explained error: yes; error kept (with safety net): yes; digest s: 21.6 |
| ✅ shootout: local/large | 102.0s | 11 | 8,226 / 1,167 | $0 | extraction: 16/16 fields; extraction s: 24.5; routing: 6/6; routing s: 24.2; model explained error: yes; error kept (with safety net): yes; digest s: 53.3 |
| ✅ small-model: digest | 25.5s | 1 | 4,905 / 64 | $0 | model: local/small; tokens in: 5413; tokens to context: 306; kept the failure: yes |
| ✅ small-model: screening | 13.8s | 1 | 709 / 203 | $0 | model: local/small; accuracy: 6/6 |

## Models and devices
| Model | Device | Calls | Errors | Median time | p95 time | Median TTFT | Output tok/s | Prompt tok/s | Thinking calls | Cost |
|---|---|---|---|---|---|---|---|---|---|---|
| lmstudio/qwen/qwen3.5-9b | Mac (LM Studio, MLX 4-bit) | 27 | 0 | 3.01s | 21.8s | 1.49s | 23.6 | 326.8 | 0 | $0 |
| llamacpp/qwen3.8-27b-gsq-rco-iq3_s | Linux GPU server (llama.cpp, Qwen 3.8 27B IQ3) | 32 | 0 | 24.6s | 581.2s | 1.83s | 13.6 | 145.0 | 5 | $0 |

## Pipeline stages
| Demo · stage | Calls | Median time | Total time | Avg tokens in | Avg tokens out |
|---|---|---|---|---|---|
| router · router | 6 | 3.00s | 17.8s | 641 | 42 |
| science · orchestrator:frame | 1 | 57.2s | 57.2s | 712 | 770 |
| science · science:protocol | 1 | 208.6s | 208.6s | 704 | 2,803 |
| science · science:screen-b | 1 | 48.3s | 48.3s | 5,431 | 439 |
| science · science:screen-a | 1 | 102.8s | 102.8s | 5,417 | 519 |
| science · science:screen-judge | 1 | 24.6s | 24.6s | 3,193 | 214 |
| science · science:extract | 2 | 81.0s | 120.0s | 1,502 | 512 |
| science · science:synthesis | 1 | 586.2s | 586.2s | 1,686 | 7,777 |
| science · science:verify | 1 | 91.8s | 91.8s | 6,032 | 973 |
| brainstorm · cross-exam:local | 1 | 35.9s | 35.9s | 721 | 474 |
| brainstorm · cross-exam:local-alt1 | 1 | 81.1s | 81.1s | 719 | 600 |
| brainstorm · judge | 1 | 212.1s | 212.1s | 2,274 | 2,766 |
| brainstorm · orchestrator:converge | 1 | 581.2s | 581.2s | 2,805 | 7,634 |
| handoff: local/small · handoff | 1 | 21.8s | 21.8s | 409 | 408 |
| handoff: local/large · handoff | 1 | 47.3s | 47.3s | 409 | 627 |
| router eval: local/small · router | 6 | 2.99s | 17.7s | 640 | 42 |
| router eval: local/large · router | 6 | 4.01s | 23.9s | 640 | 42 |
| shootout: local/small · shootout:extract | 4 | 4.86s | 19.3s | 396 | 79 |
| shootout: local/small · router | 6 | 3.00s | 17.6s | 643 | 42 |
| shootout: local/small · digest | 1 | 21.6s | 21.6s | 2,787 | 183 |
| shootout: local/large · shootout:extract | 4 | 6.09s | 24.4s | 395 | 79 |
| shootout: local/large · router | 6 | 4.04s | 24.2s | 643 | 42 |
| shootout: local/large · digest | 1 | 53.3s | 53.3s | 2,787 | 600 |
| small-model: digest · digest | 1 | 25.4s | 25.4s | 4,905 | 64 |
| small-model: screening · demo:screen | 1 | 13.8s | 13.8s | 709 | 203 |
| session · digest | 2 | 47.7s | 55.6s | 2,748 | 338 |

## Agent runs
| Demo | Agent | Model | Device | Time | Turns | Peak context | Tokens in / out | Status |
|---|---|---|---|---|---|---|---|---|
| scout subagent | scout | lmstudio/qwen/qwen3.5-9b | Mac (LM Studio, MLX 4-bit) | 50.3s | 3 | 6,431 | 13,805 / 712 | ✅ |
| review + fix | reviewer | llamacpp/qwen3.8-27b-gsq-rco-iq3_s | Linux GPU server (llama.cpp, Qwen 3.8 27B IQ3) | 171.0s | 5 | 4,807 | 4,228 / 2,111 | ✅ |
| review + fix | coder | llamacpp/qwen3.8-27b-gsq-rco-iq3_s | Linux GPU server (llama.cpp, Qwen 3.8 27B IQ3) | 86.5s | 6 | 5,718 | 5,088 / 921 | ✅ |
| parallel subagents | scout (local/large) | llamacpp/qwen3.8-27b-gsq-rco-iq3_s | Linux GPU server (llama.cpp, Qwen 3.8 27B IQ3) | 60.6s | 3 | 4,962 | 4,803 / 591 | ✅ |
| parallel subagents | scout (local/small) | lmstudio/qwen/qwen3.5-9b | Mac (LM Studio, MLX 4-bit) | 84.1s | 5 | 8,208 | 29,141 / 918 | ✅ |

<sub>Time is wall-clock per call, including queueing and model load on local servers. TTFT is the time to the first streamed token. Output tok/s = output tokens ÷ (time − TTFT); prompt tok/s = input tokens ÷ TTFT (rough prefill speed). Tokens in include cache reads. Devices come from NPI_DEVICE_* labels in .env.</sub>
