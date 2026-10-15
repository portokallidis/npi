# Benchmark report

Runs: 2026-10-15T21-20-30-085Z, 2026-10-15T22-57-18-286Z · 2026-10-15T21:20:31.380Z
Client: os: win32 10.0.26200 · cpu: 13th Gen Intel(R) Core(TM) i7-13700H · cores: 20 · memoryGB: 34 · freeMemoryGB: 10 · node: v22.20.0

## Demos
| Demo | Wall time | Model calls (incl. agent turns) | Tokens in / out | Cost | Results |
|---|---|---|---|---|---|
| ✅ science | 1753.5s | 12 | 40,646 / 22,499 | $0 | found: 18; screened: 12; included: 3; kappa: 0.80; quotes verified: 2/3; citations supported: 17/34 |
| ✅ brainstorm | 2176.5s | 8 | 18,597 / 31,877 | $0 | panel: local+local-small; orchestrator: local/large; pathways: 6; disputes: 2; resolved: 2; recommended: yes |
| ✅ tier eval: local/small | 224.8s | 52 | 40,632 / 2,790 | $0 | tier accuracy: 25/30; route accuracy: 19/21; light↔heavy: 0; no answer: 0; p50 s: 2.96; p90 s: 2.98 |
| ✅ tier eval: local/large | 256.7s | 52 | 40,632 / 2,794 | $0 | tier accuracy: 30/30; route accuracy: 21/21; light↔heavy: 0; no answer: 0; p50 s: 4.92; p90 s: 4.95 |
| ✅ tier eval: http://127.0.0.1:8090/route | 508.8s | 0 | 0 / 0 | $0 | tier accuracy: 24/30; route accuracy: 19/21; light↔heavy: 0; no answer: 0; p50 s: 9.82; p90 s: 11.19 |
| ✅ review + fix | 260.3s | 12 | 9,249 / 3,034 | $0 | model: local/large; review caught bug: yes; review s: 170.4; fix s: 88.5; tests pass in worktree: yes; main checkout untouched: yes |
| ✅ shootout: local/small | 67.0s | 11 | 9,058 / 803 | $0 | extraction: 16/16 fields; extraction s: 19.3; routing: 6/6; routing s: 37.7; model explained error: yes; error kept (with safety net): yes; digest s: 9.9 |
| ✅ shootout: local/large | 88.0s | 11 | 9,054 / 952 | $0 | extraction: 16/16 fields; extraction s: 25.5; routing: 6/6; routing s: 29.5; model explained error: yes; error kept (with safety net): yes; digest s: 33.0 |
| ✅ scout subagent | 145.7s | 9 | 113,564 / 1,248 | $0 | model: local/small; turns: 9; summary tokens: 299; found policy.ts: yes |
| ✅ parallel subagents | 63.4s | 7 | 22,833 / 1,477 | $0 | wall s: 63.2; sum of runs s: 122.7; speedup: 1.94x; found router.ts: yes; found papers.ts: yes |
| ✅ handoff: local/small | 18.0s | 1 | 409 / 347 | $0 | facts kept: 3/4; transcript tokens: 222; handoff tokens: 349 |
| ✅ handoff: local/large | 60.5s | 1 | 409 / 810 | $0 | facts kept: 4/4; transcript tokens: 222; handoff tokens: 793 |
| ✅ small-model: digest | 2.68s | 1 | 4,905 / 37 | $0 | model: local/small; tokens in: 5413; tokens to context: 283; kept the failure: yes |
| ✅ small-model: screening | 11.3s | 1 | 709 / 198 | $0 | model: local/small; accuracy: 6/6 |
| ✅ guard | 0.00s | 0 | 0 / 0 | $0 | decisions: 40 |
| ✅ router eval: local/small | 11.7s | 4 | 3,105 / 212 | $0 | accuracy: 23/24; classifier accuracy: 2/3; median classify s: 2.89 |
| ✅ router eval: local/large | 16.7s | 4 | 3,105 / 184 | $0 | accuracy: 24/24; classifier accuracy: 3/3; median classify s: 4.79 |
| ✅ router | 11.9s | 4 | 3,109 / 216 | $0 | accuracy: 8/8; classified: 3; classifier: local/small; median classify s: 2.94 |

## Models and devices
| Model | Device | Calls | Errors | Median time | p95 time | Median TTFT | Output tok/s | Prompt tok/s | Thinking calls | Cost |
|---|---|---|---|---|---|---|---|---|---|---|
| llamacpp/qwen3.8-27b-gsq-rco-iq3_s | Linux GPU server (llama.cpp, Qwen 3.8 27B IQ3) | 86 | 0 | 4.95s | 353.8s | 1.66s | 13.6 | 131.9 | 8 | $0 |
| lmstudio/qwen/qwen3.5-9b | Mac (LM Studio, MLX 4-bit) | 76 | 0 | 3.05s | 11.3s | 0.95s | 21.8 | 360.6 | 0 | $0 |

## Pipeline stages
| Demo · stage | Calls | Median time | Total time | Avg tokens in | Avg tokens out |
|---|---|---|---|---|---|
| science · orchestrator:frame | 1 | 105.9s | 105.9s | 712 | 1,417 |
| science · science:protocol | 2 | 178.8s | 216.9s | 722 | 1,448 |
| science · science:screen-b | 1 | 51.4s | 51.4s | 5,212 | 476 |
| science · science:screen-a | 1 | 51.9s | 51.9s | 5,212 | 544 |
| science · science:screen-judge | 1 | 6.39s | 6.39s | 918 | 61 |
| science · science:extract | 3 | 84.2s | 273.7s | 1,506 | 666 |
| science · science:synthesis | 2 | 604.2s | 958.0s | 2,054 | 6,338 |
| science · science:verify | 1 | 254.8s | 254.8s | 18,524 | 2,433 |
| brainstorm · orchestrator:frame | 1 | 112.8s | 112.8s | 749 | 1,522 |
| brainstorm · panel:local | 1 | 184.3s | 184.3s | 1,022 | 2,455 |
| brainstorm · panel:local-small | 1 | 191.2s | 191.2s | 1,022 | 3,584 |
| brainstorm · orchestrator:map | 2 | 622.6s | 877.3s | 5,394 | 5,585 |
| brainstorm · judge | 2 | 382.9s | 513.2s | 806 | 2,574 |
| brainstorm · orchestrator:converge | 1 | 612.1s | 612.1s | 3,405 | 8,000 |
| tier eval: local/small · router | 52 | 2.98s | 224.4s | 781 | 54 |
| tier eval: local/large · router | 52 | 4.93s | 256.5s | 781 | 54 |
| shootout: local/small · shootout:extract | 4 | 4.85s | 19.3s | 396 | 78 |
| shootout: local/small · router | 6 | 6.29s | 37.6s | 781 | 53 |
| shootout: local/small · digest | 1 | 9.88s | 9.88s | 2,787 | 171 |
| shootout: local/large · shootout:extract | 4 | 6.07s | 25.4s | 395 | 78 |
| shootout: local/large · router | 6 | 4.87s | 29.5s | 781 | 54 |
| shootout: local/large · digest | 1 | 33.0s | 33.0s | 2,787 | 320 |
| handoff: local/small · handoff | 1 | 17.9s | 17.9s | 409 | 347 |
| handoff: local/large · handoff | 1 | 60.5s | 60.5s | 409 | 810 |
| small-model: digest · digest | 1 | 2.53s | 2.53s | 4,905 | 37 |
| small-model: screening · demo:screen | 1 | 11.3s | 11.3s | 709 | 198 |
| router eval: local/small · router | 4 | 2.90s | 11.6s | 776 | 53 |
| router eval: local/large · router | 4 | 4.79s | 16.7s | 776 | 46 |
| router · router | 4 | 2.95s | 11.8s | 777 | 54 |

## Agent runs
| Demo | Agent | Model | Device | Time | Turns | Peak context | Tokens in / out | Status |
|---|---|---|---|---|---|---|---|---|
| review + fix | reviewer | llamacpp/qwen3.8-27b-gsq-rco-iq3_s | Linux GPU server (llama.cpp, Qwen 3.8 27B IQ3) | 170.4s | 3 | 4,296 | 4,138 / 2,097 | ✅ |
| review + fix | coder | llamacpp/qwen3.8-27b-gsq-rco-iq3_s | Linux GPU server (llama.cpp, Qwen 3.8 27B IQ3) | 88.5s | 9 | 5,867 | 5,111 / 937 | ✅ |
| scout subagent | scout | lmstudio/qwen/qwen3.5-9b | Mac (LM Studio, MLX 4-bit) | 145.6s | 9 | 19,382 | 113,564 / 1,248 | ✅ |
| parallel subagents | scout (local/small) | lmstudio/qwen/qwen3.5-9b | Mac (LM Studio, MLX 4-bit) | 59.5s | 4 | 6,936 | 17,720 / 844 | ✅ |
| parallel subagents | scout (local/large) | llamacpp/qwen3.8-27b-gsq-rco-iq3_s | Linux GPU server (llama.cpp, Qwen 3.8 27B IQ3) | 63.2s | 3 | 5,380 | 5,113 / 633 | ✅ |

<sub>Time is wall-clock per call, including queueing and model load on local servers. TTFT is the time to the first streamed token. Output tok/s = output tokens ÷ (time − TTFT); prompt tok/s = input tokens ÷ TTFT (rough prefill speed). Tokens in include cache reads. Devices come from NPI_DEVICE_* labels in .env.</sub>
