# npi — full guide

A personal agent harness on [pi](https://github.com/earendil-works/pi) (`@earendil-works/pi-coding-agent` 1.2.0).

- **Routing:** each prompt goes to a **mode**, and the mode loads only its own model, tools, skills, MCP servers and subagents. Anything else stays reachable through `tool_search`.
- **Subagents:** coordinated through `delegate`.
- **Models:** local and frontier.
- **Brainstorm:** a multi-model mode that explores every pathway for a goal and settles disagreements.

It is a pi **package** plus a launcher, not a fork. Its config, sessions and models live in `~/.harness/agent`, separate from plain `pi`.

---

## Quick start

```bash
npm install
docker compose -f docker/compose.yml up -d     # Playwright MCP on :8931 (add --profile search for SearXNG on :8888)
npx harness doctor                              # keys, local model servers, MCP endpoints
npx harness                                     # first run seeds ~/.harness/agent and opens the TUI
```

- **Keys:** set `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY` and `OPENROUTER_API_KEY`, or use `/login` inside the TUI.
- **Local models:** edit `~/.harness/agent/models.json`. Ollama `:11434`, LM Studio `:1234` and llama.cpp `:8080` are preconfigured; replace the model ids with the ones you've pulled.
- **Default model:** `harness/auto`, the router.
- **Re-seeding defaults:** `harness init --force` (it overwrites `harness.json`, `models.json` and `mcp.json`).
- **Everything else:** any other argument goes straight to pi, e.g. `harness -p "…"`, `harness --list-models`, `harness mcp list`.

---

## Modes at a glance

| Mode | Use it for | Picked when | Model preference | Loaded only in this mode |
|---|---|---|---|---|
| `chat` | explanations, writing, quick answers | default / classifier | Sonnet 5.5 → GPT-5.6 Terra → local | nothing extra; no skills listed |
| `code` | read, write, debug, refactor or test code; shell | keywords: fix, bug, refactor, test, stack trace, `.ts`/`.py`… | Opus 5.5 → GPT-6.1 Sol → local | `bash` `edit` `write` `grep` `find` `ls`; agents `scout`, `coder` |
| `research` | current facts, docs, versions, prices, with citations | keywords: latest, news, sources, cite… | Sonnet 5.5 → Gemini 3.1 Pro → local | `web_search` `fetch_content` `get_search_content`; Playwright MCP; agents `researcher`, `browser` |
| `browse` | operate a website: open, click, fill, screenshot | URLs, "open the site", click, screenshot… | Sonnet 5.5 → GPT-5.6 Terra | Playwright MCP (5 core tools declared, the other 20 via `tool_search`); agents `browser`, `researcher` |
| `brainstorm` | abstract goals, decisions, strategy, "what are my options" | brainstorm, trade-offs, should I/we, options for, ways to… | Fable 5.1 → Opus 5.5 → GPT-6.1 Sol | `brainstorm` tool; agent `researcher` (for evidence) |
| `science` | literature-grounded research with graded evidence | planned, see [docs/roadmap.md](roadmap.md) | | |

Every mode also has `read`, `tool_search` (finds and loads any other registered tool on demand) and `delegate`.

### How a mode is chosen (first match wins)
1. **Pinned:** `/route code` keeps that mode until `/route auto`.
2. **Per-prompt prefix:** `#research what changed in Node 26?` (the prefix is removed before the model sees the prompt). It's `#`, not `@`, because pi uses `@` for files.
3. **Keywords:** the regexes in each route's `keywords`. A tie between two routes counts as no match.
4. **Classifier:** a small model (local Qwen 4B → Haiku 5.5 → OpenRouter Qwen Flash) with a 2.5 s timeout. It's used only if confidence ≥ 0.55, and skipped for prompts under 4 words.
5. **Sticky:** otherwise stay on the previous mode (follow-ups like "yes, do it" keep their context).
6. **Default:** `chat`.

- The status bar shows `route: research (keyword) → anthropic/claude-sonnet-5-5`.
- `/routes` lists every mode with its models and tools.
- Tool follow-ups and retries stay on the model that started the turn, so prompt caches stay valid.
- If you pick a concrete model in `/model` instead of `harness/auto`, routing still sets the tools, skills and MCP servers, but not the model.

---

## Modes in detail

### `chat`
- Plain conversation with the smallest loadout: `read`, `tool_search` and `delegate`.
- No skills are listed in the prompt, but `/skill:name` still loads any skill explicitly.

### `code`
- Full editing toolset on a strong coding model.
- Delegate reconnaissance to `scout` (read-only, cheap model) and well-specified changes to `coder`. Their reports stay out of your context; you get summaries plus file paths.
- Example: `fix the failing test in parser.test.ts`, or `#code add retry with backoff to fetchUser`.

### `research`
- Web search and fetch come from `pi-web-access`. Search works with no key through Exa, and gets better with keys or self-hosted SearXNG in `~/.harness/agent/web-search.json`.
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
- the full report, shown in the TUI and saved to `.harness/brainstorms/<time>.md` with a `.json` trace. It contains: the summary, your directions, the recommendation or criteria, a table of all pathways (fit, effort, pros, cons, best-when), pathway details, consensus, each dispute with its verdict, method, sources and research artifact, open questions, a panel scorecard (who was on the winning side), and cost broken down by stage;
- in the **conversation**: only a short digest plus the report path, so follow-up questions don't carry the whole report.

**Behaviour details:**
- **Panelists:** unavailable ones (no key, local server down) are skipped. It needs at least 2, and failed panelists are listed in the report.
- **Cost:** capped by `maxCostUSD` (default $5). When the cap is hit, it stops settling disputes and still ranks the pathways.
- **Non-interactive** (`-p`, JSON): no questions are asked, the orchestrator's own interpretation is used, and context disputes go to the judge.

### `science` (planned)
Specified in [docs/roadmap.md](roadmap.md). It reuses the brainstorm machinery for literature search, screening, structured extraction, contradiction resolution by methodology quality, and a GRADE-style evidence summary with BibTeX. Paper-search MCP servers would load only in this mode.

---

## Subagents (`delegate`, `/agents`)

| Call | Shape |
|---|---|
| single | `{agent, task, model?}` |
| parallel | `{tasks: [{agent, task}, …]}`: up to 8 tasks, 4 at once |
| chain | `{chain: [{agent, task: "… {previous} …"}, …]}`: stops at the first failure |

**How a subagent runs:**
- **Isolation:** an in-process pi session with its own context window, model (the first available in its list), tools and MCP servers.
- **What it loads:** your pi packages (e.g. web tools), but never the harness extensions, so it can't recurse into `delegate` or `brainstorm`.
- **Scope:** only the agents the active mode allows.

**Bundled agents** (in `agents/`):

| Agent | Models | Tools | Budget |
|---|---|---|---|
| `researcher` | Sonnet 5.5 → Gemini 3.1 Pro → GPT-5.6 Terra → local | web_search, fetch_content, get_search_content + Playwright MCP | 80k context, 400-token summary |
| `browser` | Sonnet 5.5 → GPT-5.6 Terra | read + Playwright MCP | defaults |
| `scout` | Haiku 5.5 → local → GPT-5.6 Luna | read, grep, find, ls | defaults |
| `coder` | Opus 5.5 → GPT-6.1 Sol → local | read, bash, edit, write, grep, find, ls | defaults |

**Your own agents:** add `~/.harness/agent/agents/<name>.md`, or `.pi/agents/<name>.md` in a trusted project. Later directories override earlier ones by name.

```markdown
---
name: reviewer
description: Reviews a diff for bugs and risky changes
model: anthropic/claude-opus-5-5, ollama/qwen3.6:27b   # ordered fallbacks
thinking: medium
tools: read, grep, find, ls, bash
mcp: playwright            # optional: servers from harness.json mcpServers or mcp.json
contextTokens: 60000       # optional: wrap-up steer at this size, hard stop at 1.5x
summaryTokens: 500         # optional: cap on what the caller receives
---
System prompt for the agent…
```

---

## Context discipline (no pollution, no token waste)

| Mechanism | Effect |
|---|---|
| **Per-mode loadout** | Only the mode's tools are declared, only its skills are listed, and only its MCP servers connect (lazily, on first use). Everything else is one `tool_search` away. |
| **Subagent reporting contract** | Each subagent must end with `## Summary`, and the caller receives only that, capped at `summaryTokens` (default 500). The full report and a log of every tool call go to `.harness/artifacts/<run>/NNN-<agent>.md`; the caller sees the path and reads it only if needed. |
| **Subagent context budget** | Each subagent is told its budget. When one request's context exceeds `contextTokens` (default 60k) it is steered to wrap up; at 1.5× it is stopped and its partial summary is returned. |
| **Large tool output offload** | In the main session, any tool result over 12,000 chars is saved to an artifact and replaced by a ~2,500-char preview plus the path, readable with `read` and an offset/limit. `read`, `delegate`, `brainstorm` and `tool_search` are exempt. |
| **Brainstorm data flow** | Stages pass compact structured data, not prose. Full panel proposals and research reports are written as artifacts; the orchestrator sees structured claims only; the judge sees research summaries only. The conversation gets a digest. |
| **Output caps per role** | Panelist and orchestrator calls have `maxOutputTokens` (4k / 8k). |
| **Cost caps** | Brainstorm `maxCostUSD`. `delegate` and `brainstorm` report their nested usage, so pi's session totals stay accurate. |

---

## Adding a use case (a "mode")

Add one entry to `routes` in `~/.harness/agent/harness.json`. Nothing else loads it.

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

Add MCP servers to `mcpServers` in `harness.json`, not to the global `mcp.json`, so they only connect for the modes that list them. The global `mcp.json` is for servers you want in every session.

---

## Config reference (`~/.harness/agent/harness.json`)

| Key | Meaning |
|---|---|
| `router.classifierModels` / `classifierTimeoutMs` / `minConfidence` | the classifier model chain, its timeout, and the confidence needed for its answer to count |
| `router.defaultRoute` / `alwaysTools` | the fallback mode; tools declared in every mode |
| `routes.<name>` | `description, models, thinking, tools, promote, keywords, prompt, skills, mcp, agents` |
| `mcpServers.<name>` | the MCP catalogue (same shape as `mcp.json` entries: `url` or `command`, `exposure`, `timeout`, …) |
| `context.*` | `artifactDir`, `toolResultInlineChars`, `toolResultPreviewChars`, `subagentContextTokens`, `subagentSummaryTokens` |
| `subagents.*` | `maxConcurrency`, `maxParallelTasks`, `timeoutMs` |
| `brainstorm.orchestrator` / `panel[]` / `judge` | model chains; panelists are `{id, model, thinking?, persona?}` |
| `brainstorm.*` | `minPanelists, evidenceAgent, maxDirectionQuestions, maxPathwaysPerPanelist, maxDisputes, crossExamRounds, recommendThreshold, askUser, maxCostUSD, callTimeoutMs, maxOutputTokens{panelist,orchestrator}, reportDir` |

Model refs are `provider/model-id`, split at the first `/`: `openrouter/z-ai/glm-5.3` means provider `openrouter`, model `z-ai/glm-5.3`. A local model counts as available only if its server answers.

---

## Commands

| Command | Does |
|---|---|
| `/brainstorm [goal]` | run the explore-and-decide panel |
| `/route [name\|auto]` | show, pin or unpin the mode |
| `/routes` | list modes with their models and tools |
| `/agents` | list subagents with their models, tools and MCP servers |
| `/mcp`, `/model`, `/skill:name`, … | pi built-ins |

## Layout

```
bin/harness.mjs               launcher (isolated agent dir, init, doctor)
config/                       defaults seeded into ~/.harness/agent
docker/compose.yml            Playwright MCP (+ optional SearXNG)
agents/                       bundled subagents
src/core/                     config, llm, structured output, budget, artifacts, router, subagent runner, delegate
src/brainstorm/               frame, panel, map, resolve/{evidence,crossExam,askUser,judge}, pipeline, report
src/extensions/               context (offload), router (harness/auto), subagents (delegate), brainstorm
test/                         unit tests (scripted fake models); test/integration needs HARNESS_AGENT_DIR (+ Playwright)
```

```bash
npm test                       # unit tests
npm run typecheck
HARNESS_AGENT_DIR=~/.harness/agent npx vitest --run test/integration   # live pi sessions + Playwright MCP
```

## Status

- **Verified with scripted models in the real pi CLI:** routing (keyword, classifier, prefix), per-mode tools, lazy MCP connection, tool-output offload, subagent sessions driving Playwright, and the budget steer and stop.
- **Covered by unit tests:** the brainstorm pipeline.
- **Not yet run against real frontier or local models;** prompts may need tuning after first real use.
- **Built on pi's primitives:** virtual models, `registerMcpServer`, the SDK sessions, tool search and skills. oh-my-pi (a pi fork) was reviewed and used only as a design reference.
