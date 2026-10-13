import assert from "node:assert/strict";
import { test } from "node:test";
import { renderMarkdown, resolvePath, sanitizeHtml } from "../src/markdown.ts";

const ctx = { dir: "docs", fileUrl: (p: string) => `/file/${p}`, rawUrl: (p: string) => `/raw/${p}` };

test("markdown renders with repo-relative links and images rewritten", () => {
	const out = renderMarkdown("# Title\n\n[guide](./guide.md#setup) ![shot](../img/a.png) [ext](https://example.com/x?a=1&b=2)\n\n```js\nconst a = '<b>';\n```\n", ctx);
	assert.match(out, /<h1>Title<\/h1>/);
	assert.match(out, /href="\/file\/docs\/guide\.md#setup"/);
	assert.match(out, /src="\/raw\/img\/a\.png"/);
	assert.match(out, /href="https:\/\/example\.com\/x\?a=1&amp;b=2"/);
	assert.match(out, /<code class="language-js">const a = &#39;&lt;b&gt;&#39;;/);
});

test("active content never survives", () => {
	const attacks = [
		`<script>alert(1)</script>`,
		`<img src=x onerror=alert(1)>`,
		`<img src="x" onerror="alert(1)">`,
		`<a href="javascript:alert(1)">x</a>`,
		`<a href="java&#115;cript:alert(1)">x</a>`,
		`<a href=" jav\tascript:alert(1)">x</a>`,
		`[x](javascript:alert(1))`,
		`[x](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)`,
		`<iframe src="https://evil.example"></iframe>`,
		`<form method="post" action="/accounts/x"><button>Click</button><input name="enabled" value="1"></form>`,
		`<svg onload=alert(1)><script>alert(1)</script></svg>`,
		`<style>body{display:none}</style>`,
		`<div style="position:fixed;inset:0" onclick="alert(1)">x</div>`,
		`<meta http-equiv="refresh" content="0;url=https://evil.example">`,
		`<base href="https://evil.example/">`,
		`<object data="x"></object><embed src="x">`,
		`<a href="x" onclick='alert(1)>y</a>`,
		`<img src="x"onerror="alert(1)">`,
		`<scr<script>ipt>alert(1)</scr</script>ipt>`,
		`<details open ontoggle=alert(1)>x</details>`,
		`<math><mi xlink:href="javascript:alert(1)">x</mi></math>`,
		`<a href="vbscript:msgbox(1)">x</a>`,
		`<img src="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=">`,
		`<script></script><img src=x onerror=alert(1)>`,
		`<pre><img src=x onerror=alert(1)></pre>`,
		`<style><img src=x onerror=alert(1)>`,
		`<textarea></textarea><script>alert(1)</script>`,
	];
	for (const attack of attacks) {
		for (const out of [renderMarkdown(attack, ctx), sanitizeHtml(attack, ctx)]) {
			// Whatever is left must contain no executable tag, handler, style or scripting URL in real markup.
			assert.doesNotMatch(out, /<\/?script/i, `${attack} -> ${out}`);
			const tags = out.match(/<[^>]+>/g) ?? [];
			for (const tag of tags) {
				assert.doesNotMatch(tag, /^<\/?(script|style|iframe|form|input|button|svg|math|meta|base|object|embed|link)\b/i, `${attack} -> ${out}`);
				assert.doesNotMatch(tag, /\son[a-z]+\s*=|\sstyle\s*=/i, `${attack} -> ${out}`);
				assert.doesNotMatch(tag, /(href|src|srcset)="(?!https?:\/\/|\/file\/|\/raw\/|mailto:|#|data:image\/(png|gif|jpeg|webp);base64,)/i, `${attack} -> ${out}`);
			}
		}
	}
});

test("common README html is kept", () => {
	const out = sanitizeHtml(`<p align="center"><img src="logo.png" width="120" alt="Logo"><br><a href="https://example.com">site</a> &amp; &copy; <kbd>Ctrl</kbd></p><!-- note -->`, ctx);
	assert.equal(
		out,
		`<p align="center"><img src="/raw/docs/logo.png" width="120" alt="Logo" loading="lazy"><br><a href="https://example.com" rel="noopener noreferrer nofollow">site</a> &amp; &copy; <kbd>Ctrl</kbd></p>`,
	);
});

test("relative paths cannot escape the repository", () => {
	assert.equal(resolvePath("docs/api", "../img/a.png"), "docs/img/a.png");
	assert.equal(resolvePath("docs", "/top.md"), "top.md");
	assert.equal(resolvePath("", "../../etc/passwd"), null);
});
