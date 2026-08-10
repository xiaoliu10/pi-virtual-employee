/**
 * Directly exercise the engine (bypass GUI + HTTP transport) to diagnose the
 * model path: config → resolveModel → new Agent → prompt → reply/error.
 *
 * Usage: npx tsx scripts/direct-test.mjs [provider modelId baseUrl apiKey]
 * Defaults read from the current config store (SQLite).
 */
import { Agent } from "@earendil-works/pi-agent-core";
import { createModels } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";

const [provider, modelId, baseUrl, apiKey] = process.argv.slice(2);

async function main(): Promise<void> {
	const models = createModels();
	for (const p of builtinProviders()) models.setProvider(p);

	const m = models.getModel(provider, modelId);
	if (!m) {
		console.error(`no model ${provider}/${modelId}`);
		process.exit(1);
	}
	const model = baseUrl ? { ...m, baseUrl } : m;
	console.log(`model: ${model.id} api=${model.api} baseUrl=${model.baseUrl}`);

	const streamFn = (mdl: any, ctx: any, opts: any) =>
		models.streamSimple(mdl, ctx, { ...opts, timeoutMs: 6000 });

	const agent = new Agent({
		initialState: { systemPrompt: "You are helpful. Reply in 2 words.", model, tools: [] },
		streamFn,
		getApiKey: () => apiKey,
	});

	agent.subscribe((e) => {
		if (e.type === "message_end" && (e.message as any).role === "assistant") {
			const mm = e.message as any;
			console.log(`[message_end] stopReason=${mm.stopReason} errorMessage=${mm.errorMessage ?? "none"}`);
		}
		if (e.type === "agent_end") console.log("[agent_end]");
		if (e.type === "tool_execution_start") console.log(`[tool] ${e.toolName}`);
	});

	console.log("prompting…");
	const t0 = Date.now();
	const timer = setTimeout(() => {
		console.error(`TIMEOUT after 9s (state.errorMessage=${agent.state.errorMessage ?? "none"})`);
		process.exit(2);
	}, 9000);
	await agent.prompt("say hi");
	clearTimeout(timer);
	console.log(`prompt() returned in ${((Date.now() - t0) / 1000).toFixed(1)}s; state.errorMessage=${agent.state.errorMessage ?? "none"}`);
	const last = agent.state.messages[agent.state.messages.length - 1];
	console.log("last message role:", last?.role);
	process.exit(0);
}

main().catch((e) => {
	console.error("THREW:", e instanceof Error ? e.message : e);
	process.exit(3);
});
