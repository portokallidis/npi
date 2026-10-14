# Benchmark report

Run `2026-10-14T16-12-53-926Z` · 2026-10-14T16:12:55.182Z
Client: os: win32 10.0.26200 · cpu: 13th Gen Intel(R) Core(TM) i7-13700H · cores: 20 · memoryGB: 34 · freeMemoryGB: 10 · node: v22.20.0

## Demos
| Demo | Wall time | Model calls (incl. agent turns) | Tokens in / out | Cost | Results |
|---|---|---|---|---|---|
| ✅ scout subagent | 50.4s | 3 | 13,805 / 712 | $0 | model: local/small; turns: 3; summary tokens: 136; found policy.ts: yes |
| ✅ router | 17.9s | 6 | 3,845 / 251 | $0 | accuracy: 8/8; classified: 5; classifier: local/small; median classify s: 2.96 |
| ✅ small-model: digest | 3.90s | 1 | 4,860 / 42 | $0 | model: local/small; tokens in: 5413; tokens to context: 259; kept the failure: yes |
| ✅ small-model: screening | 12.1s | 1 | 709 / 212 | $0 | model: local/small; accuracy: 6/6 |
| ✅ guard | 0.00s | 0 | 0 / 0 | $0 | decisions: 40 |

## Models and devices
| Model | Device | Calls | Errors | Median time | p95 time | Median TTFT | Output tok/s | Prompt tok/s | Thinking calls | Cost |
|---|---|---|---|---|---|---|---|---|---|---|
| lmstudio/qwen/qwen3.5-9b | Mac (LM Studio, MLX 4-bit) | 9 | 0 | 3.01s | 109.4s | 1.50s | 20.1 | 581.4 | 0 | $0 |
| llamacpp/qwen3.8-27b-gsq-rco-iq3_s | Linux GPU server (llama.cpp, Qwen 3.8 27B IQ3) | 1 | 0 | 38.5s | 38.5s | 4.23s | 13.7 | 48.2 | 1 | $0 |

## Pipeline stages
| Demo · stage | Calls | Median time | Total time | Avg tokens in | Avg tokens out |
|---|---|---|---|---|---|
| router · router | 6 | 3.00s | 17.8s | 641 | 42 |
| small-model: digest · digest | 1 | 3.79s | 3.79s | 4,860 | 42 |
| small-model: screening · demo:screen | 1 | 12.1s | 12.1s | 709 | 212 |
| brainstorm · orchestrator:frame | 1 | 38.5s | 38.5s | 749 | 470 |
| brainstorm · panel:local-small | 1 | 109.4s | 109.4s | 999 | 2,010 |

## Agent runs
| Demo | Agent | Model | Device | Time | Turns | Peak context | Tokens in / out | Status |
|---|---|---|---|---|---|---|---|---|
| scout subagent | scout | lmstudio/qwen/qwen3.5-9b | Mac (LM Studio, MLX 4-bit) | 50.3s | 3 | 6,431 | 13,805 / 712 | ✅ |

<sub>Time is wall-clock per call, including queueing and model load on local servers. TTFT is the time to the first streamed token. Output tok/s = output tokens ÷ (time − TTFT); prompt tok/s = input tokens ÷ TTFT (rough prefill speed). Tokens in include cache reads. Devices come from HARNESS_DEVICE_* labels in .env.</sub>
