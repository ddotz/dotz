/* ---------- screens: the one table of every screen ---------- */
// One row per screen, one line per row, data only (hub/screens-read.ts reads this text for hub/ui-surfaces.ts and site/demo-views.ts).
// tab: the bottom tab a screen belongs to; nav: its place in the tab bar (no nav: not a tab); sub: a settings sub-page (the 설정 tab
// stays lit, 뒤로 leads back toward 설정); up: the fixed screen 뒤로 goes to, only where that never depends on state; title and ic: the
// header title and the icon of the tab and palette row; html: its section is in web/index.html (without it 22-settings-pages.js adds one).
// palette: false keeps a screen out of the command palette's screen list (it is reached from another screen, never by name).
// relay: a relayed computer's snapshot is drawn in this screen (44-relay-views.js); under: the settings page 뒤로 falls back to when it was not opened from another screen.
// 채팅 is one tab: its 대화 | 터미널 toggle picks the "chat" or "activity" view, and the tab reopens the last one used; term: the 터미널 view (its header bar reads term).
// keyed: the address target names one of the screen's own items (a project, a provider, a card), never a conversation: go() leaves the open one alone.
// go() reads the 채팅 tab's views as the conversation views: the open conversation is their address.
// The order is the order of the views list (the palette lists screens in it); the four settings pages come last.
const SCREENS = {
  home: { tab: "home", nav: 1, title: TX("common.home"), ic: "home", html: true, relay: true },
  chat: { tab: "chat", nav: 2, title: TX("common.chat"), ic: "chat", html: true, relay: true },
  activity: { tab: "chat", title: TX("common.chat"), ic: "activity", html: true, palette: false, term: true },
  harness: { tab: "settings", sub: true, up: "settings", title: TX("common.system"), ic: "harness", html: true },
  settings: { tab: "settings", nav: 4, title: TX("common.settings"), ic: "settings", html: true, relay: true },
  models: { tab: "settings", sub: true, title: TX("common.model"), ic: "model", html: true },
  accounts: { tab: "settings", sub: true, title: TX("common.accounts"), ic: "key", html: true, keyed: true },
  usage: { tab: "settings", sub: true, title: TX("common.usage"), ic: "usage", html: true },
  context: { tab: "settings", sub: true, title: TX("common.context"), ic: "context", html: true },
  discord: { tab: "settings", sub: true, title: TX("base.title.discord"), ic: "discord", html: true, under: "messengers" },
  jandi: { tab: "settings", sub: true, title: TX("base.title.jandi"), ic: "chat", html: true, under: "messengers" },
  slack: { tab: "settings", sub: true, title: TX("base.title.slack"), ic: "chat", html: true, under: "messengers" },
  telegram: { tab: "settings", sub: true, title: TX("base.title.telegram"), ic: "chat", html: true, under: "messengers" },
  messengers: { tab: "settings", sub: true, title: TX("base.title.messengers"), ic: "chat", html: true },
  devices: { tab: "settings", sub: true, title: TX("base.title.devices"), ic: "key", html: true },
  webaccess: { tab: "settings", sub: true, title: TX("base.title.webaccess"), ic: "open", html: true },
  project: { tab: "projects", title: TX("common.project"), ic: "projects", html: true, palette: false, keyed: true },
  projects: { tab: "projects", title: TX("common.projects"), ic: "projects", html: true, relay: true },
  monitoring: { tab: "monitoring", nav: 3, title: TX("common.apps"), ic: "apps", html: true, relay: true },
  apps: { tab: "monitoring", title: TX("common.apps"), ic: "apps", html: true },
  notices: { up: "home", title: TX("common.alerts"), ic: "bell", html: true },
  cardform: { tab: "home", up: "home", title: TX("base.title.cardform"), palette: false, keyed: true },
  notifications: { tab: "settings", sub: true, title: TX("settings.page.notifications"), ic: "bell" },
  display: { tab: "settings", sub: true, title: TX("settings.page.display"), ic: "settings" },
  update: { tab: "settings", sub: true, title: TX("settings.page.update"), ic: "download" },
  runtime: { tab: "settings", sub: true, title: TX("settings.page.runtime"), ic: "term" },
  schedules: { tab: "settings", sub: true, title: TX("settings.page.schedules"), ic: "list" },
  custom: { tab: "settings", sub: true, title: TX("settings.page.custom"), ic: "pencil" },
};
// The lists the rest of the app reads, all made from the table (web/custom.js and the tests read them by these names).
const views = Object.keys(SCREENS);
const SUB = new Set(views.filter(id => SCREENS[id].sub));
const titles = Object.fromEntries(views.map(id => [id, SCREENS[id].title]));
const NAV = views.filter(id => SCREENS[id].nav).sort((a, b) => SCREENS[a].nav - SCREENS[b].nav).map(id => [id, SCREENS[id].title]);
const RELAY_VIEWS = new Set(views.filter(id => SCREENS[id].relay));
const VIEW_ICON = Object.fromEntries(views.filter(id => SCREENS[id].ic).map(id => [id, SCREENS[id].ic]));
// A screen's own functions, which a data row cannot hold: its owner file registers them with screenHooks(id, { ... }), one function per key.
// go() asks them in this order and tests no screen name itself:
// conv(tgt): the conversation an address target opens inside the screen (모니터링's monitoring/c:<target>), drawn in the chat view.
// aim(tgt): before current changes, the screen reads the target; it may return [name, tgt] to open another screen or target instead (a third element true: the phone's chat list).
// leave(): the screen being left, before current changes (채팅 keeps the reader's place in its pane).
// route(tgt): after current is set and before the address is built, the screen reads the target into its state.
// hash(tgt): the screen's address when it says more than its id (project/<key>); empty or missing: the id.
// beside(): a view shown beside this one (the project list beside a project from 1100px).
// title(): a header title that follows state (홈 names the bot).
// away(): every other screen's, on each move, before the new one's enter (시스템's node sheet closes).
// enter(tgt): once the view is shown, the screen draws itself and asks for its data.
// back(): the app bar's 뒤로 asks it first (04-state.js #back); true means it closed something on the screen itself.
// chain(hash): the routes from 홈 down to the screen when they follow its state (32-history-nav.js routeChain); without it the row's up is used.
const SCREEN_HOOKS = {};
function screenHooks(id, hooks) {
  if (!SCREENS[id]) throw new Error(`screenHooks: unknown screen ${id}`);
  const own = SCREEN_HOOKS[id] ||= {};
  for (const [k, f] of Object.entries(hooks)) {
    if (k in own) throw new Error(`screenHooks: ${id}.${k} is registered twice`);
    own[k] = f;
  }
}
