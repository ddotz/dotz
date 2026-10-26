// Reads and closes the open KakaoTalk chat window by Accessibility (System Events), run as `osascript -l JavaScript` with ONE JSON line on stdin:
//   {action:"probe", deep?, name?} | {action:"close", name?} | {action:"rows", name, max, budgetMs, first} | {action:"open", name, row} | {action:"send", name, text, ours?, priorPressed?}
// probe prints {ok:true, windows:[{title, members?, self?}]} for every window that is not the main window; room.ts accepts the room only when
// exactly one chat window is open. `members` is read only from a static text that names itself a count (identifier or description with
// count/member/참여/명); `self` is true only when the window shows the words 나와의 채팅. A missing field means "not shown", never "no".
// openlist opens the chat list window when it is closed (see openList): needed when KakaoTalk has no window at all.
// close presses the close button of every non-main window. Nothing is typed and no key is sent.
// rows finds the rows titled `name` among ALL rows of the chat list (measured 290/290, no scrolling needed) with the AX API in this process
// (one call per attribute; ~20 ms a row, against ~100 ms through System Events). The row the database order predicts (`hint`) is read first,
// then its neighbours, then outward; the read stops at the first name hit, at the budget, or at the end. A paged list is scrolled page by
// page (AXScrollDownByPage) until the name is found or the list stops moving. Nothing is clicked or opened. Prints
// {ok:true, rows:<count>, scanned, hits:[{index, texts}], stopped:"found"|"budget"|"end", pages, ms:{scan}}, or {ok:true, opened:true}
// when a window of the name is open already, or {ok:false, step:"list", why:"no_list"}.
// open opens list row number `row` by Accessibility actions only: its title is read again (a list that moved is refused), then the row
// cell's AXShowMenu once, then AXPress on its "채팅방 열기" item (list rows have no AXPress/AXOpen; kmsg selects the row and posts an Enter
// key, which needs KakaoTalk in front). KakaoTalk is not activated and the owner's front app and focus stay (measured 2026-10-23). At most
// one context menu per call. Prints {ok:true, ms} or {ok:false, step:"list"|"recheck"|"menu"|"press"|"window", why, err?, ms}.
// send puts `text` into the input of the one window titled `name` (AXValue) and presses its 전송 button (AXPress): no key event, no
// activation. Setting AXValue enables the button (measured 2026-10-23). The input is compared normalized (NFC, line breaks, invisible
// marks, ends): a value equal to one dotz typed into this room (`ours`, or this text) is dotz's leftover and is cleared for real (read back,
// three tries); any other value is the owner's unsent text and is left alone ("owner_text" with its first characters). A value equal to a
// text whose 전송 was already pressed without confirmation (`priorPressed`) is never typed over or pressed again: when it is this very text
// the answer is pressed ("prior_pressed"), when it is another text the answer is "prior_left" with nothing pressed. A press that throws
// counts as pressed ("press_error"). Prints {ok:true} once the input is empty again, or {ok:false, why, pressed?, preview?, left?}: pressed
// means the button was (or may have been) pressed but the send is not confirmed, so it must not be sent again; left is what the input
// still holds after a failed attempt.
// close {name?} closes only the window of that name when given.
ObjC.import("Foundation");
ObjC.import("ApplicationServices");
ObjC.import("AppKit");

var BUNDLE = "com.kakao.KakaoTalkMac";
var MAX_NODES = 300;
var MAX_DEPTH = 7;
var SCAN_RADIUS = 30;

// One Accessibility call of the AX API in this process, instead of an AppleEvent to System Events (~100 ms for one attribute there).
try {
	ObjC.bindFunction("AXUIElementCreateApplication", ["id", ["int"]]);
	ObjC.bindFunction("AXUIElementCopyAttributeValue", ["int", ["id", "id", "id*"]]);
	ObjC.bindFunction("AXUIElementPerformAction", ["int", ["id", "id"]]);
} catch (e) {}

function axGet(el, name) {
	try {
		var ref = Ref();
		if ($.AXUIElementCopyAttributeValue(el, name, ref) !== 0) return null;
		var v = ref[0];
		if (v === undefined || v === null) return null;
		try {
			return ObjC.deepUnwrap(v);
		} catch (e) {
			try {
				return ObjC.unwrap(v);
			} catch (e2) {
				return String(v);
			}
		}
	} catch (e) {
		return null;
	}
}

function axStr(el, name) {
	var v = axGet(el, name);
	return v === null || v === undefined ? "" : String(v);
}

function axAction(el, action) {
	try {
		return $.AXUIElementPerformAction(el, action) === 0;
	} catch (e) {
		return false;
	}
}

// The whole list is exposed as AXRows at once (measured 290/290, no scrolling needed), so one native read sees every room.
function axList() {
	try {
		var apps = $.NSRunningApplication.runningApplicationsWithBundleIdentifier(BUNDLE).js;
		if (!apps || !apps.length) return null;
		var app = $.AXUIElementCreateApplication(apps[0].processIdentifier);
		var wins = axGet(app, "AXWindows") || [];
		var listWin = null;
		for (var i = 0; i < wins.length; i++) if (axStr(wins[i], "AXTitle") === "카카오톡") listWin = wins[i];
		if (!listWin) return null;
		var best = null;
		var bestRows = -1;
		var scrolls = [];
		var kids = axGet(listWin, "AXChildren") || [];
		for (var i = 0; i < kids.length; i++) {
			if (axStr(kids[i], "AXRole") !== "AXScrollArea") continue;
			scrolls.push(kids[i]);
			var sk = axGet(kids[i], "AXChildren") || [];
			for (var j = 0; j < sk.length; j++) {
				if (axStr(sk[j], "AXRole") !== "AXTable") continue;
				var rs = axGet(sk[j], "AXRows") || [];
				if (rs.length > bestRows) {
					bestRows = rs.length;
					best = { table: sk[j], rows: rs };
				}
			}
		}
		if (!best) return null;
		return { table: best.table, rows: best.rows, scrolls: scrolls };
	} catch (e) {
		return null;
	}
}

function axRowTexts(row) {
	var out = [];
	var cells = axGet(row, "AXChildren") || [];
	for (var i = 0; i < cells.length; i++) {
		var texts = axGet(cells[i], "AXChildren") || [];
		for (var j = 0; j < texts.length; j++) {
			var v = axStr(texts[j], "AXValue");
			if (v !== "") out.push(v);
		}
	}
	return out;
}

// Only the title while scanning (3 AX calls a row); the rest of the row is read once its title matches (count, time, preview).
function axRowTitle(row) {
	var cells = axGet(row, "AXChildren") || [];
	for (var i = 0; i < cells.length; i++) {
		var texts = axGet(cells[i], "AXChildren") || [];
		for (var j = 0; j < texts.length; j++) {
			var v = axStr(texts[j], "AXValue");
			if (v !== "") return v;
		}
	}
	return "";
}

// Title reads are the expensive part (~26 ms a row: row children, cell children, one value). The hint row (the database order in the list)
// comes first, then its neighbours (a pinned room shifts the list by a few rows), then the whole list; the read stops at the first name hit,
// at the end, or at the budget. Scrolling continues a list that exposes only its visible rows; with all rows exposed it finds the end at once.
function axScan(name, first, budgetMs, hint, need) {
	var t0 = Date.now();
	var list = axList();
	if (!list) return null;
	var want = norm(name);
	// `need`: how many rows of this name the database has; the scan stops once that many are seen (all of them are then known).
	var enough = first ? 1 : need > 0 ? need : 0;
	var hits = [];
	var seen = {};
	var scanned = 0;
	var stopped = "end";
	var pages = 0;
	var total = list.rows.length;
	var order = [];
	if (typeof hint === "number" && hint >= 0 && hint < total) {
		order.push(hint);
		for (var d = 1; d <= SCAN_RADIUS; d++) {
			if (hint + d < total) order.push(hint + d);
			if (hint - d >= 0) order.push(hint - d);
		}
		// A hint off by more than the window keeps its neighbourhood: continue outward instead of starting from the top.
		for (var i = hint + SCAN_RADIUS + 1; i < total; i++) order.push(i);
		for (var i = hint - SCAN_RADIUS - 1; i >= 0; i--) order.push(i);
	} else {
		for (var i = 0; i < total; i++) order.push(i);
	}
	for (;;) {
		for (var q = 0; q < order.length; q++) {
			if (Date.now() - t0 > budgetMs) {
				stopped = "budget";
				break;
			}
			var idx = order[q];
			if (seen[idx]) continue;
			seen[idx] = true;
			var title = axRowTitle(list.rows[idx]);
			scanned++;
			if (norm(title) === want) {
				hits.push({ index: idx, texts: axRowTexts(list.rows[idx]) });
				if (enough && hits.length >= enough) {
					stopped = "found";
					break;
				}
			}
		}
		if (stopped === "found" || stopped === "budget") break;
		// Every exposed row was read: if the list shows one page at a time, scroll and continue; otherwise this is the end.
		if (pages >= 20) break;
		var before = total && list.rows.length ? String(axStr(list.rows[0], "AXTitle")) : "";
		var scrollArea = null;
		for (var s = 0; s < list.scrolls.length && !scrollArea; s++) {
			var sk = axGet(list.scrolls[s], "AXChildren") || [];
			for (var j = 0; j < sk.length; j++) if (sk[j] === list.table) scrollArea = list.scrolls[s];
		}
		if (!scrollArea || !axAction(scrollArea, "AXScrollDownByPage")) break;
		pages++;
		var next = axList();
		if (!next) break;
		list = next;
		var after = list.rows.length ? String(axStr(list.rows[0], "AXTitle")) : "";
		if (list.rows.length === total && before === after) break;
		total = list.rows.length;
		// A paged list shows different rows at the same indices: read them again.
		seen = {};
		order = [];
		for (var i = 0; i < total; i++) order.push(i);
	}
	return { ok: true, rows: total, scanned: scanned, hits: hits, stopped: stopped, pages: pages, ms: { scan: Date.now() - t0 } };
}

function attr(el, name) {
	try {
		var v = el[name]();
		return v === null || v === undefined ? "" : String(v);
	} catch (e) {
		return "";
	}
}

// The same rule as normalizeTitle in room.ts: NFC, no zero-width marks, trimmed.
function norm(s) {
	return String(s === null || s === undefined ? "" : s).normalize("NFC").replace(/[\u200b-\u200f\u2060\ufeff]/g, "").trim();
}

// The same rule as normalizeInput in room.ts: what KakaoTalk's AX value may have changed about our text (NFD/NFC, \r vs \n, trimmed
// ends, invisible marks, collapsed spaces) does not make it a different text.
function normText(s) {
	return String(s === null || s === undefined ? "" : s)
		.normalize("NFC")
		.replace(/[\u200b-\u200f\u2060\ufeff]/g, "")
		.replace(/[\ufe00-\ufe0f\u{e0100}-\u{e01ef}]/gu, "")
		.replace(/\r\n?/g, "\n")
		.replace(/[\u2028\u2029]/g, "\n")
		.replace(/[ \t]+/g, " ")
		.replace(/ *\n */g, "\n")
		.trim();
}

function freeValue(v, ph) {
	return normText(v) === "" || (ph !== "" && normText(ph) === normText(v));
}

// What the input holds before a send, decided from its value alone (pure, unit tested through room-jxa.test.ts):
//   free: empty or only its placeholder. same_pressed: this very text, whose 전송 was pressed before without confirmation (never typed or
//   pressed again). prior_left: ANOTHER text whose 전송 was pressed before (not pressed by this call; the caller decides). ours: a text dotz
//   typed (cleared and replaced). owner: anything else, the owner's own draft (never touched).
function inputVerdict(value, ph, text, ours, priorPressed) {
	if (freeValue(value, ph)) return "free";
	var n = normText(value);
	for (var k = 0; k < priorPressed.length; k++) if (n === normText(priorPressed[k])) return n === normText(text) ? "same_pressed" : "prior_left";
	if (n === normText(text)) return "ours";
	for (var j = 0; j < ours.length; j++) if (n === normText(ours[j])) return "ours";
	return "owner";
}

// Whether a list row read at open time is still the row chosen from the scan: the same title and, where the choice rested on them, the same
// member count and the same newest-message preview. Anything else is refused (another row moved into that index).
function rowStillIs(texts, name, expect) {
	if (!texts || !texts.length || norm(texts[0]) !== norm(name)) return false;
	if (!expect) return true;
	if (typeof expect.members === "number") {
		var shown = /^\d+$/.test(String(texts[1] || "")) ? parseInt(texts[1], 10) : undefined;
		if (shown !== expect.members) return false;
	}
	if (expect.noCount === true && /^\d+$/.test(String(texts[1] || ""))) return false;
	if (typeof expect.preview === "string" && expect.preview) {
		var want = normText(expect.preview);
		var seen = false;
		for (var i = 1; i < texts.length && !seen; i++) if (normText(texts[i]) === want) seen = true;
		if (!seen) return false;
	}
	return true;
}

function chatWindows() {
	var se = Application("System Events");
	var procs = se.processes.whose({ bundleIdentifier: BUNDLE })();
	if (!procs.length) return [];
	var out = [];
	var wins = procs[0].windows();
	for (var i = 0; i < wins.length; i++) {
		var w = wins[i];
		if (attr(w, "name") === "카카오톡" || attr(w, "id") === "Main Window") continue;
		out.push(w);
	}
	return out;
}

// The window's own children are read in one batch per attribute (each AX read of KakaoTalk costs ~0.1 s; a full walk of a window
// took 17 s, measured 2026-10-23). The member count is the header button "대화상대 N명". `deep` also walks the message area for the
// 나와의 채팅 words, needed only to tell the memo chat from a room of the same name.
function batch(els, name) {
	try {
		return els[name]() || [];
	} catch (e) {
		return [];
	}
}

function facts(w, deep) {
	var info = { title: attr(w, "name") };
	var els = w.uiElements;
	var roles = batch(els, "role");
	var names = batch(els, "name");
	var values = batch(els, "value");
	for (var b = 0; b < roles.length; b++) {
		var label = String(names[b] || "");
		var m = /(\d+)\s*명/.exec(label);
		if (roles[b] === "AXButton" && m && /대화상대|참여|member/i.test(label) && info.members === undefined) info.members = parseInt(m[1], 10);
		if ((label + " " + String(values[b] || "")).indexOf("나와의 채팅") !== -1) info.self = true;
	}
	if (!deep || info.self) return info;
	var seen = 0;
	var walk = function (el, depth) {
		if (seen >= MAX_NODES || depth > MAX_DEPTH) return;
		var kids = [];
		try {
			kids = el.uiElements();
		} catch (e) {
			return;
		}
		for (var i = 0; i < kids.length && seen < MAX_NODES; i++) {
			seen++;
			var k = kids[i];
			var role = attr(k, "role");
			if (role === "AXStaticText") {
				var value = attr(k, "value").trim();
				var tag = (attr(k, "id") + " " + attr(k, "description")).toLowerCase();
				if (/^\d+$/.test(value) && /count|member|참여|명/.test(tag) && info.members === undefined) info.members = parseInt(value, 10);
				if (value.indexOf("나와의 채팅") !== -1) info.self = true;
			}
			walk(k, depth + 1);
		}
	};
	walk(w, 0);
	return info;
}

function closeAll(name) {
	var wins = chatWindows();
	if (typeof name === "string") wins = wins.filter(function (w) { return attr(w, "name") === name; });
	for (var i = 0; i < wins.length; i++) {
		try {
			wins[i].buttons.whose({ subrole: "AXCloseButton" })[0].click();
		} catch (e) {}
	}
	return { ok: true, closed: wins.length };
}

function listTable() {
	var se = Application("System Events");
	var procs = se.processes.whose({ bundleIdentifier: BUNDLE })();
	if (!procs.length) return null;
	var wins = procs[0].windows.whose({ name: "카카오톡" })();
	if (!wins.length) return null;
	var areas = wins[0].scrollAreas();
	for (var i = 0; i < areas.length; i++) {
		try {
			if (areas[i].tables().length) return { proc: procs[0], table: areas[i].tables[0] };
		} catch (e) {}
	}
	return null;
}

function windowNamed(name) {
	var ws = chatWindows();
	for (var q = 0; q < ws.length; q++) if (attr(ws[q], "name") === name) return ws[q];
	return null;
}

function until(fn, seconds) {
	var end = Date.now() + seconds * 1000;
	for (;;) {
		var v = fn();
		if (v || Date.now() > end) return v;
		delay(0.03);
	}
}

// The title is the first static text of a row cell, its member count (groups only) the second when it is all digits; both are told apart
// in room.ts. A row is one Accessibility read; the title is in the name of the static text (its value is empty for some rows).
function rowTexts(rows, i) {
	return rows[i].uiElements[0].staticTexts.name().map(function (t) { return t === null || t === undefined ? "" : String(t); });
}

// openlist brings the chat list window back when KakaoTalk runs with no window (menu bar only): AXPress on the menu item 채팅 of the
// menu 창 (no activation call, no key). KakaoTalk raises itself when that window shows (measured 2026-10-23: it became the front app), so
// the app that was in front before is put back at once, only when KakaoTalk is the front app by then. Prints {ok:true, ms:{press, window,
// restore}, focus:{from, took, restored}} or {ok:false, step:"menu"|"window", why, err?}. `from` is the bundle id of the app in front before.
function openList() {
	var se = Application("System Events");
	var procs = se.processes.whose({ bundleIdentifier: BUNDLE })();
	if (!procs.length) return { ok: false, step: "menu", why: "not_running" };
	var proc = procs[0];
	if (proc.windows.whose({ name: "카카오톡" })().length) return { ok: true, ms: {}, focus: { took: false, restored: false } };
	var from = "";
	try {
		from = String(se.processes.whose({ frontmost: true })()[0].bundleIdentifier());
	} catch (e) {}
	var t0 = Date.now();
	var ms = {};
	var item = null;
	try {
		var bar = proc.menuBars[0].menuBarItems();
		for (var i = 0; i < bar.length && !item; i++) {
			if (!/^(창|Window)$/.test(attr(bar[i], "name"))) continue;
			var items = bar[i].menus[0].menuItems();
			for (var k = 0; k < items.length && !item; k++) if (/^(채팅|Chats?)$/.test(attr(items[k], "name"))) item = items[k];
		}
	} catch (e) {
		return { ok: false, step: "menu", why: "menu_error", err: String(e).slice(0, 100) };
	}
	if (!item) return { ok: false, step: "menu", why: "no_item" };
	if (attr(item, "enabled") === "false") return { ok: false, step: "menu", why: "disabled" };
	try {
		item.actions.byName("AXPress").perform();
	} catch (e) {
		return { ok: false, step: "press", why: "press_error", err: String(e).slice(0, 100) };
	}
	ms.press = Date.now() - t0;
	t0 = Date.now();
	var shown = until(function () {
		try {
			return proc.windows.whose({ name: "카카오톡" })().length > 0;
		} catch (e) {
			return false;
		}
	}, 1.5);
	ms.window = Date.now() - t0;
	t0 = Date.now();
	var took = false;
	try {
		took = proc.frontmost() === true;
	} catch (e) {}
	var restored = false;
	if (took && from && from !== BUNDLE) {
		try {
			se.processes.whose({ bundleIdentifier: from })()[0].frontmost = true;
			restored = true;
		} catch (e) {}
	}
	ms.restore = Date.now() - t0;
	if (!shown) return { ok: false, step: "window", why: "no_window", ms: ms, focus: { from: from, took: took, restored: restored } };
	return { ok: true, ms: ms, focus: { from: from, took: took, restored: restored } };
}

function readRows(name, max, budgetMs, first, hint, need) {
	var t0 = Date.now();
	if (windowNamed(name)) return { ok: true, opened: true };
	var native = axScan(name, first, budgetMs, hint, need);
	if (native) return native;
	// No AX API in this process: the older System Events wording of the same scan (one AppleEvent per attribute, ~100 ms a read).
	var list = listTable();
	if (!list) return { ok: false, step: "list", why: "no_list", ms: { table: Date.now() - t0 } };
	var tableMs = Date.now() - t0;
	var rows = list.table.rows;
	var out = [];
	var stopped = "end";
	var want = norm(name);
	for (var i = 0; i < max; i++) {
		if (Date.now() - t0 > budgetMs) {
			stopped = "budget";
			break;
		}
		var texts;
		try {
			texts = rowTexts(rows, i);
		} catch (e) {
			break;
		}
		out.push(texts);
		if (first && norm(texts[0]) === want) {
			stopped = "found";
			break;
		}
	}
	return { ok: true, rows: out, stopped: stopped, ms: { table: tableMs, read: Date.now() - t0 - tableMs } };
}

// The texts of list row `index` read the same way the scan read them (native AX values), so a recheck compares like with like; null when
// the AX API is not available in this process (the System Events names are used then).
function nativeRowTexts(index) {
	var list = axList();
	if (!list || index >= list.rows.length) return null;
	return axRowTexts(list.rows[index]);
}

function openRowAt(index, name, expect) {
	var t0 = Date.now();
	var ms = {};
	var lap = function (key) {
		ms[key] = Date.now() - t0;
		t0 = Date.now();
	};
	var fail = function (step, why, err) {
		lap(step);
		var r = { ok: false, step: step, why: why, ms: ms };
		if (err) r.err = String(err).slice(0, 100);
		return r;
	};
	var list = listTable();
	if (!list) return fail("list", "no_list");
	lap("list");
	var cell;
	try {
		cell = list.table.rows[index].uiElements[0];
		var texts = nativeRowTexts(index);
		if (!texts) texts = cell.staticTexts.name().map(function (t) { return t === null || t === undefined ? "" : String(t); });
		if (!rowStillIs(texts, name, expect)) return fail("recheck", "moved");
	} catch (e) {
		return fail("recheck", "gone", e);
	}
	lap("recheck");
	try {
		cell.actions.byName("AXShowMenu").perform();
	} catch (e) {
		return fail("menu", "show_menu_error", e);
	}
	var menu = until(function () {
		try {
			var m = cell.menus();
			return m.length ? m[0] : null;
		} catch (e) {
			return null;
		}
	}, 0.8);
	if (!menu) return fail("menu", "no_menu");
	var items = menu.menuItems();
	var item = null;
	var labels = [];
	for (var k = 0; k < items.length && !item; k++) {
		var label = attr(items[k], "name");
		labels.push(label);
		if (/채팅방 열기|^open/i.test(label)) item = items[k];
	}
	if (!item) {
		try {
			menu.actions.byName("AXCancel").perform();
		} catch (e) {}
		return fail("menu", "no_item", labels.join("|"));
	}
	lap("menu");
	try {
		item.actions.byName("AXPress").perform();
	} catch (e) {
		return fail("press", "press_error", e);
	}
	lap("press");
	var shown = until(function () {
		return windowNamed(name);
	}, 1.2);
	if (!shown) return fail("window", "no_window");
	lap("window");
	return { ok: true, ms: ms };
}

// The input after a failed attempt holds OUR text when it is one we typed (this text or an earlier attempt's), and dotz's text must never be
// mistaken for the owner's draft. A different text is the owner's: it is left alone and reported with its first characters.
function sendInto(name, text, ours, priorPressed) {
	var w = windowNamed(name);
	if (!w) return { ok: false, why: "no_window" };
	var input = null;
	var areas = w.scrollAreas();
	for (var i = 0; i < areas.length && !input; i++) {
		try {
			var t = areas[i].textAreas();
			if (t.length) input = t[0];
		} catch (e) {}
	}
	if (!input) return { ok: false, why: "no_input" };
	var btn = null;
	try {
		btn = w.buttons.whose({ name: "전송" })[0];
		btn.role();
	} catch (e) {
		return { ok: false, why: "no_button" };
	}
	var ph = attr(input, "placeholderValue");
	var value = attr(input, "value");
	var freed = freeValue(value, ph);
	// An AX value can lag a moment behind the screen (a just-sent message still read back). Give it a short look before calling it occupied.
	if (!freed) freed = !!until(function () { return freeValue(attr(input, "value"), ph) ? "free" : null; }, 0.6);
	value = attr(input, "value");
	if (!freed) {
		var verdict = inputVerdict(value, ph, text, ours, priorPressed);
		// This very text was pressed before: it is never typed or pressed again (the caller confirms it from the database).
		if (verdict === "same_pressed") return { ok: false, why: "prior_pressed", pressed: true, left: String(value).slice(0, 200) };
		// Another text, pressed before and still in the input: nothing is pressed now and the new text is not consumed by it.
		if (verdict === "prior_left") return { ok: false, why: "prior_left", left: String(value).slice(0, 200), preview: String(value).replace(/\s+/g, " ").slice(0, 40) };
		if (verdict === "owner") return { ok: false, why: "owner_text", preview: String(value).replace(/\s+/g, " ").slice(0, 40) };
		// Ours (a leftover of an earlier attempt): clear it for real before typing, and say so when it will not clear.
		var cleared = false;
		for (var c = 0; c < 3 && !cleared; c++) {
			try {
				input.value = "";
			} catch (e) {}
			cleared = !!until(function () { return freeValue(attr(input, "value"), ph) ? "free" : null; }, 0.3);
			if (!cleared) delay(0.2);
		}
		if (!cleared) return { ok: false, why: "stuck", left: String(attr(input, "value")).slice(0, 200) };
	}
	var sameAsOurs = normText(attr(input, "value")) === normText(text);
	if (!sameAsOurs) {
		try {
			input.focused = true;
		} catch (e) {}
		input.value = text;
		var set = until(function () {
			return normText(attr(input, "value")) === normText(text) ? "set" : null;
		}, 1.5);
		// The window may have been in the background (the AX value change is what enables 전송): focus, set again, a longer bound.
		if (!set) {
			try {
				input.focused = true;
			} catch (e) {}
			input.value = text;
			set = until(function () {
				return normText(attr(input, "value")) === normText(text) ? "set" : null;
			}, 2.5);
		}
		if (!set) {
			var left = "";
			try {
				input.value = "";
				left = String(attr(input, "value")).slice(0, 200);
			} catch (e) {}
			return { ok: false, why: "not_set", ...(left ? { left: left } : {}) };
		}
	}
	// The text is in: wait for 전송 to enable, but never sit here long (a value that matches is enough to try the press).
	if (attr(btn, "enabled") !== "true") {
		try {
			input.focused = true;
		} catch (e) {}
		until(function () {
			return attr(btn, "enabled") === "true" ? "on" : null;
		}, 1.5);
	}
	// From here on the press may have reached KakaoTalk: an AppleEvent error or timeout of perform() is known to come back for a press that
	// was delivered, so a throwing press counts as pressed (confirmed from the database, never pressed again).
	try {
		btn.actions.byName("AXPress").perform();
	} catch (e) {
		var after = String(attr(input, "value")).slice(0, 200);
		return { ok: false, why: "press_error", pressed: true, ...(after ? { left: after } : {}) };
	}
	var gone = !!until(function () {
		return freeValue(attr(input, "value"), ph) ? "gone" : null;
	}, 3.5);
	if (gone) return { ok: true };
	var held = String(attr(input, "value")).slice(0, 200);
	return { ok: false, why: "unclear", pressed: true, ...(held ? { left: held } : {}) };
}

function readInput() {
	var data = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
	var text = $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding).js;
	try {
		return JSON.parse(text.split("\n")[0]);
	} catch (e) {
		return {};
	}
}

function run() {
	var req = readInput();
	try {
		if (req.action === "probe") {
			var wins = chatWindows();
			if (typeof req.name === "string") wins = wins.filter(function (w) { return attr(w, "name") === req.name; });
			return JSON.stringify({ ok: true, windows: wins.map(function (w) { return facts(w, req.deep === true); }) });
		}
		if (req.action === "close") return JSON.stringify(closeAll(req.name));
		if (req.action === "openlist") return JSON.stringify(openList());
		if (req.action === "send" && typeof req.name === "string" && req.name && typeof req.text === "string" && req.text)
			return JSON.stringify(sendInto(req.name, req.text, Array.isArray(req.ours) ? req.ours.filter(function (s) { return typeof s === "string"; }) : [], Array.isArray(req.priorPressed) ? req.priorPressed.filter(function (s) { return typeof s === "string"; }) : []));
		if (req.action === "rows" && typeof req.name === "string" && req.name)
			return JSON.stringify(readRows(req.name, Math.min(Math.max(1, req.max | 0), 300), Math.min(Math.max(500, req.budgetMs | 0), 6500), req.first === true, Number.isInteger(req.hint) ? req.hint : undefined, Number.isInteger(req.need) ? req.need : 0));
		if (req.action === "open" && typeof req.name === "string" && req.name && Number.isInteger(req.row) && req.row >= 0) return JSON.stringify(openRowAt(req.row, req.name, req.expect && typeof req.expect === "object" ? req.expect : undefined));
		return JSON.stringify({ ok: false });
	} catch (e) {
		return JSON.stringify({ ok: false, why: "error", error: String(e).slice(0, 120) });
	}
}
