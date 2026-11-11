#!/usr/bin/env bun
// 결과물 점검: 만든 화면이 보기 좋은지 눈으로 보기 전에 숫자로 재요.
//   bun check.ts <주소|파일.html> [--json] [--shots <폴더>]
// 390x844와 1280x800, 라이트와 다크로 헤드리스 Bun.WebView에 열어 위반을 한 줄씩 보여 주고 0~100 점수를 매겨요.
// 종료 코드: 0 깨끗함, 1 위반 있음, 2 쓰는 법이 틀림, 3 막힘(WebView가 없거나 페이지가 안 열림).
// 모델도 외부 네트워크도 쓰지 않아요. 파일은 이 기기의 루프백에서만 잠깐 서빙해서 CSS 링크가 같은 출처로 읽혀요.
// 다크: WebKit WebView에는 prefers-color-scheme 전환 스위치가 없어서, 페이지 안의 그 미디어 규칙을 바꿔 끼워(에뮬레이션) 재요.
import { parseArgs } from "node:util";
import { existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { measureMobile, measureMotion, measureRaw, prepCss } from "./measure-more.ts";

export const RULES: Record<string, { w: number; label: string }> = {
	contrast: { w: 1.5, label: "글자 대비" },
	touch: { w: 1, label: "누르는 곳 크기" },
	"one-lead": { w: 1, label: "첫눈에 하나" },
	repeat: { w: 1, label: "같은 말 반복" },
	"state-word": { w: 1, label: "상태를 글자로" },
	accent: { w: 1, label: "강조색은 누를 것에만" },
	colors: { w: 0.5, label: "색 가짓수" },
	"icon-box": { w: 0.5, label: "아이콘 뒤 색 상자" },
	"nested-card": { w: 1, label: "카드 안 카드" },
	"side-stripe": { w: 1, label: "한쪽 색 줄" },
	glow: { w: 1, label: "색 번지는 그림자" },
	"gradient-text": { w: 1, label: "그라데이션 글자" },
	"body-size": { w: 1, label: "글자 크기" },
	"line-height": { w: 1, label: "줄 간격" },
	"line-length": { w: 1, label: "한 줄 길이" },
	"overflow-x": { w: 1.5, label: "가로 넘침" },
	"zoom-lock": { w: 1, label: "확대 잠금" },
	"safe-area": { w: 0.5, label: "안전 영역에 cover 없음" },
	"theme-color": { w: 0.5, label: "상태 막대 색 하나" },
	"vh-shell": { w: 1, label: "100vh 앱 틀" },
	"hover-ungated": { w: 1, label: "터치에 남는 hover" },
	"input-font": { w: 1, label: "입력칸 글자 16px 미만" },
	"transition-all": { w: 0.5, label: "transition: all" },
	"ease-in": { w: 0.5, label: "ease-in 움직임" },
	"slow-motion": { w: 0.5, label: "300ms 넘는 움직임" },
	"scale-zero": { w: 0.5, label: "scale(0)에서 시작" },
	"layout-motion": { w: 1, label: "배치 속성 움직임" },
	"no-reduced-motion": { w: 1, label: "움직임 줄이기 없음" },
	"raw-value": { w: 1.5, label: "화면에 샌 값" },
};
type Hit = { rule: string; sel: string; val: string };
type PageOut = { swapped: number; unread: number; hits: Hit[] };

// 페이지 안에서 도는 측정 코드예요. kit, measureA, measureB를 String()으로 한 식에 넣어 K를 넘기니 바깥 값을 쓰지 않는 덩어리여야 해요.
function kit(cfg: { scheme: string; touch: boolean; narrow: boolean }): any {
	const W: any = window, D = document, root = D.documentElement;
	const hits: { rule: string; sel: string; val: string }[] = [];
	const count: Record<string, number> = {};
	const add = (rule: string, sel: string, val: string) => {
		count[rule] = (count[rule] || 0) + 1;
		if (count[rule] <= 40) hits.push({ rule, sel, val });
	};
	const cs = (e: Element) => getComputedStyle(e);

	// ---- 색 구성표 바꿔 끼우기 (WebView에 전환 스위치가 없어요)
	const O: Map<any, string> = W.__chkO || (W.__chkO = new Map());
	W.__chkScheme = cfg.scheme;
	const sw = (t: string) =>
		t.replace(/\(\s*prefers-color-scheme\s*:\s*(dark|light)\s*\)/gi, (_m, k) => (String(k).toLowerCase() === cfg.scheme ? "(min-width: 0px)" : "(min-width: 99999px)"));
	let swapped = 0, unread = 0;
	const walk = (rules: CSSRuleList) => {
		for (const r of Array.from(rules) as any[]) {
			if (r instanceof CSSMediaRule) {
				if (!O.has(r)) O.set(r, r.media.mediaText);
				const o = O.get(r)!;
				if (/prefers-color-scheme/i.test(o)) { swapped++; r.media.mediaText = sw(o); }
			}
			if (r.cssRules) walk(r.cssRules);
		}
	};
	for (const s of Array.from(D.styleSheets)) { try { walk(s.cssRules); } catch { unread++; } }
	for (const n of Array.from(D.querySelectorAll("link[media],style[media]"))) {
		if (!O.has(n)) O.set(n, n.getAttribute("media") || "");
		if (/prefers-color-scheme/i.test(O.get(n)!)) { swapped++; n.setAttribute("media", sw(O.get(n)!)); }
	}
	if (!W.__chkMM) {
		W.__chkMM = W.matchMedia.bind(W);
		W.matchMedia = (q: string) => W.__chkMM(String(q).replace(/\(\s*prefers-color-scheme\s*:\s*(dark|light)\s*\)/gi, (_m: string, k: string) => (k.toLowerCase() === W.__chkScheme ? "(min-width: 0px)" : "(min-width: 99999px)")));
	}
	root.style.setProperty("color-scheme", cfg.scheme, "important");
	if (!D.getElementById("chk-freeze")) {
		const st = D.createElement("style");
		st.id = "chk-freeze";
		st.textContent = "*,*::before,*::after{transition:none!important;animation:none!important}";
		D.head.appendChild(st);
	}

	// ---- 색 도구
	const cv = D.createElement("canvas").getContext("2d", { willReadFrequently: true } as any);
	const pcache = new Map<string, number[] | null>();
	const parse = (s: string): number[] | null => {
		s = (s || "").trim();
		if (!s) return null;
		if (pcache.has(s)) return pcache.get(s)!;
		let r: number[] | null = null;
		if (s === "transparent") r = [0, 0, 0, 0];
		else {
			let m = s.match(/^rgba?\(([^)]+)\)$/);
			if (m) { const p = m[1].split(/[\s,/]+/).filter(Boolean).map(parseFloat); if (p.length >= 3 && !p.some(Number.isNaN)) r = [p[0], p[1], p[2], p.length > 3 ? p[3] : 1]; }
			else if ((m = s.match(/^color\(srgb\s+([^)]+)\)$/))) { const p = m[1].split(/[\s/]+/).filter(Boolean).map(parseFloat); if (p.length >= 3 && !p.some(Number.isNaN)) r = [p[0] * 255, p[1] * 255, p[2] * 255, p.length > 3 ? p[3] : 1]; }
			if (!r && cv) {
				cv.clearRect(0, 0, 1, 1);
				cv.fillStyle = "#000";
				cv.fillStyle = s;
				cv.fillRect(0, 0, 1, 1);
				const d = cv.getImageData(0, 0, 1, 1).data;
				r = [d[0], d[1], d[2], d[3] / 255];
			}
		}
		pcache.set(s, r);
		return r;
	};
	const over = (f: number[], b: number[]) => { const a = f[3]; return [f[0] * a + b[0] * (1 - a), f[1] * a + b[1] * (1 - a), f[2] * a + b[2] * (1 - a), 1]; };
	const lum = (c: number[]) => { const f = (v: number) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
	const hex = (c: number[]) => "#" + c.slice(0, 3).map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
	const chroma = (c: number[]) => (Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2])) / 255;
	const hsl = (x: number[]) => {
		const r = x[0] / 255, g = x[1] / 255, b = x[2] / 255, mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
		let h = 0, s = 0;
		if (d > 0) { s = d / (1 - Math.abs(2 * l - 1)); h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; h = (h * 60 + 360) % 360; }
		return { h, s, l };
	};
	const probe = D.createElement("div");
	probe.style.cssText = "position:absolute;left:-9999px;width:1px;height:1px;background:Canvas";
	D.body.appendChild(probe);
	const canvasBg = parse(cs(probe).backgroundColor) || [255, 255, 255, 1];
	probe.remove();
	const bgOf = (p: Element): number[] | null => {
		const layers: number[][] = [];
		for (let e: Element | null = p; e; e = e.parentElement) {
			const s = cs(e);
			if (s.backgroundImage !== "none") return null;
			const c = parse(s.backgroundColor);
			if (!c) return null;
			if (c[3] > 0) layers.push(c);
			if (c[3] >= 0.999) break;
		}
		let base = [canvasBg[0], canvasBg[1], canvasBg[2], 1];
		if (layers.length && layers[layers.length - 1][3] >= 0.999) base = layers.pop()!;
		for (let i = layers.length - 1; i >= 0; i--) base = over(layers[i], base);
		return base;
	};
	const opacityOf = (p: Element) => { let o = 1; for (let e: Element | null = p; e; e = e.parentElement) o *= parseFloat(cs(e).opacity); return o; };

	// ---- 이름과 보임
	const seg = (e: Element) => {
		let s = e.tagName.toLowerCase();
		if (e.id) return s + "#" + e.id;
		const c = (typeof e.className === "string" ? e.className.trim().split(/\s+/).filter(Boolean) : []).slice(0, 2);
		if (c.length) return s + "." + c.join(".");
		if (e.parentElement) { const sib = Array.from(e.parentElement.children).filter((x) => x.tagName === e.tagName); if (sib.length > 1) s += ":nth-of-type(" + (sib.indexOf(e) + 1) + ")"; }
		return s;
	};
	const path = (e: Element) => {
		const a: string[] = [];
		for (let x: Element | null = e; x && x !== D.body && x !== root && a.length < 3; x = x.parentElement) { a.unshift(seg(x)); if (x.id) break; }
		return a.join(">") || "body";
	};
	const r1 = (x: number) => Math.round(x * 10) / 10;
	const vis = (e: any): boolean => (cs(e).display === "contents" ? (e.parentElement ? vis(e.parentElement) : true) : e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }));
	const svgInner = (e: Element) => e instanceof SVGElement && e.tagName.toLowerCase() !== "svg";
	const els = Array.from(D.body.querySelectorAll("*")).filter((e) => {
		if (svgInner(e) || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|LINK|META|HEAD|TITLE)$/.test(e.tagName) || !vis(e)) return false;
		const r = e.getBoundingClientRect();
		return cs(e).display === "contents" || (r.width > 1 && r.height > 1);
	});
	const items: { n: Text; p: Element; t: string }[] = [];
	{
		const seen = new Map<Element, boolean>();
		const w = D.createTreeWalker(D.body, NodeFilter.SHOW_TEXT);
		let n: Node | null;
		while ((n = w.nextNode())) {
			const t = n.nodeValue, p = n.parentElement;
			if (!t || !t.trim() || !p || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|OPTION|TITLE)$/.test(p.tagName) || svgInner(p)) continue;
			let v = seen.get(p);
			if (v === undefined) { const r = p.getBoundingClientRect(); v = vis(p) && cs(p).fontSize !== "0px" && (r.width > 1 || cs(p).display === "contents") && r.right > 0; seen.set(p, v); }
			if (v) items.push({ n: n as Text, p, t });
		}
	}
	const uniq = <T,>(a: T[]) => Array.from(new Set(a));
	const textEls = uniq(items.map((i) => i.p));
	const vw = root.clientWidth, vh = window.innerHeight;
	const PRESS = 'button,a,input,label,select,textarea,summary,[role="button"],[role="link"],[role="tab"],[role="switch"],[role="option"],[role="menuitem"]';
	const ACCOK = '.on,.sel,.selected,.active,.current,[aria-selected="true"],[aria-current],[aria-pressed="true"],[aria-checked="true"],progress,[role="progressbar"],meter,[class~="dot"],[class*="progress" i],[class*="spinner" i]';
	const USERC = 'img,picture,video,canvas,[class*="avatar" i],[class*="bubble" i],[class*="photo" i],[class*="logo" i]';
	const SELF_NOT = 'dialog,[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"],[role="tooltip"],table,tr,td,th';
	const ANC_NOT = 'button,[role="button"],[role="tab"],[role="menuitem"],[role="option"],input,textarea,select,summary,a[href],label,pre,code,blockquote,img,picture,video,canvas,[class~="tag"],[class~="chip"],[class~="badge"],[class~="pill"],[class*="bubble" i],[class*="quote" i],[class*="avatar" i]';
	const SHEET = 'dialog[open],[role="dialog"],[role="alertdialog"],[class~="sheet"],[class~="modal"]';
	const CTRL = 'button,.btn,[role="button"]';

	// ---- 카드 모양 상자: 바탕이 부모와 다르고 모서리 8px 이상인 64x40 이상 상자
	const cardish = new Set<Element>();
	for (const e of els) {
		if (e instanceof SVGElement || !e.parentElement || e.matches(SELF_NOT) || e.closest(ANC_NOT)) continue;
		const r = e.getBoundingClientRect();
		if (r.width < 63.99 || r.height < 39.99) continue;
		const s = cs(e), rad = Math.min(parseFloat(s.borderTopLeftRadius), parseFloat(s.borderTopRightRadius), parseFloat(s.borderBottomLeftRadius), parseFloat(s.borderBottomRightRadius));
		if (!(rad >= 7.99)) continue;
		const own = parse(s.backgroundColor);
		if (!own || own[3] < 0.05) continue;
		const eb = bgOf(e), pb = bgOf(e.parentElement);
		if (eb && pb && Math.abs(eb[0] - pb[0]) + Math.abs(eb[1] - pb[1]) + Math.abs(eb[2] - pb[2]) <= 6) continue;
		const kids = Array.from(e.children).filter((k) => vis(k));
		if (kids.length && kids.every((k) => k.matches('button,[role="button"],a,svg,img,input,select'))) continue;   // 단추 줄
		cardish.add(e);
	}
	for (const c of cardish) c.setAttribute("data-chk-card", "");
	const CX = '[data-chk-card],[class*="card" i],article,' + SHEET;
	const CR = CX + ',li,tr,[role="listitem"],[role="row"],[class~="row"],[class~="item"],header,[role="banner"],[class~="appbar"],[class~="toolbar"]';

	return { W, D, root, add, hits, cs, parse, over, lum, hex, chroma, hsl, bgOf, opacityOf, seg, path, r1, vis, svgInner, els, items, textEls, vw, vh, PRESS, ACCOK, USERC, CTRL, SHEET, CX, CR, cardish, cfg, uniq, swapped, unread };
}

function measureA(K: any): void {
	const { W, D, root, add, hits, cs, parse, over, lum, hex, chroma, hsl, bgOf, opacityOf, seg, path, r1, vis, svgInner, els, items, textEls, vw, vh, PRESS, ACCOK, USERC, CTRL, SHEET, CX, CR, cardish, cfg, uniq } = K;
	// ---- 글자 대비 (3:1은 18px 이상 또는 굵은 14px 이상)
	for (const p of textEls) {
		if (p.closest(":disabled,[disabled],[aria-disabled='true']")) continue;
		const s = cs(p), fg = parse(s.color), bg = bgOf(p);
		if (!fg || !bg || fg[3] * opacityOf(p) < 0.02) continue;
		const col = over([fg[0], fg[1], fg[2], fg[3] * opacityOf(p)], bg);
		const L1 = lum(col), L2 = lum(bg), ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
		const f = parseFloat(s.fontSize), bold = parseInt(s.fontWeight) >= 600, need = f >= 18 || (bold && f >= 14) ? 3 : 4.5;
		if (ratio + 0.005 < need) add("contrast", path(p), (Math.round(ratio * 100) / 100) + "<" + need + " " + hex(col) + "/" + hex(bg));
	}

	// ---- 누르는 곳 (폰 폭에서 44px)
	if (cfg.touch) {
		const INT = 'button,a[href],[role="button"],input:not([type="hidden"]),select,textarea,summary', sy = W.scrollY;
		for (const e0 of els as HTMLElement[]) {
			if (!e0.matches(INT) || e0.matches(":disabled,[aria-disabled='true']")) continue;
			if (e0.matches("a[href]") && cs(e0).display === "inline" && e0.parentElement) {
				const rest = (e0.parentElement.textContent || "").replace(e0.textContent || "", "").replace(/\s+/g, "");
				if (rest.length >= 8) continue;   // 글 속 링크는 예외
			}
			const lab = e0 instanceof HTMLInputElement && /checkbox|radio/.test(e0.type) && e0.labels && e0.labels[0];
			const e = (lab || e0) as HTMLElement;
			let r = e.getBoundingClientRect();
			if (r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw) { e.scrollIntoView({ block: "center", inline: "center" }); r = e.getBoundingClientRect(); }
			const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
			if (cx < 0 || cy < 0 || cx >= vw || cy >= vh) continue;
			const hit = (x: number, y: number) => { const t = D.elementFromPoint(x, y); return !!t && (t === e || e.contains(t)); };
			if (!hit(cx, cy)) continue;
			const ext = (dx: number, dy: number) => { let k = 0; while (k < 23 && hit(cx + dx * (k + 1), cy + dy * (k + 1))) k++; return k; };
			const w = ext(-1, 0) + ext(1, 0) + 1, h = ext(0, -1) + ext(0, 1) + 1;
			if (w < 44 || h < 44) add("touch", path(e0), (w >= 47 ? "47+" : w) + "x" + (h >= 47 ? "47+" : h) + "<44");
		}
		W.scrollTo(0, sy);
	}

	// ---- 첫눈에 하나: 카드·창·시트마다 가장 큰 글자 단계를 나눠 가진 서로 다른 글자 수
	{
		const per = new Map<Element, Element[]>();
		for (const p of textEls) {
			if (p.closest(CTRL + ',[class~="tag"],[class~="chip"],[class~="badge"],[class~="pill"]')) continue;
			const g = p.closest(CX);
			if (g) (per.get(g) || per.set(g, []).get(g)!).push(p);
		}
		for (const [g, a] of per) {
			const key = (p: Element) => { const s = cs(p); return [parseFloat(s.fontSize), parseInt(s.fontWeight)]; };
			let top = key(a[0]);
			for (const p of a) { const k = key(p); if (k[0] > top[0] || (k[0] === top[0] && k[1] > top[1])) top = k; }
			const tally = new Map<number, number>();
			for (const p of a) { const f = key(p)[0]; tally.set(f, (tally.get(f) || 0) + 1); }
			let mode = 0, best = -1;
			for (const [f, n] of tally) if (n > best || (n === best && f > mode)) { best = n; mode = f; }
			if (top[1] < 500 && top[0] <= mode) continue;   // 제목 없는 글 그대로의 덩어리
			const texts = new Map<string, Element>();
			for (const p of a) { const k = key(p); if (k[0] === top[0] && k[1] === top[1]) { const t = (p.textContent || "").replace(/\s+/g, " ").trim(); if (t && !texts.has(t)) texts.set(t, p); } }
			if (texts.size > 1) add("one-lead", path(g), "가장 큰 단계 " + top[0] + "px/" + top[1] + " " + texts.size + "개: " + Array.from(texts.keys()).slice(0, 2).map((t) => t.slice(0, 12)).join(" / "));
		}
	}

	// ---- 같은 말 반복: 카드·행·창·시트·앱바 안에서 정규화 글이 같거나 한쪽이 다른 쪽을 품는 쌍
	{
		const own = new Map<Element, string>();
		for (const it of items) {
			if (it.p.closest('[aria-hidden="true"],input,textarea,select,blockquote,q,[class*="quote" i],[class*="bubble" i],[class*="message" i],[class*="comment" i]')) continue;
			own.set(it.p, (own.get(it.p) || "") + it.t);
		}
		const ch = Array.from(own).map(([p, t]) => ({ p, t: t.replace(/\s+/g, " ").trim(), n: t.replace(/[\s\p{P}\p{S}]/gu, "") })).filter((x) => x.n);
		const hg = (s: string) => (s.match(/[\uAC00-\uD7A3]/g) || []).length;
		const rowOf = (x: Element, k: Element) => { const r = x.closest('li,tr,[role="listitem"],[role="row"]'); return r && k.contains(r) && r !== k ? r : null; };
		const seen = new Set<string>();
		for (const k of els.filter((e) => e.matches(CR))) {
			const inn = ch.filter((x) => k.contains(x.p)).slice(0, 80);
			for (let i = 0; i < inn.length; i++) for (let j = i + 1; j < inn.length; j++) {
				const a = inn[i], b = inn[j], sh = a.n.length <= b.n.length ? a : b, lg = sh === a ? b : a;
				if (!(hg(sh.n) >= 2 || sh.n.length >= 4) || !lg.n.includes(sh.n)) continue;
				const ca = a.p.closest(CTRL), cb = b.p.closest(CTRL);
				if (ca && cb) continue;   // 단추 둘이 같은 이름을 쓰는 건 괜찮아요
				const ra = rowOf(a.p, k), rb = rowOf(b.p, k);
				if (ra && rb && ra !== rb) continue;   // 목록의 서로 다른 행
				if (k.matches(SHEET) && ((ca && !cb) || (cb && !ca))) continue;   // 창 제목의 동사를 쓴 실행 단추
				const id = ch.indexOf(a) + "|" + ch.indexOf(b);
				if (seen.has(id)) continue;
				seen.add(id);
				add("repeat", path(k), "'" + a.t.slice(0, 14) + "' ~ '" + b.t.slice(0, 14) + "'");
			}
		}
	}

	// ---- 상태를 글자로 (점·아이콘이 말할 자리)
	{
		const WORDS = new Set(["진행 중", "작업 중", "완료", "실패", "멈춤", "오류", "정상", "대기 중", "답을 기다림", "확인 필요", "연결됨", "끊김", "중단됨", "in progress", "done", "completed", "failed", "error", "running", "pending", "online", "offline", "connected", "disconnected", "stopped", "waiting", "ok"]);
		for (const p of textEls) {
			if (p.closest(CTRL) || !p.closest(CX + ',li,tr,[role="listitem"],[role="row"],[class~="row"],[class~="item"]')) continue;
			const t = (p.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
			if (WORDS.has(t)) add("state-word", path(p), "'" + t + "'");
		}
	}

	// ---- 강조색: 누를 것·선택·진행 밖에서 쓰였는지, 화면 넓이 10% 이하인지
	let ac: number[] | null = null;
	{
		const rs = cs(root);
		for (const v of ["--accent", "--primary", "--brand", "--color-accent", "--color-primary", "--accent-color"]) {
			const raw = rs.getPropertyValue(v).trim();
			if (!raw) continue;
			for (const cand of [raw, "hsl(" + raw + ")"]) {
				const t = D.createElement("div");
				t.style.color = cand;
				if (!t.style.color) continue;
				D.body.appendChild(t);
				const c = parse(cs(t).color);
				t.remove();
				if (c && c[3] > 0.5) { ac = c; break; }
			}
			if (ac) break;
		}
		if (!ac) {
			const tally = new Map<string, { n: number; c: number[] }>();
			for (const e of els) {
				if (!e.matches("button,a[href],[role='button']")) continue;
				const c = parse(cs(e).backgroundColor);
				if (!c || c[3] < 0.9) continue;
				const q = hsl(c);
				if (q.s < 0.4 || q.l < 0.2 || q.l > 0.8) continue;
				const k = hex(c), t = tally.get(k) || { n: 0, c };
				t.n++;
				tally.set(k, t);
			}
			let best = 0;
			for (const t of tally.values()) if (t.n > best) { best = t.n; ac = t.c; }
		}
	}
	if (ac) {
		const A = ac, isAc = (x: number[] | null) => !!x && x[3] > 0.5 && Math.abs(x[0] - A[0]) < 1.5 && Math.abs(x[1] - A[1]) < 1.5 && Math.abs(x[2] - A[2]) < 1.5;
		const accBg = new Set<Element>();
		let area = 0;
		for (const e of els) {
			const s = cs(e), uses: string[] = [];
			if (Array.from(e.childNodes).some((n) => n.nodeType === 3 && !!n.nodeValue && !!n.nodeValue.trim()) && isAc(parse(s.color))) uses.push("글자");
			if (isAc(parse(s.backgroundColor))) {
				uses.push("바탕");
				let top = true;
				for (let a = e.parentElement; a; a = a.parentElement) if (accBg.has(a)) { top = false; break; }
				accBg.add(e);
				if (top) { const r = e.getBoundingClientRect(); area += Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0)) * Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0)); }
			}
			if (["Top", "Right", "Bottom", "Left"].some((side) => (s as any)["border" + side + "Style"] !== "none" && parseFloat((s as any)["border" + side + "Width"]) > 0 && isAc(parse((s as any)["border" + side + "Color"])))) uses.push("테두리");
			if (e instanceof SVGSVGElement) for (const d of [e, ...Array.from(e.querySelectorAll("*"))]) { const q = cs(d); if (isAc(parse(q.fill)) || isAc(parse(q.stroke))) { uses.push("svg"); break; } }
			if (uses.length && !e.closest(PRESS) && !e.closest(ACCOK)) add("accent", path(e), uses.join("+") + " " + hex(A));
		}
		const ratio = area / (vw * vh);
		if (ratio > 0.1) add("accent", "(화면)", "강조색 바탕 넓이 " + r1(ratio * 100) + "% > 10%");
	}

}

function measureB(K: any): void {
	const { W, D, root, add, hits, cs, parse, over, lum, hex, chroma, hsl, bgOf, opacityOf, seg, path, r1, vis, svgInner, els, items, textEls, vw, vh, PRESS, ACCOK, USERC, CTRL, SHEET, CX, CR, cardish, cfg, uniq } = K;
	// ---- 색 가짓수 (채도 있는 색을 색상 30° 구간으로 묶어요)
	{
		const by = new Map<number, string>();
		const note = (x: number[] | null, e: Element, own: boolean, what: string) => {
			if (!x || x[3] <= 0) return;
			let col = x;
			if (x[3] < 0.999) { const b = bgOf(own ? e.parentElement || e : e); if (b) col = over(x, b); }
			const q = hsl(col);
			if (q.s < 0.25 || q.l < 0.12 || q.l > 0.92) return;
			const k = Math.floor(q.h / 30);
			if (!by.has(k)) by.set(k, hex(col) + " " + what);
		};
		for (const e of els) {
			if (e.closest(USERC)) continue;
			const s = cs(e);
			if (Array.from(e.childNodes).some((n) => n.nodeType === 3 && !!n.nodeValue && !!n.nodeValue.trim())) note(parse(s.color), e, false, "글자");
			note(parse(s.backgroundColor), e, true, "바탕");
			for (const side of ["Top", "Right", "Bottom", "Left"]) if ((s as any)["border" + side + "Style"] !== "none" && parseFloat((s as any)["border" + side + "Width"]) > 0) note(parse((s as any)["border" + side + "Color"]), e, false, "테두리");
			if (e instanceof SVGSVGElement) for (const d of [e, ...Array.from(e.querySelectorAll("*"))]) { const q = cs(d); note(parse(q.fill), e, false, "svg"); note(parse(q.stroke), e, false, "svg"); }
		}
		if (by.size > 6) add("colors", "(페이지)", "색 " + by.size + "가지>6: " + Array.from(by.entries()).sort((a, b) => a[0] - b[0]).slice(0, 4).map(([k, t]) => k * 30 + "° " + t).join(" | "));
	}

	// ---- 아이콘 뒤 색 상자: svg를 품은 56x56 이하 장식 상자의 바탕이 주변과 다르고 색이 있어요
	for (const e of els) {
		if (e instanceof SVGElement || !e.querySelector("svg") || e.matches(PRESS) || e.closest(USERC) || e.closest(ACCOK)) continue;
		const r = e.getBoundingClientRect();
		if (r.width > 56.01 || r.height > 56.01 || (e.textContent || "").trim()) continue;
		const own = parse(cs(e).backgroundColor);
		if (!own || own[3] < 0.05 || !e.parentElement) continue;
		const eb = bgOf(e), pb = bgOf(e.parentElement);
		if (!eb) continue;
		if (pb && Math.abs(eb[0] - pb[0]) + Math.abs(eb[1] - pb[1]) + Math.abs(eb[2] - pb[2]) <= 6) continue;
		if (chroma(eb) >= 0.05) add("icon-box", path(e), Math.round(r.width) + "x" + Math.round(r.height) + " 바탕 " + hex(eb) + " 농도 " + r1(chroma(eb)));
	}

	// ---- 카드 안 카드
	{
		const outer = new Map<Element, Element[]>();
		for (const e of cardish) for (let a = e.parentElement; a; a = a.parentElement) if (cardish.has(a)) { (outer.get(a) || outer.set(a, []).get(a)!).push(e); break; }
		for (const [a, inn] of outer) add("nested-card", path(a), "안에 " + inn.length + "개: " + inn.slice(0, 2).map(seg).join(", "));
	}
	for (const c of cardish) c.removeAttribute("data-chk-card");

	// ---- AI 티: 둥근 상자 한쪽의 색 줄, 색 번지는 그림자, 그라데이션 글자
	{
		const coloredC = (c: number[] | null) => !!c && c[3] >= 0.3 && chroma(c) >= 0.12;
		const shadows = (v: string) => {
			const out: string[] = [];
			let d = 0, cur = "";
			for (const ch of v) { if (ch === "(") d++; if (ch === ")") d--; if (ch === "," && d === 0) { out.push(cur.trim()); cur = ""; } else cur += ch; }
			if (cur.trim()) out.push(cur.trim());
			return out.filter((x) => x && x !== "none");
		};
		const COLOR = /(?:rgba?|color|hsla?|oklch|oklab|lab|lch)\([^)]*\)|#[0-9a-fA-F]{3,8}/;
		const glowOf = (v: string, e: Element, kind: string) => {
			for (const sh of shadows(v)) {
				const cm = sh.match(COLOR);
				if (!cm) continue;
				const nums = (sh.replace(cm[0], "").match(/-?\d*\.?\d+(?:px)?/g) || []).map(parseFloat);
				const blur = nums[2] || 0;
				if (!/inset/.test(sh) && blur >= 6 && coloredC(parse(cm[0]))) add("glow", path(e), kind + " 블러 " + blur + "px " + cm[0].slice(0, 28));
			}
		};
		for (const e of els) {
			if (e instanceof SVGElement) continue;
			const s = cs(e);
			const rad = Math.max(parseFloat(s.borderTopLeftRadius), parseFloat(s.borderTopRightRadius), parseFloat(s.borderBottomLeftRadius), parseFloat(s.borderBottomRightRadius));
			const r = e.getBoundingClientRect();
			if (rad >= 4 && r.width >= 40 && r.height >= 24) {
				const side = ["Top", "Right", "Bottom", "Left"].map((n) => ({ n, w: parseFloat((s as any)["border" + n + "Width"]) || 0, st: (s as any)["border" + n + "Style"] as string, c: parse((s as any)["border" + n + "Color"]) }));
				const thick = side.filter((x) => x.st !== "none" && x.st !== "hidden" && x.w >= 3 && coloredC(x.c));
				if (thick.length === 1 && side.filter((x) => x !== thick[0]).every((x) => x.st === "none" || x.w <= 1)) add("side-stripe", path(e), thick[0].n.toLowerCase() + " " + thick[0].w + "px " + hex(thick[0].c!));
				else for (const sh of shadows(s.boxShadow)) {
					const cm = sh.match(COLOR);
					const nums = cm ? (sh.replace(cm[0], "").match(/-?\d*\.?\d+(?:px)?/g) || []).map(parseFloat) : [];
					if (cm && /inset/.test(sh) && nums[2] === 0 && ((Math.abs(nums[0]) >= 3 && nums[1] === 0) || (Math.abs(nums[1]) >= 3 && nums[0] === 0)) && coloredC(parse(cm[0]))) add("side-stripe", path(e), "안쪽 그림자 줄 " + Math.max(Math.abs(nums[0]), Math.abs(nums[1])) + "px " + cm[0].slice(0, 28));
				}
				for (const ps of ["::before", "::after"]) {
					const q = getComputedStyle(e, ps);
					if (!q.content || q.content === "none" || q.content === "normal" || q.position !== "absolute") continue;
					const pw = parseFloat(q.width), ph = parseFloat(q.height);
					if (Number.isNaN(pw) || Number.isNaN(ph) || !coloredC(parse(q.backgroundColor))) continue;
					if ((pw <= 8 && ph >= r.height * 0.6) || (ph <= 8 && pw >= r.width * 0.6)) add("side-stripe", path(e), ps + " 줄 " + Math.round(pw) + "x" + Math.round(ph) + " " + q.backgroundColor);
				}
			}
			glowOf(s.boxShadow, e, "상자");
			glowOf(s.textShadow, e, "글자");
			const f = s.filter;
			if (f && f.includes("drop-shadow")) glowOf(f.replace(/drop-shadow\(([^]*?)\)(?=\s|$)/g, "$1"), e, "필터");
		}
		for (const p of textEls) {
			const s = cs(p) as any;
			if ((s.webkitBackgroundClip === "text" || s.backgroundClip === "text") && s.backgroundImage.includes("gradient")) add("gradient-text", path(p), s.backgroundImage.slice(0, 40));
		}
	}

	// ---- 글자 크기, 줄 간격, 한 줄 길이
	{
		for (const p of textEls) {
			if (p.closest("sub,sup")) continue;
			const f = parseFloat(cs(p).fontSize);
			if (f < 11.99) add("body-size", path(p), r1(f) + "px<12");
		}
		const rg = D.createRange(), lensOf = new Map<Element, number>(), linesOf = new Map<Element, number>();
		for (const it of items) {
			if (it.p.closest("pre,code,textarea,input,sub,sup") || it.t.trim().length < 1) continue;
			rg.selectNodeContents(it.n);
			const tops = new Set(Array.from(rg.getClientRects()).filter((q) => q.width > 1).map((q) => Math.round(q.top)));
			linesOf.set(it.p, Math.max(linesOf.get(it.p) || 0, tops.size));
			const txt = it.t.replace(/\s+/g, " ").trim();
			if (txt.length < 60) continue;
			let max = txt.length;
			if (tops.size > 1) {
				const per = new Map<number, number>();
				const raw = it.t, lim = Math.min(raw.length, 4000);
				for (let i = 0; i < lim; i++) {
					if (/\s/.test(raw[i])) continue;
					rg.setStart(it.n, i);
					rg.setEnd(it.n, i + 1);
					const q = rg.getClientRects()[0];
					if (!q) continue;
					const k = Math.round(q.top);
					per.set(k, (per.get(k) || 0) + 1);
				}
				const sp = (raw.slice(0, lim).match(/\s/g) || []).length / Math.max(1, tops.size);
				max = Math.round(Math.max(...per.values()) + sp);
			}
			lensOf.set(it.p, Math.max(lensOf.get(it.p) || 0, max));
			const letters = txt.replace(/[\s\p{P}\p{S}\d]/gu, ""), ko = (letters.match(/[\uAC00-\uD7A3]/g) || []).length / Math.max(1, letters.length) >= 0.3;
			if (max > (ko ? 45 : 80)) add("line-length", path(it.p), "한 줄 " + max + "자>" + (ko ? 40 : 75) + (ko ? " (한글)" : ""));
		}
		for (const p of textEls) {
			if ((linesOf.get(p) || 0) < 2 || p.closest("pre,code,sub,sup")) continue;
			const s = cs(p), f = parseFloat(s.fontSize), l = s.lineHeight === "normal" ? 1.2 * f : parseFloat(s.lineHeight);
			if (f < 24 && l / f < 1.395) add("line-height", path(p), r1(l / f) + (s.lineHeight === "normal" ? " (normal)" : "") + "<1.4");
		}
	}

	// ---- 폰 폭 가로 넘침
	if (cfg.narrow) {
		if (root.scrollWidth > root.clientWidth + 1) add("overflow-x", "(문서)", "가로 스크롤 " + root.scrollWidth + ">" + root.clientWidth);
		for (const e of els) {
			const r = e.getBoundingClientRect();
			if (r.width <= 0 || r.right <= vw + 1 || r.left >= vw - 1) continue;
			let clipped = false;
			for (let a = e.parentElement; a && a !== root; a = a.parentElement) {
				const s = cs(a);
				if (s.overflowX !== "visible" && a.getBoundingClientRect().right <= vw + 1) { clipped = true; break; }
			}
			if (!clipped) add("overflow-x", path(e), "오른쪽 " + r1(r.right) + ">" + vw);
		}
	}
}

// ---------------------------------------------------------------- 실행부
const die = (code: number, msg: string): never => { console.error(msg); process.exit(code); };
const withTimeout = <T,>(p: Promise<T>, ms: number, what: string) => {
	let t: any;
	return Promise.race([p, new Promise<never>((_, rej) => { t = setTimeout(() => rej(new Error(what + " 시간 초과 " + ms / 1000 + "초")), ms); })]).finally(() => clearTimeout(t));
};
const COMBOS: { w: number; h: number; scheme: "light" | "dark" }[] = [
	{ w: 390, h: 844, scheme: "light" }, { w: 390, h: 844, scheme: "dark" },
	{ w: 1280, h: 800, scheme: "light" }, { w: 1280, h: 800, scheme: "dark" },
];

export function scoreOf(n: Record<string, number>) {
	let pen = 0;
	for (const [r, k] of Object.entries(n)) if (k > 0) pen += (RULES[r]?.w ?? 1) * Math.min(12, 4 + 2 * (k - 1));
	return Math.max(0, Math.round(100 - pen));
}

async function main() {
	let args;
	try { args = parseArgs({ allowPositionals: true, options: { json: { type: "boolean" }, shots: { type: "string" } } }); } catch (e) { return die(2, String(e)); }
	const target = args.positionals[0];
	if (!target) return die(2, "쓰는 법: bun check.ts <주소|파일.html> [--json] [--shots <폴더>]");
	const json = !!args.values.json, shots = args.values.shots ? resolve(args.values.shots) : "";
	const blocked = (why: string): never => {
		if (json) console.log(JSON.stringify({ target, blocked: true, why, exit: 3 }));
		else console.log("막힘: " + why);
		process.exit(3);
	};
	if (typeof (Bun as any).WebView === "undefined") blocked("이 기기의 Bun에는 WebView가 없어요 (Bun 1.3 이상, macOS 또는 Chrome이 있는 기기에서 돼요)");
	let url = target, server: any = null;
	if (!/^https?:\/\//i.test(target)) {
		const file = resolve(target.replace(/^file:\/\//, ""));
		if (!existsSync(file) || !statSync(file).isFile()) blocked("파일이 없어요: " + file);
		const dir = dirname(file);
		server = Bun.serve({
			hostname: "127.0.0.1", port: 0,
			fetch(req) {
				const f = resolve(join(dir, decodeURIComponent(new URL(req.url).pathname)));
				if (f !== dir && !f.startsWith(dir + "/")) return new Response("금지", { status: 403 });
				const bf = Bun.file(f);
				return bf.size ? new Response(bf) : new Response("없어요", { status: 404 });
			},
		});
		url = `http://127.0.0.1:${server.port}/${file.slice(dir.length + 1).split("/").map(encodeURIComponent).join("/")}`;
	}
	if (shots) mkdirSync(shots, { recursive: true });
	const merged = new Map<string, { rule: string; sel: string; val: string; at: Set<string> }>();
	let swappedMax = 0, unreadMax = 0;
	const ran: string[] = [];
	try {
		for (const w of [390, 1280]) {
			const h = w === 390 ? 844 : 800;
			let view: any;
			try {
				view = new (Bun as any).WebView({ width: w, height: h });
				await withTimeout(view.navigate(url), 20000, "페이지 열기");
				const empty = await withTimeout(view.evaluate("document.body ? document.body.children.length === 0 && !document.body.innerText.trim() : true"), 10000, "페이지 읽기");
				if (empty === true || empty === "true") throw new Error("페이지가 비어 있어요");
				await withTimeout(view.evaluate("document.fonts.ready.then(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(1)))))"), 10000, "글꼴 기다리기");
				for (const c of COMBOS.filter((x) => x.w === w)) {
					const cfg = { scheme: c.scheme, touch: w === 390 && c.scheme === "light", narrow: w === 390 };
					const raw = await withTimeout(view.evaluate(`(() => { const K = (${kit})(${JSON.stringify(cfg)}); (${measureA})(K); (${measureB})(K); (${prepCss})(K); (${measureMobile})(K); (${measureMotion})(K); (${measureRaw})(K); return JSON.stringify({ swapped: K.swapped, unread: K.unread, hits: K.hits }); })()`), 60000, "측정");
					const out = JSON.parse(String(raw)) as PageOut;
					swappedMax = Math.max(swappedMax, out.swapped);
					unreadMax = Math.max(unreadMax, out.unread);
					const tag = `${w} ${c.scheme === "light" ? "라이트" : "다크"}`;
					ran.push(tag);
					for (const x of out.hits) {
						const k = x.rule + "|" + x.sel + "|" + x.val;
						(merged.get(k) || merged.set(k, { ...x, at: new Set() }).get(k)!).at.add(tag);
					}
					if (shots) { const png = join(shots, `${w}-${c.scheme}.png`); await Bun.write(png + ".tmp", await view.screenshot()); renameSync(png + ".tmp", png); }
				}
			} catch (e) {
				blocked("페이지를 열거나 재지 못했어요: " + (e instanceof Error ? e.message : String(e)));
			} finally {
				try { view?.close(); } catch { /* 이미 닫힘 */ }
			}
		}
	} finally {
		server?.stop(true);
	}
	const hits = Array.from(merged.values());
	const counts: Record<string, number> = {};
	for (const x of hits) counts[x.rule] = (counts[x.rule] || 0) + 1;
	const score = scoreOf(counts), code = hits.length ? 1 : 0;
	const notes: string[] = [];
	if (swappedMax) notes.push(`다크: WebView에 색 구성표 전환이 없어 prefers-color-scheme 미디어 규칙 ${swappedMax}개를 바꿔 끼워 재요`);
	else notes.push("다크: WebView에 색 구성표 전환이 없고 페이지에 prefers-color-scheme 규칙도 없어서 라이트와 같은 모습으로 재요 (클래스나 data 속성으로 바꾸는 다크는 못 봐요)");
	if (unreadMax) notes.push(`읽지 못한 스타일시트 ${unreadMax}개는 다크 규칙을 바꾸지 못했어요`);
	notes.push("누르는 곳 크기는 390px 라이트에서만 재요");
	const at = (s: Set<string>) => (s.size === ran.length ? "전체" : Array.from(s).join(","));
	if (json) {
		console.log(JSON.stringify({ target, score, exit: code, notes, ran, counts, violations: hits.map((x) => ({ rule: x.rule, label: RULES[x.rule]?.label, at: Array.from(x.at), selector: x.sel, value: x.val })) }));
	} else {
		console.log(`점검: ${target}`);
		for (const n of notes) console.log("참고: " + n);
		for (const x of hits) console.log(`[${x.rule}] ${at(x.at)} | ${x.sel} | ${x.val}`);
		console.log(`점수 ${score}/100 (위반 ${hits.length}건, 규칙 ${Object.keys(counts).length}개)${shots ? ` 스크린샷: ${shots}` : ""}`);
	}
	process.exit(code);
}
if (import.meta.main) await main();
