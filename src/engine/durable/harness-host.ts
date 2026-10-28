/**
 * Durable host for a VE conversation — the crash-recovery path.
 *
 * WHY: the legacy kernel keeps an execution in memory (`Engine.send` runs the
 * whole turn loop and only the user/assistant messages reach SQLite). A crash or
 * an upgrade mid-turn therefore loses "how far did it get": the model is handed
 * back its old Q&A, not a resumable execution. This host wraps the same VE tools
 * in a durable Harness, which commits every model turn, tool intent and tool
 * result BEFORE showing it — so a restarted process picks the work up.
 *
 * SCOPE (phase 1, gray rollout): ONE conversation at a time, chosen by the
 * caller. The legacy path stays the default; nothing here is reachable unless a
 * caller explicitly opens a host.
 *
 * STORAGE ISOLATION: durable states "one process owns a storage at a time, no
 * cross-process locking", and VE already runs several profiles per machine. Each
 * profile therefore gets its own database file under its userData dir — never a
 * shared path (the same class of bug that made two profiles fight over the
 * updater cache, the DingTalk messages and work-item deletion).
 */
import { join } from "node:path";
import { mkdirSync } from "node:fs";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, type Models } from "@earendil-works/pi-ai/models";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
	Harness,
	createRegistry,
	defineExtension,
	type Extension,
	type ToolRegistration,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

import { toDurableTools } from "./ve-tools.js";
import { createDurableSettleGate } from "./ve-settle-gate.js";
import { createInterruptedToolNotice } from "./interrupted-notice.js";

export interface DurableHostOptions {
	/** Profile-scoped data directory (app.getPath("userData")). */
	userDataDir: string;
	/** Profile name — part of the database filename, so profiles never share a store. */
	profileName: string;
	/** VE tools to expose; adapted by `ve-tools.ts` (replay policy applied there). */
	tools: AgentTool<any>[];
	models?: Models;
	registrations?: ToolRegistration<any, any>[];
	/** Extra durable extensions (plugin host). */
	extensions?: Extension[];
	/** Disable the settle gate (tests / eval runs). */
	settleGate?: boolean;
}

export interface DurableHost {
	harness: Harness;
	/** Resume any run the previous process left unfinished. Call once after open. */
	resume(): void;
	/** Close cleanly; waits for running task code to return. */
	close(): Promise<void>;
	/** Absolute path of this profile's durable database. */
	databasePath: string;
	/** Underlying storage — same single-owner handle the Harness runs on, for reads the Harness does not expose (e.g. scanning submissions on startup). */
	storage: Awaited<ReturnType<typeof openNodeSqliteStorage>>;
}

/**
 * Database file for one profile. Exported for tests and diagnostics.
 *
 * Profile names come from a directory name, which a user can rename freely, so
 * the sanitization must also collapse `..` runs — a name like "../evil" would
 * otherwise produce a path that still contains a parent segment and could write
 * outside the data dir. Leading dots are stripped for the same reason.
 */
export function durableDatabasePath(userDataDir: string, profileName: string): string {
	const safe = (profileName || "default")
		.replace(/[^a-zA-Z0-9._-]/g, "_")
		.replace(/\\.{2,}/g, ".") // collapse ".." so no parent segment survives
		.replace(/^\.+/, "") // never start with a dot (hidden file / traversal idiom)
		.slice(0, 64) || "default";
	return join(userDataDir, `durable-${safe}.sqlite`);
}

/**
 * Open (or create) the durable host for this profile.
 *
 * `models` is deliberately VE's own model catalog: the Harness only needs a
 * `Models` instance to issue requests, and VE resolves credentials/providers in
 * its own layer — this function must not become a second auth path.
 */
export async function openDurableHost(opts: DurableHostOptions): Promise<DurableHost> {
	const models = opts.models ?? createModels();
	const registry = createRegistry();

	const tools: ToolRegistration<any, any>[] = opts.registrations ?? toDurableTools(opts.tools);
	const extensions: Extension[] = [
		defineExtension({ name: "ve-tools", tools }),
		// Rewrite durable's one-line "interrupted" results into an instruction that
		// tells the model to VERIFY instead of retry (phase 3).
		createInterruptedToolNotice(),
		...(opts.settleGate === false ? [] : [createDurableSettleGate()]),
		...(opts.extensions ?? []),
	];
	for (const extension of extensions) registry.install(extension);

	mkdirSync(opts.userDataDir, { recursive: true });
	const databasePath = durableDatabasePath(opts.userDataDir, opts.profileName);
	const storage = await openNodeSqliteStorage(databasePath);
	const harness = await Harness.open(storage, { models, registry }, BACKGROUND_CONTEXT);

	return {
		harness,
		storage,
		databasePath,
		resume: () => harness.resume(),
		close: () => harness.close(BACKGROUND_CONTEXT),
	};
}
