# npi roadmap

## Principle: load only what the use case and the request need

Three layers, each narrower than the last:

| Layer | Chosen | Decides |
|---|---|---|
| **Profile** (`npi --profile dev\|research\|saas`, or `.pi/npi.json`) | at launch | which modes exist, their models and policies, the ground-rules prompt, `checks` |
| **Mode** (a route in `npi.json`) | per request: pin, `#prefix`, keywords, classifier | tools (`setActiveTools`; the rest via `tool_search`), skills, lazy MCP servers, subagents, policy, sandbox |
| **Tier** (light / standard / heavy) | per request, by the same classifier call; escalates on struggle | which of the mode's model lists is used, and how much thinking |

Rule: when a use case needs a new capability, add it to that profile or mode and nowhere else.

## Status (Oct 2026)

**Done**
- Per-mode loadout: `skills`, `mcp` (lazy) and `agents` per mode; MCP catalogue in `npi.json`.
- Approval policies (`readonly` / `ask` / `auto`) and the Docker sandbox. Protected paths. Subagents inherit the policy.
- `plan` mode, the `todo` tool, `/handoff` to a mode, a model or an external agent CLI.
- File checkpoints and `/undo`; git-worktree isolation for `coder`; `/review` with a read-only reviewer.
- Telemetry (JSONL) and `/stats`; router evals (offline keywords plus a live classifier).
- Durable brainstorm and science runs (`--resume`).
- Long-term memory (`remember`, `recall`, `#pin`).
- Science mode: protocol, 4-database search, dual screening with κ, extraction with quote checks, GRADE, citation verification, BibTeX.
- Local models configured from `.env` (llama.cpp, LM Studio, Ollama, vLLM, any OpenAI-compatible server) with automatic discovery; `local/large` and `local/small` aliases.
- Code intelligence: Serena MCP in `code` mode (opt-in).
- Launch-time profiles (`npi --profile dev|research|saas`, user and trusted-project overlays).
- Effort tiers chosen by the same classifier call, with escalation on struggle, `/tier`, an HTTP decision-model endpoint, a classifier cache and a tier eval (demo 12).
- Project ledger (`.npi/ledger.md`) re-injected every turn; todos and pins persist across restarts.
- Post-edit check gate; experiment log with bootstrap CIs and permutation tests; prompt templates `/hypothesis`, `/ablate`, `/prd`, `/preflight`, `/repro`.
- Guard hardening: chained shell commands, `find -delete/-exec`, `git branch -D`, protected paths in shell commands, no powershell on sandboxed modes.

**Next**
- A sub-second decision model. The 9B and 27B local classifiers are accurate but take ~3–5 s. Intern-Decision-0.8B (`scripts/decision-server.py`) scores 24/30 tiers at ~10 s on the laptop CPU; next, try it on a GPU (model card: ~34 ms), or serve its GGUF build through llama.cpp logprobs.
- Guardrails against prompt injection in fetched pages and papers: a classifier pass on tool results in `browse`, `research` and `science`.
- Science: full-text reading of open-access PDFs; contradiction search; a novelty check for idea generation.
- Browser action caching (Stagehand-style) and a domain allowlist for `browse`.
- A per-turn advisor model (oh-my-pi style), opt-in per mode.
- An OpenTelemetry exporter for the JSONL traces; scheduled or background agents.

## Improvements without bloat

1. **Prefer built-ins.** Replace our code wherever pi or oh-my-pi already ships an equivalent. Candidates: subagents, ask-user dialogs, output truncation, web and browser tools, cost tracking.
2. **Skip the classifier while a conversation stays on one topic.** Repeated prompts are already cached; topic continuity would remove most remaining calls.
3. **One artifact index per session.** Write an `index.md` listing every artifact with a one-line description, so the model reads one small file instead of guessing paths.
4. **Profiles that filter pi packages at launch,** for heavy, rarely used extensions (extension code cannot be unloaded mid-session).

## Scientific research mode (`science`, implemented; original design)

**Goal:** literature-grounded answers to research questions, where every claim is traced to papers and the strength of the evidence is graded.

- **Flow** (reuses the brainstorm machinery):
  1. Frame: define the question, scope, and inclusion and exclusion criteria, and ask the user for direction.
  2. Search: run parallel literature-search subagents with different strategies and databases.
  3. Screen: deduplicate the candidates and screen them against the criteria.
  4. Extract: pull claims, methods, sample sizes and effect sizes into structured records, one artifact per paper.
  5. Map consensus and contradictions across studies.
  6. Resolve contradictions using methodology quality, recency and replication, with the judge plus a methods critic.
  7. Synthesize: a graded summary (e.g. a GRADE-like strong / moderate / weak / insufficient), open questions, and suggested next experiments.
- **MCP / tools (lazy, this profile only):** paper search and metadata (arXiv, PubMed/Europe PMC, Semantic Scholar, OpenAlex, Crossref), full-text fetch and PDF extraction (pi-web-access already handles PDFs), optional Zotero export.
- **Agents** (planned, not implemented; the pipeline uses direct model calls plus the `researcher` agent): `literature-scout` (search and screen), `paper-reader` (structured extraction, summary only, full notes as an artifact), `methods-critic` (bias, power, confounders), `statistician` (re-checks the numbers).
- **Skills:** literature-review protocol, citation formatting (BibTeX/CSL), evidence grading rubric.
- **Output:** a report with an evidence table (paper, design, n, effect, quality, supports/contradicts), BibTeX file, and every claim citing its source; full extractions kept in artifacts.
- **Models:** a top frontier model as orchestrator; long-context models for paper reading; local models allowed for screening to save cost.

## Gaps found in the harness survey (Oct 2026)

Surveyed: opencode, Codex CLI, Gemini CLI, OpenHands, Cline, Goose, Aider, Crush, Qwen Code, Kilo, Plandex, Amp, oh-my-pi, Claude Agent SDK, OpenAI Agents SDK, deepagents, CrewAI, Letta, Mastra, PydanticAI, browser-use, Stagehand, GPT Researcher, STORM, PaperQA2, AI Scientist, Agent Laboratory, Orca, Paseo.

Prefer pi's shipped example extensions or MCP servers, scoped to a mode, over new code. Ranked:

| # | Gap | How (no bloat) | Seen in |
|---|---|---|---|
| 1 | Approval gates for risky tools | Per-mode policy via pi's `permission-gate` / `confirm-destructive` / `protected-paths` examples, using MCP tool annotations; browse mode asks before submits | Codex, Cline, Crush, deepagents |
| 2 | Sandbox for shell/file tools | pi `containerization.md` options (Docker Sandboxes, Gondolin micro-VM) for the `code` mode; an "auto" mode is allowed only when sandboxed | Codex, Gemini, OpenHands |
| 3 | Plan mode | A `plan` route: read-only tools plus pi's `plan-mode` and `todo` examples; then hand off to `code` | opencode, Cline, Kilo, Qwen |
| 4 | **Handoff** to another model, agent or session | Adopt pi's `handoff.ts`. Done: `/handoff [--to mode\|provider/model\|claude\|codex\|…] goal`. It writes the prompt to an artifact plus the worktree path, so Claude Code/Codex/another pi can pick it up. `/model` already moves context across providers | Amp, Paseo, pi example |
| 5 | File checkpoints / undo | pi's `git-checkpoint` example (one commit per turn, rewind with `/tree`) | opencode, Cline, Gemini |
| 6 | Worktree isolation for parallel coding subagents | `coder` runs in `git worktree add`; results merged or reviewed | Codex, Qwen, oh-my-pi, Orca |
| 7 | Tracing and evals | pi-telemetry spans (route decision, model, tokens, cost, subagent tree) to JSONL/OTel; a small eval set to tune router keywords, thresholds and model chains | Gemini, PydanticAI, Agents SDK |
| 8 | Durable long runs | Checkpoint brainstorm/science stage outputs (already JSON) to the artifact dir; `--resume <run>` skips finished stages | PydanticAI, LangGraph, pi-durable |
| 9 | Code intelligence | An LSP/symbol MCP server (e.g. Serena) in the `code` mode's `mcp` list only; diagnostics after edits | opencode, Crush, Qwen, Aider repo map |
| 10 | Long-term memory | A `memory` skill writing `~/.npi/agent/memory/*.md` (retain/recall), listed only where useful | oh-my-pi, Letta, Qwen |

Also noted: guardrails against prompt injection in fetched pages; browser action caching (Stagehand); per-turn advisor model (oh-my-pi); scheduled agents and a `/review` command.

### Science mode additions (from STORM, PaperQA2, AI Scientist, Agent Laboratory)
- **Sources:**
  - Literature: OpenAlex, Semantic Scholar, Crossref, Unpaywall.
  - Biomedical: PubMed/PMC and Europe PMC.
  - Also arXiv and ClinicalTrials.gov.
  - Retraction checks.
  - Wrap **PaperQA2** as an MCP server for retrieval with ranked, summarized evidence chunks and citations, rather than rebuilding it.
- **Process:**
  1. PICO protocol up front.
  2. Multi-database search with DOI dedup, PRISMA counts and a dated query log.
  3. **Dual-model screening** with Cohen's kappa; disagreements go to the existing dispute resolvers.
  4. Extraction where every field cites a quoted span and page.
  5. GRADE per outcome.
  6. Every sentence of the synthesis is checked against a quoted chunk.
  7. Contradiction search.
  8. A STORM-style multi-perspective outline before writing.
  9. A novelty check (AI Scientist) for idea generation.
  10. Co-pilot pauses between phases.
- **Evaluation:** Deep Research Bench (RACE) for the research and science modes.

## Remote / mobile access
- **Paseo** (getpaseo/paseo): the recommended option. Native iOS/Android/desktop/web, pi is a first-class agent, worktree per agent, and a `/paseo-handoff` skill. Point it at `PI_CODING_AGENT_DIR=~/.npi/agent` (or the `npi` launcher) so npi's packages load.
- **Orca** (stablyai/orca): desktop agent-development environment (ADE) with a mobile companion. Runs pi/Codex/Claude Code side by side in worktrees, sends one prompt to N agents and lets you merge the best. Good for multi-agent comparison; it is not a transcript-handoff tool.
- **Oppi** (iOS, TestFlight): the deepest pi integration (mirrors a terminal session, native cards for extension UI).
- **pi-web** (`@jmfederico/pi-web`): actively maintained browser UI.
- **pi-acp**: runs pi inside Zed and other ACP editors.
- **pi-chat** (official): Discord and Telegram.
- Connect over **Tailscale only**: these UIs can run anything the agent can.
