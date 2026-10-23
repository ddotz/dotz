// Reads and closes the open KakaoTalk chat window by Accessibility (System Events), run as `osascript -l JavaScript` with ONE JSON line on stdin:
//   {action:"probe", deep?, name?} | {action:"close", name?} | {action:"rows", name, max, budgetMs, first} | {action:"open", name, row} | {action:"send", name, text}
// probe prints {ok:true, windows:[{title, members?, self?}]} for every window that is not the main window; room.ts accepts the room only when
// exactly one chat window is open. `members` is read only from a static text that names itself a count (identifier or description with
// count/member/참여/명); `self` is true only when the window shows the words 나와의 채팅. A missing field means "not shown", never "no".
// openlist opens the chat list window when it is closed (see openList): needed when KakaoTalk has no window at all.
// close presses the close button of every non-main window. Nothing is typed and no key is sent.
// rows reads the static texts of the chat list rows, in order, until `max` rows, `budgetMs` or (first) the first row titled `name`: one
// Accessibility read per row (~0.07 s, measured 2026-10-23; the whole 290-row list takes 20 s), nothing is clicked or opened. Prints
// {ok:true, rows:[[title, count?, time, unread?]], stopped:"found"|"budget"|"end", ms:{table, read}}, or {ok:true, opened:true} when a
// window of the name is open already, or {ok:false, step:"list", why:"no_list"}.
// open opens list row number `row` by Accessibility actions only: its title is read again (a list that moved is refused), then the row
// cell's AXShowMenu once, then AXPress on its "채팅방 열기" item (list rows have no AXPress/AXOpen; kmsg selects the row and posts an Enter
// key, which needs KakaoTalk in front). KakaoTalk is not activated and the owner's front app and focus stay (measured 2026-10-23). At most
// one context menu per call. Prints {ok:true, ms} or {ok:false, step:"list"|"recheck"|"menu"|"press"|"window", why, err?, ms}.
// send puts `text` into the input of the one window titled `name` (AXValue) and presses its 전송 button (AXPress): no key event, no
// activation. Setting AXValue enables the button (measured 2026-10-23). A non-empty input is the owner's own unsent text and is left
// alone ("busy"). Prints {ok:true} once the input is empty again, or {ok:false, why, pressed?}: pressed means the button was pressed
// but the input did not empty, so the message may have gone out and must not be sent again.
// close {name?} closes only the window of that name when given.
ObjC.import("Foundation");

var BUNDLE = "com.kakao.KakaoTalkMac";
var MAX_NODES = 300;
var MAX_DEPTH = 7;

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

function readRows(name, max, budgetMs, first) {
	var t0 = Date.now();
	if (windowNamed(name)) return { ok: true, opened: true };
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

function openRowAt(index, name) {
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
		if (norm(cell.staticTexts.name()[0]) !== norm(name)) return fail("recheck", "moved");
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

function sendInto(name, text) {
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
	if (attr(input, "value") !== "") return { ok: false, why: "busy" };
	input.value = text;
	var ready = until(function () {
		return attr(input, "value") === text && attr(btn, "enabled") === "true";
	}, 1.5);
	if (!ready) {
		try {
			input.value = "";
		} catch (e) {}
		return { ok: false, why: "not_set" };
	}
	btn.actions.byName("AXPress").perform();
	var gone = until(function () {
		return attr(input, "value") === "";
	}, 3);
	return gone ? { ok: true } : { ok: false, why: "unclear", pressed: true };
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
		if (req.action === "send" && typeof req.name === "string" && req.name && typeof req.text === "string" && req.text) return JSON.stringify(sendInto(req.name, req.text));
		if (req.action === "rows" && typeof req.name === "string" && req.name) return JSON.stringify(readRows(req.name, Math.min(Math.max(1, req.max | 0), 300), Math.min(Math.max(500, req.budgetMs | 0), 4000), req.first === true));
		if (req.action === "open" && typeof req.name === "string" && req.name && Number.isInteger(req.row) && req.row >= 0) return JSON.stringify(openRowAt(req.row, req.name));
		return JSON.stringify({ ok: false });
	} catch (e) {
		return JSON.stringify({ ok: false, why: "error", error: String(e).slice(0, 120) });
	}
}
