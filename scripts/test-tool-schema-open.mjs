/**
 * Tool schemas must stay OPEN after the pi-durable 1.5.0 migration.
 *
 * 1.5.0 replaced TypeBox's `Type.Object` with pi-schema's `obj()`. The two are
 * NOT equivalent: `obj()` is CLOSED by default (`additionalProperties: false`),
 * while `Type.Object` was open. Left unadjusted, every tool call the model makes
 * with an extra field would be rejected by schema validation — a silent
 * behaviour regression across all 60+ tools that no other test would notice.
 *
 * This test pins the observable contract: schemas built by buildTools accept
 * extra properties, matching pre-migration behaviour.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const outDir = join(root, "node_modules/.schema-open-probe");
mkdirSync(outDir, { recursive: true });
const bundle = join(outDir, "b.mjs");
await build({
	stdin: { contents: `export { buildTools } from "./src/engine/definition.ts";`, resolveDir: root, loader: "ts" },
	outfile: bundle, bundle: true, platform: "node", format: "esm", packages: "external", logLevel: "silent",
});
const { buildTools } = await import(pathToFileURL(bundle).href + `?t=${Date.now()}`);

const fakeConfig = {
	all: () => ({
		security: { defaultRole: "admin", adminStaffIds: [], ownerStaffIds: [], people: [], conversations: [] },
		capabilities: {},
		kb: { enabled: false, learn: { enabled: false }, manage: { enabled: false }, research: { enabled: false } },
		browser: { enabled: false }, computer: { enabled: false }, scheduler: { enabled: false },
		documents: { enabled: false }, filesystem: { enabled: false }, reports: { enabled: false },
		downloads: { enabled: false }, skills: { disabled: [] },
	}),
};

const tools = buildTools({
	config: fakeConfig,
	conversationId: "dt:group:x",
	resolveActor: () => ({ senderId: "u1", senderName: "u1" }),
	resolveMemoryContext: () => ({}),
});

test("every object tool schema stays open (extra model args are not rejected)", () => {
	const closed = tools.filter((t) => {
		const s = t.parameters;
		return s && s.type === "object" && s.additionalProperties === false;
	});
	assert.deepEqual(
		closed.map((t) => t.name),
		[],
		`these tools became closed after the pi-schema migration (would reject extra args): ${closed.map((t) => t.name).join(", ")}`,
	);
});

test("the schema surface is non-trivial (guards against a vacuous pass)", () => {
	const objects = tools.filter((t) => t.parameters?.type === "object");
	assert.ok(objects.length >= 10, `expected many object schemas, saw ${objects.length}`);
	// At least one must declare properties, else "all open" proves nothing.
	assert.ok(objects.some((t) => Object.keys(t.parameters.properties ?? {}).length > 0));
});
