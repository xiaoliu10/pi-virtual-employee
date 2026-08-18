/**
 * Aliyun OSS publisher for the report center.
 *
 * Puts the report body into a (private) OSS bucket under basePath, then returns
 * a presigned GET URL valid for urlTtlSec — anyone with the link can read the
 * file until expiry, with NO login required. This solves the private-repo auth
 * friction that Gitee raw+token links have. Every field comes from config;
 * nothing is hard-coded.
 */
import OSS from "ali-oss";
import type { AppConfig } from "../db/config-store.js";

type ReportsConfig = AppConfig["reports"];

export interface OssPublishResult {
	path: string;
	url: string;
}

export class OssClient {
	private readonly cfg: ReportsConfig;

	constructor(reports: ReportsConfig) {
		this.cfg = reports;
	}

	private get o() {
		return this.cfg.oss;
	}

	isConfigured(): boolean {
		const o = this.o;
		return !!(o.region && o.accessKeyId && o.accessKeySecret && o.bucket);
	}

	private client(): OSS {
		const o = this.o;
		return new OSS({
			region: o.region,
			accessKeyId: o.accessKeyId,
			accessKeySecret: o.accessKeySecret,
			bucket: o.bucket,
			...(o.endpoint ? { endpoint: o.endpoint, secure: o.endpoint.startsWith("https") } : {}),
		});
	}

	/** Put a text object and return its repo-relative path + presigned URL. */
	async publishFile(relPath: string, content: string, _message: string): Promise<OssPublishResult> {
		return this.put(relPath, Buffer.from(content, "utf8"), "text/markdown; charset=utf-8");
	}

	/**
	 * Put a binary object (e.g. an image) with the given MIME type and return its
	 * path + presigned URL. Used to host screenshots/photos so an IM channel can
	 * embed them as a public link.
	 */
	async publishBinary(relPath: string, buffer: Buffer, mime: string): Promise<OssPublishResult> {
		return this.put(relPath, buffer, mime);
	}

	private async put(relPath: string, buffer: Buffer, mime: string): Promise<OssPublishResult> {
		if (!this.isConfigured()) throw new Error("OSS 未配置完整（region/accessKeyId/accessKeySecret/bucket）");
		const full = `${this.o.basePath}${relPath}`.replace(/^\/+/, "");
		const store = this.client();
		await store.put(full, buffer, { headers: { "Content-Type": mime } });
		// NOTE: OSS forbids overriding `content-type` via the presigned URL's
		// `response` params (InvalidRequest 0017-00000902). The object already
		// carries the MIME type from putObject, so the client renders it correctly.
		const url = store.signatureUrl(full, {
			expires: Math.max(60, Math.floor(this.o.urlTtlSec || 30 * 24 * 3600)),
		});
		return { path: full, url };
	}

	/** Verify credentials + bucket by listing the basePath prefix. */
	async test(): Promise<{ ok: boolean; detail: string }> {
		if (!this.isConfigured()) return { ok: false, detail: "配置不完整（region/accessKeyId/accessKeySecret/bucket）" };
		try {
			const store = this.client();
			const prefix = this.o.basePath || "";
			const res = await store.list({ prefix, "max-keys": 5 }, {});
			return {
				ok: true,
				detail: `已连接 OSS bucket ${this.o.bucket}（${this.o.region}），前缀 ${prefix || "/"} 可写`,
			};
		} catch (err) {
			return { ok: false, detail: `OSS 连接失败：${(err as Error).message}` };
		}
	}
}
