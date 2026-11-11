/**
 * Credential egress gate for outbound IM text.
 *
 * Field incident (2026-10-20): the employee pasted an account password into a
 * GROUP chat while troubleshooting a login failure. The employee is supposed to
 * use credentials internally (auto-login, form filling) and never print them —
 * the prompt says so — but a prompt rule is a suggestion, not a gate. This
 * module is the mechanical gate: outbound text is scanned before delivery.
 *
 * EVOLUTION (user ruling 2026-11-11, field: the spay-login completion reply was
 * withheld whole): whole-message withholding destroyed useful replies over one
 * embedded credential. The gate now REDACTS in place — labels stay readable
 * (「密码：****」「sk-****」), values are masked, a short suffix note says how many
 * spots were masked — and delivers. Fail-closed withholding remains the
 * FALLBACK for anything that still trips detection after masking.
 *
 * Deliberate design choices:
 *  - Only CONCRETE values are gated. Merely talking about credentials
 *    (「密码最近变更过吗」, 「验证码过期了」, 「知识库里有密码」) must pass through, or
 *    every legitimate troubleshooting reply gets nuked.
 *  - Mask keeps the label/prefix, never the value: identification without the
 *    secret (the old header feared 「masking still tells which account」 — the
 *    ruling accepts that trade-off; a re-ask beats a dead message).
 *  - Scope is TEXT egress. File/image payloads (and their filenames/URLs) are
 *    not inspected (documented limitation, not an oversight) and a heuristic
 *    detector is not a semantic DLP: an unlabeled free-form secret in prose, or
 *    a value split by spaces, can still slip through.
 *  - 验证码 is deliberately NOT a gated label: the waiting_human flow invites
 *    users to send codes IN the same chat, so by the time the employee echoes
 *    one the code has already transited that conversation.
 *  - Credential-bearing URL query params (report-share links) are redacted in
 *    place instead of nuking the message — see redactUrlCredentialParams.
 */

/** What the requester is allowed to see. */
export type CredentialAudience = "admin-single" | "restricted";

export const CREDENTIAL_WITHHELD_NOTICE =
	"⚠️ 这条回复含账号密码/密钥等敏感凭据，已按安全规定拦下，未发送明文。\n如需核对凭据，请管理员在单聊中获取。";

/** Suffix appended to a masked delivery (v0.2.225: redact-don't-block). {count}
 * is the number of masked spots. */
export const CREDENTIAL_MASKED_SUFFIX =
	"\n\n⚠️ 检测到敏感凭据 {count} 处，已脱敏发送；如需核对，请管理员在单聊中获取。";

/** Label words that, followed by a concrete value, mean a real credential. */
const SECRET_LABELS_ZH = [
	"密码", "口令", "密钥", "秘钥", "令牌", "凭据", "凭证",
	"访问密钥", "私钥", "授权码",
];
const SECRET_LABELS_EN = [
	"password", "passwd", "passphrase", "pwd", "secret",
	"api[-_ ]?key", "apikey", "access[-_ ]?key", "private[-_ ]?key",
	"client[-_ ]?secret", "token", "credential", "auth[-_ ]?token",
];

/**
 * A value that is "concrete enough" to be a credential. Bare words like
 * 「已变更」/「不知道」 fail this and are treated as prose. Wrapping quotes,
 * backticks and brackets are stripped first so "abc_123" counts as one value
 * (review P1: an underscore/quote mid-value used to truncate the capture
 * below 6 chars and bypass the gate).
 *
 * Qualifies when ANY of: mixed letters+digits/symbol (machine-style), a digit
 * run of 8+ (numeric PIN/password — the exact field case), or a letter run of
 * 12+ (long alpha passphrase without digits).
 */
function looksLikeSecretValue(raw: string): boolean {
	const v = raw.trim().replace(/^[`'“”‘’「」『』(（[【]+/, "").replace(/[`'“”‘’」』)）\]】,，。;；]+$/, "");
	if (v.length < 6 || v.length > 200) return false;
	if (/\s/.test(v)) return false;
	const hasDigitSymbol = /[0-9!@#$%^&*()_+=~<>?/\\|{}[\]:;"'.,-]/.test(v);
	const hasLetter = /[A-Za-z]/.test(v);
	if (hasDigitSymbol && hasLetter) return true;
	if (/[0-9]{8,}/.test(v)) return true; // numeric PIN / digit-only password
	if (/[A-Za-z]{12,}/.test(v)) return true; // long alpha passphrase
	return false;
}

/** Build the "label + concrete value" patterns once. */
const LABEL_VALUE_PATTERNS: RegExp[] = [];
for (const label of [...SECRET_LABELS_ZH, ...SECRET_LABELS_EN]) {
	// Separator form: 密码：xxx / 密码是 xxx / 密码还是 xxx / password: xxx / **密码**：`xxx`
	// 0x60 = backtick, kept as an escape so the character class stays readable.
	LABEL_VALUE_PATTERNS.push(new RegExp(
		String.raw`(?<![A-Za-z0-9_])(?:${label})[^\n]{0,12}?(?:[:：=]|是|为|还是|改成|改为|变成|重置成|重设为|修改成)\s*[*_\x60"'“”「『(（]*(\S{6,200})`,
		"iu",
	));
	// Verb-first form: 正在用密码 xxx 登录 / 拿 token xxx 调接口 / 输入口令 xxx.
	// No colon or 是 here — the verb + label is the separator.
	LABEL_VALUE_PATTERNS.push(new RegExp(
		String.raw`(?<![A-Za-z0-9_])(?:用|拿|以|输入|填入|填|试试|尝试|带上|附上)\s*(?:${label})\s*[:：=]?\s*[*_\x60"'“”「『(（]*(\S{6,200})`,
		"iu",
	));
}

/** Credential-bearing URL query-param name list (shared source, see below). */
const URL_TOKEN_PARAM_SOURCE_BODY =
	"(?:password|passwd|pwd|secret|token|api_?key|apikey|access_?token|access_?key|OSSAccessKeyId|Signature|X-Amz-Signature|X-Amz-Credential)";

/**
 * Presigned object-storage URLs (report links the system itself generates via
 * save_report → OSS signatureUrl) are an exception to the query-param redaction:
 * their query IS the access grant. OSSAccessKeyId is a key ID (not the secret),
 * Signature is an HMAC over the request — the AccessKeySecret never travels in
 * a URL — so the triple is a bearer access credential, not a leaked password.
 * Field 2026-10-27: redacting Signature/AccessKeyId in group pushes delivered
 * dead report links (private chats were exempt, hence "works for me" reports).
 * A Gitee raw_with_token URL is the OPPOSITE case and stays redacted: its
 * access_token is a long-lived personal token with API-wide scope.
 *
 * The exemption is TWO-FACTOR (review P1/P2): only the grant-carrying param
 * ASSIGNMENTS (name+value) inside the URL are exempt — any other credential param in the same
 * URL (access_token, password, ...) is redacted as usual, so a fake
 * "&OSSAccessKeyId=x&Signature=y" marker cannot smuggle a credential URL
 * through; and only aliyuncs.com/amazonaws.com hosts qualify, so "Signature="
 * on an arbitrary host is never mistaken for a grant.
 */
/**
 * Extra hosts the deployment itself publishes report links on (v0.2.175).
 *
 * The default allowlist below is the two cloud object-storage domains. But
 * `reports.oss.endpoint` is configurable — its own docs name "an internal/CDN
 * domain" as a supported value — and a deployment pointing OSS at a custom
 * host (CNAME, CDN, self-hosted MinIO) produced presigned links on a host the
 * gate refused to recognise, so every report link in a group was redacted
 * (field 2026-10-29, box agent "orion"). The gate cannot hard-code what the
 * config declares; main.ts seeds this from `config.reports.oss.endpoint`.
 *
 * Security note: this only widens WHICH host may carry a grant, never the
 * grant shape. The two-factor rule stays — a host listed here still needs the
 * matching param pair AND every non-grant credential param is still redacted.
 */
const configuredReportHosts = new Set<string>();

/** Register hosts (from config, never from message content) whose presigned URLs are legitimate. */
export function setConfiguredReportHosts(hosts: Iterable<string>): void {
	configuredReportHosts.clear();
	for (const raw of hosts) {
		const host = hostFrom(raw);
		if (host) configuredReportHosts.add(host);
	}
}

function hostFrom(raw: string | undefined | null): string {
	const value = raw?.trim();
	if (!value) return "";
	try {
		// Accept a bare host ("oss.example.com") or a full endpoint URL.
		return (value.includes("://") ? new URL(value) : new URL(`https://${value}`)).hostname.toLowerCase();
	} catch {
		return "";
	}
}

/** True when `host` is `suffix` or a subdomain of it (never a mere string suffix). */
function hostMatches(host: string, suffix: string): boolean {
	return host === suffix || host.endsWith(`.${suffix}`);
}

function isPresignedObjectUrl(url: string): boolean {
	// Host allowlist first (review P2): without it, ANY host's "Signature=<real
	// secret>" param would be treated as an access grant and left in place.
	// Only object-storage hosts we actually generate report links on qualify.
	let host = "";
	try {
		host = new URL(url).hostname.toLowerCase();
	} catch {
		return false;
	}
	const knownCloudHost = hostMatches(host, "aliyuncs.com") || hostMatches(host, "amazonaws.com");
	// One-directional on purpose: the URL's host must be, or be a subdomain of,
	// a CONFIGURED host. The reverse direction would let a longer configured
	// value ("evilorion-corp.com") vouch for a shorter message host
	// ("orion-corp.com" as a string suffix) — and, with a bare suffix test,
	// "evilorion-corp.com" would match "orion-corp.com". hostMatches anchors on
	// a dot boundary, so neither can happen.
	const configuredHost = [...configuredReportHosts].some((h) => hostMatches(host, h));
	if (!knownCloudHost && !configuredHost) return false;
	return (
		(/[?&]OSSAccessKeyId=/.test(url) && /[?&]Signature=/.test(url)) ||
		(/[?&]X-Amz-Signature=/.test(url) && /[?&]X-Amz-Credential=/.test(url))
	);
}

/** URL spans: everything up to whitespace or an angle/quote delimiter. */
const OBJECT_URL_SPAN_PATTERN = /https?:\/\/[^\s<>"']+/g;
/** CJK/bracket punctuation that glues onto a URL in prose but is not part of it. */
const URL_TRAILING_NOISE = /[)\]}>，。；！？、）】」』”’…]+$/;

/**
 * The param names whose values are the presigned grant itself — exactly the
 * OSS/AWS entries of URL_TOKEN_PARAM_SOURCE_BODY. Everything else in the same
 * URL (access_token, password, token, ...) stays subject to redaction: a fake
 * "&OSSAccessKeyId=x&Signature=y" marker must never rescue a credential URL
 * (review P1 — the exemption is per-param, never per-URL).
 */
const PRESIGNED_PARAM_PATTERN = /([?&](?:OSSAccessKeyId|Signature|X-Amz-Signature|X-Amz-Credential)=)([^\s&"']*)/gi;

/**
 * Char spans of the grant-carrying param ASSIGNMENTS (name + = + value) inside
 * presigned URLs. The name must be masked along with the value: param names
 * like X-Amz-Credential contain detector label words ("credential"), and a
 * value-only mask would leave "credential=<next params>" — a label+value shape
 * assembled from the leftovers — for the detector to trip on.
 */
function presignedParamSpans(text: string): Array<[number, number]> {
	const spans: Array<[number, number]> = [];
	if (!text) return spans;
	for (const match of text.matchAll(OBJECT_URL_SPAN_PATTERN)) {
		const url = match[0].replace(URL_TRAILING_NOISE, "");
		const start = match.index;
		const end = start + url.length;
		if (!url || !isPresignedObjectUrl(url)) continue;
		for (const param of text.slice(start, end).matchAll(PRESIGNED_PARAM_PATTERN)) {
			spans.push([start + param.index, start + param.index + param[0].length]);
		}
	}
	return spans;
}

/** Known credential shapes that need no label. */
const SHAPE_PATTERNS: RegExp[] = [
	/\bsk-[A-Za-z0-9_-]{16,}\b/,                                     // OpenAI-style keys
	/\bgh[pousr]_[A-Za-z0-9]{20,}\b/,                               // GitHub tokens
	/\bxox[abpsr]-[A-Za-z0-9-]{10,}\b/,                             // Slack tokens
	/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/, // JWT
	/-----BEGIN [A-Z ]*PRIVATE KEY-----/,                            // PEM private key
	/\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/,                           // Authorization header
	// URL credentials: scheme://user:password@host
	/\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]{3,}@/i,
	// Sensitive query params carrying a value (see redactUrlCredentialParams —
	// matched by SHAPE_PATTERNS via a shared source so the two never drift).
	new RegExp(`[?&]${URL_TOKEN_PARAM_SOURCE_BODY}=[^\\s&"']{6,}`, "i"),
	// env / ini style assignment of a secret-looking key
	/\b(?:PASSWORD|PASSWD|PWD|SECRET|TOKEN|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CLIENT_?SECRET)\s*=\s*["']?[^\s"']{6,}/,
	// JSON credential field with a concrete value
	/"(?:password|passwd|pwd|secret|token|api_?key|apikey|access_?key|client_?secret|secret_?key)"\s*:\s*"[^"]{6,}"/i,
];

/**
 * True when the text carries a concrete credential that must not be delivered
 * to a restricted audience.
 *
 * Deliberately does NOT scan for the deployment's configured secrets by value:
 * doing so would require plumbing config into the adapter's send path, and the
 * shapes above already cover the field failure (`密码还是 <value> 吗`).
 */
export function containsConcreteCredential(text: string): boolean {
	return containsConcreteCredentialIn(text, []);
}

/**
 * Detection over text with certain spans pre-cleared (the presigned grant-param VALUE spans):
 * the query params inside a protected URL are an access grant, not a credential
 * leak, so they must not trip the detector either — otherwise gateOutboundText
 * would withhold the whole message for the link it just chose to deliver.
 * Spans are masked with a hazard-free filler of the same length so offsets and
 * surrounding context stay intact.
 */
function containsConcreteCredentialIn(text: string, protectedSpans: Array<[number, number]>): boolean {
	if (!text) return false;
	let masked = text;
	if (protectedSpans.length) {
		const parts: string[] = [];
		let cursor = 0;
		for (const [start, end] of protectedSpans) {
			parts.push(text.slice(cursor, start));
			cursor = end;
		}
		parts.push(text.slice(cursor));
		masked = parts.join("");
	}
	for (const pattern of SHAPE_PATTERNS) {
		if (pattern.test(masked)) return true;
	}
	for (const pattern of LABEL_VALUE_PATTERNS) {
		const match = pattern.exec(masked);
		if (!match) continue;
		// A labelled mention only counts when the following token looks like a
		// real value, not prose such as 「密码已变更」/「密码忘记就重置」.
		if (looksLikeSecretValue(match[1] ?? "")) return true;
	}
	return false;
}

/**
 * One masked region: [start, end) plus how many LEADING characters of the
 * region stay readable (label/prefix — never the secret itself). Merging keeps
 * the smallest keepPrefix (mask everything a label-value span covers).
 */
interface MaskSpan { start: number; end: number; keepPrefix: number; }

/** Keep-prefix rule for a whole-match SHAPE span: keep through the first
 * assignment sigil so the kind stays identifiable ("password=****"), else the
 * first 3 characters (token families sk- / ghp_ / eyJ / xox). */
function shapeKeepPrefix(matched: string): number {
	const sigil = /[=:]/.exec(matched);
	if (sigil && sigil.index <= 24) return sigil.index + 1;
	return Math.min(3, matched.length);
}

function overlapsProtected(start: number, end: number, spans: Array<[number, number]>): boolean {
	return spans.some(([ps, pe]) => start < pe && end > ps);
}

/** Value-mask spans over `text`; candidates overlapping a presigned grant span
 * are skipped (the grant is delivered intact by design — 0.2.175). */
function credentialMaskSpans(text: string, protectedSpans: Array<[number, number]>): MaskSpan[] {
	if (!text) return [];
	const spans: MaskSpan[] = [];
	for (const pattern of SHAPE_PATTERNS) {
		const global = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
		for (const m of text.matchAll(global)) {
			const start = m.index, end = start + m[0].length;
			if (overlapsProtected(start, end, protectedSpans)) continue;
			spans.push({ start, end, keepPrefix: Math.min(shapeKeepPrefix(m[0]), end - start) });
		}
	}
	for (const pattern of LABEL_VALUE_PATTERNS) {
		const global = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
		for (const m of text.matchAll(global)) {
			const value = m[1] ?? "";
			if (!value || !looksLikeSecretValue(value)) continue;
			const start = m.index + m[0].length - value.length;
			if (overlapsProtected(start, start + value.length, protectedSpans)) continue;
			spans.push({ start, end: start + value.length, keepPrefix: 0 });
		}
	}
	spans.sort((a, b) => a.start - b.start || a.end - b.end);
	const merged: MaskSpan[] = [];
	for (const span of spans) {
		const prev = merged[merged.length - 1];
		if (prev && span.start <= prev.end) {
			prev.end = Math.max(prev.end, span.end);
			prev.keepPrefix = Math.min(prev.keepPrefix, span.keepPrefix);
		} else {
			merged.push({ ...span });
		}
	}
	return merged;
}

function applyCredentialMasks(text: string, spans: MaskSpan[]): string {
	const parts: string[] = [];
	let cursor = 0;
	for (const span of spans) {
		parts.push(text.slice(cursor, span.start));
		parts.push(text.slice(span.start, span.start + span.keepPrefix));
		parts.push("****");
		cursor = span.end;
	}
	parts.push(text.slice(cursor));
	return parts.join("");
}

/**
 * Fail-closed residue check for the MASKED output: SHAPE patterns only
 * (sk-/JWT/password=/URL-params — high-precision), and only OUTSIDE the spans
 * we already masked (and presigned grants). The label-value heuristics are
 * deliberately NOT re-run here: on masked output they re-match at alternate
 * alignments (lazy skip past 「密码是****」 → capture the next 「https:」 colon →
 * the following URL becomes a phantom "value") — the same false positive the
 * original gate produced on any 「密码是：https://help.example.com」 prose. The
 * first pass already gave every label-value the detector accepts a mask span,
 * so re-running labels here can only re-find phantoms, never real residue.
 */
function shapeTripsOutside(text: string, maskedSpans: MaskSpan[], protectedSpans: Array<[number, number]>): boolean {
	if (!text) return false;
	for (const pattern of SHAPE_PATTERNS) {
		const global = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
		for (const m of text.matchAll(global)) {
			const start = m.index, end = start + m[0].length;
			if (overlapsProtected(start, end, maskedSpans.map((s) => [s.start, s.end]))) continue;
			if (overlapsProtected(start, end, protectedSpans)) continue;
			return true;
		}
	}
	return false;
}

/**
 * Gate outbound text for one delivery (v0.2.225 redact-first).
 *
 * restricted audiences get the masked delivery: every credential span is
 * masked in place (label/prefix readable, value → ****) and a short suffix
 * note states how many spots were masked. Fail-closed withholding remains the
 * fallback when a HIGH-PRECISION shape hit survives outside the masked spans —
 * the mask is the happy path, never a weakening of the gate.
 */
export function gateOutboundText(text: string, audience: CredentialAudience): string {
	if (audience === "admin-single") return text;
	const redacted = redactUrlCredentialParams(text);
	const protectedSpans = presignedParamSpans(redacted);
	const spans = credentialMaskSpans(redacted, protectedSpans);
	if (!spans.length) return redacted !== text ? redacted : text;
	const masked = applyCredentialMasks(redacted, spans);
	if (shapeTripsOutside(masked, spans, presignedParamSpans(masked))) {
		// Un-maskable residue: keep the original fail-closed contract.
		return CREDENTIAL_WITHHELD_NOTICE;
	}
	return `${masked}${CREDENTIAL_MASKED_SUFFIX.replace("{count}", String(spans.length))}`;
}
/**
 * Global matcher for credential-bearing URL query params. Shared source with
 * SHAPE_PATTERNS so detection and in-place redaction never drift.
 */
const URL_TOKEN_PARAM_GLOBAL = new RegExp(
	`([?&]${URL_TOKEN_PARAM_SOURCE_BODY}=)([^\\s&"\']{6,})`,
	"gi",
);

/**
 * Redact just the credential param values inside URLs (e.g. a Gitee
 * raw_with_token report link) and keep the rest of the message: the surrounding
 * prose is a report body, not a re-statement of the secret, so whole-message
 * suppression here would only destroy scheduled-report delivery without making
 * anyone safer. Presigned object-storage URLs are left intact (see
 * isPresignedObjectUrl — redacting their signature destroys the link itself).
 * Anything else that still trips the detector after this removal falls through
 * to the full withhold.
 */
function redactUrlCredentialParams(text: string): string {
	const spans = presignedParamSpans(text);
	if (!spans.length) return text.replace(URL_TOKEN_PARAM_GLOBAL, (_m, prefix: string) => `${prefix}***`);
	// spans cover the whole assignment while the callback match is the same
	// assignment — the overlap test below is an exact containment in practice.
	const inPresigned = (offset: number, length: number) =>
		spans.some(([valueStart, valueEnd]) => offset < valueEnd && offset + length > valueStart);
	return text.replace(URL_TOKEN_PARAM_GLOBAL, (match, prefix: string, _value: string, offset: number) =>
		inPresigned(offset, match.length) ? match : `${prefix}***`);
}

/**
 * Length of the tail of `text` that must NOT be sent yet: it could still grow into
 * a credential once more deltas arrive.
 *
 * Streaming split the gate open: `gateOutboundText` judges a STRING, and each
 * increment was gated in isolation, so `密码：8392017` passed (no pattern matches a
 * bare seven-digit number) and the next delta `4` completed the password — the
 * first seven digits were already on the wire and a later `replace` cannot
 * retract bytes a client has rendered (review, 2026-11-02). Holding back a
 * bounded tail until it is decidably safe is the only way to stream and still
 * withhold.
 *
 * The window is the longest prefix that the patterns could still extend: any
 * dangling quote, quote-opened value, partial scheme or half-typed keyword. It is
 * deliberately generous — a few withheld characters delay text, leaked bytes
 * cannot be undone.
 */
export function streamingHoldbackLength(text: string): number {
	if (!text) return 0;
	// Look at the tail only: a credential pattern never spans more than this.
	const window = 200;
	const tail = text.slice(-window);
	const base = text.length - tail.length;

	let hold = 0;
	const holdFrom = (index: number): void => {
		if (index < 0) return;
		const length = text.length - (base + index);
		if (length > hold) hold = length;
	};

	// 1) An unterminated quote may still become a quoted secret value.
	const lastQuote = Math.max(tail.lastIndexOf('"'), tail.lastIndexOf("'"));
	if (lastQuote >= 0) {
		const quote = tail[lastQuote];
		const closed = tail.indexOf(quote, lastQuote + 1) >= 0;
		if (!closed) holdFrom(lastQuote);
	}

	// 2) A pending key/value assignment or JSON field whose value may still grow.
	//    `PASSWORD=abc123` is not a credential until 6+ chars follow the sigil, so
	//    the shorter prefix passes the gate — hold the whole tail of the line.
	const assign = /(?:PASSWORD|PASSWD|PWD|SECRET|TOKEN|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CLIENT_?SECRET)\s*=\s*["']?[^\s"']*$/i.exec(tail);
	if (assign) holdFrom(assign.index);
	const jsonField = /"(?:password|passwd|pwd|secret|token|api_?key|apikey|access_?key|client_?secret|secret_?key)"\s*:\s*"?[^"]*$/i.exec(tail);
	if (jsonField) holdFrom(jsonField.index);

	// 3) A URL still being written: a scheme, or userinfo without '@' yet.
	const urlLike = /[a-z][a-z0-9+.-]*:\/\/[^\s]*$/i.exec(tail);
	if (urlLike) {
		const candidate = urlLike[0];
		if (!candidate.includes("@") || /[?&][^\s&"']*$/.test(candidate)) holdFrom(urlLike.index);
	}

	// 4) A token prefix that the patterns may still match (sk-, ghp_, xox, eyJ…).
	const tokenPrefix = /\b(?:sk-\w*|gh[pousr]_\w*|xox[abpsr]-[\w-]*|eyJ[\w-]*(?:\.[\w-]*){0,2}|Bearer\s+[\w.~+/-]*)$/.exec(tail);
	if (tokenPrefix) holdFrom(tokenPrefix.index);

	// 5) A bare digit run: `密码：83920174` matches no pattern as a whole, but a
	//    LONG digit run following a password-ish label is exactly what the field
	//    leaked. Hold digits while the label is still in view.
	const labelRun = /(?:密码|口令|password|passwd|pwd|secret|token)[^\w]{0,3}([\dA-Za-z]{1,64})$/i.exec(tail);
	if (labelRun) holdFrom(labelRun.index);

	return Math.min(hold, text.length);
}

