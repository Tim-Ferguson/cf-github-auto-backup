// Renders README files. Repository content is untrusted (forks and starred
// repos are other people's), so nothing from the source reaches the page
// verbatim: Markdown is rendered by marked, and any raw HTML in it is rebuilt
// from an allowlist of tags and attributes. The pages that show the result
// also run under a CSP with no inline script.

import { Marked, type Tokens } from "marked";

const ALLOWED_TAGS = new Set([
	"a", "b", "blockquote", "br", "center", "code", "dd", "del", "details", "div", "dl", "dt", "em", "h1", "h2", "h3", "h4", "h5", "h6",
	"hr", "i", "img", "ins", "kbd", "li", "ol", "p", "picture", "pre", "s", "samp", "source", "span", "strike", "strong", "sub", "summary",
	"sup", "table", "tbody", "td", "tfoot", "th", "thead", "tr", "tt", "u", "ul", "var",
]);
const VOID_TAGS = new Set(["br", "hr", "img", "source"]);
const GLOBAL_ATTRS = new Set(["align", "title"]);
const TAG_ATTRS: Record<string, Set<string>> = {
	a: new Set(["href", "name"]),
	img: new Set(["src", "alt", "width", "height"]),
	source: new Set(["srcset", "media", "type"]),
	td: new Set(["colspan", "rowspan", "valign"]),
	th: new Set(["colspan", "rowspan", "valign"]),
	ol: new Set(["start"]),
	details: new Set(["open"]),
};
// Elements whose content must go too, not just the tags.
const DROP_WITH_CONTENT = /<(script|style|iframe|object|embed|template|noscript|textarea|title|svg|math)\b[\s\S]*?(?:<\/\1\s*>|$)/gi;
const TAG_OR_COMMENT = /<!--[\s\S]*?(?:-->|$)|<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:[^<>"']|"[^"]*"|'[^']*')*)>/g;
const ATTR = /([a-zA-Z][a-zA-Z0-9-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>`]+)))?/g;

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: String.fromCharCode(0xa0) };
// Whitespace, control and zero-width characters, which browsers skip inside a URL scheme.
const INVISIBLE = new RegExp("[" + ["0000-0020", "007f-009f", "200b-200f", "2028", "2029", "feff"].map((r) => r.split("-").map((h) => String.fromCharCode(parseInt(h, 16))).join("-")).join("") + "]", "g");

function decodeEntities(text: string): string {
	return text.replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));?/gi, (whole, dec, hexa, name) => {
		if (dec) return String.fromCodePoint(Math.min(Number(dec), 0x10ffff));
		if (hexa) return String.fromCodePoint(Math.min(parseInt(hexa, 16), 0x10ffff));
		return NAMED[name.toLowerCase()] ?? whole;
	});
}

const escapeAttr = (text: string) => text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** Escapes text but leaves character references the author wrote intact. */
const escapeText = (text: string) => text.replace(/&(?!#?\w+;)/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export interface LinkContext {
	/** Maps a path inside the repository to the URL that shows it. */
	fileUrl: (path: string) => string;
	/** Maps a path inside the repository to the URL of its raw bytes. */
	rawUrl: (path: string) => string;
	/** Directory of the document being rendered, "" for the root. */
	dir: string;
}

/** Resolves a relative reference against the document's directory, or null if it escapes the repo. */
export function resolvePath(dir: string, ref: string): string | null {
	const parts = ref.startsWith("/") ? [] : dir.split("/").filter(Boolean);
	for (const part of ref.split("/")) {
		if (part === "" || part === ".") continue;
		if (part === "..") {
			if (parts.length === 0) return null;
			parts.pop();
		} else parts.push(part);
	}
	return parts.join("/");
}

/**
 * Returns a URL that is safe to emit, or null. Absolute URLs must be http(s)
 * or mailto; anything relative is pointed at the backed-up file.
 */
export function safeUrl(value: string, kind: "link" | "image", ctx: LinkContext): string | null {
	// Browsers ignore whitespace and control characters inside a scheme.
	const url = decodeEntities(value).replace(INVISIBLE, "");
	if (!url) return null;
	if (/^https?:\/\//i.test(url)) return url;
	if (url.startsWith("//")) return `https:${url}`;
	if (kind === "link" && /^mailto:/i.test(url)) return url;
	if (kind === "link" && url.startsWith("#")) return url;
	if (kind === "image" && /^data:image\/(?:png|gif|jpeg|webp);base64,[a-z0-9+/=]+$/i.test(url)) return url;
	if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return null;

	const [pathPart, fragment] = url.split("#", 2);
	let path: string | null;
	try {
		path = resolvePath(ctx.dir, decodeURIComponent(pathPart.split("?")[0]));
	} catch {
		return null;
	}
	if (path === null) return null;
	return (kind === "image" ? ctx.rawUrl(path) : ctx.fileUrl(path)) + (kind === "link" && fragment ? `#${encodeURIComponent(fragment)}` : "");
}

function rebuildTag(closing: boolean, name: string, attrText: string, ctx: LinkContext): string {
	if (!ALLOWED_TAGS.has(name)) return "";
	if (closing) return VOID_TAGS.has(name) ? "" : `</${name}>`;

	let out = `<${name}`;
	const seen = new Set<string>();
	for (const m of attrText.matchAll(ATTR)) {
		const attr = m[1].toLowerCase();
		if (seen.has(attr) || !(GLOBAL_ATTRS.has(attr) || TAG_ATTRS[name]?.has(attr))) continue;
		seen.add(attr);
		let value = m[2] ?? m[3] ?? m[4] ?? "";
		if (attr === "href" || attr === "src") {
			const url = safeUrl(value, attr === "src" ? "image" : "link", ctx);
			if (url === null) continue;
			value = url;
		} else if (attr === "srcset") {
			const url = safeUrl(value.trim().split(/\s+/)[0] ?? "", "image", ctx);
			if (url === null) continue;
			value = url;
		} else {
			value = decodeEntities(value);
		}
		out += ` ${attr}="${escapeAttr(value)}"`;
	}
	if (name === "a") out += ` rel="noopener noreferrer nofollow"`;
	if (name === "img") out += ` loading="lazy"`;
	return `${out}>`;
}

/** Rebuilds an HTML fragment from allowlisted tags; everything else becomes text or is dropped. */
export function sanitizeHtml(fragment: string, ctx: LinkContext): string {
	const input = fragment.replace(DROP_WITH_CONTENT, "");
	let out = "";
	let last = 0;
	for (const m of input.matchAll(TAG_OR_COMMENT)) {
		out += escapeText(input.slice(last, m.index));
		last = m.index + m[0].length;
		if (m[2]) out += rebuildTag(m[1] === "/", m[2].toLowerCase(), m[3] ?? "", ctx);
	}
	return out + escapeText(input.slice(last));
}

export function renderMarkdown(source: string, ctx: LinkContext): string {
	const marked = new Marked({
		gfm: true,
		renderer: {
			html(token: Tokens.HTML | Tokens.Tag) {
				return sanitizeHtml(token.text, ctx);
			},
			// marked emits text inside <script>, <pre> and similar verbatim,
			// trusting the tags around it. Those tags may have been dropped
			// here, so text is always escaped.
			text(token: Tokens.Text | Tokens.Escape) {
				return "tokens" in token && token.tokens ? this.parser.parseInline(token.tokens) : escapeText(token.text);
			},
			link(token: Tokens.Link) {
				const text = this.parser.parseInline(token.tokens);
				const href = safeUrl(token.href, "link", ctx);
				if (href === null) return text;
				const title = token.title ? ` title="${escapeAttr(token.title)}"` : "";
				return `<a href="${escapeAttr(href)}"${title} rel="noopener noreferrer nofollow">${text}</a>`;
			},
			image(token: Tokens.Image) {
				const src = safeUrl(token.href, "image", ctx);
				if (src === null) return escapeText(token.text);
				const title = token.title ? ` title="${escapeAttr(token.title)}"` : "";
				return `<img src="${escapeAttr(src)}" alt="${escapeAttr(token.text)}"${title} loading="lazy">`;
			},
		},
	});
	return marked.parse(source, { async: false });
}
