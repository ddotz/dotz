// KakaoTalk login by Accessibility (System Events), run as `osascript -l JavaScript` with ONE JSON line on stdin:
//   {action:"state"} | {action:"focus", field:"id"|"password"} | {action:"submit"} | {action:"ack"}
// Prints one JSON line {state:"main"|"login"|"locked"|"confirm"|"error"|"unknown", detail?, pid?}. Details are fixed words.
// KakaoTalk enables its login button only on real key input, so the id and password are never sent here: "focus" clears one field
// and gives it AXFocused (pid in the answer), login.ts types into that process (keys.ts), then "submit" presses the button once it
// is enabled. It only sets AXValue / AXFocused and performs AXPress: no app activation, no window raise, no System Events key input.
//
// Detection is ported from kmsg Sources/kmsg/Auth/KakaoTalkAuthenticator.swift (MIT, Park Hee Chan, commit 54cbff79): the login
// markers (isLikelyLoginWindow / containsLoginMarkers), the lock screen test (resolveLockScreen: marker text in the window's own
// static text, exactly one input field, no scroll area or table), the post-login acknowledgement dialog, the login/lock button scoring
// (scoreButton / scoreLockConfirmButton) and the field roles. Error texts follow kakaocli LoginAutomator.checkForLoginErrors (MIT).
// The Korean marker variants and the device-confirmation words are additions of this port and have not been seen on a real screen.
ObjC.import("Foundation");

var BUNDLE = "com.kakao.KakaoTalkMac";
var MAX_NODES = 220;
var MAX_DEPTH = 5;
var FIELD_ROLES = ["AXTextField", "AXTextArea", "AXSecureTextField"];
var LIST_ROLES = ["AXScrollArea", "AXTable", "AXOutline", "AXList"];

var LOGIN_MARKERS = ["qr code", "start over", "keep me logged in", "find my kakao account", "reset password", "remaining time", "how to log in", "log in using a qr code", "로그인 상태 유지", "카카오계정 찾기", "비밀번호 재설정", "다시 시작"];
var LOCK_MARKERS = ["currently locked", "lock mode", "잠금 모드", "잠겨 있습니다", "잠금 상태"];
var ACK_MARKERS = ["currently logged in", "already logged in", "you are currently logged in", "you are already logged in", "logged in on another device", "이미 로그인", "로그인되어 있습니다"];
var CONFIRM_MARKERS = ["verification", "verify", "otp", "2fa", "인증", "new device", "새로운 기기", "새 기기"];
var REJECT_MARKERS = [["비밀번호", "틀"], ["비밀번호", "올바르지"], ["비밀번호", "일치"], ["incorrect"], ["wrong"], ["invalid"]];
var NETWORK_MARKERS = ["네트워크", "network", "connection"];

function norm(s) {
	return String(s == null ? "" : s).toLowerCase().replace(/\s+/g, " ").trim();
}

function get(el, name) {
	try {
		var v = el[name]();
		return v === null ? undefined : v;
	} catch (e) {
		return undefined;
	}
}

function press(el) {
	try {
		el.actions.byName("AXPress").perform();
		return true;
	} catch (e) {
		return false;
	}
}

function anyIn(text, markers) {
	for (var i = 0; i < markers.length; i++) if (text.indexOf(markers[i]) >= 0) return true;
	return false;
}

// Bounded breadth-first read of a window. A list (chat list, message area) is noted but never entered, so chat text can never pose
// as a login, lock or error notice. Field values are never read.
function scan(win) {
	var out = { title: norm(get(win, "title") || get(win, "name")), fields: [], buttons: [], texts: [], hasList: false };
	var queue = [{ el: win, depth: 0 }];
	var seen = 0;
	while (queue.length && seen < MAX_NODES) {
		var item = queue.shift();
		var kids = [];
		try {
			kids = item.el.uiElements();
		} catch (e) {
			kids = [];
		}
		for (var i = 0; i < kids.length && seen < MAX_NODES; i++) {
			var el = kids[i];
			seen++;
			var role = String(get(el, "role") || "");
			if (LIST_ROLES.indexOf(role) >= 0) {
				out.hasList = true;
				continue;
			}
			var n = { el: el, role: role, title: norm(get(el, "title") || get(el, "name")), desc: norm(get(el, "description")), enabled: get(el, "enabled") !== false, pos: get(el, "position") || [0, 0] };
			if (FIELD_ROLES.indexOf(role) >= 0) out.fields.push(n);
			else if (role === "AXButton" || role === "AXCheckBox") out.buttons.push(n);
			else if (role === "AXStaticText") {
				n.text = norm(get(el, "value") || n.title || n.desc);
				out.texts.push(n);
			}
			if (item.depth < MAX_DEPTH) queue.push({ el: el, depth: item.depth + 1 });
		}
	}
	return out;
}

function staticText(s) {
	return s.texts.map(function (t) { return t.text; }).join(" ");
}

function allText(s) {
	return [s.title, staticText(s)].concat(s.buttons.map(function (b) { return b.title + " " + b.desc; })).join(" ");
}

function classify(s) {
	if (s.hasList) return { state: "main" };
	var text = staticText(s);
	if (s.fields.length === 1 && anyIn(text, LOCK_MARKERS)) return { state: "locked" };
	var all = allText(s);
	if (anyIn(all, ACK_MARKERS)) return { state: "login", detail: "notice" };
	if (s.fields.length < 2 && anyIn(all, CONFIRM_MARKERS)) return { state: "confirm" };
	if (anyIn(text, NETWORK_MARKERS) && s.fields.length >= 2) return { state: "error", detail: "network" };
	for (var i = 0; i < REJECT_MARKERS.length; i++) {
		var ok = true;
		for (var j = 0; j < REJECT_MARKERS[i].length; j++) if (text.indexOf(REJECT_MARKERS[i][j]) < 0) ok = false;
		if (ok && s.fields.length >= 2) return { state: "error", detail: "rejected" };
	}
	var titled = s.title.indexOf("login") >= 0 || s.title.indexOf("log in") >= 0 || s.title.indexOf("로그인") >= 0;
	var secure = s.fields.some(function (f) { return f.role === "AXSecureTextField"; });
	if (titled || anyIn(all, LOGIN_MARKERS) || s.fields.length >= 2 || secure) return { state: "login" };
	return { state: "unknown" };
}

var PRIORITY = ["locked", "confirm", "error", "login", "main", "unknown"];

function observe() {
	var se = Application("System Events");
	var procs = se.processes.whose({ bundleIdentifier: BUNDLE })();
	if (!procs || !procs.length) return { windows: [], result: { state: "unknown", detail: "not_running" } };
	var pid = get(procs[0], "unixId");
	var wins = procs[0].windows();
	var views = [];
	for (var i = 0; i < wins.length; i++) {
		var s = scan(wins[i]);
		views.push({ win: wins[i], scan: s, cls: classify(s) });
	}
	if (!views.length) return { windows: [], pid: pid, result: { state: "unknown", detail: "no_window" } };
	views.sort(function (a, b) { return PRIORITY.indexOf(a.cls.state) - PRIORITY.indexOf(b.cls.state); });
	return { windows: views, pid: pid, result: views[0].cls };
}

function labels(b) {
	return [b.title, b.desc].filter(function (x) { return x; });
}

function loginButton(s, pwField) {
	var best;
	var bestScore = 0;
	s.buttons.forEach(function (b) {
		var l = labels(b);
		var score = 0;
		if (l.some(function (t) { return ["login", "log in", "signin", "sign in", "로그인"].indexOf(t) >= 0; })) score += 220;
		else if (l.some(function (t) { return t.indexOf("로그인") >= 0 || t.indexOf("login") >= 0; })) score += 120;
		if (l.some(function (t) { return t.indexOf("qr") >= 0; })) score -= 260;
		if (score <= 0) return;
		if (b.enabled) score += 20;
		var dy = b.pos[1] - pwField.pos[1];
		if (dy >= -12 && dy <= 180) score += 30;
		if (score > bestScore) {
			best = b;
			bestScore = score;
		}
	});
	return best;
}

function lockButton(s) {
	var best;
	var bestScore = 0;
	s.buttons.forEach(function (b) {
		var l = labels(b);
		var score = 0;
		if (l.indexOf("ok") >= 0 || l.indexOf("확인") >= 0) score += 120;
		if (l.indexOf("unlock") >= 0 || l.indexOf("잠금 해제") >= 0) score += 100;
		if (l.some(function (t) { return t.indexOf("switch account") >= 0 || t.indexOf("계정 변경") >= 0; })) score -= 200;
		if (score > bestScore) {
			best = b;
			bestScore = score;
		}
	});
	return best;
}

function dismissNotice(s) {
	var best;
	var bestScore = 0;
	s.buttons.forEach(function (b) {
		var l = labels(b);
		var score = l.indexOf("ok") >= 0 ? 140 : l.indexOf("확인") >= 0 ? 120 : l.indexOf("confirm") >= 0 ? 100 : 0;
		if (score > bestScore) {
			best = b;
			bestScore = score;
		}
	});
	return best ? press(best.el) : false;
}

function focusEmpty(el) {
	try {
		el.value = "";
	} catch (e) {}
	try {
		el.focused = true;
		return true;
	} catch (e) {
		return false;
	}
}

function byPosition(a, b) {
	return a.pos[1] - b.pos[1] || a.pos[0] - b.pos[0];
}

// The password field is an AXTextField described as "보안 텍스트 필드" on the Korean UI (AXSecureTextField elsewhere).
function loginFields(v) {
	var fields = v.scan.fields.slice().sort(byPosition);
	if (fields.length < 2) return undefined;
	var pw = fields.filter(function (f) { return f.role === "AXSecureTextField" || /password|passwd|secure|비밀번호|보안/.test(f.title + " " + f.desc); })[0] || fields[1];
	return { user: fields.filter(function (f) { return f !== pw; })[0], pw: pw };
}

function focus(v, field, pid) {
	var state = v.cls.state;
	var el;
	if (state === "locked") el = v.scan.fields[0];
	else {
		var f = loginFields(v);
		if (!f) return { state: "error", detail: "ui_changed" };
		el = field === "id" ? f.user : f.pw;
	}
	if (!el || !focusEmpty(el.el) || typeof pid !== "number") return { state: "error", detail: "ui_changed" };
	return { state: state, detail: "focused", pid: pid };
}

function submit(v) {
	var state = v.cls.state;
	var button;
	if (state === "locked") button = lockButton(v.scan);
	else {
		var f = loginFields(v);
		button = f && loginButton(v.scan, f.pw);
	}
	if (!button) return { state: "error", detail: "ui_changed" };
	if (!button.enabled) return { state: state, detail: "submit_disabled" };
	return press(button.el) ? { state: state, detail: "submitted" } : { state: "error", detail: "ui_changed" };
}

function readInput() {
	var data = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
	return ObjC.unwrap($.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding));
}

function run() {
	var req;
	try {
		req = JSON.parse(readInput());
	} catch (e) {
		return JSON.stringify({ state: "error", detail: "bad_input" });
	}
	try {
		var seen = observe();
		var out = seen.result;
		if (req.action === "ack") {
			seen.windows.forEach(function (v) {
				if (v.cls.detail === "notice") dismissNotice(v.scan);
			});
			out = { state: seen.result.state, detail: "notice_handled" };
		} else if (req.action === "focus" || req.action === "submit") {
			var target = seen.windows[0];
			var form = seen.result.state === "locked" || (seen.result.state === "login" && seen.result.detail !== "notice") || (seen.result.state === "error" && seen.result.detail === "rejected");
			if (form) out = req.action === "submit" ? submit(target) : focus(target, req.field === "id" ? "id" : "password", seen.pid);
		}
		return JSON.stringify(out);
	} catch (e) {
		return JSON.stringify({ state: "error", detail: "ui_changed" });
	}
}
