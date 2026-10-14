#!/usr/bin/env node
// Harness launcher: runs pi with an isolated agent directory (~/.harness/agent by default) that has
// this package, pi-web-access, default models/MCP config, and the `harness/auto` router selected.
//
//   harness                 start the TUI (seeds config on first run)
//   harness init [--force]  (re)seed config files; --force overwrites harness.json/models.json/mcp.json
//   harness doctor          check keys, local model servers and the Playwright MCP endpoint
//   harness <pi args...>    anything else is passed to pi (e.g. `harness -p "hi"`, `harness --list-models`)

import { spawnSync, spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HARNESS_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const AGENT_DIR = process.env.HARNESS_AGENT_DIR || join(homedir(), ".harness", "agent");
const WEB_ACCESS_PACKAGE = "npm:pi-web-access@0.40.0";
const SEEDED_FILES = ["harness.json", "models.json", "mcp.json"];

// .env files (see .env.example): repo root, then the agent dir. Real env vars always win.
for (const file of [join(HARNESS_ROOT, ".env"), join(AGENT_DIR, ".env")]) {
	if (existsSync(file)) process.loadEnvFile(file);
}

function piCliPath() {
	const index = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
	return join(dirname(index), "bundle", "cli.js");
}

function piEnv() {
	return { ...process.env, PI_CODING_AGENT_DIR: AGENT_DIR, HARNESS_ROOT };
}

function runPiSync(args) {
	const result = spawnSync(process.execPath, [piCliPath(), ...args], { stdio: "inherit", env: piEnv() });
	return result.status ?? 1;
}

function readJson(path, fallback) {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return fallback;
	}
}

function init(force) {
	mkdirSync(AGENT_DIR, { recursive: true });
	for (const file of SEEDED_FILES) {
		const target = join(AGENT_DIR, file);
		if (force || !existsSync(target)) {
			copyFileSync(join(HARNESS_ROOT, "config", file), target);
			console.log(`seeded ${target}`);
		}
	}

	// Register packages through pi itself so it installs/reconciles them.
	const settingsPath = join(AGENT_DIR, "settings.json");
	// pi stores local packages relative to the settings file, so compare resolved paths.
	const packages = (readJson(settingsPath, {}).packages ?? []).map((p) => (typeof p === "string" ? p : p.source));
	const hasHarness = packages.some((p) => !/^(npm|git|https?):/.test(p) && resolve(AGENT_DIR, p) === HARNESS_ROOT);
	if (!hasHarness && runPiSync(["install", HARNESS_ROOT]) !== 0) {
		throw new Error("pi install of the harness package failed");
	}
	if (!packages.some((p) => p.includes("pi-web-access")) && runPiSync(["install", WEB_ACCESS_PACKAGE]) !== 0) {
		console.warn("warning: installing pi-web-access failed; web_search/fetch_content will be unavailable");
	}

	const settings = readJson(settingsPath, {});
	settings.defaultProvider ??= "harness";
	settings.defaultModel ??= "auto";
	writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
	console.log(`harness agent dir: ${AGENT_DIR}`);
}

async function probe(url) {
	try {
		const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
		return `up (HTTP ${res.status})`;
	} catch {
		return "down";
	}
}

async function doctor() {
	const keys = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY"];
	for (const key of keys) console.log(`${key.padEnd(20)} ${process.env[key] ? "set" : "missing (or use /login)"}`);
	const strip = (u) => u.replace(/\/+$/, "");
	const endpoints = {
		...(process.env.LLAMA_BASE_URL && { "llama.cpp": `${strip(process.env.LLAMA_BASE_URL)}/models` }),
		...(process.env.LMSTUDIO_BASE_URL && { lmstudio: `${strip(process.env.LMSTUDIO_BASE_URL)}/models` }),
		...(process.env.OLLAMA_BASE_URL && { ollama: `${strip(process.env.OLLAMA_BASE_URL)}/models` }),
		...(process.env.VLLM_BASE_URL && { vllm: `${strip(process.env.VLLM_BASE_URL)}/models` }),
		"playwright-mcp": "http://localhost:8931/mcp",
		searxng: "http://localhost:8888/",
	};
	for (const [name, url] of Object.entries(endpoints)) console.log(`${name.padEnd(20)} ${await probe(url)}  ${url}`);
	for (const alias of ["HARNESS_LOCAL_LARGE", "HARNESS_LOCAL_SMALL"]) console.log(`${alias.padEnd(20)} ${process.env[alias] || "unset"}`);
	console.log(`agent dir            ${existsSync(AGENT_DIR) ? AGENT_DIR : "not initialised (run: harness init)"}`);
}

const args = process.argv.slice(2);
if (args[0] === "init") {
	init(args.includes("--force"));
} else if (args[0] === "doctor") {
	await doctor();
} else {
	if (!existsSync(join(AGENT_DIR, "harness.json"))) init(false);
	const child = spawn(process.execPath, [piCliPath(), ...args], { stdio: "inherit", env: piEnv() });
	child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
}
