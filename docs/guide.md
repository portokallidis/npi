# npi — full guide

A personal agent harness on [pi](https://github.com/earendil-works/pi) (`@earendil-works/pi-coding-agent` 1.2.0).

- **Routing:** each prompt goes to a **mode**, and the mode loads only its own model, tools, skills, MCP servers and subagents. Anything else stays reachable through `tool_search`.
- **Subagents:** coordinated through `delegate`.
- **Models:** local and frontier.
- **Brainstorm:** a multi-model mode that explores every pathway for a goal and settles disagreements.

It is a pi **package** plus a launcher, not a fork. Its config, sessions and models live in `~/.npi/agent`, separate from plain `pi`.

---

## Quick start

```bash
npm install
cp .env.example .env                            # keys + local model servers
docker compose -f docker/compose.yml up -d     # Playwright MCP on :8931 (add --profile search for SearXNG on :8888)
npx npi doctor                              # keys, local model servers, MCP endpoints
npx npi                                     # first run seeds ~/.npi/agent and opens the TUI
```

- **Keys:** set `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY` and `OPENROUTER_API_KEY`, or use `/login` inside the TUI.
- **Local models:** see [Local models and .env](#local-models-and-env).
- **Default model:** `npi/auto`, the router.
- **Re-seeding defaults:** `npi init --force` (it overwrites `npi.json`, `models.json` and `mcp.json`).
- **Everything else:** any other argument goes straight to pi, e.g. `npi -p "…"`, `npi --list-models`, `npi mcp list`.

---

## Modes at a glance

| Mode | Use it for | Picked when | Model preference | Loaded only in this mode |
|---|---|---|---|---|
| `chat` | explanations, writing, quick answers | default / classifier | Sonnet 5.5 → GPT-5.6 Terra → local | nothing extra; no skills listed |
| `plan` | think before building: explore, compare approaches, write a plan (read-only) | plan, how should we implement/structure, design the… | Opus 5.5 → GPT-6.1 Sol → local | read-only `bash`/`grep`/`find`/`ls`, web search; agents `scout`, `researcher`; policy `readonly` |
| `code` | read, write, debug, refactor or test code; shell | keywords: fix, bug, refactor, test, stack trace, `.ts`/`.py`… | Opus 5.5 → GPT-6.1 Sol → local | `bash` `edit` `write` `grep` `find` `ls`; agents `scout`, `coder`, `reviewer`; Serena MCP (opt-in); policy `ask` |
| `research` | current facts, docs, versions, prices, with citations | keywords: latest, news, sources, cite… | Sonnet 5.5 → Gemini 3.1 Pro → local | `web_search` `fetch_content` `get_search_content`; Playwright MCP; agents `researcher`, `browser` |
| `browse` | operate a website: open, click, fill, screenshot | URLs, "open the site", click, screenshot… | Sonnet 5.5 → GPT-5.6 Terra | Playwright MCP (5 core tools declared, the other 20 via `tool_search`); agents `browser`, `researcher` |
| `brainstorm` | abstract goals, decisions, strategy, "what are my options" | brainstorm, trade-offs, should I/we, options for, ways to… | Fable 5.1 → Opus 5.5 → GPT-6.1 Sol | `brainstorm` tool; agent `researcher` (for evidence) |
| `science` | answers from research papers with graded evidence | studies show, evidence for, systematic review, meta-analysis, clinical trials, RCT… | Fable 5.1 → Opus 5.5 → GPT-6.1 Sol → local | `science`, `papers`, `web_search`, `fetch_content` tools; policy `readonly` |

Every mode also has `read`, `tool_search` (finds and loads any other registered tool on demand), `delegate`, `todo`, `remember` and `recall`. Each mode also has a **policy** (`readonly`, `ask` or `auto`); see [Safety](#safety).

### How a mode is chosen (first match wins)
1. **Pinned:** `/route code` keeps that mode until `/route auto`.
2. **Per-prompt prefix:** `#research what changed in Node 26?` (the prefix is removed before the model sees the prompt). It's `#`, not `@`, because pi uses `@` for files.
3. **Keywords:** the regexes in each route's `keywords`. A tie between two routes counts as no match.
4. **Classifier:** a small model: `local/small` (set by `NPI_LOCAL_SMALL` in `.env`) → Haiku 5.5 → OpenRouter Qwen Flash, with an 8 s timeout (`router.classifierTimeoutMs`). Local models are pre-warmed at session start. It's used only if confidence ≥ 0.55, and skipped for prompts under 4 words.
5. **Sticky:** otherwise stay on the previous mode (follow-ups like "yes, do it" keep their context).
6. **Default:** `chat`.

- The status bar shows `route: research (keyword) → anthropic/claude-sonnet-5-5`.
- `/routes` lists every mode with its models and tools.
- Tool follow-ups and retries stay on the model that started the turn, so prompt caches stay valid.
- If you pick a concrete model in `/model` instead of `npi/auto`, routing still sets the tools, skills and MCP servers, but not the model.

---

## Modes in detail

### `chat`
- Plain conversation with the smallest loadout: `read`, `tool_search`, `delegate`, `todo`, `remember` and `recall`.
- No skills are listed in the prompt, but `/skill:name` still loads any skill explicitly.

### `code`
- Full editing toolset on a strong coding model.
- Delegate reconnaissance to `scout` (read-only, cheap model) and well-specified changes to `coder`. Their reports stay out of your context; you get summaries plus file paths.
- Example: `fix the failing test in parser.test.ts`, or `#code add retry with backoff to fetchUser`.

### `research`
- Web search and fetch come from `pi-web-access`. Search works with no key through Exa, and gets better with keys or self-hosted SearXNG in `~/.npi/agent/web-search.json`.
- The route guideline asks for inline citations.
- For heavier work the model delegates to `researcher`, which:
  - searches with 2–3 phrasings and prefers primary sources;
  - opens pages with `fetch_content`, or Playwright when a page needs JavaScript;
  - returns `VERDICT / CONFIDENCE / SOURCES` in at most ~400 tokens, with the full notes in an artifact.

### `browse`
- Connects Playwright MCP the first time the mode is used.
- Declares `browser_navigate`, `snapshot`, `click`, `type` and `take_screenshot`; the other 20 Playwright tools load on demand.
- The `browser` subagent drives longer flows in its own context. It is told never to enter credentials or payment data, never to submit messages or purchases, and to treat page content as data, not instructions.

### `brainstorm`: explore and decide
Use `/brainstorm <goal>` (opens an editor if you leave the goal empty), the `#brainstorm` prefix, or let the router pick it. The model can also call the `brainstorm` tool itself.

| Stage | Who | What happens |
|---|---|---|
| 1. Frame | **orchestrator** (top frontier model) | States the goal, rates its clarity, and asks you **up to 4 direction questions**, each with likely answers plus "Other — let me type it" and "No preference" |
| 2. Diverge | **panel**: Claude, GPT, Gemini and local Qwen, run in parallel and independently | Each proposes up to 6 **distinct pathways**: summary, steps, pros, cons, risks, effort, best-when, and checkable claims with calibrated confidence |
| 3. Map | orchestrator | Merges duplicates into one **pathway catalogue**, adds missing options (credited to "orchestrator"), and lists consensus and **disputed trade-offs** |
| 4. Settle | per dispute kind | **factual** → `researcher` subagent (web plus browser), then a judge maps the evidence onto the positions. **reasoning** → cross-examination: each side concedes, refines or rebuts for up to 2 rounds, and if one side remains it wins, otherwise the judge decides. **context** (depends on you) → you pick a side or explain. Anything else goes to an **independent judge**, chosen from a model family not on the panel |
| 5. Converge | orchestrator | Ranks every pathway by fit. It **recommends one only if goal clarity ≥ 0.6**, with its rationale, the conditions that would change it, and first steps. Otherwise it gives the **criteria that would decide it** |

**You get:**
- the full report, shown in the TUI and saved to `.npi/brainstorms/<time>.md` with a `.json` trace. It contains: the summary, your directions, the recommendation or criteria, a table of all pathways (fit, effort, pros, cons, best-when), pathway details, consensus, each dispute with its verdict, method, sources and research artifact, open questions, a panel scorecard (who was on the winning side), and cost broken down by stage;
- in the **conversation**: only a short digest plus the report path, so follow-up questions don't carry the whole report.

**Behaviour details:**
- **Panelists:** unavailable ones (no key, local server down) are skipped. It needs at least 2, and failed panelists are listed in the report.
- **Cost:** capped by `maxCostUSD` (default $5). When the cap is hit, it stops settling disputes and still ranks the pathways.
- **Non-interactive** (`-p`, JSON): no questions are asked, the orchestrator's own interpretation is used, and context disputes go to the judge.

### `plan`
Read-only exploration that ends in a numbered plan, recorded with the `todo` tool. Then `/handoff --to code <goal>` opens a fresh code-mode session that starts from the plan.

### `science`: systematic-review-style answers
Use `/science <question>` (or `/science --resume` to continue an interrupted run), or let the router pick it. For a quick lookup the model can call `papers`.

| Stage | What happens |
|---|---|
| Frame | The orchestrator states the goal and asks you up to 3 direction questions (population, outcomes, time range…) |
| Protocol | PICO (population, intervention, comparison, outcomes), inclusion and exclusion criteria, earliest year, and up to 5 search queries |
| Search | Every query on OpenAlex, PubMed, Semantic Scholar and arXiv, run in parallel. Each search is logged with a timestamp. Results are de-duplicated by DOI and title, and retracted papers and papers without abstracts are dropped |
| Screen | **Two different models** decide include/exclude from title and abstract. Their agreement is measured with **Cohen's κ**, and disagreements go to a third model |
| Extract | For each paper: design, n, population, intervention, comparator, outcomes (finding, direction, significance), limitations, and a **verbatim quote, checked against the abstract** |
| Synthesize | The orchestrator writes an answer in which every sentence cites `[P#]`, rates **GRADE certainty** per outcome, and lists open questions and suggested next studies |
| Verify | Every cited sentence is checked against the extractions of the papers it cites. Results are marked ✅, ⚠️ partial or ❌ unsupported, and citations of papers that were not included are flagged |

**Outputs:**
- `.npi/science/<time>.md`: the answer, GRADE table, evidence table, PRISMA flow counts, κ, search log and references;
- `.json`: the full trace;
- `.bib`: references for the included papers.

**Caveats:**
- Decisions are made from titles and abstracts only. The pipeline doesn't read full texts; the open-access PDF links are recorded.
- Semantic Scholar works without a key but is heavily rate-limited; set `SEMANTIC_SCHOLAR_API_KEY` to avoid that.
- Two screener models must be available, preferably from different providers. Two local models count.

---

## Subagents (`delegate`, `/agents`)

| Call | Shape |
|---|---|
| single | `{agent, task, model?}` |
| parallel | `{tasks: [{agent, task}, …]}`: up to 8 tasks, 4 at once |
| chain | `{chain: [{agent, task: "… {previous} …"}, …]}`: stops at the first failure |

**How a subagent runs:**
- **Isolation:** an in-process pi session with its own context window, model (the first available in its list), tools and MCP servers.
- **What it loads:** your pi packages (e.g. web tools), but never the npi extensions, so it can't recurse into `delegate` or `brainstorm`.
- **Scope:** only the agents the active mode allows.

**Bundled agents** (in `agents/`):

| Agent | Models | Tools | Budget |
|---|---|---|---|
| `researcher` | Sonnet 5.5 → Gemini 3.1 Pro → GPT-5.6 Terra → local | web_search, fetch_content, get_search_content + Playwright MCP | 80k context, 400-token summary |
| `browser` | Sonnet 5.5 → GPT-5.6 Terra | read + Playwright MCP | defaults |
| `scout` | Haiku 5.5 → local → GPT-5.6 Luna | read, grep, find, ls | defaults |
| `coder` | Opus 5.5 → GPT-6.1 Sol → local | read, bash, edit, write, grep, find, ls | defaults; **runs in its own git worktree** and commits there |
| `reviewer` | Opus 5.5 → GPT-6.1 Sol → Gemini 3.1 Pro | read, grep, find, ls, bash (inspection only) | 700-token summary; used by `/review` |

**Your own agents:** add `~/.npi/agent/agents/<name>.md`, or `.pi/agents/<name>.md` in a trusted project. Later directories override earlier ones by name.

```markdown
---
name: reviewer
description: Reviews a diff for bugs and risky changes
model: anthropic/claude-opus-5-5, ollama/qwen3.6:27b   # ordered fallbacks
thinking: medium
tools: read, grep, find, ls, bash
mcp: playwright            # optional: servers from npi.json mcpServers or mcp.json
contextTokens: 60000       # optional: wrap-up steer at this size, hard stop at 1.5x
summaryTokens: 500         # optional: cap on what the caller receives
isolation: worktree        # optional: fresh git worktree + branch per run, changes committed there
---
System prompt for the agent…
```

---

## Context discipline (no pollution, no token waste)

| Mechanism | Effect |
|---|---|
| **Per-mode loadout** | Only the mode's tools are declared, only its skills are listed, and only its MCP servers connect (lazily, on first use). Everything else is one `tool_search` away. |
| **Subagent reporting contract** | Each subagent must end with `## Summary`, and the caller receives only that, capped at `summaryTokens` (default 500). The full report and a log of every tool call go to `.npi/artifacts/<run>/NNN-<agent>.md`; the caller sees the path and reads it only if needed. |
| **Subagent context budget** | Each subagent is told its budget. When one request's context exceeds `contextTokens` (default 60k) it is steered to wrap up; at 1.5× it is stopped and its partial summary is returned. |
| **Large tool output offload** | In the main session, any tool result over 12,000 chars is saved to an artifact and replaced by a ~2,500-char preview plus the path, readable with `read` and an offset/limit. `read`, `delegate`, `brainstorm` and `tool_search` are exempt. |
| **Brainstorm data flow** | Stages pass compact structured data, not prose. Full panel proposals and research reports are written as artifacts; the orchestrator sees structured claims only; the judge sees research summaries only. The conversation gets a digest. |
| **Output caps per role** | Panelist and orchestrator calls have `maxOutputTokens` (4k / 8k). |
| **Cost caps** | Brainstorm `maxCostUSD`. `delegate` and `brainstorm` report their nested usage, so pi's session totals stay accurate. |

---

## Adding a use case (a "mode")

Add one entry to `routes` in `~/.npi/agent/npi.json`. Nothing else loads it.

```jsonc
"science": {
  "description": "Literature-grounded research questions …",  // what the classifier reads
  "models": ["anthropic/claude-fable-5-1", "google/gemini-3.1-pro-preview"],
  "thinking": "high",
  "tools": ["web_search", "fetch_content"],          // declared up front
  "promote": ["mcp__papers__search"],                // MCP tools declared up front
  "mcp": ["papers"],                                  // servers from "mcpServers", connected lazily
  "skills": ["literature-review"],                    // skills listed in the prompt (omit = all)
  "agents": ["researcher", "paper-reader"],           // what delegate may use (omit = all)
  "keywords": ["\\bstud(y|ies)\\b", "meta-analysis", "\\bpapers?\\b"],
  "prompt": "Cite every claim to a paper; grade evidence strength."
}
```

Add MCP servers to `mcpServers` in `npi.json`, not to the global `mcp.json`, so they only connect for the modes that list them. The global `mcp.json` is for servers you want in every session.

---

## Config reference (`~/.npi/agent/npi.json`)

| Key | Meaning |
|---|---|
| `router.classifierModels` / `classifierTimeoutMs` / `minConfidence` | the classifier model chain, its timeout, and the confidence needed for its answer to count |
| `router.defaultRoute` / `alwaysTools` | the fallback mode; tools declared in every mode |
| `routes.<name>` | `description, models, thinking, tools, promote, keywords, prompt, skills, mcp, agents` |
| `mcpServers.<name>` | the MCP catalogue (same shape as `mcp.json` entries: `url` or `command`, `exposure`, `timeout`, …) |
| `routes.<name>.policy` / `sandbox` | `readonly`, `ask` or `auto`; `sandbox: true` runs shell commands in Docker (`auto` takes effect only when sandboxed) |
| `guard.*` | `defaultPolicy, protectedPaths, askCommands, readonlyCommands, readonlyTools, askTools, sandboxImage, sandboxNetwork` |
| `memory.*` / `telemetry.*` | `dir, pinnedChars` / `enabled, dir` (both under the agent dir) |
| `science.*` | `orchestrator, screeners, extractor, verifier, sources, maxDirectionQuestions, maxQueries, perQuery, maxCandidates, maxIncluded, askUser, maxCostUSD, reportDir` |
| `context.*` | `artifactDir`, `toolResultInlineChars`, `toolResultPreviewChars`, `subagentContextTokens`, `subagentSummaryTokens` |
| `subagents.*` | `maxConcurrency`, `maxParallelTasks`, `timeoutMs` |
| `brainstorm.orchestrator` / `panel[]` / `judge` | model chains; panelists are `{id, model, thinking?, persona?}` |
| `brainstorm.*` | `minPanelists, evidenceAgent, maxDirectionQuestions, maxPathwaysPerPanelist, maxDisputes, crossExamRounds, recommendThreshold, askUser, maxCostUSD, callTimeoutMs, maxOutputTokens{panelist,orchestrator}, reportDir` |

Model refs are `provider/model-id`, split at the first `/`: `openrouter/z-ai/glm-5.3` means provider `openrouter`, model `z-ai/glm-5.3`. A local model counts as available only if its server answers.

---

## Commands

| Command | Does |
|---|---|
| `/brainstorm [goal]` · `/brainstorm --resume` | run (or continue) the explore-and-decide panel |
| `/science [question]` · `/science --resume` | run (or continue) a literature review |
| `/handoff [--to mode\|provider/model\|claude\|codex\|opencode\|gemini\|pi] <goal>` | write a self-contained prompt for a fresh session (opened for you) or for another agent CLI (saved to a file, with the command to run) |
| `/undo [n]` · `/checkpoints` | restore files to the state before the agent's nth-last change (each undo can itself be undone) |
| `/review [range]` | read-only review of uncommitted changes or a branch/range |
| `/policy [readonly\|ask\|auto\|reset]` | show or override the approval policy for this session |
| `/stats [days]` | cost by model and mode, cache hit rate, routing reasons, tool errors |
| `/memory` | where long-term notes live, plus the pinned ones |
| `/bench [report|on|off]` | benchmark report per model and device, or pause/resume recording |
| `/route [name\|auto]` | show, pin or unpin the mode |
| `/routes` | list modes with their models and tools |
| `/agents` | list subagents with their models, tools and MCP servers |
| `/mcp`, `/model`, `/skill:name`, … | pi built-ins |

## Safety

| Policy | Behaviour |
|---|---|
| `readonly` | No edits or writes. Only shell commands on the inspection allowlist (`ls`, `cat`, `rg`, `git status/log/diff`…), and only without redirection or command substitution. Other tools run only if they are known to be read-only or declare `readOnlyHint` |
| `ask` (default) | Asks before risky shell commands (`rm -rf`, `git push`, `git reset --hard`, `sudo`, `curl … \| sh`, publish, drop table…), before writes outside the project, and before state-changing browser or MCP tools (form fill, file upload, run code, `destructiveHint`). With no UI available, it blocks instead of asking |
| `auto` | Runs everything, but **only if the mode is sandboxed**; otherwise it behaves like `ask` |

- **Protected paths** are blocked in every policy: `.env*`, `.git/**`, keys and certificates, `~/.ssh`, `~/.aws`, and npi's own auth files.
- **Sandbox:** set `"sandbox": true` on a mode to run its shell commands as `docker run --rm -v <project>:/work <image>`. The image defaults to `node:22-bookworm` and can be changed with `guard.sandboxImage`.
- **Subagents** inherit the calling mode's policy. They have no one to ask, so `ask` means blocked; the research agents used by brainstorm and science always run `readonly`.

## Workflow tools
- **`todo`:** a visible task list the model keeps up to date for multi-step work.
- **Checkpoints and `/undo`:** before the first change in each turn, the working tree (tracked and untracked files, respecting `.gitignore`) is snapshotted through a private git index. Your staging area is never touched. Needs a git repository.
- **`/handoff`:** instead of compressing a long conversation, the current model writes a self-contained prompt: context, decisions, files, artifacts, and the task with acceptance criteria. You edit it, and it opens in a fresh session on the chosen mode or model, or is saved for `claude`/`codex`/… with the exact command to run.
- **Durable runs:** brainstorm and science save each finished stage to `state.json`. `--resume` continues without repeating paid model calls or questions you already answered.

## Memory and stats
- **`remember` / `recall`:** notes live in one Markdown file, `~/.npi/agent/memory/notes.md`, which you can edit by hand. Each note is tagged with its project. Only notes tagged `#pin` are added to every prompt (capped by `memory.pinnedChars`); the rest cost tokens only when recalled.
- **Telemetry:** every routing decision, model call (tokens, cache, cost), tool call (duration, errors), subagent run and brainstorm is appended to `~/.npi/agent/telemetry/<date>.jsonl`, which `/stats` summarizes. It's a flat JSON format, easy to send to OpenTelemetry or Langfuse later.
- **Evals:** `test/evals/router-cases.json` holds labelled prompts. `npm test` checks keyword routing precision. `NPI_LIVE_EVAL=1 npx vitest --run test/evals` also scores the real classifier on the prompts keywords miss.

## Benchmarks and observability
- **Built in:** with `telemetry.enabled` (the default), every model call is timed and appended to `~/.npi/agent/telemetry/bench/<date>.jsonl`. That covers the agent loop and also npi's own direct calls (classifier, digests, brainstorm and science). Each call records model, device, time to first token, total time, tokens, cache reads, reasoning tokens and cost. `/bench report` writes a Markdown report to `.npi/benchmarks/`; `/bench off` and `/bench on` pause and resume recording for the session. Set `telemetry.enabled: false` to turn all of this off.
- **Device names** come from `NPI_DEVICE_<PROVIDER>` in `.env`; without one, a device shows as "this machine", "LAN server" or "cloud API". IPs never appear in reports.
- **Demos:** `npm run demo` / `npm run demo:quick` record the same numbers per demo, plus quality results. `npm run bench:report [-- --last N --publish]` merges runs into one report. See [test/demos/README.md](../test/demos/README.md).
- **Optional dashboards (pi packages, no code needed):**
  - `npx npi install npm:pi-otel`: OpenTelemetry traces of agent sessions. `/otel start` opens a local dashboard.
  - `npx npi install npm:@langfuse/pi-observability-plugin`: Langfuse traces. The plugin reads `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY` and `LANGFUSE_BASE_URL` (see `.env.example`).

  Both trace pi's agent loop. npi's own benchmark recorder is what covers the direct pipeline calls.

## Local models and .env
Copy `.env.example` to `.env`, in the repo or in `~/.npi/agent/`. Real environment variables take precedence over both files.

| Variable | Server | Model refs |
|---|---|---|
| `LLAMA_BASE_URL` | llama.cpp router; models and context sizes are discovered automatically, and pi's `/llama` command also uses it | `llamacpp/<id>` |
| `LMSTUDIO_BASE_URL` (…`/v1`) | LM Studio; context sizes come from its native API | `lmstudio/<id>` |
| `OLLAMA_BASE_URL`, `VLLM_BASE_URL`, `OPENAI_COMPATIBLE_BASE_URL` (+ `*_API_KEY`) | other OpenAI-compatible servers | `ollama/<id>`, `vllm/<id>`, `openai-compatible/<id>` |
| `NPI_LOCAL_LARGE`, `NPI_LOCAL_SMALL` | what the shared config means by `local/large` and `local/small` | e.g. `llamacpp/qwen3.8-27b…` |

Every mode, brainstorm and science model list ends with a `local/*` fallback (the router classifier chain starts with `local/small`), so npi works with local models only, including a brainstorm panel of two local models and science screening by two local models. With only one local model, brainstorm fills the panel with the same model in contrasting personas (`brainstorm.fallbackPersonas`), and science screening uses that model as two independent reviewers; reports note the reduced diversity. `npi doctor` shows what is reachable. Servers on your LAN are probed before use, so a machine that is switched off is skipped quickly.

## Layout

```
bin/npi.mjs               launcher (isolated agent dir, init, doctor)
config/                       defaults seeded into ~/.npi/agent
docker/compose.yml            Playwright MCP (+ optional SearXNG)
agents/                       bundled subagents
src/core/                     agents, artifacts, bench, budget, config, delegate, digest, gitsnap, handoff, llm, localmodels, memory, policy, pool, router, runstate, structured, subagent, telemetry
src/brainstorm/               frame, panel, map, resolve/{evidence,crossExam,askUser,judge}, pipeline, report
src/science/                  papers (OpenAlex/PubMed/S2/arXiv), pipeline, report
src/extensions/               local-models, context, telemetry, guard, router, memory, workflow, subagents, brainstorm, science
test/                         unit tests (scripted fake models); test/integration needs NPI_AGENT_DIR (+ Playwright)
```

```bash
npm test                       # unit tests
npm run typecheck
NPI_AGENT_DIR=~/.npi/agent npx vitest --run test/integration   # live pi sessions + Playwright MCP
```

## Status

- **Run on real local models (LM Studio and llama.cpp on the LAN):** `npi/auto` routing with fallback to `local/large`, telemetry and prompt caching.
- **Run for real in the pi CLI with scripted models:** routing (keyword, classifier, prefix), per-mode tools, lazy MCP, tool-output offload, subagents driving Playwright, and the budget steer and stop.
- **Covered by unit tests:** policy, snapshots and undo, memory, telemetry, the brainstorm and science pipelines (including resume), paper parsers, and router evals.
- **Not yet run with frontier API keys;** prompts may need tuning on first real use.
- **Built on pi's primitives:** virtual models, `registerMcpServer`, SDK sessions, tool search and skills. oh-my-pi and roughly 30 other harnesses were reviewed as design references (see the roadmap).
