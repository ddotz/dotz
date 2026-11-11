// 폰 웹, 움직임, 화면에 샌 값 측정. check.ts의 kit이 만든 K를 받아 페이지 안에서 돌아요.
// 이 함수들은 String()으로 한 식에 들어가 페이지에서 실행되니, 바깥 값을 쓰지 않고 서로를 부르지도 않아요. 값은 K로만 주고받아요.

// 스타일시트를 한 번만 훑어 K.rl(스타일 규칙과 인라인 스타일), K.kf(키프레임), K.reduced, K.motion을 채워요.
// gate: 규칙이 @media (hover: hover) 안에 있는지. live: 지금 폭에서 적용되는 미디어 안에 있는지.
function prepCss(K: any): void {
	const { W, D, path } = K;
	const rl: any[] = [], kf = new Map<string, any>();
	let reduced = false;
	const walk = (rules: CSSRuleList, gate: boolean, live: boolean) => {
		for (const r of Array.from(rules) as any[]) {
			if (r instanceof CSSMediaRule) {
				const o: string = (W.__chkO && W.__chkO.get(r)) || r.media.mediaText;
				if (/prefers-reduced-motion/i.test(o)) reduced = true;
				walk(r.cssRules, gate || /\bhover\s*:\s*hover\b/i.test(o), live && W.matchMedia(r.media.mediaText).matches);
			} else if (r instanceof CSSKeyframesRule) kf.set(r.name, r);
			else if (r.style && r.selectorText !== undefined) {
				rl.push({ r, gate, live });
				if (r.cssRules && r.cssRules.length) walk(r.cssRules, gate, live);
			} else if (r.cssRules) walk(r.cssRules, gate, live);
		}
	};
	for (const s of Array.from(D.styleSheets) as any[]) {
		if (s.ownerNode && s.ownerNode.id === "chk-freeze") continue;
		try { walk(s.cssRules, false, true); } catch (e) { K.cssUnread = (K.cssUnread || 0) + 1; }
	}
	for (const e of Array.from(D.querySelectorAll("[style]")) as HTMLElement[]) {
		if (e === D.documentElement && !e.style.transition) continue;
		rl.push({ r: { selectorText: path(e) + "[style]", style: e.style, cssText: e.style.cssText }, gate: false, live: true, el: e });
	}
	const split = (v: string) => {
		const o: string[] = [];
		let d = 0, c = "";
		for (const ch of v) {
			if (ch === "(") d++;
			if (ch === ")") d--;
			if (ch === "," && d === 0) { o.push(c.trim()); c = ""; } else c += ch;
		}
		if (c.trim()) o.push(c.trim());
		return o;
	};
	const ms = (t: string) => { const m = /^(-?[\d.]+)(ms|s)$/.exec(t.trim()); return m ? parseFloat(m[1]) * (m[2] === "s" ? 1000 : 1) : 0; };
	const rs = getComputedStyle(D.documentElement);
	const subst = (v: string) => {
		for (let n = 0; n < 4 && /var\(/.test(v); n++) v = v.replace(/var\(\s*(--[\w-]+)\s*(?:,([^()]*))?\)/g, (_m: string, name: string, fb: string) => rs.getPropertyValue(name).trim() || (fb || "").trim());
		return v;
	};
	const EASE = /^(ease|ease-in|ease-out|ease-in-out|linear|step-start|step-end|cubic-bezier\(.*\)|steps\(.*\)|linear\(.*\))$/, TIME = /^-?[\d.]+m?s$/;
	const toks = (s: string) => s.split(/\s+(?![^(]*\))/).filter(Boolean);
	const parseTransition = (v: string) => {
		const o = { props: [] as string[], durs: [] as number[], eases: [] as string[] };
		for (const item of split(subst(v))) {
			let dur = -1;
			for (const t of toks(item)) {
				if (TIME.test(t)) { if (dur < 0) dur = ms(t); } else if (EASE.test(t)) o.eases.push(t);
				else if (/^[a-z][a-z-]*$/.test(t) && t !== "allow-discrete" && t !== "normal") o.props.push(t);
			}
			o.durs.push(Math.max(dur, 0));
		}
		return o;
	};
	const parseAnimation = (v: string) => {
		const o = { anims: [] as string[], adur: [] as number[], iters: [] as string[], eases: [] as string[] };
		for (const item of split(subst(v))) {
			let dur = -1, iter = "1";
			for (const t of toks(item)) {
				if (TIME.test(t)) { if (dur < 0) dur = ms(t); } else if (EASE.test(t)) o.eases.push(t);
				else if (t === "infinite" || /^[\d.]+$/.test(t)) iter = t;
				else if (/^[a-z_][\w-]*$/i.test(t) && !/^(normal|reverse|alternate|alternate-reverse|none|forwards|backwards|both|running|paused)$/.test(t)) o.anims.push(t);
			}
			o.adur.push(Math.max(dur, 0));
			o.iters.push(iter);
		}
		return o;
	};
	K.rl = rl;
	K.kf = kf;
	K.reduced = reduced;
	K.motion = (st: CSSStyleDeclaration) => {
		const t = st.getPropertyValue("transition-property") ? { props: split(st.getPropertyValue("transition-property")), durs: split(st.getPropertyValue("transition-duration")).map(ms), eases: split(st.getPropertyValue("transition-timing-function")) } : parseTransition(st.getPropertyValue("transition"));
		const a = st.getPropertyValue("animation-name") ? { anims: split(st.getPropertyValue("animation-name")), adur: split(st.getPropertyValue("animation-duration")).map(ms), iters: split(st.getPropertyValue("animation-iteration-count")), eases: split(st.getPropertyValue("animation-timing-function")) } : parseAnimation(st.getPropertyValue("animation"));
		return { props: t.props, durs: t.durs, anims: a.anims, adur: a.adur, iters: a.iters, eases: [...t.eases, ...a.eases] };
	};
}

// 모바일 웹 기본: 확대 잠금, 안전 영역, 상태 막대 색, 100vh, 터치에서 남는 hover, 작은 입력 글자.
function measureMobile(K: any): void {
	const { W, D, root, add, cs, rl, els, path, cfg, vh } = K;
	const vp = D.querySelector('meta[name="viewport"]');
	const vc = ((vp && vp.getAttribute("content")) || "").toLowerCase();
	const val = (k: string) => { const m = new RegExp("(?:^|[,;\\s])" + k + "\\s*=\\s*([^,;\\s]+)").exec(vc); return m ? m[1] : ""; };
	const mx = parseFloat(val("maximum-scale")), us = val("user-scalable");
	if (us === "no" || us === "0" || (!Number.isNaN(mx) && mx <= 1)) add("zoom-lock", "meta[viewport]", vc.slice(0, 60));

	const safe = rl.find((x: any) => String(x.r.cssText || "").includes("env(safe-area-inset"));
	if (safe && val("viewport-fit") !== "cover") add("safe-area", String(safe.r.selectorText).slice(0, 50), "env(safe-area-inset-*)를 쓰는데 viewport-fit=cover가 없어요");

	const tc = Array.from(D.querySelectorAll('meta[name="theme-color"]')) as Element[];
	const media: string[] = Array.from(W.__chkO ? W.__chkO.values() : []);
	const cm = D.querySelector('meta[name="color-scheme"]');
	const hasDark = media.some((t) => /prefers-color-scheme\s*:\s*dark/i.test(t)) || /\bdark\b/.test((cm && cm.getAttribute("content")) || "") || rl.some((x: any) => String(x.r.cssText || "").includes("light-dark("));
	const paired = tc.length >= 2 && tc.some((m) => /prefers-color-scheme\s*:\s*dark/i.test(m.getAttribute("media") || ""));
	if (tc.length && hasDark && !paired) add("theme-color", "meta[theme-color]", tc.length + "개, 라이트·다크 쌍(media=prefers-color-scheme) 없음");

	const VH = /(^|[^\d.])100vh\b/, cand = new Set<Element>([root, D.body]);
	for (const e of Array.from(D.querySelectorAll("body > *, #app, #root, #__next, main, [role=application]")) as Element[]) cand.add(e);
	for (const e of els as Element[]) {
		const s = cs(e);
		if (s.position !== "fixed" && s.position !== "sticky") continue;
		const r = e.getBoundingClientRect();
		if (r.bottom >= vh - 2 && r.top > vh * 0.4) cand.add(e);
	}
	const seenVh = new Set<string>();
	for (const x of rl) {
		const prop = ["height", "min-height", "max-height"].find((p) => VH.test(x.r.style.getPropertyValue(p)));
		if (!prop || !x.live) continue;
		const hit = x.el ? [x.el] : Array.from(cand).filter((c) => { try { return c.matches(x.r.selectorText); } catch (e) { return false; } });
		for (const c of hit as Element[]) if (cand.has(c) && !seenVh.has(path(c))) { seenVh.add(path(c)); add("vh-shell", path(c), prop + ": " + x.r.style.getPropertyValue(prop).slice(0, 30)); }
	}

	let n = 0, ex = "";
	for (const x of rl) {
		const sel = String(x.r.selectorText || "");
		if (x.gate || !/:hover/.test(sel)) continue;
		let changes = false;
		for (let i = 0; i < x.r.style.length; i++) { const p = x.r.style[i]; if (/^(color$|background|border-|box-shadow|text-shadow|outline-color|fill$|stroke$)/.test(p) && !/radius/.test(p)) { changes = true; break; } }
		if (changes) { n++; if (!ex) ex = sel.slice(0, 60); }
	}
	if (n) add("hover-ungated", ex, n + "개 규칙이 @media (hover: hover) 밖에 있어요");

	if (cfg.narrow) for (const e of els as Element[]) {
		if (!e.matches("input,textarea,select") || e.matches("input[type=hidden],input[type=checkbox],input[type=radio],input[type=range],input[type=color],input[type=file],input[type=button],input[type=submit],input[type=reset],input[type=image]")) continue;
		const f = parseFloat(cs(e).fontSize);
		if (f < 15.995) add("input-font", path(e), f + "px<16");
	}
}

// 움직임 기본: transition: all, ease-in, 300ms 넘는 길이, scale(0) 시작, 배치 속성 움직임, reduced-motion 없음.
function measureMotion(K: any): void {
	const { add, rl, kf, motion, reduced } = K;
	const LAYOUT = /^(width|height|top|left|right|bottom|inset(-[a-z-]+)?|margin(-[a-z-]+)?|padding(-[a-z-]+)?)$/, MOVE = /^(transform|translate|scale|rotate)$/;
	const ZERO = /scale(?:3d|x|y)?\(\s*0(?:\.0+)?\s*[,)]|^\s*0(?:\.0+)?\s*$/i;
	const used = new Set<string>();
	let moves = false;
	for (const x of rl) {
		const sel = String(x.r.selectorText || ""), m = motion(x.r.style), off = m.props.length === 1 && m.props[0] === "none";
		if (m.props.includes("all")) add("transition-all", sel, "transition: all");
		const slow = Math.max(0, ...m.durs);
		if (!off && slow > 300) add("slow-motion", sel, "transition " + slow + "ms>300");
		for (const e of m.eases) if (e === "ease-in") add("ease-in", sel, "timing-function: ease-in");
		for (const p of m.props) {
			if (LAYOUT.test(p)) add("layout-motion", sel, "transition: " + p);
			if (MOVE.test(p)) moves = true;
		}
		m.anims.forEach((name: string, i: number) => {
			if (name === "none") return;
			used.add(name);
			const d = m.adur.length ? m.adur[i % m.adur.length] : 0, it = m.iters.length ? m.iters[i % m.iters.length] : "1";
			if (d > 300 && it !== "infinite") add("slow-motion", sel, "animation " + name + " " + d + "ms>300");
		});
	}
	for (const name of used) {
		const k = kf.get(name);
		if (!k) continue;
		for (const fr of Array.from(k.cssRules) as any[]) {
			const st = fr.style;
			if (!st) continue;
			for (let i = 0; i < st.length; i++) {
				const p = st[i];
				if (LAYOUT.test(p)) add("layout-motion", "@keyframes " + name, p);
				if (MOVE.test(p)) moves = true;
			}
			if (st.getPropertyValue("animation-timing-function") === "ease-in") add("ease-in", "@keyframes " + name, fr.keyText);
			if (/^(from|0%)$/.test(fr.keyText) && (ZERO.test(st.getPropertyValue("scale")) || /scale(?:3d|x|y)?\(\s*0(?:\.0+)?\s*[,)]/i.test(st.getPropertyValue("transform")))) add("scale-zero", "@keyframes " + name, fr.keyText + " scale(0)");
		}
	}
	if (moves && !reduced) add("no-reduced-motion", "(페이지)", "움직임이 있는데 prefers-reduced-motion 규칙이 없어요");
}

// 화면에 샌 값: NaN, undefined, null, [object Object], Infinity가 글자로 그대로 보이는 곳.
function measureRaw(K: any): void {
	const { add, items, path } = K;
	const RAW = /(?<![\w$.-])(?:-?Infinity|NaN|undefined|null|\[object Object\])(?![\w$-])/;
	for (const it of items as { p: Element; t: string }[]) {
		if (it.p.closest("code,pre,kbd,samp,textarea")) continue;
		const m = RAW.exec(it.t);
		if (m) add("raw-value", path(it.p), "'" + m[0] + "' <- " + it.t.trim().slice(0, 24));
	}
}

export { prepCss, measureMobile, measureMotion, measureRaw };
