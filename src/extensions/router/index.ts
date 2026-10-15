import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { firstAvailable, parseModelRef, userMessage } from "../../core/llm.ts";
import type { ThinkingLevel } from "../../core/config.ts";
import {
	type Classifier,
	createClassifier,
	decideRoute,
	escalateTier,
	parsePrefix,
	parseTierPrefix,
	type RouteDecision,
	routeSkills,
	routeTools,
	TIERS,
	type Tier,
	tierModels,
} from "../../core/router.ts";
import { latestEntry, runtimeHolder } from "../runtime.ts";

const PROMOTE_WAIT_MS = 5000;
/** Other npi extensions (delegate) listen on this channel for the active route. */
export const ROUTE_CHANNEL = "npi:route";
/** Other extensions (checks) emit here when a turn struggled, so the next turn escalates a tier. */
export const STRUGGLE_CHANNEL = "npi:struggle";
/** Session entry that keeps /route and /tier pins across restarts. */
const PINS_ENTRY = "npi-router-pins";
/** Tool errors in one agent run that make the next turn go one tier up. */
const ESCALATE_AFTER_ERRORS = 3;
const THINKING_ORDER: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

/** light caps thinking at low; heavy raises it to at least high. */
export function tierThinking(base: ThinkingLevel | undefined, tier: Tier): ThinkingLevel | undefined {
	if (!base || tier === "standard") return base;
	const i = THINKING_ORDER.indexOf(base);
	return tier === "light" ? THINKING_ORDER[Math.min(i, 2)] : THINKING_ORDER[Math.max(i, 4)];
}

interface RouterState {
	route: string;
	model: string;
	tier?: Tier;
}

/**
 * Per prompt: decide a route (pin > #prefix > keywords > classifier > sticky > default), declare only
 * that route's tools (everything else stays reachable via tool_search), add its guideline, and, when the
 * selected model is `npi/auto`, dispatch to the route's first available model.
 */
export default function router(pi: ExtensionAPI) {
	const holder = runtimeHolder();
	let pinned: string | undefined;
	let pinnedTier: Tier | undefined;
	let prefixRoute: string | undefined;
	let prefixTier: Tier | undefined;
	let current: RouteDecision | undefined;
	let classifier: Classifier | undefined;
	let toolErrors = 0;
	let escalate = false;

	const savePins = () => pi.appendEntry(PINS_ENTRY, { pinned, pinnedTier });
	pi.events.on(STRUGGLE_CHANNEL, () => {
		escalate = true;
	});

	// MCP servers this session has connected on demand (registrations last for the session).
	const connected = new Set<string>();

	pi.on("session_start", (_event, ctx) => {
		holder.reset();
		connected.clear();
		// Warm the small classifier model (local servers load models lazily) so the first routing is fast.
		const rt = holder.get(ctx);
		if (rt.config.router.prewarm) {
			void firstAvailable(rt.llm, rt.config.router.classifierModels)
				.then((m) => {
					if (m?.startsWith("local/")) return rt.llm.complete(m, { messages: [userMessage("ok")], maxTokens: 1, thinking: "off" });
				})
				.catch(() => undefined);
		}
		classifier = undefined;
		current = undefined;
		escalate = false;
		const pins = latestEntry<{ pinned?: string; pinnedTier?: Tier }>(ctx, PINS_ENTRY);
		pinned = pins?.pinned && rt.config.routes[pins.pinned] ? pins.pinned : undefined;
		pinnedTier = pins?.pinnedTier;
	});

	function setStatus(ctx: ExtensionContext, model?: string) {
		if (!ctx.hasUI || !current) return;
		const how = current.reason === "classifier" ? `classifier ${current.confidence?.toFixed(2)}` : current.reason;
		const profile = holder.get(ctx).config.profile?.name;
		const tier = current.tier === "standard" ? "" : `·${current.tier}${current.tierReason === "escalated" ? "↑" : ""}`;
		ctx.ui.setStatus("npi-route", `${profile ? `[${profile}] ` : ""}route: ${current.route}${tier} (${how})${model ? ` → ${model}` : ""}`);
	}

	// Strip "#route " / "#heavy " (either order) so the model never sees routing prefixes.
	pi.on("input", (event, ctx) => {
		const routes = holder.get(ctx).config.routes;
		let text = event.text;
		for (let i = 0; i < 2; i++) {
			const tier = parseTierPrefix(text);
			if (tier) [prefixTier, text] = [tier.tier, tier.text];
			const route = parsePrefix(text, routes);
			if (route) [prefixRoute, text] = [route.route, route.text];
		}
		return text === event.text ? { action: "continue" } : { action: "transform", text, images: event.images };
	});

	pi.on("tool_execution_end", (event) => {
		if (event.isError) toolErrors++;
	});
	pi.on("agent_end", () => {
		if (toolErrors >= ESCALATE_AFTER_ERRORS) escalate = true;
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (event.messageType !== "user") {
			// Automatic follow-ups (e.g. failing checks) keep the route but may escalate the tier.
			if (escalate && current && !pinnedTier && current.tier !== "heavy") {
				current = { ...current, tier: escalateTier(current.tier), tierReason: "escalated" };
				setStatus(ctx);
			}
			escalate = false;
			return;
		}
		const rt = holder.get(ctx);
		classifier ??= createClassifier(rt.llm, rt.config);
		// Prompt templates expand after the input hook: honour a leading "#route"/"#tier" in the expanded text too.
		let expanded = event.prompt;
		for (let i = 0; i < 2; i++) {
			const t = parseTierPrefix(expanded);
			if (t) [prefixTier, expanded] = [prefixTier ?? t.tier, t.text];
			const r = parsePrefix(expanded, rt.config.routes);
			if (r) [prefixRoute, expanded] = [prefixRoute ?? r.route, r.text];
		}
		current = await decideRoute({
			text: expanded,
			config: rt.config,
			pinned,
			prefixRoute,
			previous: current?.route,
			classify: classifier,
			pinnedTier,
			prefixTier,
			previousTier: current?.tier,
			escalate,
		});
		prefixRoute = undefined;
		prefixTier = undefined;
		escalate = false;
		toolErrors = 0;

		const route = rt.config.routes[current.route];
		pi.events.emit(ROUTE_CHANNEL, current.route);
		pi.events.emit("npi:telemetry", {
			type: "route",
			route: current.route,
			reason: current.reason,
			confidence: current.confidence,
			tier: current.tier,
			tierReason: current.tierReason,
		});

		// Lazy MCP: connect this route's servers the first time it is used.
		for (const name of route.mcp ?? []) {
			const server = rt.config.mcpServers[name];
			if (connected.has(name) || !server) continue;
			try {
				pi.registerMcpServer(name, server as any);
				connected.add(name);
			} catch (error) {
				if (ctx.hasUI) ctx.ui.notify(`MCP server ${name}: ${(error as Error).message}`, "warning");
			}
		}

		// Only this route's skills are listed in the prompt (all remain usable via /skill:name).
		if (event.systemPromptOptions.skills) {
			event.systemPromptOptions.skills = routeSkills(rt.config, current.route, event.systemPromptOptions.skills);
		}

		// MCP servers connect in the background: give promoted tools a moment to register.
		const promote = route.promote ?? [];
		const registeredNow = () => new Set(pi.getAllTools().map((t) => t.name));
		for (let waited = 0; waited < PROMOTE_WAIT_MS && !promote.every((t) => registeredNow().has(t)); waited += 250) {
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
		pi.setActiveTools(routeTools(rt.config, current.route, registeredNow()));

		const guideline = route.prompt;
		const profilePrompt = rt.config.profile?.prompt;
		if (guideline || profilePrompt) {
			event.systemPromptOptions.sections = {
				...event.systemPromptOptions.sections,
				...(profilePrompt && { npi_profile: profilePrompt }),
				...(guideline && { npi_route: guideline }),
			};
		}
		setStatus(ctx);
	});

	pi.registerVirtualModel<RouterState>({
		provider: "npi",
		id: "auto",
		name: "npi auto-router",
		thinkingLevels: ["off", "low", "medium", "high"],
		async route(request, ctx) {
			const rt = holder.get(ctx);
			// Tool follow-ups and retries stay on the model that handled the turn (keeps prompt cache valid).
			const sticky = request.reason === "retry" ? request.failed : request.previous;
			// ...unless the tier was escalated since (e.g. a failing-checks follow-up): then re-route on purpose.
			const escalated = current?.tierReason === "escalated" && request.state?.tier !== current.tier;
			if (request.reason !== "user" && request.reason !== "direct" && sticky && !escalated) {
				return { model: sticky.model, thinkingLevel: sticky.thinkingLevel ?? request.thinkingLevel };
			}

			const routeName = current?.route ?? request.state?.route ?? rt.config.router.defaultRoute;
			const route = rt.config.routes[routeName] ?? rt.config.routes[rt.config.router.defaultRoute];
			const tier = current?.tier ?? request.state?.tier ?? "standard";
			const preferred = tierModels(route, tier);
			const ref = (await firstAvailable(rt.llm, preferred)) ?? (await firstAvailable(rt.llm, rt.config.routes[rt.config.router.defaultRoute].models));
			if (!ref) throw new Error(`No available model for route "${routeName}" (tier ${tier}; tried ${preferred.join(", ")})`);
			const { provider, id } = parseModelRef(ref);
			const model = ctx.modelRegistry.find(provider, id);
			if (!model) throw new Error(`Model ${ref} is not in the catalog`);

			setStatus(ctx, ref);
			const thinkingLevel = request.thinkingLevel === "off" ? "off" : (tierThinking(route.thinking, tier) ?? request.thinkingLevel);
			const same = request.state?.route === routeName && request.state.model === ref && request.state.tier === tier;
			const state = same ? undefined : { route: routeName, model: ref, tier };
			return { model, thinkingLevel, state };
		},
	});

	pi.registerCommand("route", {
		description: "Pin a route (/route code), return to automatic routing (/route auto), or show the current route",
		handler: async (args, ctx) => {
			const routes = holder.get(ctx).config.routes;
			const name = args.trim();
			if (!name) {
				ctx.ui.notify(`route: ${pinned ?? current?.route ?? "none yet"}${pinned ? " (pinned)" : ""}. Routes: ${Object.keys(routes).join(", ")}`, "info");
			} else if (name === "auto") {
				pinned = undefined;
				savePins();
				ctx.ui.notify("Automatic routing", "info");
			} else if (routes[name]) {
				pinned = name;
				savePins();
				ctx.ui.notify(`Pinned route: ${name}`, "info");
			} else {
				ctx.ui.notify(`Unknown route "${name}". Routes: ${Object.keys(routes).join(", ")}`, "error");
			}
		},
	});

	pi.registerCommand("tier", {
		description: "Pin the effort tier (/tier light|standard|heavy), return to automatic (/tier auto), or show it",
		handler: async (args, ctx) => {
			const arg = args.trim();
			if (!arg) {
				if (pinnedTier) return ctx.ui.notify(`tier: ${pinnedTier} (pinned; /tier auto to unpin)`, "info");
				return ctx.ui.notify(current ? `tier: ${current.tier} (${current.tierReason})` : "tier: automatic (no request routed yet)", "info");
			}
			if (arg === "auto") pinnedTier = undefined;
			else if (TIERS.includes(arg as Tier)) pinnedTier = arg as Tier;
			else return ctx.ui.notify(`Usage: /tier [${TIERS.join("|")}|auto]`, "error");
			savePins();
			ctx.ui.notify(pinnedTier ? `Pinned tier: ${pinnedTier}` : "Automatic tier", "info");
		},
	});

	pi.registerCommand("routes", {
		description: "List routes with their models and tools",
		handler: async (_args, ctx) => {
			const { routes, profile } = holder.get(ctx).config;
			const header = profile ? `profile: ${profile.name}${profile.description ? ` (${profile.description})` : ""}\n` : "profile: none (all routes)\n";
			const lines = Object.entries(routes).map(
				([name, r]) => `${name}${name === current?.route ? " ◀" : ""}\n    ${r.description}\n    models: ${r.models.join(" > ")}${r.tiers?.light ? `\n    light: ${r.tiers.light.join(" > ")}` : ""}${r.tiers?.heavy ? `\n    heavy: ${r.tiers.heavy.join(" > ")}` : ""}\n    tools: ${[...r.tools, ...(r.promote ?? [])].join(", ") || "(always-on only)"}`,
			);
			ctx.ui.notify(header + lines.join("\n"), "info");
		},
	});
}
