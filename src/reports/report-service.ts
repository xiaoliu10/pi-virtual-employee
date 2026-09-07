/**
 * ReportService — orchestrates the report / artifact center.
 *
 * A producer (the scheduled-task runner) calls startRun() before the LLM turn
 * and completeRun() after, so the run records the real duration. publish()
 * then pushes the body to Gitee and records the shareable link.
 *
 * GUI helpers (list/get/runs/body/url/delete) back the 产物中心 tab.
 *
 * Publish failures are contained: the local run/attachment is always kept, and
 * publish() returns null instead of throwing, so a Gitee outage never breaks
 * the main task chain — only the IM push then omits the link.
 */
import type { AppConfig, ConfigStore } from "../db/config-store.js";
import { ArtifactStore, type ArtifactSource, type RunStatus, type AttachmentType, type Artifact, type ArtifactRun, type ArtifactAttachment } from "../db/artifact-store.js";
import { GiteeClient } from "./gitee-client.js";
import { OssClient } from "./oss-client.js";
import { renderReportHtml } from "./markdown-html.js";

interface Publisher {
	isConfigured(): boolean;
	publishFile(relPath: string, content: string, message: string, mime?: string): Promise<{ path: string; url: string }>;
	publishBinary(relPath: string, buffer: Buffer, message: string): Promise<{ path: string; url: string }>;
}

function pickPublisher(reports: AppConfig["reports"]): Publisher | null {
	if (reports.target === "oss") return new OssClient(reports) as unknown as Publisher;
	return new GiteeClient(reports) as unknown as Publisher;
}

/** Keep an uploaded image's filename URL-safe (no spaces / path separators / weird chars). */
function sanitizeFileName(name: string): string {
	const cleaned = name
		.replace(/[\\/:*?"<>|\s]+/g, "-")
		.replace(/-{2,}/g, "-")
		.replace(/^[-.]+|[-.]+$/g, "")
		.slice(0, 80);
	return cleaned || "image.png";
}

export interface StartRunInput {
	source: ArtifactSource;
	sourceRef: string | null;
	title: string;
	summary?: string | null;
	trigger?: string;
	inputRef?: string | null;
}

export interface CompleteRunInput {
	status: RunStatus;
	content: string;
	contentType?: AttachmentType;
	summary?: string | null;
	error?: string | null;
	metrics?: Record<string, unknown> | null;
}

export interface PublishOutcome {
	/** Preferred share link — the styled HTML version when it uploaded, else the raw body link. */
	url: string;
	path: string;
	/** Raw markdown link (always present when the .md upload succeeded). */
	mdUrl?: string;
}

export class ReportService {
	constructor(
		private readonly store: ArtifactStore,
		private readonly config: ConfigStore,
	) {}

	/** Create (or reuse) the artifact + open a running run. Call before the LLM turn. */
	startRun(input: StartRunInput): { artifactId: string; runId: string } {
		const artifact = this.store.upsertBySource({
			source: input.source,
			sourceRef: input.sourceRef,
			title: input.title,
			summary: input.summary ?? null,
		});
		const run = this.store.createRun({
			artifactId: artifact.id,
			trigger: input.trigger ?? "cron",
			status: "running",
			inputRef: input.inputRef ?? null,
		});
		return { artifactId: artifact.id, runId: run.id };
	}

	/** Close the run with status + body attachment. Call after the LLM turn. */
	completeRun(runId: string, input: CompleteRunInput): void {
		this.store.finishRun(runId, input.status, {
			error: input.error ?? null,
			summary: input.summary ?? null,
			metrics: input.metrics ?? null,
		});
		this.store.createAttachment({
			runId,
			type: input.contentType ?? "markdown",
			content: input.content,
			mime: (input.contentType ?? "markdown") === "markdown" ? "text/markdown" : "text/html",
		});
	}

	/**
	 * Push the run body to the publisher and record the link. The raw markdown
	 * goes up first (the artifact of record), then a styled HTML rendition of
	 * the same body — a browser shows a bare .md as an unstyled text wall, and
	 * the link the employee hands out should open as a readable report. The
	 * HTML link is returned as the primary URL when it uploaded; an HTML
	 * failure never fails the publish (md link is the fallback).
	 *
	 * Returns null when reports are disabled, unconfigured, or publishing
	 * failed (failure is logged, not thrown — see file header).
	 */
	async publish(runId: string, title: string, content: string): Promise<PublishOutcome | null> {
		const reports = this.config.all().reports;
		if (!reports.enabled) return null;
		const client = pickPublisher(reports);
		if (!client || !client.isConfigured()) return null;
		const artifact = this.artifactOfRun(runId);
		const relPath = `${artifact?.id ?? "misc"}/${runId}.md`;
		const message = `report: ${title.slice(0, 60)}`;
		try {
			const res = await client.publishFile(relPath, content, message);
			let url = res.url;
			let path = res.path;
			try {
				const html = await client.publishFile(
					relPath.replace(/\.md$/, ".html"),
					renderReportHtml(title, content),
					message,
					"text/html; charset=utf-8",
				);
				url = html.url;
				path = html.path;
			} catch (htmlErr) {
				console.warn(`[reports] HTML rendition failed for run ${runId} (sharing raw markdown link):`, (htmlErr as Error).message);
			}
			this.store.createPublish({ runId, target: reports.target, url, path, status: "ok" });
			return { url, path, mdUrl: res.url };
		} catch (err) {
			const error = (err as Error).message;
			console.warn(`[reports] publish (${reports.target}) failed for run ${runId}:`, error);
			this.store.createPublish({ runId, target: reports.target, url: null, path: null, status: "error", error });
			return null;
		}
	}

	/**
	 * Upload an image (or any binary) to the configured publisher and return a
	 * public URL, WITHOUT creating a report artifact/run. Used to host screenshots
	 * and user-visible photos so an IM channel can send them as inline images.
	 * Returns null (never throws) when reports are disabled/unconfigured or the
	 * upload fails — callers fall back to a text notice.
	 */
	async publishImage(buffer: Buffer, mime: string, name: string): Promise<{ url: string; path: string } | null> {
		const reports = this.config.all().reports;
		if (!reports.enabled) return null;
		const client = pickPublisher(reports);
		if (!client || !client.isConfigured()) return null;
		const relPath = `images/${Date.now()}-${sanitizeFileName(name)}`;
		try {
			const res = await client.publishBinary(relPath, buffer, `image: ${name.slice(0, 60)}`);
			return { url: res.url, path: res.path };
		} catch (err) {
			console.warn(`[reports] publishImage (${reports.target}) failed:`, (err as Error).message);
			return null;
		}
	}

	/** Verify the configured publisher target (for the settings "test" button). */
	async testTarget(): Promise<{ ok: boolean; detail: string }> {
		const reports = this.config.all().reports;
		if (reports.target === "oss") return new OssClient(reports).test();
		return new GiteeClient(reports).testRepo();
	}

	/** Verify the configured Gitee repo + write token. */
	async testGitee(): Promise<{ ok: boolean; detail: string }> {
		return new GiteeClient(this.config.all().reports).testRepo();
	}

	/** Verify OSS credentials + bucket. */
	async testOss(): Promise<{ ok: boolean; detail: string }> {
		return new OssClient(this.config.all().reports).test();
	}

	/** Re-push an existing run's body to Gitee (e.g. after fixing the config). */
	async republish(runId: string): Promise<PublishOutcome | null> {
		const body = this.store.runBody(runId);
		if (!body?.content) return null;
		const artifact = this.artifactOfRun(runId);
		return this.publish(runId, artifact?.title ?? "report", body.content);
	}

	// --- GUI helpers ---

	listArtifacts(): Artifact[] {
		return this.store.listArtifacts();
	}

	getArtifact(id: string): Artifact | undefined {
		return this.store.getArtifact(id);
	}

	listRuns(artifactId: string): ArtifactRun[] {
		return this.store.listRuns(artifactId);
	}

	runBody(runId: string): ArtifactAttachment | undefined {
		return this.store.runBody(runId);
	}

	runUrl(runId: string): string | null {
		return this.store.latestPublishUrl(runId);
	}

	deleteArtifact(id: string): void {
		this.store.deleteArtifact(id);
	}

	/** Resolve the artifact a run belongs to (used to derive a stable repo path). */
	private artifactOfRun(runId: string): Artifact | undefined {
		const run = this.store.getRun(runId);
		return run ? this.store.getArtifact(run.artifactId) : undefined;
	}
}
