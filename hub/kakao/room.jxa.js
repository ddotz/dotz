// Reads and closes the open KakaoTalk chat window by Accessibility (System Events), run as `osascript -l JavaScript` with ONE JSON line on stdin:
//   {action:"probe"} | {action:"close"}
// probe prints {ok:true, windows:[{title, members?, self?}]} for every window that is not the main window; room.ts accepts the room only when
// exactly one chat window is open. `members` is read only from a static text that names itself a count (identifier or description with
// count/member/참여/명); `self` is true only when the window shows the words 나와의 채팅. A missing field means "not shown", never "no".
// close presses the close button of every non-main window. Nothing is typed and no key is sent.
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

function facts(w) {
	var info = { title: attr(w, "name") };
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

function closeAll() {
	var wins = chatWindows();
	for (var i = 0; i < wins.length; i++) {
		try {
			wins[i].buttons.whose({ subrole: "AXCloseButton" })[0].click();
		} catch (e) {}
	}
	return { ok: true, closed: wins.length };
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
		if (req.action === "probe") return JSON.stringify({ ok: true, windows: chatWindows().map(facts) });
		if (req.action === "close") return JSON.stringify(closeAll());
		return JSON.stringify({ ok: false });
	} catch (e) {
		return JSON.stringify({ ok: false });
	}
}
