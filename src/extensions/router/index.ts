import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { firstAvailable, parseModelRef, userMessage } from "../../core/llm.ts";
import { type Classifier, decideRoute, llmClassifier, parsePrefix, type RouteDecision, routeSkills, routeTools } from "../../core/router.ts";
import { runtimeHolder } from "../runtime.ts";

const PROMOTE_WAIT_MS = 5000;
/** Other npi extensions (delegate) listen on this channel for the active route. */
export const ROUTE_CHANNEL = "npi:route";

interface RouterState {
	route: string;
	model: string;
}

/**
 * Per prompt: decide a route (pin > #prefix > keywords > classifier > sticky > default), declare only
 * that route's tools (everything else stays reachable via tool_search), add its guideline, and, when the
 * selected model is `npi/auto`, dispatch to the route's first available model.
 */
export default function router(pi: ExtensionAPI) {
	const holder = runtimeHolder();
	let pinned: string | undefined;
	let prefixRoute: string | undefined;
	let current: RouteDecision | undefined;
	let classifier: Classifier | undefined;

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
	});

	function setStatus(ctx: ExtensionContext, model?: string) {
		if (!ctx.hasUI || !current) return;
		const how = current.reason === "classifier" ? `classifier ${current.confidence?.toFixed(2)}` : current.reason;
		ctx.ui.setStatus("npi-route", `route: ${current.route} (${how})${model ? ` → ${model}` : ""}`);
	}

	// Strip "#route " so the model never sees the routing prefix.
	pi.on("input", (event, ctx) => {
		const routes = holder.get(ctx).config.routes;
		const prefix = parsePrefix(event.text, routes);
		if (!prefix) return { action: "continue" };
		prefixRoute = prefix.route;
		return { action: "transform", text: prefix.text, images: event.images };
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (event.messageType !== "user") return;
		const rt = holder.get(ctx);
		classifier ??= llmClassifier(rt.llm, rt.config);
		current = await decideRoute({
			text: event.prompt,
			config: rt.config,
			pinned,
			prefixRoute,
			previous: current?.route,
			classify: classifier,
		});
		prefixRoute = undefined;

		const route = rt.config.routes[current.route];
		pi.events.emit(ROUTE_CHANNEL, current.route);
		pi.events.emit("npi:telemetry", { type: "route", route: current.route, reason: current.reason, confidence: current.confidence });

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
		if (guideline) {
			event.systemPromptOptions.sections = { ...event.systemPromptOptions.sections, npi_route: guideline };
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
			if (request.reason !== "user" && request.reason !== "direct" && sticky) {
				return { model: sticky.model, thinkingLevel: sticky.thinkingLevel ?? request.thinkingLevel };
			}

			const routeName = current?.route ?? request.state?.route ?? rt.config.router.defaultRoute;
			const route = rt.config.routes[routeName] ?? rt.config.routes[rt.config.router.defaultRoute];
			const ref = (await firstAvailable(rt.llm, route.models)) ?? (await firstAvailable(rt.llm, rt.config.routes[rt.config.router.defaultRoute].models));
			if (!ref) throw new Error(`No available model for route "${routeName}" (tried ${route.models.join(", ")})`);
			const { provider, id } = parseModelRef(ref);
			const model = ctx.modelRegistry.find(provider, id);
			if (!model) throw new Error(`Model ${ref} is not in the catalog`);

			setStatus(ctx, ref);
			const thinkingLevel = request.thinkingLevel === "off" ? "off" : (route.thinking ?? request.thinkingLevel);
			const state = request.state?.route === routeName && request.state.model === ref ? undefined : { route: routeName, model: ref };
			return { model, thinkingLevel, state };
		},
	});

	pi.registerCommand("route", {
		description: "Pin a route (/route code), return to automatic routing (/route auto), or show the current route",
		handler: async (args, ctx) => {
			const routes = holder.get(ctx).config.routes;
			const name = args.trim();
			if (!name) {
				ctx.ui.notify(`route: ${current?.route ?? "none yet"}${pinned ? " (pinned)" : ""}. Routes: ${Object.keys(routes).join(", ")}`, "info");
			} else if (name === "auto") {
				pinned = undefined;
				ctx.ui.notify("Automatic routing", "info");
			} else if (routes[name]) {
				pinned = name;
				ctx.ui.notify(`Pinned route: ${name}`, "info");
			} else {
				ctx.ui.notify(`Unknown route "${name}". Routes: ${Object.keys(routes).join(", ")}`, "error");
			}
		},
	});

	pi.registerCommand("routes", {
		description: "List routes with their models and tools",
		handler: async (_args, ctx) => {
			const { routes } = holder.get(ctx).config;
			const lines = Object.entries(routes).map(
				([name, r]) => `${name}${name === current?.route ? " ◀" : ""}\n    ${r.description}\n    models: ${r.models.join(" > ")}\n    tools: ${[...r.tools, ...(r.promote ?? [])].join(", ") || "(always-on only)"}`,
			);
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
