/**
 * Markdown → self-contained HTML for published reports.
 *
 * The report center publishes the raw markdown body, but a browser renders a
 * bare .md as an unstyled wall of text (OSS serves it as text/markdown and
 * Gitee raw as plain text). This module wraps the same body in a standalone,
 * print-friendly HTML page — embedded CSS only, no external assets — so the
 * share link the employee hands out opens as a clean readable report. The
 * stylesheet mirrors a GitHub-ish reading view (bordered zebra tables, code
 * blocks, @media print for save-as-PDF).
 */
import { marked } from "marked";

const CSS = `
:root { --ink:#1f2328; --muted:#57606a; --line:#d8dee4; --accent:#0969da; --bg:#f6f8fa; }
* { box-sizing: border-box; }
body { margin:0; padding:2.5rem 1.25rem 4rem; background:#fafbfc; color:var(--ink);
  font-family:-apple-system,"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Segoe UI",sans-serif;
  font-size:15px; line-height:1.75; }
.report { max-width:860px; margin:0 auto; }
h1 { font-size:1.5rem; border-bottom:2px solid var(--line); padding-bottom:.4rem; }
h2 { font-size:1.22rem; margin-top:2rem; border-bottom:1px solid var(--line); padding-bottom:.3rem; }
h3 { font-size:1.05rem; }
a { color:var(--accent); text-decoration:none; }
a:hover { text-decoration:underline; }
table { border-collapse:collapse; width:100%; margin:1rem 0; font-size:.92rem; background:#fff; }
th, td { border:1px solid var(--line); padding:.5rem .7rem; text-align:left; vertical-align:top; }
th { background:var(--bg); font-weight:600; white-space:nowrap; }
tr:nth-child(even) td { background:#fcfdfe; }
code { background:var(--bg); border:1px solid var(--line); border-radius:4px; padding:.1em .35em; font-size:.88em; }
pre { background:var(--bg); border:1px solid var(--line); border-radius:6px; padding:.9rem; overflow-x:auto; }
pre code { border:none; background:none; padding:0; }
blockquote { border-left:4px solid var(--line); margin:1rem 0; padding:.2rem 1rem; color:var(--muted); }
hr { border:none; border-top:1px solid var(--line); margin:2rem 0; }
li { margin:.25rem 0; }
img { max-width:100%; }
@media print {
  body { background:#fff; padding:0; font-size:12.5pt; }
  .report { max-width:none; }
  h2 { page-break-after:avoid; }
  table, pre { page-break-inside:avoid; }
}
`;

function escapeHtml(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Render report markdown into a standalone styled HTML page. */
export function renderReportHtml(title: string, markdown: string): string {
	const body = marked.parse(markdown ?? "", { async: false, gfm: true });
	return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
<style>${CSS}</style>
</head>
<body>
<div class="report">
<h1>${escapeHtml(title)}</h1>
${body}
</div>
</body>
</html>`;
}
