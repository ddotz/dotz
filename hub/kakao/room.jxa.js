// Reads and closes the open KakaoTalk chat window by Accessibility (System Events), run as `osascript -l JavaScript` with ONE JSON line on stdin:
//   {action:"probe", deep?, name?} | {action:"close", name?} | {action:"open", name, rows} | {action:"send", name, text}
// probe prints {ok:true, windows:[{title, members?, self?}]} for every window that is not the main window; room.ts accepts the room only when
// exactly one chat window is open. `members` is read only from a static text that names itself a count (identifier or description with
// count/member/참여/명); `self` is true only when the window shows the words 나와의 채팅. A missing field means "not shown", never "no".
// close presses the close button of every non-main window. Nothing is typed and no key is sent.
// open finds the chat list row titled exactly `name` among the first `rows` rows and opens it by Accessibility actions only: the row
// cell's AXShowMenu, then AXPress on its "채팅방 열기" item (list rows have no AXPress/AXOpen; kmsg selects the row and posts an Enter
// key, which needs KakaoTalk in front). KakaoTalk is not activated and the owner's front app and focus stay (measured 2026-10-23).
// A window of the name already open is used as it is (row -1). Prints {ok:true, row} or {ok:false, why:"no_list"|"none"|"no_menu"|"no_window"}.
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

function openRow(name, max) {
	if (windowNamed(name)) return { ok: true, row: -1 };
	var list = listTable();
	if (!list) return { ok: false, why: "no_list" };
	var rows = list.table.rows;
	var hit = -1;
	// Rows are read by index and the first row of the title is taken: only a name no other database room has comes here, and the window
	// it opens is checked against the room after. Counting `rows` would fetch every row of the list (7 s for 290); a row read is ~0.1 s.
	for (var i = 0; i < max && hit < 0; i++) {
		var title;
		try {
			title = rows[i].uiElements[0].staticTexts[0].value();
		} catch (e) {
			break;
		}
		if (title === name) hit = i;
	}
	if (hit < 0) return { ok: false, why: "none" };
	var cell = rows[hit].uiElements[0];
	cell.actions.byName("AXShowMenu").perform();
	var menu = until(function () {
		try {
			var m = cell.menus();
			return m.length ? m[0] : null;
		} catch (e) {
			return null;
		}
	}, 1);
	if (!menu) return { ok: false, why: "no_menu" };
	var items = menu.menuItems();
	var item = null;
	for (var k = 0; k < items.length && !item; k++) if (/채팅방 열기|^open/i.test(attr(items[k], "name"))) item = items[k];
	if (!item) {
		try {
			menu.actions.byName("AXCancel").perform();
		} catch (e) {}
		return { ok: false, why: "no_menu" };
	}
	item.actions.byName("AXPress").perform();
	var shown = until(function () {
		return windowNamed(name);
	}, 3);
	return shown ? { ok: true, row: hit } : { ok: false, why: "no_window" };
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
		if (req.action === "send" && typeof req.name === "string" && req.name && typeof req.text === "string" && req.text) return JSON.stringify(sendInto(req.name, req.text));
		if (req.action === "open" && typeof req.name === "string" && req.name) return JSON.stringify(openRow(req.name, Math.min(Math.max(1, req.rows | 0), 300)));
		return JSON.stringify({ ok: false });
	} catch (e) {
		return JSON.stringify({ ok: false, why: "error", error: String(e).slice(0, 120) });
	}
}
