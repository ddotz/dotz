// Owner (2026-11-05): "각 접속하는 기기의 해상도에 맞춰서 전체화면으로 되어야해. 지금은 확대도 안되더라 모바일에서는"
// Runs inside voxl's own page (the gateway adds this one script, see deskPage in hub/remote-desktop.ts; design in DESIGN.md Viewer).
// voxl sizes #surface to fit the window and reads its input through getBoundingClientRect, so a transform on #surface is the local view
// and the remote pointer stays right at any zoom. One finger stays voxl's; two fingers never reach it. No timer, no frame loop.
(() => {
	// The one-time ticket of the direct open is spent: it leaves the address bar before voxl copies the query into its socket address.
	if (new URLSearchParams(location.search).has("go")) {
		const u = new URL(location.href);
		u.searchParams.delete("go");
		history.replaceState(null, "", u);
	}
	const SAFE = side => `env(safe-area-inset-${side},0px)`;
	const css = `
		html,body{height:100vh;height:100dvh;touch-action:none}
		#surface{position:fixed;left:0;top:0;transform-origin:0 0}
		#dsk-room{position:fixed;visibility:hidden;pointer-events:none;left:${SAFE("left")};right:${SAFE("right")};top:${SAFE("top")};
			height:calc(100vh - ${SAFE("top")} - ${SAFE("bottom")});height:calc(100dvh - ${SAFE("top")} - ${SAFE("bottom")})}
		#tools.touch{bottom:calc(12px + ${SAFE("bottom")});right:calc(8px + ${SAFE("right")})}`;
	document.head.append(Object.assign(document.createElement("style"), { textContent: css }));

	const MAX_ZOOM = 4; // past the filled view
	const touchFirst = matchMedia("(pointer: coarse)").matches;
	const between = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
	const onTools = e => !!e.target.closest?.("#tools,#files");

	function start() {
		const surface = document.getElementById("surface");
		const room = document.body.appendChild(Object.assign(document.createElement("div"), { id: "dsk-room" }));
		const view = { k: 1, x: 0, y: 0, w: 0, h: 0, fit: 1, fill: 1, seen: "", tall: false, zoomed: false };
		const box = () => room.getBoundingClientRect();

		// voxl snaps #surface to a whole multiple of its video stripes so no hairline shows between them, and with stripes cut on 16-pixel
		// rows that multiple can be 135 device pixels: the black sides of a phone. The view takes the exact size and each stripe reaches one
		// screen pixel under the next instead.
		function draw() {
			const r = box(), dpr = devicePixelRatio || 1, k = view.k;
			const axis = (at, len, lo, hi) => Math.round((len <= hi - lo ? lo + (hi - lo - len) / 2 : between(at, hi - len, lo)) * dpr) / dpr;
			view.x = axis(view.x, view.w * k, r.left, r.right);
			view.y = axis(view.y, view.h * k, r.top, r.bottom);
			surface.style.transform = `translate(${view.x}px,${view.y}px) scale(${k})`;
			for (const v of surface.querySelectorAll("video.stripe")) {
				v.dataset.h ??= v.style.height;
				v.style.height = `calc(${v.dataset.h} + ${1 / k}px)`;
			}
		}
		// A touch screen starts filled, nothing black: the stream keeps its shape, so a portrait phone shows part of a landscape Mac and a
		// pinch out shows all of it. A mouse has no way to pan, so it starts with the whole screen.
		function place() {
			const r = box();
			view.w = parseFloat(surface.style.width) || surface.offsetWidth;
			view.h = parseFloat(surface.style.height) || surface.offsetHeight;
			if (!view.w || !view.h || !r.width || !r.height) return;
			const seen = `${r.width},${r.height},${view.w},${view.h}`;
			if (seen === view.seen) return;
			view.seen = seen;
			view.fit = Math.min(r.width / view.w, r.height / view.h);
			view.fill = Math.ceil(Math.max(r.width / view.w, r.height / view.h) * 1e4) / 1e4; // up, or a rounded scale leaves a black hairline
			const tall = r.height > r.width;
			if (tall !== view.tall) view.zoomed = false;
			view.tall = tall;
			if (!view.zoomed) {
				view.k = touchFirst ? view.fill : view.fit;
				view.x = r.left + (r.width - view.w * view.k) / 2;
				view.y = r.top + (r.height - view.h * view.k) / 2;
			}
			view.k = between(view.k, view.fit, view.fill * MAX_ZOOM);
			draw();
		}

		// Two fingers: the second one takes the gesture away from voxl, which sees the first finger cancelled and neither clicks nor drags.
		const fingers = new Map();
		let pinch = null, cancelling = false;
		function grip() {
			const [a, b] = [...fingers.values()];
			const midX = (a.x + b.x) / 2, midY = (a.y + b.y) / 2;
			pinch = { k: view.k, gap: Math.hypot(a.x - b.x, a.y - b.y) || 1, atX: (midX - view.x) / view.k, atY: (midY - view.y) / view.k };
		}
		function hand(id) {
			cancelling = true;
			surface.dispatchEvent(new PointerEvent("pointercancel", { pointerId: id, pointerType: "touch", bubbles: true }));
			cancelling = false;
		}
		const own = e => { e.stopImmediatePropagation(); e.preventDefault(); };
		addEventListener("pointerdown", e => {
			if (e.pointerType !== "touch" || onTools(e)) return;
			fingers.set(e.pointerId, { x: e.clientX, y: e.clientY });
			if (fingers.size < 2) return;
			if (!pinch) hand(fingers.keys().next().value);
			view.zoomed = true;
			grip();
			own(e);
		}, true);
		addEventListener("pointermove", e => {
			const f = fingers.get(e.pointerId);
			if (!f) return;
			f.x = e.clientX;
			f.y = e.clientY;
			if (!pinch) return;
			own(e);
			if (fingers.size < 2) return;
			const [a, b] = [...fingers.values()];
			view.k = between((pinch.k * Math.hypot(a.x - b.x, a.y - b.y)) / pinch.gap, view.fit, view.fill * MAX_ZOOM);
			view.x = (a.x + b.x) / 2 - pinch.atX * view.k;
			view.y = (a.y + b.y) / 2 - pinch.atY * view.k;
			draw();
		}, true);
		const lift = e => {
			if (cancelling || !fingers.delete(e.pointerId) || !pinch) return;
			own(e);
			if (fingers.size >= 2) grip();
			else if (!fingers.size) pinch = null;
		};
		addEventListener("pointerup", lift, true);
		addEventListener("pointercancel", lift, true);
		addEventListener("gesturestart", e => e.preventDefault()); // Safari's own pinch event, outside pointer events

		// Fullscreen needs a user gesture and a page opened in a new tab has none yet, so the first touch or click asks, once: leaving it stays
		// left. iPhone Safari has no requestFullscreen and another browser may refuse: the page already fills what it is given.
		const askFullscreen = e => {
			if (onTools(e)) return;
			removeEventListener("pointerup", askFullscreen, true);
			if (!document.fullscreenElement) document.documentElement.requestFullscreen?.({ navigationUI: "hide" })?.catch?.(() => {});
		};
		addEventListener("pointerup", askFullscreen, true);

		new ResizeObserver(place).observe(surface);
		new ResizeObserver(place).observe(room);
		surface.addEventListener("resize", draw, true); // a stripe's first frame: voxl has just built it
	}
	addEventListener("DOMContentLoaded", start);
})();
