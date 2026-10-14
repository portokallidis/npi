# npi

**An AI agent harness that uses the right tools and models for each request.** It's built on the [pi](https://github.com/earendil-works/pi) coding agent.

You type a request. npi works out what kind of job it is (coding, research, browsing the web, or brainstorming) and loads only what that job needs. Nothing else enters the context or costs you tokens.

## What makes it different

**1. It loads only what each request needs.**
Most harnesses load every tool, plugin and server at startup. npi picks a *mode* for each request, and the mode decides the model, tools, skills, MCP servers and helper agents. A coding question never connects a browser, and a chat message never sees your git tools.

**2. Several AI models brainstorm together, and settle their disagreements.**
Give it a vague goal ("how should we launch this?"). A top model asks you a few clarifying questions. Claude, GPT, Gemini and a local model then each suggest ways to get there, and their ideas are merged into one list of options with pros and cons. When the models disagree, npi settles it by searching the web, making them debate, asking you, or asking a neutral judge. It recommends one option only when your goal is clear enough. We didn't find this in any other open-source harness.

**3. Helper agents report back briefly.**
When npi sends work to a helper agent (researcher, browser, coder…), it gets back a short summary. The full report is saved to a file. Each helper has a token budget: it is told to wrap up when it reaches its budget and stopped at 1.5×. Large tool outputs become a short preview plus a file link. Your main conversation stays small and focused.

**4. It mixes local and cloud models freely.**
Ollama, LM Studio, llama.cpp, Anthropic, OpenAI, Google and OpenRouter. Each job has a fallback list of models, so if a cloud key is missing or your local server is off, the next model in the list is used.

**5. It's a plugin, not a fork.**
npi is a pi package plus a small launcher, so it gets pi's updates. Its settings live in their own folder, `~/.harness/agent`, apart from plain `pi`.

## Modes

| Mode | For | Example |
|---|---|---|
| chat | questions, writing | `explain CRDTs simply` |
| code | read, fix and change code | `fix the failing test in parser.ts` |
| research | facts from the web, with sources | `what's new in Node 26?` |
| browse | use a real website | `open example.com and take a screenshot` |
| brainstorm | explore options for a goal and decide | `/brainstorm how should I price my app?` |
| science *(planned)* | research grounded in scientific papers | see the [roadmap](docs/roadmap.md) |

npi chooses the mode automatically. To choose it yourself, start the request with `#research …`, or use `/route code` to stay in a mode.

## Get started

```bash
npm install
docker compose -f docker/compose.yml up -d   # browser for the "browse" mode
npx harness doctor                           # shows which models and services it can reach
npx harness
```

Add API keys as environment variables (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`) or with `/login`, start a local model server, or both.

## Learn more

- [Full guide](docs/guide.md): every mode, command and setting
- [Roadmap](docs/roadmap.md): what's next, including approval prompts, a sandbox, plan mode, handoff to another model or agent, and the science mode

## Status

Early. Everything is tested with scripted models, including runs inside the real pi CLI and a real browser. It has not been tested with real cloud or local models yet.
