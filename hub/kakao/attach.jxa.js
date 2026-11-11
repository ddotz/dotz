// attach (the owner's own 나와의 채팅 only, hub/kakao/sendfile.ts) pastes ONE file into the one window titled `name`. It runs appended to
// room.jxa.js (a second osascript -e) and uses its helpers. The general pasteboard gets the file URL, the input is focused, and KakaoTalk's
// own menu item 편집 > 붙여넣기 is pressed (AXPress, no key event); KakaoTalk then shows its file send dialog, whose 전송 is pressed.
// KakaoTalk stays where it is: no activation, no frontmost, no AXRaise (the owner's rule, and a text send does the same). A paste it does not
// answer in the background ends as no_dialog, never as a raised window.
// The menu item reaches whatever KakaoTalk has focused, so selfGate runs right before the paste and again right before the press: the self
// window must be the only chat window and must show the words 나와의 채팅. A press of the dialog is refused otherwise and the dialog cancelled.
// A new window that has a message input is another chat, never the dialog: its own 전송 would send what the owner typed there.
// The owner's pasteboard is saved before and restored after, whatever happened, unless the owner copied something newer meanwhile. An input
// holding the owner's text is never touched. Prints {ok:true, pressed:true} once the dialog closed after the press, or {ok:false, why,
// pressed?, seen?}: seen names the windows and buttons that were there instead of the dialog. clipboard:false: not fully restored.
var GATE_MS = 4000;

function pasteMenuItem(proc) {
	var bar = proc.menuBars[0].menuBarItems();
	for (var i = 0; i < bar.length; i++) {
		if (!/^(편집|Edit)$/.test(attr(bar[i], "name"))) continue;
		var items = bar[i].menus[0].menuItems();
		for (var k = 0; k < items.length; k++) if (/^(붙여넣기|Paste)$/.test(attr(items[k], "name"))) return items[k];
	}
	return null;
}

function saveClipboard(pb) {
	var saved = { items: $.NSMutableArray.array, whole: true };
	var items = pb.pasteboardItems;
	var n = items && !items.isNil() ? items.count : 0;
	for (var i = 0; i < n; i++) {
		var it = items.objectAtIndex(i);
		var copy = $.NSPasteboardItem.alloc.init;
		var types = it.types;
		for (var t = 0; t < types.count; t++) {
			var ty = types.objectAtIndex(t);
			var data = it.dataForType(ty);
			if (data && !data.isNil()) copy.setDataForType(data, ty);
			else saved.whole = false;
		}
		saved.items.addObject(copy);
	}
	return saved;
}

// `ours`: the change count of our own write. Any other count is a newer copy of the owner's, which stays. Answers whether nothing was lost.
function restoreClipboard(pb, saved, ours) {
	try {
		if (pb.changeCount !== ours) return true;
		pb.clearContents;
		return (Number(saved.items.count) === 0 || pb.writeObjects(saved.items) === true) && saved.whole;
	} catch (e) {
		return false;
	}
}

function windowKey(w) {
	return attr(w, "name") + "|" + attr(w, "subrole");
}

function press(el) {
	try {
		el.actions.byName("AXPress").perform();
		return true;
	} catch (e) {
		return false;
	}
}

// "" when the self window of `name` is the only chat window besides `dialogs` new windows and shows that it is the 나와의 채팅.
function selfGate(name, before, dialogs) {
	var wins = chatWindows();
	var kept = wins.filter(function (x) {
		return before.indexOf(windowKey(x)) !== -1;
	});
	if (kept.length !== 1 || wins.length - kept.length !== dialogs || !sameTitle(attr(kept[0], "name"), name)) return "other_window";
	var f = facts(kept[0], true, GATE_MS);
	return f.self === true && !(f.members > 1) ? "" : "not_self";
}

// A send button of a sheet of the chat window, or of a window that was not there before the paste and is not a chat.
function dialogButton(proc, w, before) {
	var places = [];
	try {
		w.sheets().forEach(function (s) {
			places.push({ el: s, sheet: true });
		});
		proc.windows().forEach(function (x) {
			if (before.indexOf(windowKey(x)) === -1 && !inputOf(x)) places.push({ el: x, sheet: false });
		});
	} catch (e) {
		return null;
	}
	for (var p = 0; p < places.length; p++) {
		var btns = batch(places[p].el, "buttons");
		for (var b = 0; b < btns.length; b++) if (/^(전송|보내기|Send)$/.test(attr(btns[b], "name"))) return { place: places[p], button: btns[b] };
	}
	return null;
}

function cancelDialog(place) {
	var btns = batch(place.el, "buttons");
	for (var b = 0; b < btns.length; b++) if (/^(취소|Cancel)$/.test(attr(btns[b], "name"))) return press(btns[b]);
	return false;
}

function seenNow(proc, w) {
	var out = batch(proc, "windows").map(function (x) {
		return "win:" + attr(x, "name") + "/" + batch(x.buttons, "name").join(",");
	});
	batch(w, "sheets").forEach(function (s) {
		out.push("sheet:" + batch(s.buttons, "name").join(","));
	});
	return out.join(" | ").slice(0, 400);
}

// From a clipboard that holds the file to the press of the dialog; the caller restores the clipboard.
function pasteAndPress(proc, w, input, item, name, before, state) {
	try {
		input.focused = true;
	} catch (e) {
		// The same best effort as a text send; the dialog decides below.
	}
	if (!press(item)) return { ok: false, why: "paste_error" };
	var hit = until(function () {
		return dialogButton(proc, w, before);
	}, 4);
	if (!hit) {
		// The paste went in as text (a path, a name): put the input back as it was; nothing was sent.
		var free = freeValue(attr(input, "value"), attr(input, "placeholderValue"));
		if (!free) input.value = "";
		return { ok: false, why: free ? "no_dialog" : "pasted_text", seen: seenNow(proc, w) };
	}
	var refused = selfGate(name, before, hit.place.sheet ? 0 : 1);
	if (refused) return { ok: false, why: cancelDialog(hit.place) ? refused : "dialog_left", seen: seenNow(proc, w) };
	// From here on the press may have reached KakaoTalk, so a throwing press counts as pressed (the database decides, never pressed again).
	state.pressed = true;
	if (!press(hit.button)) return { ok: false, why: "press_error", pressed: true };
	var gone = until(function () {
		return dialogButton(proc, w, before) ? null : "gone";
	}, 5);
	return gone ? { ok: true, pressed: true } : { ok: false, why: "dialog_stayed", pressed: true, seen: seenNow(proc, w) };
}

function attachFile(name, path) {
	var procs = Application("System Events").processes.whose({ bundleIdentifier: BUNDLE })();
	if (!procs.length) return { ok: false, why: "not_running" };
	var proc = procs[0];
	var w = windowNamed(name);
	if (!w) return { ok: false, why: "no_window" };
	var input = inputOf(w);
	if (!input) return { ok: false, why: "no_input" };
	if (!freeValue(attr(input, "value"), attr(input, "placeholderValue"))) return { ok: false, why: "owner_text" };
	var item = pasteMenuItem(proc);
	if (!item) return { ok: false, why: "no_paste_item" };
	var before = proc.windows().map(windowKey);
	var refused = selfGate(name, before, 0);
	if (refused) return { ok: false, why: refused };
	var url = $.NSURL.fileURLWithPath(path);
	var urls = $.NSMutableArray.array;
	urls.addObject(url);
	var pb = $.NSPasteboard.generalPasteboard;
	var saved = saveClipboard(pb);
	pb.clearContents;
	var wrote = pb.writeObjects(urls) === true;
	var ours = pb.changeCount;
	var state = { pressed: false };
	var out;
	try {
		out = wrote ? pasteAndPress(proc, w, input, item, name, before, state) : { ok: false, why: "pasteboard" };
	} catch (e) {
		out = { ok: false, why: "error", pressed: state.pressed, err: String(e).slice(0, 100) };
	}
	if (!restoreClipboard(pb, saved, ours)) out.clipboard = false;
	return out;
}
