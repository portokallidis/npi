# npi

**An AI agent harness that uses the right tools and models for each request.** It's built on the [pi](https://github.com/earendil-works/pi) coding agent.

You type a request. npi works out what kind of job it is (coding, planning, research, browsing, brainstorming or a literature review) and loads only what that job needs. Nothing else enters the context or costs you tokens.

## What makes it different

**1. It loads only what each request needs.**
Most harnesses load every tool, plugin and server at startup. npi picks a *mode* for each request, and the mode decides the model, tools, skills, MCP servers, helper agents and safety level. A chat message never connects a browser or sees your git tools.

**2. Several AI models brainstorm together, and settle their disagreements.**
Give it a vague goal. A top model asks you a few clarifying questions. Several different models (cloud and local) then each suggest ways to get there, and npi merges their ideas into one list of options with pros and cons. When the models disagree, npi settles it by searching the web, making them debate, asking you, or asking a neutral judge. It recommends one option only when your goal is clear enough.

**3. Literature reviews you can check.**
`/science` searches OpenAlex, PubMed, Semantic Scholar and arXiv. Two different models screen the papers and npi measures how often they agree. It then pulls structured data out of each paper, checking that every quote really appears in the abstract, and grades how strong the evidence is. Finally it checks every sentence of the answer against the papers that sentence cites, and flags the ones that aren't supported.

**4. Helper agents report back briefly.**
Helper agents return a short summary; their full report is saved to a file. Each helper has a token budget: it is told to wrap up when it reaches the budget and is stopped at 1.5×. Large tool outputs become a short preview plus a file link. Your main conversation stays small.

**5. Local and cloud models, set up in one file.**
Put your servers and keys in `.env`. Ollama, LM Studio, llama.cpp, vLLM, Anthropic, OpenAI, Google and OpenRouter are supported. Each job has a fallback list of models, so it keeps working when a key is missing or a server is off.

**6. Safe by default.**
- Approval prompts before risky commands. Read-only modes can't change anything.
- An optional Docker sandbox for shell commands.
- Secrets and `.git` are always protected.
- Automatic file checkpoints, with `/undo` to roll back.

**7. It's a plugin, not a fork.**
npi is a pi package plus a small launcher, so it gets pi's updates. Its settings live in their own folder, `~/.npi/agent`, apart from plain `pi`.

## Modes

| Mode | For | Example |
|---|---|---|
| chat | questions, writing | `explain CRDTs simply` |
| plan | think before building (read-only) | `plan how we should add billing` |
| code | read, fix and change code | `fix the failing test in parser.ts` |
| research | facts from the web, with sources | `what's new in Node 26?` |
| browse | use a real website | `open example.com and take a screenshot` |
| brainstorm | explore options for a goal and decide | `/brainstorm how should I price my app?` |
| science | answers from research papers, graded | `/science does exercise help depression?` |

npi chooses the mode automatically. To choose it yourself, start the request with `#plan …`, or use `/route code` to stay in a mode.

## Get started

```bash
npm install
cp .env.example .env          # add your keys and/or local model servers
docker compose -f docker/compose.yml up -d   # browser for the "browse" mode (optional)
npx npi doctor            # shows which models and services it can reach
npx npi
```

## Handy commands

| Command | Does |
|---|---|
| `/handoff --to code <goal>` | start a fresh, focused session (on another mode, model, or `claude`/`codex`) |
| `/undo` | put files back the way they were before the agent's last change |
| `/review` | have a read-only reviewer check your uncommitted changes |
| `/policy readonly\|ask\|auto` | change how much the agent may do without asking |
| `/stats` | cost, cache hits, routing and errors |
| `/bench report` · `/bench off` | timing per model and device (time to first token, tokens/s); turn recording off or on |
| `/memory` | notes it keeps between sessions |

## Try the demos

```bash
npm run demo:quick   # routing, small-model jobs, a real subagent, safety policies
npm run demo         # + multi-model brainstorm and a literature review (slow on local models)
```

Measured on two home machines: a Mac running Qwen 3.5 9B in LM Studio ("small") and a Linux GPU box running Qwen 3.8 27B in llama.cpp ("large"). Everything ran locally and cost $0.

| Use case | Result |
|---|---|
| Routing (24 labelled prompts) | 24/24 with either model; ~3 s per decision on the small one |
| Pull invoice fields into JSON | 16/16 fields on both models |
| Shrink a 5k-token log | ~300 tokens, error kept, 3–25 s |
| Screen papers against criteria | 6/6 on the small model |
| Review + fix a buggy commit | Bug found, fixed on its own branch, tests pass (4 min) |
| Two subagents on two machines | 1.7× faster than one after the other |
| Handoff to a new session | Small model kept 3/4 key facts; large kept 4/4 |
| Brainstorm, literature review | Complete on one local model in 15–20 min |

Each run prints what happened and writes a benchmark report (time, tokens/s and quality per model and device). [Latest numbers](docs/benchmarks.md) · [What each demo shows](test/demos/README.md)

## Learn more

- [Full guide](docs/guide.md): every mode, command and setting
- [Roadmap](docs/roadmap.md): what's done and what's next

## Status

Early. Unit tests use scripted models. The demos run on real local models (LM Studio and llama.cpp) and real paper databases; see the [benchmarks](docs/benchmarks.md).
