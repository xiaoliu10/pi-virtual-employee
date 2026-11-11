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

/** All label alternatives as one regex branch — used to make value captures
 * STOP at the next label word (review P1-2: a greedy \S run swallowed the
 * second 「password:」 so its value escaped masking). */
const ALL_LABELS_ALT = [...SECRET_LABELS_ZH, ...SECRET_LABELS_EN].join("|");
/** Boundary guard: capture stops at the START of a later label word, not on a
 * substring inside the value (review P1-2 fix iteration): English labels like
 * 「secret」 must not cut 「SuperSecret99!」 in half — the (?<![A-Za-z0-9_])
 * lookbehind requires a word boundary before the label, so a label embedded in
 * a longer token does not count.
 *
 * TWO pattern sets share the builder (review round-6 N1, P0):
 * - INPUT set (`urlBoundary: true`) — mask loop + public detection. Value
 *   capture stops at `https?://`, the v0.2.225 delivery contract: a report or
 *   share URL adjacent to a masked secret survives as a delivery artifact, and
 *   verified grants are additionally protected by whole-URL subtraction.
 * - RESIDUE set (`urlBoundary: false`) — ONLY for re-checking the final text.
 *   A label + whitespace + secret URL (`密码：\nhttps://example.com/Abc_123456`,
 *   a wholly natural line break — review N1) must trip exactly like main, so
 *   URLs do NOT stop capture there. Masked-output artifacts cannot false-trip
 *   because narrowly recognized redacted Gitee raw artifacts and verified
 *   report skeletons/grant params are cleared only from the probe. */
function buildLabelValuePatterns(urlBoundary: boolean): RegExp[] {
	const boundary = urlBoundary
		? String.raw`(?<![A-Za-z0-9_])(?:${ALL_LABELS_ALT})|https?://`
		: String.raw`(?<![A-Za-z0-9_])(?:${ALL_LABELS_ALT})`;
	const tempered = String.raw`((?:(?!${boundary})\S){6,200})`;
	const patterns: RegExp[] = [];
	for (const label of [...SECRET_LABELS_ZH, ...SECRET_LABELS_EN]) {
		// Separator form: 密码：xxx / 密码是 xxx / 密码还是 xxx / password: xxx / **密码**：`xxx`
		// 0x60 = backtick, kept as an escape so the character class stays readable.
		// Detection keeps main's FULL separator coverage (review round-4: narrowing
		// the gap colon leaked `password hint://Abc_123456` — 731 corpus cases).
		patterns.push(new RegExp(
			String.raw`(?<![A-Za-z0-9_])(?:${label})[^\n]{0,12}?(?:[:：=]|是|为|还是|改成|改为|变成|重置成|重设为|修改成)\s*[*_\x60'"“”「『(（]*${tempered}`,
			"iu",
		));
		// Verb-first form: 正在用密码 xxx 登录 / 拿 token xxx 调接口 / 输入口令 xxx.
		// No colon or 是 here — the verb + label is the separator.
		patterns.push(new RegExp(
			String.raw`(?<![A-Za-z0-9_])(?:用|拿|以|输入|填入|填|试试|尝试|带上|附上)\s*(?:${label})\s*[:：=]?\s*[*_\x60'"“”「『(（]*${tempered}`,
			"iu",
		));
	}
	return patterns;
}

/** Label+value patterns over INPUT text (mask loop + public detection). */
const LABEL_VALUE_PATTERNS: RegExp[] = buildLabelValuePatterns(true);
/** Label+value patterns for the RESIDUE re-check over final/probe text — a
 * label + gap + URL value counts there (review N1). */
const RESIDUE_LABEL_VALUE_PATTERNS: RegExp[] = buildLabelValuePatterns(false);

/**
 * Review round-6 N1 (P0): label + separator + (whitespace or mask markers) +
 * an http(s) URL — the URL IS the value. Main withholds such a message
 * wholesale; the branch masks the URL span instead (delivery preserved, secret
 * gone). Only ZERO-GAP separators qualify: a match that reaches a URL through
 * a prose gap (「…生成：https://…」 after unrelated words) is not a labeled
 * value, so report/share links adjacent to other text survive untouched.
 * Verified report grants are skipped in the mask loop (system artifacts per
 * the 0.2.175 field ruling). */
function buildLabelUrlValuePatterns(): RegExp[] {
	const patterns: RegExp[] = [];
	for (const label of [...SECRET_LABELS_ZH, ...SECRET_LABELS_EN]) {
		patterns.push(new RegExp(
			String.raw`(?<![A-Za-z0-9_])(?:${label})(?:[:：=]|是|为|还是|改成|改为|变成|重置成|重设为|修改成)\s*(?:\*{3,}\s*)?(https?:\/\/\S{6,200})`,
			"iu",
		));
	}
	return patterns;
}
const LABEL_URL_VALUE_PATTERNS: RegExp[] = buildLabelUrlValuePatterns();

/** Credential-bearing URL query-param name list (shared source, see below).
 * Value class EXCLUDES the star marker (*): redaction/mask fillers (***, ****,
 * and their concatenations like  *******) must never re-trip the shape in a
 * later masking pass (review: iterative-mask self-excitation). */
const URL_TOKEN_PARAM_SOURCE_BODY =
	"(?:password|passwd|pwd|secret|client[-_]?secret|credential|passphrase|private[-_]?key|auth[-_]?token|token|api[-_]?key|apikey|access[-_]?token|access[-_]?key|OSSAccessKeyId|Signature|X-Amz-Signature|X-Amz-Credential)";
const URL_TOKEN_PARAM_VALUE = "[^\\s&\"'*]{6,}";

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
/** A report URL span, query-aware: `scheme://` + path (CJK allowed, so a
 * `/r/日报.xlsx` object key stays intact) + `?` + an ASCII query that STOPS at
 * the first non-ASCII char. Review RL-1: the old `[^\s<>"]+` counted CJK as URL
 * chars, so a whole-URL protection span swallowed 「，密码：Abc_123456」 glued
 * after the query and subtraction then erased the password's mask span. A
 * presigned query is percent-encoded ASCII, so bounding the query (but not the
 * path) at 0x7F keeps the grant intact AND lets glued CJK prose be masked. The
 * `\?` is required — every presigned grant has a query, and a span without one
 * is never a grant, so nothing to protect is lost. */
const OBJECT_URL_SPAN_PATTERN = /https?:\/\/[^\s<>"'?]*\?(?:(?!https?:\/\/)[^\s<>"',;\u0080-\uffff])+/g;
/** CJK/bracket punctuation that glues onto a URL in prose but is not part of it. */
const URL_TRAILING_NOISE = /[)\]}>，。；！？、）】」』”’…]+$/;
const REPORT_FILE_EXTENSION = /\.(?:md|markdown|txt|pdf|xlsx|xls|csv|html?|json|log|png|jpe?g)$/i;

/** A concrete value inside a credential-bearing URL path. Known document
 * extensions are structural; encoded input is decoded before applying the same
 * value heuristic used for labeled credentials. Invalid encoding fails closed. */
function isConcreteUrlPathSegment(part: string): boolean {
	let decoded = "";
	try {
		decoded = decodeURIComponent(part);
	} catch {
		return true;
	}
	return looksLikeSecretValue(decoded.replace(REPORT_FILE_EXTENSION, ""));
}

/** Fail-closed glue scan for text we would otherwise PRESERVE. The whole
 * region goes through the same value heuristic as labeled credentials — all
 * three secret rules (letter+digit/symbol ≥6, digit run ≥8, alpha run ≥12),
 * not just the mixed-run shape. Whitespace/`&`/quotes cannot occur inside the
 * region (the tail regex excludes them), so CJK glue like 「，巡检已完成12345678」
 * or 「Abc.123456」 trips exactly like main's swallowed-run check; pure CJK
 * prose (「，报告二」「，明细」) and the `***` marker alone stay unaffected. */
function hasConcreteGlueInPreservedRegion(segment: string): boolean {
	return looksLikeSecretValue(segment);
}

/** A nested URL following an already-redacted credential may be ordinary prose
 * (another report/document link), not necessarily a secret tail. Preserve it
 * only when nothing concrete can hide in authority, path, query or fragment.
 * Scheme-less `www.` tails get the same heuristics. The RAW authority must be
 * pure ASCII (CJK inside it means the URL run swallowed prose/secret glue —
 * the span matcher cannot parse that reliably); punycode labels are not
 * decodable here. Anything unparseable fails closed — main truncates these
 * tails anyway, so removal is parity and preservation is the improvement. */
function isSafeNestedCredentialTailUrl(raw: string): boolean {
	const url = raw.replace(URL_TRAILING_NOISE, "");
	if (isPresignedObjectUrl(url)) return true;
	const authority = url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").split(/[/?#]/)[0];
	if (/[^\x20-\x7f]/.test(authority)) return false;
	let parsed: URL;
	try {
		parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`);
	} catch {
		return false;
	}
	// Userinfo is part of the delivered text and a classic secret carrier
	// (https://Abc_123456:x@host/…). Report links never need it — fail closed.
	if (parsed.username || parsed.password) return false;
	for (const label of parsed.hostname.split(".")) {
		if (label.startsWith("xn--") || isConcreteUrlPathSegment(label)) return false;
	}
	const path = parsed.pathname;
	const giteeRaw = hostMatches(parsed.hostname.toLowerCase(), "gitee.com") && /^\/[^/]+\/[^/]+\/raw\//.test(path);
	const candidatePath = giteeRaw ? path.slice(path.indexOf("/raw/") + 5) : path;
	if (candidatePath.split("/").some((part) => isConcreteUrlPathSegment(part))) return false;
	for (const [, value] of parsed.searchParams) {
		if (!value || /^\*+$/.test(value)) continue;
		if (value.length > 200 || looksLikeSecretValue(value)) return false;
	}
	if (parsed.hash && parsed.hash.length > 1) {
		let decodedHash = "";
		try {
			decodedHash = decodeURIComponent(parsed.hash.slice(1));
		} catch {
			return false;
		}
		if (looksLikeSecretValue(decodedHash)) return false;
	}
	return true;
}

/**
 * Char spans of the grant-carrying param ASSIGNMENTS inside presigned URLs
 * (name + = + value) — DETECTION-level protection: these params are an access
 * grant, not a credential leak, so shape/label detection skips them. Non-grant
 * credential params on the same URL (access_token, password, …) are NOT
 * protected and still get masked (per-param, never per-URL).
 */
// Expires/Date params are part of the grant triple too: the backstop splices
// grant assignments out of the probe text, and a leftover `&Expires=1799999999`
// would otherwise serve as label-value material for a preceding 「密码：」 and
// withhold a delivered report (review round-6 regression hunt).
const PRESIGNED_PARAM_PATTERN = /([?&](?:OSSAccessKeyId|Signature|X-Amz-Signature|X-Amz-Credential|Expires|X-Amz-Expires|X-Amz-Date|X-Oss-Date)=)([^\s&"']*)/gi;

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

/**
 * Char spans of presigned OBJECT URLs as WHOLE URLs — SUBTRACTION-level
 * protection (review P1-1b): when a no-space CJK message glues a labeled value
 * straight into the report URL, the label mask span is carved AROUND the link
 * so the grant link survives intact instead of being torn apart. Detection
 * still uses the param-level spans above; this list only feeds subtractProtected.
 */
function presignedUrlSpans(text: string): Array<[number, number]> {
	const spans: Array<[number, number]> = [];
	if (!text) return spans;
	for (const match of text.matchAll(OBJECT_URL_SPAN_PATTERN)) {
		const url = match[0].replace(URL_TRAILING_NOISE, "");
		if (!url || !isPresignedObjectUrl(url)) continue;
		const start = match.index;
		spans.push([start, start + url.length]);
	}
	return spans;
}

/** Known credential shapes that need no label. */
const SHAPE_PATTERNS: RegExp[] = [
	/\bsk-[A-Za-z0-9_-]{16,}\b/,                                     // OpenAI-style keys
	/\bgh[pousr]_[A-Za-z0-9]{20,}\b/,                               // GitHub tokens
	/\bxox[abpsr]-[A-Za-z0-9-]{10,}\b/,                             // Slack tokens
	/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/, // JWT
	/-----BEGIN [A-Z ]*PRIVATE KEY-----/,                            // PEM private key banner
	// Review RL-2: the banner shape alone masked only `-----BEGIN…-----`, shipping
	// the base64 key body in full. The whole BEGIN…END (or to EOF when truncated)
	// block is masked as one region below via PEM_BLOCK_PATTERN.
	/\bBearer\s+[A-Za-z0-9._~+/-=]{12,}/,                           // Authorization header (= covers in-token base64 padding, review P1-4)
	// URL credentials: scheme://user:password@host
	/\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]{3,}@/i,
	// Sensitive query params carrying a value (see redactUrlCredentialParams —
	// matched via SHAPE_PATTERNS with a shared source so detection and redaction
	// never drift). Star-excluding value class prevents mask/redaction fillers
	// from re-tripping the shape in later iterative passes.
	new RegExp(`[?&]${URL_TOKEN_PARAM_SOURCE_BODY}=${URL_TOKEN_PARAM_VALUE}`, "i"),
	// A pasted access-token assignment after prose punctuation is no longer a
	// URL query param, but still carries the same credential. Horizontal-only
	// gaps plus the scheme lookahead keep the match from crossing a line break
	// or capturing a following (report) URL as the value (review round-6 P2);
	// the star-excluded value class never re-trips on redacted `***`.
	/(?<![A-Za-z0-9_])access[-_]?token[^\S\r\n]*[:=][^\S\r\n]*(?!https?:\/\/)[^*\s&"']{6,}/i,
	// env / ini style assignment of a secret-looking key. The value class
	// tempers on a URL scheme (review P1-1b): without it a no-space
	// 「PASSWORD=secret巡检报告https://…」 capture swallows the report URL.
	/\b(?:PASSWORD|PASSWD|PWD|SECRET|TOKEN|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CLIENT_?SECRET)\s*=\s*["']?(?:(?!https?:\/\/)[^\s"']){6,}/,
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
function containsConcreteCredentialIn(text: string, protectedSpans: Array<[number, number]>, labelPatterns: RegExp[] = LABEL_VALUE_PATTERNS): boolean {
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
	for (const pattern of labelPatterns) {
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

/** Keep-prefix rule for a whole-match SHAPE span.
 *
 * Review P1-4 (2026-11-11): the old "keep through any first =/:" rule leaked
 * whole secrets — a base64 padding `=` sits INSIDE the token
 * (`Bearer YWJjZGVmZ2hpamw=` → the entire 16-char token survived). A sigil is
 * honored ONLY when the head is a recognizable assignment label (env/JSON/URL
 * param), never inside a bare token; otherwise just the 3-char family head
 * (sk-/ghp_/eyJ/xox/Bea) stays. */
function shapeKeepPrefix(matched: string): number {
	const sigil = /[=:]/.exec(matched);
	if (sigil && sigil.index <= 24) {
		const head = matched.slice(0, sigil.index);
		// env-style (PASSWORD), JSON-ish ("password"), URL param (?token).
		if (/^[?&]?"?[A-Za-z_][A-Za-z0-9_.-]*"?$/.test(head)) return sigil.index + 1;
	}
	return Math.min(3, matched.length);
}

function overlapsProtected(start: number, end: number, spans: Array<[number, number]>): boolean {
	return spans.some(([ps, pe]) => start < pe && end > ps);
}

/** Split a candidate mask span AROUND protected (presigned grant) ranges:
 * review P1-1 — dropping a candidate that merely INTERSECTS a grant span threw
 * away the whole mask, so a no-space CJK message gluing the password straight
 * into the report URL shipped the password in plaintext. We keep every
 * non-protected sub-range; the grant itself stays intact (0.2.175). */
function subtractProtected(start: number, end: number, keepPrefix: number, protectedSpans: Array<[number, number]>): MaskSpan[] {
	const fragments: Array<[number, number]> = [];
	let cursor = start;
	for (const [ps, pe] of [...protectedSpans].sort((a, b) => a[0] - b[0])) {
		if (pe <= cursor) continue;
		if (ps >= end) break;
		if (ps > cursor) fragments.push([cursor, Math.min(ps, end)]);
		cursor = Math.max(cursor, pe);
		if (cursor >= end) break;
	}
	if (cursor < end) fragments.push([cursor, end]);
	return fragments
		.filter(([s, e]) => e > s)
		.map(([s, e], i) => ({
			start: s,
			end: e,
			// keepPrefix is relative to the original span start — only the
			// first fragment can contain the readable head.
			keepPrefix: i === 0 ? Math.max(0, Math.min(keepPrefix, e - s)) : 0,
		}));
}

/** Label-value capture at the detector's ceiling: the value pattern caps at
 * 200 chars, so a 220-char secret yields a 200-char capture with the tail
 * still glued (no whitespace boundary) — no mask span can ever cover that
 * tail, and main would have withheld the message. A full 200-char capture
 * followed by a non-space character therefore keeps the fail-closed contract
 * (review P1-3). */
function hasOverlongLabelValue(text: string): boolean {
	for (const pattern of LABEL_VALUE_PATTERNS) {
		const global = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
		for (const m of text.matchAll(global)) {
			const value = m[1] ?? "";
			if (value.length >= 200) {
				const after = text[m.index + m[0].length];
				if (after && !/\s/.test(after)) return true;
			}
		}
	}
	return false;
}

/** Value-mask spans over `text`. Two protection levels (review P1-1):
 * SHAPE matches subtract around GRANT PARAM spans only — a non-grant
 * credential param (access_token) on a presigned URL must still be masked;
 * LABEL-value matches subtract around WHOLE presigned URLs — a labeled value
 * glued into a report link must never tear the link apart. */
/** A whole PEM private-key block, BEGIN banner → END banner (or to end of text
 * when the END banner is truncated). Review RL-2: masking only the banner left
 * the base64 key body on the wire while the suffix claimed 「已脱敏」. */
const PEM_BLOCK_PATTERN = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g;

function credentialMaskSpans(text: string): MaskSpan[] {
	if (!text) return [];
	const grantParamSpans = presignedParamSpans(text);
	const wholeUrlSpans = presignedUrlSpans(text);
	// End a masked label before a verified report grant without treating an
	// arbitrary URL as exempt. Other markers stay visible so later passes can
	// still expose swallowed labels. Probe replacements preserve offsets.
	const labelProbe = reportMaskProbe(text);
	const spans: MaskSpan[] = [];
	for (const pattern of SHAPE_PATTERNS) {
		const global = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
		for (const m of text.matchAll(global)) {
			const start = m.index, end = start + m[0].length;
			if (overlapsProtected(start, end, grantParamSpans)) {
				// Review N4: a match that STARTS inside a grant param (the grant's
				// own `Signature=…` whose CJK value class swallowed trailing prose
				// like 「。请查收」) is grant + incidental tail — exempt it whole.
				// Emitting the tail as a fragment produced false masks on benign
				// report pushes. A match starting OUTSIDE protection (e.g. a
				// non-grant `credential=` param glued to a labeled secret) still
				// subtracts, keeping the M1b defense.
				if (grantParamSpans.some(([ps, pe]) => start >= ps && start < pe)) continue;
				spans.push(...subtractProtected(start, end, Math.min(shapeKeepPrefix(m[0]), end - start), grantParamSpans));
				continue;
			}
			spans.push({ start, end, keepPrefix: Math.min(shapeKeepPrefix(m[0]), end - start) });
		}
	}
	// RL-2: mask the ENTIRE PEM private-key block, not just its banner.
	for (const m of text.matchAll(PEM_BLOCK_PATTERN)) {
		const start = m.index, end = start + m[0].length;
		spans.push({ start, end, keepPrefix: Math.min(3, end - start) });
	}
	// Collect masked label values for the P1-C cross-scan below.
	const labelValues = new Set<string>();
	for (const pattern of LABEL_VALUE_PATTERNS) {
		const global = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
		for (const m of labelProbe.matchAll(global)) {
			const value = m[1] ?? "";
			if (!value || !looksLikeSecretValue(value)) continue;
			const start = m.index + m[0].length - value.length;
			if (overlapsProtected(start, start + value.length, wholeUrlSpans)) {
				spans.push(...subtractProtected(start, start + value.length, 0, wholeUrlSpans));
			} else {
				spans.push({ start, end: start + value.length, keepPrefix: 0 });
			}
			if (value.length >= 6) labelValues.add(value);
		}
	}
	// Review round-6 N1: a URL directly after a label separator IS the value.
	// Mask the URL span unless it is a verified report grant (wholeUrlSpans) —
	// links delivered as artifacts must never be torn apart by a nearby label.
	for (const pattern of LABEL_URL_VALUE_PATTERNS) {
		const global = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
		for (const m of labelProbe.matchAll(global)) {
			const url = m[1] ?? "";
			if (!url) continue;
			const start = m.index + m[0].length - url.length;
			if (overlapsProtected(start, start + url.length, wholeUrlSpans)) continue;
			spans.push({ start, end: start + url.length, keepPrefix: 0 });
		}
	}
	// P1-C hardening: a secret that was masked after a label may ALSO appear bare
	// elsewhere in the same message (`Abc_123456 密码是 Abc_123456`). The bare copy
	// has no shape and no label, so neither gate catches it standalone; main only
	// protected it incidentally via whole-message withhold. Cross-scan every masked
	// label value and mask its literal occurrences too (never tearing a grant).
	for (const val of labelValues) {
		let idx = text.indexOf(val);
		while (idx !== -1) {
			const start = idx, end = idx + val.length;
			if (overlapsProtected(start, end, wholeUrlSpans)) {
				spans.push(...subtractProtected(start, end, 0, wholeUrlSpans));
			} else {
				spans.push({ start, end, keepPrefix: 0 });
			}
			idx = text.indexOf(val, idx + val.length);
		}
	}
	// Review N4(ii): a span whose keepPrefix covers its whole length masks
	// nothing yet would still append `****` and bump the count — drop no-ops so
	// the iterative gate loop structurally converges.
	const effective = spans.filter((s) => s.keepPrefix < s.end - s.start);
	effective.sort((a, b) => a.start - b.start || a.end - b.end);
	const merged: MaskSpan[] = [];
	for (const span of effective) {
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
 * Fail-closed residue check on the FINAL masked text. Review P2-2: spans were
 * computed on `redacted` but verified against `masked`, whose length differs
 * (redaction uses `***`, masks use `****`) — stale coordinates then let a
 * `?access_token=*******` re-match. Coordinates are therefore recomputed on
 * the text actually being sent.
 *
 * The final check includes shapes and label values. Verified grant material
 * and narrowly recognized redacted Gitee raw artifacts are cleared only from
 * its probe; all other URL text and label associations stay inspectable.
 */
/** Recheck remaining credentials without joining words across mask markers. */
function reportMaskProbe(text: string): string {
	const reportStarts = new Set(presignedUrlSpans(text).map(([start]) => start));
	return text.replace(/\*{3,}/g, (marker, offset: number) => {
		// Whitespace belongs to the mask/report boundary too. Without this,
		// normalization exposes the grant scheme colon to the prior label.
		const after = offset + marker.length;
		const gap = /^\s*/u.exec(text.slice(after))?.[0].length ?? 0;
		if (reportStarts.has(after + gap)) return "\n".repeat(marker.length);
		return marker;
	});
}

function finalCredentialCheck(text: string): boolean {
	if (!text) return false;
	const cleared: Array<[number, number]> = [...presignedParamSpans(text)];
	const verifiedUrls = presignedUrlSpans(text);
	// Verified report URLs are system artifacts: clear the SKELETON
	// (scheme://host/path) and each grant-param assignment. NON-grant query
	// params (e.g. `&secret_key=…`) stay visible — catching those is the
	// compound-leak purpose of this backstop.
	for (const [start, end] of verifiedUrls) {
		const q = text.indexOf("?", start);
		cleared.push([start, q !== -1 && q < end ? q : end]);
	}
	// Re-gating a redacted Gitee raw share link must not re-read its URL as a
	// value for an unrelated preceding label. Only a known raw-file route with
	// fully redacted credential params and no concrete secret in its branch/file
	// path qualifies. Unknown markers, plaintext params, nested URLs and other
	// hosts stay visible to the residue detector.
	const redactedParam = new RegExp(`^${URL_TOKEN_PARAM_SOURCE_BODY}=\\*{3,}$`, "i");
	for (const match of text.matchAll(OBJECT_URL_SPAN_PATTERN)) {
		const url = match[0].replace(URL_TRAILING_NOISE, "");
		if (verifiedUrls.some(([start]) => start === match.index)) continue;
		let parsed: URL;
		try {
			parsed = new URL(url);
		} catch {
			continue;
		}
		if (!hostMatches(parsed.hostname.toLowerCase(), "gitee.com")) continue;
		const route = /^\/[^/]+\/[^/]+\/raw\/[^/]+(?:\/[^/]+)*$/.exec(parsed.pathname);
		if (!route) continue;
		const params = parsed.search.slice(1).split("&");
		if (!params.length || params.some((param) => !redactedParam.test(param))) continue;
		let concretePathValue = false;
		for (const part of parsed.pathname.slice(parsed.pathname.indexOf("/raw/") + 5).split("/")) {
			if (isConcreteUrlPathSegment(part)) {
				concretePathValue = true;
				break;
			}
		}
		if (!concretePathValue) cleared.push([match.index, match.index + url.length]);
	}
	// Replace cleared spans with SAME-LENGTH double-quote filler, never a newline
	// or deletion. The probe therefore keeps offsets AND the original label →
	// prose → following-URL association. Quote fillers are excluded by the
	// credential shape value classes and stripped by looksLikeSecretValue, while
	// any concrete material after a cleared link remains visible (review N4-N6).
	cleared.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
	const parts: string[] = [];
	let cursor = 0;
	for (const [start, end] of cleared) {
		if (start < cursor) continue;
		parts.push(text.slice(cursor, start), "\"".repeat(end - start));
		cursor = end;
	}
	parts.push(text.slice(cursor));
	// Two spaces preserve split words (including api***key: the label allows
	// ONE optional space) without letting marker length exhaust the bounded
	// gap before a remaining credential. Whitespace after an untrusted marker
	// is part of that boundary too: a newline must not shelter a URL value when
	// another credential in the message was already masked.
	return containsConcreteCredentialIn(parts.join("").replace(/\*{3,}\s*/g, "  "), [], RESIDUE_LABEL_VALUE_PATTERNS);
}

function shapeTripsOutside(text: string, protectedSpans: Array<[number, number]>): boolean {
	if (!text) return false;
	const maskMarkerSpans: Array<[number, number]> = [];
	for (const m of text.matchAll(/\*{3,}/g)) maskMarkerSpans.push([m.index, m.index + m[0].length]);
	for (const pattern of SHAPE_PATTERNS) {
		const global = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
		for (const m of text.matchAll(global)) {
			const start = m.index, end = start + m[0].length;
			if (overlapsProtected(start, end, maskMarkerSpans)) continue;
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
 * fallback: (1) a label value beyond the detector's 200-char ceiling (review
 * P1-3 — no mask span can ever cover it); (2) after iterative masking a
 * high-precision shape hit still survives outside masked/protected spans on
 * the FINAL text (coordinate-sound, review P2-2). The mask is the happy path,
 * never a weakening: anything main withholds for safety stays either masked
 * to nothing or withheld.
 */
export function gateOutboundText(text: string, audience: CredentialAudience): string {
	if (audience === "admin-single") return text;
	const redacted = redactUrlCredentialParams(text);
	// P1-3: an over-long labeled value cannot produce a mask span at all.
	if (hasOverlongLabelValue(redacted)) return CREDENTIAL_WITHHELD_NOTICE;
	let working = redacted;
	let total = 0;
	// Iterative masking (review P1-2): a greedy value capture can swallow a
	// later credential label so it never starts its own match; re-running on the
	// masked output exposes the next label. Bounded so a pathological text can
	// never loop forever.
	for (let pass = 0; pass < 8; pass++) {
		const spans = credentialMaskSpans(working);
		if (!spans.length) break;
		working = applyCredentialMasks(working, spans);
		total += spans.length;
	}
	if (total === 0) {
		// Review N1/N2/N3 amplifier: protection subtraction can erase every mask
		// span while a concrete credential still sits in the text — the early
		// return used to ship it plaintext with no suffix and the fail-closed
		// fallback was never consulted. Degrade any protection-induced blind
		// spot to main's own verdict (withhold) instead of plaintext.
		return finalCredentialCheck(redacted) ? CREDENTIAL_WITHHELD_NOTICE : (redacted !== text ? redacted : text);
	}
	if (shapeTripsOutside(working, presignedParamSpans(working))) {
		return CREDENTIAL_WITHHELD_NOTICE;
	}
	// Review round-3 structural backstop: whole-URL protection can hide a
	// non-grant credential param (e.g. `&secret_key=…` inside a presigned URL)
	// from masking while ANOTHER masked span keeps total > 0 — the total===0
	// guard never fires and the secret ships. Re-run main's own full detection
	// (shapes + label heuristics) over the FINAL text, with grant params and
	// mask markers pre-cleared, so any survivor degrades to withhold.
	if (finalCredentialCheck(working)) {
		return CREDENTIAL_WITHHELD_NOTICE;
	}
	return `${working}${CREDENTIAL_MASKED_SUFFIX.replace("{count}", String(total))}`;
}
/**
 * Global matcher for credential-bearing URL query params. Shared source with
 * SHAPE_PATTERNS so detection and in-place redaction never drift.
 */
const URL_TOKEN_PARAM_GLOBAL = new RegExp(
	`([?&]${URL_TOKEN_PARAM_SOURCE_BODY}=)([^\\s&"\'*]{6,})`,
	"gi",
);
const URL_CREDENTIAL_NAME_PATTERN = new RegExp(`[?&]${URL_TOKEN_PARAM_SOURCE_BODY}=`, "i");
const URL_ANY_PARAM_GLOBAL = /([?&][^=&#\s]+=)([^&\s"']*)/g;
// Redaction must see a nested URL tail too. The protection span deliberately
// stops at the next scheme; using it here would leave that tail untouched.
const URL_REDACTION_SPAN_PATTERN = /https?:\/\/[^\s<>"',;\u0080-\uffff]*/g;
// An already-redacted credential value may still have a residue tail: nested
// URLs (scheme-bearing or scheme-less `www.`) and/or CJK glue. The run fires
// whenever the value contains a redaction marker — a trailing URL is NOT
// required, because separator-free glue like 「。密码First_123456」 after the
// marker is invisible to every label/residue pattern (review round-13 F1).
const REDACTED_URL_NESTED_TAIL_GLOBAL = new RegExp(
	`([?&]${URL_TOKEN_PARAM_SOURCE_BODY}=)(?=[^\\s&"']*\\*)[^\\s&"']*`,
	"gi",
);
const NESTED_URL_SPAN_PATTERN = /(?:https?:\/\/|www\.)[^\s<>"']*/g;

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
	// spans cover the whole assignment while the callback match is the same
	// assignment — the overlap test below is an exact containment in practice.
	const inPresigned = (offset: number, length: number) =>
		spans.some(([valueStart, valueEnd]) => offset < valueEnd && offset + length > valueStart);
	const redacted = text.replace(URL_TOKEN_PARAM_GLOBAL, (match, prefix: string, _value: string, offset: number) =>
		inPresigned(offset, match.length) ? match : `${prefix}***`);
	// Once a URL carries a credential param, a concrete-looking SIBLING value
	// is not safe either: it can be another secret or a nested URL tail glued to
	// a redaction marker. Redact those values too, while leaving verified grant
	// assignments intact. Ordinary values and URLs without credentials retain
	// their existing behavior.
	const grantSpans = presignedParamSpans(redacted);
	const siblingsRedacted = redacted.replace(URL_REDACTION_SPAN_PATTERN, (matched: string, offset: number) => {
		const url = matched.replace(URL_TRAILING_NOISE, "");
		if (!URL_CREDENTIAL_NAME_PATTERN.test(url)) return matched;
		// The first pass already redacts every credential-NAMED non-grant param.
		// Do not generic-redact signed structural params on a verified grant
		// (X-Amz-Algorithm, response-content-disposition, x-oss-process): changing
		// them invalidates the signature without removing a credential.
		if (isPresignedObjectUrl(url)) return matched;
		const stripped = url.replace(URL_ANY_PARAM_GLOBAL, (assignment: string, prefix: string, value: string, localOffset: number) => {
			const absolute = offset + localOffset;
			if (grantSpans.some(([start, end]) => absolute < end && absolute + assignment.length > start)) return assignment;
			if (!value || /^\*+$/.test(value)) return assignment;
			return value.length > 200 || looksLikeSecretValue(value) ? `${prefix}***` : assignment;
		});
		// A credential URL's path can carry the same secret too. Redact concrete
		// path segments, except on a verified grant whose object key is a system
		// artifact. On Gitee raw links the owner/repo routing stays readable;
		// only branch/file segments are candidates.
		let result = stripped;
		if (!isPresignedObjectUrl(url)) {
			const schemeEnd = result.indexOf("://");
			const pathStart = result.indexOf("/", schemeEnd + 3);
			const queryStart = result.indexOf("?", pathStart);
			if (schemeEnd > 0 && pathStart > 0 && queryStart > pathStart) {
				const path = result.slice(pathStart, queryStart);
				let candidatePath = path;
				try {
					if (hostMatches(new URL(result).hostname.toLowerCase(), "gitee.com") && /^\/[^/]+\/[^/]+\/raw\//.test(path)) {
						candidatePath = path.slice(path.indexOf("/raw/") + 5);
					}
				} catch {
					// An unparseable credential URL gets the conservative whole-path scan.
				}
				let changed = false;
				const redactedPath = candidatePath.split("/").map((part) => {
					if (!isConcreteUrlPathSegment(part)) return part;
					changed = true;
					const extension = REPORT_FILE_EXTENSION.exec(part)?.[0] ?? "";
					return `***${extension}`;
				}).join("/");
				if (changed) {
					const startInPath = candidatePath === path ? 0 : path.indexOf("/raw/") + 5;
					result = result.slice(0, pathStart) + path.slice(0, startInPath) + redactedPath + result.slice(queryStart);
				}
			}
		}
		return result + matched.slice(url.length);
	});
	const cleanupGrantSpans = presignedParamSpans(siblingsRedacted);
	return siblingsRedacted.replace(REDACTED_URL_NESTED_TAIL_GLOBAL, (match: string, prefix: string, offset: number) => {
		if (cleanupGrantSpans.some(([start, end]) => offset < end && offset + match.length > start)) return match;
		const nestedAt = match.search(/https?:\/\/|www\./);
		if (nestedAt < 0) {
			// No nested URL: the residue after the marker is plain prose. Fail
			// closed when it carries a secret shape (「。密码First_123456」 — no
			// separator, invisible to label/residue capture); pure CJK prose
			// (「，请查收。」) stays below every rule threshold and keeps
			// delivering. main truncates the whole run — removal is parity.
			return hasConcreteGlueInPreservedRegion(match.slice(prefix.length)) ? `${prefix}***` : match;
		}
		const tail = match.slice(nestedAt);
		const before = match.slice(prefix.length, nestedAt);
		// Fail closed: secret-shaped glue inside the prose we would keep, or any
		// unsafe nested URL, removes the whole tail.
		if (hasConcreteGlueInPreservedRegion(before) || [...tail.matchAll(NESTED_URL_SPAN_PATTERN)].some((m) => !isSafeNestedCredentialTailUrl(m[0]))) {
			return `${prefix}***`;
		}
		// Safe nested report/document links and their CJK prose survive. Only the
		// credential-shaped prefix is normalized; no legitimate trailing URL is
		// deleted merely because it follows a redaction marker.
		const proseAt = before.search(/[\u0080-\uffff]/);
		const prose = proseAt >= 0 ? before.slice(proseAt) : "";
		return `${prefix}***${prose}${tail}`;
	});
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

