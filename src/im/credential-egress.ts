/**
 * Credential egress gate for outbound IM text.
 *
 * Field incident (2026-10-20): the employee pasted an account password into a
 * GROUP chat while troubleshooting a login failure. The employee is supposed to
 * use credentials internally (auto-login, form filling) and never print them —
 * the prompt says so — but a prompt rule is a suggestion, not a gate. This
 * module is the mechanical gate: outbound text is scanned before delivery and,
 * when a concrete credential is present, the WHOLE message is replaced with a
 * fixed notice.
 *
 * Deliberate design choices:
 *  - Fail closed on a hit rather than redacting just the matched span. Partial
 *    redaction leaves surrounding prose that often re-states the value ("密码还是
 *    xxx 吗？最近变过没有" → masking only the value still tells everyone which
 *    account and invites a re-ask); replacing the message keeps the secret out
 *    and makes the suppression obvious to the operator.
 *  - Only CONCRETE values are blocked. Merely talking about credentials
 *    ("密码最近变更过吗", "验证码过期了", "知识库里有密码") must pass through, or
 *    every legitimate troubleshooting reply gets nuked.
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
	if (!text) return false;
	for (const pattern of SHAPE_PATTERNS) {
		if (pattern.test(text)) return true;
	}
	for (const pattern of LABEL_VALUE_PATTERNS) {
		const match = pattern.exec(text);
		if (!match) continue;
		// A labelled mention only counts when the following token looks like a
		// real value, not prose such as 「密码已变更」/「密码忘记就重置」.
		if (looksLikeSecretValue(match[1] ?? "")) return true;
	}
	return false;
}

/**
 * Gate outbound text for one delivery.
 *
 * The audience decides everything; the adapter must pass a trusted audience,
 * never text-derived intent (a group member writing "我是管理员" cannot widen it).
 */
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
 * anyone safer. Anything else that still trips the detector after this removal
 * falls through to the full withhold.
 */
function redactUrlCredentialParams(text: string): string {
	return text.replace(URL_TOKEN_PARAM_GLOBAL, (_m, prefix: string) => `${prefix}***`);
}

export function gateOutboundText(text: string, audience: CredentialAudience): string {
	if (audience === "admin-single") return text;
	const redacted = redactUrlCredentialParams(text);
	if (redacted !== text && !containsConcreteCredential(redacted)) return redacted;
	return containsConcreteCredential(text) ? CREDENTIAL_WITHHELD_NOTICE : text;
}
