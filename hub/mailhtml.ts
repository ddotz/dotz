// Mail HTML for the web's original view: the poster's HTML body reduced to a safe allowlist before it is stored. The web also shows
// it in a sandboxed iframe with a CSP (web/js/30-mailbody.js), so this is the first of two layers, not the only one.
// Kept: layout tags (tables, lists, headings, text), inline styles without url()/expression, links (http, https, mailto, tel) and images
// (data: images, `cid:` images of an attachment, and remote images parked in data-rsrc until the owner asks for them).
// Dropped with their content: scripts, styles, frames, objects, svg, media, forms' controls. Everything else loses its tag and keeps its text.

export const MAIL_HTML_MAX = 400_000;

const DROP = new Set(["script", "style", "iframe", "frame", "frameset", "object", "embed", "applet", "svg", "math", "video", "audio", "canvas", "noscript", "template", "head", "title", "textarea", "select", "option", "button"]);
const KEEP = new Set([
	"a", "abbr", "address", "article", "aside", "b", "big", "blockquote", "br", "caption", "center", "cite", "code", "col", "colgroup", "dd", "del", "details", "div", "dl", "dt", "em", "figcaption", "figure", "font",
	"footer", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "i", "img", "ins", "li", "mark", "ol", "p", "pre", "q", "s", "section", "small", "span", "strike", "strong", "sub", "summary", "sup", "table", "tbody",
	"td", "tfoot", "th", "thead", "tr", "u", "ul",
]);
const ATTRS = new Set(["align", "alt", "bgcolor", "border", "cellpadding", "cellspacing", "color", "colspan", "dir", "face", "height", "href", "lang", "nowrap", "rowspan", "scope", "size", "src", "style", "title", "valign", "width"]);
const DATA_IMG = /^data:image\/(?:png|jpe?g|gif|webp|bmp);base64,[a-z0-9+/=\s]+$/i;
const SAFE_LINK = /^(?:https?:|mailto:|tel:)/i;

/** An inline style without anything that loads, runs or covers the page: url() other than data images, expression(), @import, fixed/absolute positioning. */
export function cleanStyle(s: string): string {
	return s
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/\\/g, "")
		.replace(/url\s*\(\s*(['"]?)(data:image\/[a-z+.-]+;base64,[a-z0-9+/=]+)\1\s*\)/gi, (_, _q, d) => `url("${d}")`)
		.replace(/url\s*\((?!\s*"data:image\/)[^)]*\)/gi, "none")
		.replace(/expression\s*\(|javascript:|behavior\s*:|-moz-binding\s*:|@import/gi, "x")
		.replace(/position\s*:\s*(?:fixed|absolute|sticky)/gi, "position:static");
}

/** Sanitizes a mail's HTML. `cids` maps a Content-ID (without `cid:`) to the route that serves that attachment. */
export async function sanitizeMailHtml(html: string, cids: Record<string, string> = {}): Promise<string> {
	const rewriter = new HTMLRewriter()
		.onDocument({
			comments(c) {
				c.remove();
			},
			doctype(d) {
				d.remove();
			},
		})
		.on("*", {
			element(el) {
				const tag = el.tagName.toLowerCase();
				if (DROP.has(tag)) {
					el.remove();
					return;
				}
				if (!KEEP.has(tag)) {
					el.removeAndKeepContent();
					return;
				}
				for (const [name, raw] of [...el.attributes]) {
					const n = name.toLowerCase();
					const v = raw.trim();
					if (!ATTRS.has(n)) el.removeAttribute(name);
					else if (n === "style") {
						const c = cleanStyle(v);
						if (c) el.setAttribute("style", c);
						else el.removeAttribute(name);
					} else if (n === "href") {
						if (tag === "a" && SAFE_LINK.test(v)) el.setAttribute("href", v);
						else el.removeAttribute(name);
					} else if (n === "src") {
						if (tag !== "img") el.removeAttribute(name);
						else if (DATA_IMG.test(v)) el.setAttribute("src", v.replace(/\s+/g, ""));
						else if (/^cid:/i.test(v) && cids[v.slice(4).replace(/^<|>$/g, "")]) el.setAttribute("src", cids[v.slice(4).replace(/^<|>$/g, "")]!);
						else {
							el.removeAttribute(name);
							if (/^https?:\/\//i.test(v)) el.setAttribute("data-rsrc", v);
						}
					}
				}
				if (tag === "a") {
					el.setAttribute("target", "_blank");
					el.setAttribute("rel", "noopener noreferrer");
				}
			},
		});
	return (await rewriter.transform(new Response(html.slice(0, MAIL_HTML_MAX))).text()).trim();
}
