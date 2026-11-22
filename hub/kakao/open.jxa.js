// returnOpen, the first way room.jxa.js open tries (openRowIn). It runs appended to room.jxa.js (a second osascript -e, hub/kakao/room.ts)
// and uses its helpers (until, sameTitle).
// Opens list row `index` the way a click and Return would, without the context menu (which can raise the list window over the owner's
// window): the row is selected and one Return goes to KakaoTalk's pid only (CGEventPostToPid: no activation, no key to the app in front, an
// off-screen row needs no scroll). A key sent to a pid reaches that app's main window and focused element, so it is sent only once the list
// window is main, the focus is in its list and the one selected row is this room: a Return in a chat input could send what is typed there.
// Any doubt returns {why} and sends no key; openRowIn then uses the menu. Idea from kakaocli-skill (MIT, Tygb99) kakao-open-ui.js.
ObjC.import("CoreGraphics");

function returnOpen(list, index, name) {
	var proc = list.proc;
	var table = list.table;
	var row = table.rows[index];
	var win = proc.windows.whose({ name: "카카오톡" })()[0];
	try {
		row.selected = true;
	} catch (e) {
		return { why: "no_select" };
	}
	var selected = function () {
		try {
			return row.selected() === true;
		} catch (e) {
			return false;
		}
	};
	if (!until(selected, 1)) return { why: "select" };
	var isMain = function () {
		try {
			return win.attributes.byName("AXMain").value() === true;
		} catch (e) {
			return false;
		}
	};
	if (!isMain()) {
		try {
			win.attributes.byName("AXMain").value = true;
		} catch (e) {}
	}
	try {
		table.focused = true;
	} catch (e) {}
	var focused = function () {
		try {
			var role = proc.attributes.byName("AXFocusedUIElement").value().role();
			return isMain() && proc.attributes.byName("AXFocusedWindow").value().name() === "카카오톡" && ["AXTable", "AXOutline", "AXRow", "AXCell"].indexOf(role) >= 0;
		} catch (e) {
			return false;
		}
	};
	if (!until(focused, 1)) return { why: "focus" };
	var picked = [];
	try {
		picked = table.rows.whose({ selected: true })().map(function (r) {
			try {
				return String(r.uiElements[0].staticTexts[0].value());
			} catch (e) {
				return "";
			}
		});
	} catch (e) {}
	if (picked.length !== 1 || !sameTitle(picked[0], name)) return { why: "selection" };
	var pid = proc.unixId();
	$.CGEventPostToPid(pid, $.CGEventCreateKeyboardEvent($(), 36, true)); // 36 = Return
	$.CGEventPostToPid(pid, $.CGEventCreateKeyboardEvent($(), 36, false));
	return { pressed: true };
}
