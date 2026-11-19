const Main = imports.ui.main;
const Settings = imports.ui.settings;
const Meta = imports.gi.Meta;
const GLib = imports.gi.GLib;
const Gio = imports.gi.Gio;
const St = imports.gi.St;
const Clutter = imports.gi.Clutter;
const Cinnamon = imports.gi.Cinnamon;

const UUID = "cinnamon-fullscreen-to-workspace@arashdayaniii";

let extSettings = null;
var trackedWindows = new Map();
var dedicatedWorkspaces = new Map();
let globalSignals = [];
let activeTimeouts = new Set();
let wmPrefs = null;

let topBar = null;
let topBarWindow = null;
let topBarVisible = false;
let barPollTimer = 0;
let barHideTimer = 0;

let cfg = {
    mode: "fullscreen",
    resyncOnSwitch: true,
    floatingTopbar: true,
    floatingTopbarSkipCustom: true,
    settleDelay: 100,
    restoreMaximizeDelay: 0,
    exitHotkey: "<Super><Shift>f",
    enableLogs: false
};

function logDebug(msg) {
    if (cfg.enableLogs) {
        global.log(`[CinnamonFullscreenToWorkspace] ${msg}`);
    }
}

function scheduleTimeout(ms, fn) {
    let delay = Math.max(0, ms);
    let id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
        activeTimeouts.delete(id);
        fn();
        return GLib.SOURCE_REMOVE;
    });
    activeTimeouts.add(id);
    return id;
}

function clearAllTimeouts() {
    for (let id of activeTimeouts) {
        try { GLib.source_remove(id); } catch (e) {}
    }
    activeTimeouts.clear();
}

function isWindowAlive(win) {
    return win && !win.unmanaged && trackedWindows.has(win);
}

function getWmPrefs() {
    if (!wmPrefs) {
        wmPrefs = new Gio.Settings({ schema_id: "org.cinnamon.desktop.wm.preferences" });
    }
    return wmPrefs;
}

function getParsedButtonLayout() {
    let layout = ":minimize,maximize,close";
    try {
        let val = getWmPrefs().get_string("button-layout");
        if (val && val.length > 0) {
            layout = val;
        }
    } catch (e) {}

    let parts = layout.split(":");
    let leftPart = parts[0] || "";
    let rightPart = parts[1] || "";

    let leftBtns = leftPart.split(",").map(s => s.trim()).filter(s => s && s !== "spacer");
    let rightBtns = rightPart.split(",").map(s => s.trim()).filter(s => s && s !== "spacer");

    return { leftBtns: leftBtns, rightBtns: rightBtns };
}

function getButtonLayoutInfo() {
    let { leftBtns, rightBtns } = getParsedButtonLayout();

    let isRtl = false;
    try {
        isRtl = (Clutter.get_default_text_direction() === Clutter.TextDirection.RTL);
    } catch (e) {}

    if (isRtl) {
        let tmp = leftBtns.slice().reverse();
        leftBtns = rightBtns.slice().reverse();
        rightBtns = tmp;
    }

    let rIdx = rightBtns.indexOf("maximize");
    if (rIdx !== -1) {
        return { side: "right", idx: rightBtns.length - 1 - rIdx };
    }
    let lIdx = leftBtns.indexOf("maximize");
    if (lIdx !== -1) {
        return { side: "left", idx: lIdx };
    }
    return { side: "right", idx: 1 };
}

function getScaleFactor() {
    try {
        return Math.max(1, St.ThemeContext.get_for_stage(global.stage).scale_factor || 1);
    } catch (e) {
        return 1;
    }
}

function hasCustomTitlebar(win) {
    if (!win) return false;
    let clientDecorated = false;
    let decorated = true;

    try {
        if (typeof win.is_client_decorated === "function") {
            clientDecorated = !!win.is_client_decorated();
        }
    } catch (e) {}

    try {
        if ("decorated" in win) {
            decorated = !!win.decorated;
        }
    } catch (e) {}

    let result = clientDecorated || !decorated;
    logDebug(`titlebarCheck title='${win.get_title()}' decorated=${decorated} clientDecorated=${clientDecorated} custom=${result}`);
    return result;
}

function isPointerOnMaximizeButton(rect) {
    if (!rect) return false;
    let [px, py] = global.get_pointer();
    let scale = getScaleFactor();
    let { side, idx } = getButtonLayoutInfo();

    let inY = (py >= rect.y - 10 * scale && py <= rect.y + 60 * scale);
    let minD = Math.max(0, (idx * 20 - 4) * scale);
    let maxD = ((idx + 1) * 54 + 12) * scale;

    let dist = (side === "right")
        ? (rect.x + rect.width) - px
        : px - rect.x;

    let matched = inY && (dist >= minD && dist <= maxD);
    logDebug(`click ptr=(${px},${py}) rect=(${rect.x},${rect.y},${rect.width},${rect.height}) scale=${scale} dist=${dist} range=[${minD},${maxD}] inY=${inY} matched=${matched}`);
    return matched;
}

function copyRect(r) {
    return { x: r.x, y: r.y, width: r.width, height: r.height };
}

function getMonitorRect(win) {
    try {
        let monIdx = win.get_monitor();
        let rect = global.display.get_monitor_geometry(monIdx);
        if (rect && rect.width > 0 && rect.height > 0) {
            return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
        }
    } catch (e) {}

    try {
        let monIdx = win.get_monitor();
        let m = Main.layoutManager.monitors[monIdx];
        if (m) return { x: m.x, y: m.y, width: m.width, height: m.height };
    } catch (e) {}

    return { x: 0, y: 0, width: global.screen_width, height: global.screen_height };
}

function getWorkAreaRect(win) {
    try {
        let wa = win.get_work_area_for_monitor(win.get_monitor());
        if (wa && wa.width > 0 && wa.height > 0) {
            return { x: wa.x, y: wa.y, width: wa.width, height: wa.height };
        }
    } catch (e) {}
    return getMonitorRect(win);
}

function isNormalState(win) {
    return win.get_maximized() === 0 && !win.is_fullscreen() && !win.minimized;
}

function isMatchingWorkAreaOrScreen(r, win) {
    if (!r || typeof r.x !== "number" || typeof r.y !== "number" ||
        typeof r.width !== "number" || typeof r.height !== "number") {
        return true;
    }
    if (r.width <= 100 || r.height <= 100) return true;
    let wa = getWorkAreaRect(win);
    let mon = getMonitorRect(win);
    if (r.width >= mon.width && r.height >= mon.height) return true;
    if (r.width >= wa.width - 4 && r.height >= wa.height - 4) return true;
    return false;
}

function updateSavedRects(win) {
    if (!win || win.unmanaged || win._macBusy || win._macDedicated) return;
    let currentWs = null;
    try { currentWs = win.get_workspace(); } catch (e) {}
    if (currentWs && dedicatedWorkspaces.has(currentWs)) return;

    let r = win.get_frame_rect();
    if (!r || r.width <= 50 || r.height <= 50) return;

    if (isNormalState(win)) {
        if (!isMatchingWorkAreaOrScreen(r, win)) {
            win._macNormalRect = copyRect(r);
        }
    } else if (win.get_maximized() === Meta.MaximizeFlags.BOTH && !win.is_fullscreen()) {
        win._macMaxRect = copyRect(r);
    }
}

function scheduleRectUpdate(win) {
    if (!isWindowAlive(win) || win._macBusy || win._macDedicated) return;
    if (win._macRectTimer) {
        try {
            GLib.source_remove(win._macRectTimer);
            activeTimeouts.delete(win._macRectTimer);
        } catch (e) {}
        win._macRectTimer = 0;
    }
    win._macRectTimer = scheduleTimeout(30, () => {
        if (win) win._macRectTimer = 0;
        updateSavedRects(win);
    });
}

function getWindowAppName(win) {
    if (!win) return "App";
    try {
        let tracker = Cinnamon.WindowTracker.get_default();
        let app = tracker.get_window_app(win);
        if (app) {
            let name = app.get_name();
            if (name && name.trim().length > 0) return name.trim();
        }
    } catch (e) {}

    try {
        let wmClass = win.get_wm_class();
        if (wmClass && wmClass.trim().length > 0) {
            let c = wmClass.trim();
            return c.charAt(0).toUpperCase() + c.slice(1);
        }
    } catch (e) {}

    try {
        let title = win.get_title();
        if (title && title.trim().length > 0) return title.trim();
    } catch (e) {}

    return "App";
}

const IDE_SPECS = [
    { match: /rider/i, defaultIdeName: "Rider" },
    { match: /idea|intellij/i, defaultIdeName: "IntelliJ IDEA" },
    { match: /pycharm/i, defaultIdeName: "PyCharm" },
    { match: /webstorm/i, defaultIdeName: "WebStorm" },
    { match: /clion/i, defaultIdeName: "CLion" },
    { match: /goland/i, defaultIdeName: "GoLand" },
    { match: /rubymine/i, defaultIdeName: "RubyMine" },
    { match: /phpstorm/i, defaultIdeName: "PhpStorm" },
    { match: /datagrip/i, defaultIdeName: "DataGrip" },
    { match: /rustrover/i, defaultIdeName: "RustRover" },
    { match: /fleet/i, defaultIdeName: "Fleet" },
    { match: /android.*studio/i, defaultIdeName: "Android Studio" },
    { match: /visual-studio-code|code-oss|code|vscodium|vscode/i, defaultIdeName: "VS Code" },
    { match: /cursor/i, defaultIdeName: "Cursor" },
    { match: /windsurf/i, defaultIdeName: "Windsurf" },
    { match: /antigravity/i, defaultIdeName: "Antigravity" },
    { match: /sublime/i, defaultIdeName: "Sublime Text" },
    { match: /eclipse/i, defaultIdeName: "Eclipse" },
    { match: /qtcreator/i, defaultIdeName: "Qt Creator" },
    { match: /netbeans/i, defaultIdeName: "NetBeans" },
    { match: /zed/i, defaultIdeName: "Zed" },
    { match: /atom/i, defaultIdeName: "Atom" },
    { match: /kate/i, defaultIdeName: "Kate" },
    { match: /kdevelop/i, defaultIdeName: "KDevelop" },
    { match: /geany/i, defaultIdeName: "Geany" }
];

function getWorkspaceTitleForWindow(win) {
    if (!win) return "App";

    let appName = "";
    try {
        let tracker = Cinnamon.WindowTracker.get_default();
        let app = tracker.get_window_app(win);
        if (app) {
            let name = app.get_name();
            if (name && name.trim().length > 0) appName = name.trim();
        }
    } catch (e) {}

    let wmClass = "";
    try {
        let c = win.get_wm_class();
        if (c && c.trim().length > 0) wmClass = c.trim();
    } catch (e) {}

    let title = "";
    try {
        let t = win.get_title();
        if (t && t.trim().length > 0) title = t.trim();
    } catch (e) {}

    let fullId = `${appName} ${wmClass}`.toLowerCase();

    let matchedIde = null;
    for (let spec of IDE_SPECS) {
        if (spec.match.test(fullId)) {
            matchedIde = spec.defaultIdeName;
            break;
        }
    }

    if (!matchedIde && fullId.indexOf("jetbrains") !== -1) {
        matchedIde = "JetBrains";
    }

    if (!matchedIde) {
        return getWindowAppName(win);
    }

    let ideDisplay = matchedIde;
    if (appName && appName.length > 1 && !appName.toLowerCase().endsWith(".py")) {
        let lowerApp = appName.toLowerCase();
        if (lowerApp !== "code" && lowerApp !== "code-oss" && lowerApp !== "jetbrains-rider" && lowerApp !== "antigravity") {
            ideDisplay = appName;
        }
    }
    if (matchedIde && ideDisplay.toLowerCase() === matchedIde.toLowerCase()) {
        ideDisplay = matchedIde;
    }

    if (!title) {
        return ideDisplay;
    }

    if (/^(welcome|get started|welcome to)/i.test(title)) {
        return ideDisplay;
    }

    let cleanT = title.replace(/^[●*•]\s*/, "").trim();
    cleanT = cleanT.replace(/^\[Extension Development Host\]\s*[-—–]?\s*/i, "").trim();

    let project = null;
    let isJetBrains = /rider|idea|intellij|pycharm|webstorm|clion|goland|rubymine|phpstorm|datagrip|rustrover|fleet|jetbrains/i.test(fullId) ||
                      /android.*studio/i.test(fullId);

    if (isJetBrains) {
        let bracketMatch = cleanT.match(/^\[([^\]]+)\]/);
        if (bracketMatch) {
            project = bracketMatch[1].trim();
        } else if (cleanT.indexOf("[") !== -1) {
            let beforeBracket = cleanT.split("[")[0].trim();
            beforeBracket = beforeBracket.replace(/[\s–—-]+$/, "").trim();
            if (beforeBracket) {
                project = beforeBracket;
            }
        } else {
            let parts = cleanT.split(/\s+[—–-]\s+/).map(p => p.trim()).filter(p => p.length > 0);
            if (parts.length > 0) {
                let first = parts[0];
                if (first.toLowerCase() !== ideDisplay.toLowerCase() && first.toLowerCase() !== appName.toLowerCase()) {
                    project = first;
                }
            }
        }
    } else {
        let parts = cleanT.split(/\s+[—–-]\s+/).map(p => p.trim()).filter(p => p.length > 0);

        if (parts.length >= 2) {
            let last = parts[parts.length - 1];
            let isLastIde = /code|studio|sublime|eclipse|cursor|antigravity|zed|creator/i.test(last) ||
                            (last.toLowerCase() === ideDisplay.toLowerCase());
            if (isLastIde) {
                let cand = parts[parts.length - 2];
                cand = cand.replace(/\s*\((Workspace|SSH:[^)]+)\)/i, "").trim();
                cand = cand.replace(/\s*\[[^\]]+\]/g, "").trim();
                if (cand.indexOf("•") !== -1) {
                    let sub = cand.split("•");
                    cand = sub[sub.length - 1].trim();
                }
                if (cand && !/^(welcome|get started)$/i.test(cand)) {
                    project = cand;
                }
            } else {
                let first = parts[0];
                if (!/\.[a-zA-Z0-9]{1,6}$/.test(first)) {
                    project = first;
                }
            }
        } else if (parts.length === 1) {
            let cand = parts[0];
            if (cand.toLowerCase() !== ideDisplay.toLowerCase() && cand.toLowerCase() !== appName.toLowerCase()) {
                project = cand;
            }
        }
    }

    if (project && project.toLowerCase() !== ideDisplay.toLowerCase()) {
        project = project.replace(/^[\s–—-]+|[\s–—-]+$/g, "").trim();
        if (project.length > 0) {
            return `${project} - ${ideDisplay}`;
        }
    }

    return ideDisplay;
}

function getDedicatedWindowForWorkspace(ws) {
    if (!ws) return null;
    let win = dedicatedWorkspaces.get(ws);
    if (win && isWindowAlive(win)) return win;

    for (let w of trackedWindows.keys()) {
        if (w._macDedicated && (w._macDedicated.dedWs === ws || (w._macDedicated.dedWs && w._macDedicated.dedWs.index() === ws.index()))) {
            return w;
        }
    }
    return null;
}

function isChildOrDialogOf(otherWin, parentWin) {
    if (!otherWin || !parentWin) return false;
    if (otherWin === parentWin) return true;

    try {
        if (otherWin.get_transient_for() === parentWin) return true;
    } catch (e) {}

    try {
        if (otherWin.find_root_ancestor() === parentWin) return true;
    } catch (e) {}

    try {
        if (typeof otherWin.is_ancestor_of_transient === "function" && otherWin.is_ancestor_of_transient(parentWin)) {
            return true;
        }
    } catch (e) {}

    try {
        if (otherWin.window_type !== Meta.WindowType.NORMAL) {
            let tracker = Cinnamon.WindowTracker.get_default();
            let appOther = tracker.get_window_app(otherWin);
            let appParent = tracker.get_window_app(parentWin);
            if (appOther && appParent && appOther === appParent) return true;
            if (otherWin.get_pid && parentWin.get_pid && otherWin.get_pid() === parentWin.get_pid()) return true;
        }
    } catch (e) {}

    return false;
}

function getNonDedicatedWorkspace(preferredWs) {
    let wsMgr = global.workspace_manager;
    let n = wsMgr.get_n_workspaces();

    if (preferredWs && preferredWs.index() >= 0 && preferredWs.index() < n) {
        if (!getDedicatedWindowForWorkspace(preferredWs)) {
            return preferredWs;
        }
    }

    for (let i = 0; i < n; i++) {
        let ws = wsMgr.get_workspace_by_index(i);
        if (!getDedicatedWindowForWorkspace(ws)) {
            return ws;
        }
    }

    return wsMgr.append_new_workspace(false, global.get_current_time());
}

function isWindowValid(win) {
    try {
        if (!win || win.unmanaged) return false;
        let actor = win.get_compositor_private();
        if (!actor) return false;
        return true;
    } catch (e) {
        return false;
    }
}

function onWindowAddedToDedicated(ws, addedWin, dedicatedWin) {
    if (!addedWin || addedWin === dedicatedWin) return;
    try {
        if (addedWin.is_on_all_workspaces()) return;
    } catch (e) {
        return;
    }
    if (isChildOrDialogOf(addedWin, dedicatedWin)) return;

    logDebug(`Disallowed window '${addedWin.get_title()}' (class=${addedWin.get_wm_class()}) added to dedicated workspace '${Main.getWorkspaceName(ws.index())}'. Ejecting...`);

    scheduleTimeout(30, () => {
        if (!addedWin || !isWindowValid(addedWin)) return;
        let currentWs = null;
        try { currentWs = addedWin.get_workspace(); } catch (e) {}
        if (!currentWs || currentWs !== ws) return;

        let origWs = dedicatedWin._macDedicated ? dedicatedWin._macDedicated.origWs : null;
        let targetWs = getNonDedicatedWorkspace(origWs);

        addedWin.change_workspace(targetWs);

        let wsMgr = global.workspace_manager;
        let activeWs = wsMgr.get_active_workspace();
        if (activeWs === ws) {
            targetWs.activate(global.get_current_time());
            scheduleTimeout(50, () => {
                try {
                    if (isWindowValid(addedWin)) {
                        addedWin.activate(global.get_current_time());
                    }
                } catch (e) {}
            });
        }
    });
}

function removeWorkspaceIfEmpty(ws, fallbackWs) {
    if (!ws || ws === fallbackWs) return;
    let wsMgr = global.workspace_manager;
    if (wsMgr.get_n_workspaces() <= 1) {
        try { Main.setWorkspaceName(ws.index(), ""); } catch (e) {}
        return;
    }

    let remaining = ws.list_windows().filter(
        w => !w.is_on_all_workspaces() && w.window_type === Meta.WindowType.NORMAL
    );
    if (remaining.length === 0) {
        dedicatedWorkspaces.delete(ws);
        try {
            if (typeof Main._removeWorkspace === "function") {
                Main._removeWorkspace(ws);
            } else {
                Main.setWorkspaceName(ws.index(), "");
                wsMgr.remove_workspace(ws, global.get_current_time());
            }
        } catch (e) {
            try { wsMgr.remove_workspace(ws, global.get_current_time()); } catch (err) {}
        }
    }
}

function cancelBarHideTimer() {
    if (barHideTimer) {
        try { GLib.source_remove(barHideTimer); } catch (e) {}
        barHideTimer = 0;
    }
}

function destroyTopBar() {
    cancelBarHideTimer();
    if (topBar) {
        try { Main.layoutManager.removeChrome(topBar); } catch (e) {}
        try { topBar.destroy(); } catch (e) {}
        topBar = null;
    }
    topBarVisible = false;
    topBarWindow = null;
}

function hideTopBar() {
    cancelBarHideTimer();
    if (topBar && topBarVisible) {
        topBar.hide();
        topBarVisible = false;
    }
}

function createBarButton(kind, win) {
    let iconName = "window-restore-symbolic";
    let hoverBg = "rgba(255, 255, 255, 0.16)";
    if (kind === "minimize") {
        iconName = "window-minimize-symbolic";
    } else if (kind === "close") {
        iconName = "window-close-symbolic";
        hoverBg = "rgba(220, 53, 69, 0.85)";
    }

    let baseStyle = "border-radius: 6px; padding: 4px 8px; margin: 0 2px; background-color: transparent;";
    let hoverStyle = `border-radius: 6px; padding: 4px 8px; margin: 0 2px; background-color: ${hoverBg};`;

    let icon = new St.Icon({
        icon_name: iconName,
        icon_size: 14,
        style: "color: #f2f2f2;"
    });

    let btn = new St.Button({
        child: icon,
        reactive: true,
        can_focus: false,
        y_align: Clutter.ActorAlign.CENTER,
        style: baseStyle
    });

    btn.connect("enter-event", () => {
        btn.set_style(hoverStyle);
    });
    btn.connect("leave-event", () => {
        btn.set_style(baseStyle);
    });
    btn.connect("clicked", () => {
        hideTopBar();
        if (!isWindowAlive(win)) return;
        if (kind === "minimize") {
            win.minimize();
        } else if (kind === "maximize") {
            exitDedicatedWorkspace(win);
        } else if (kind === "close") {
            win.delete(global.get_current_time());
        }
    });

    return btn;
}

function buildTopBarForWindow(win) {
    destroyTopBar();
    if (!isWindowAlive(win)) return;

    let mon = getMonitorRect(win);
    let scale = getScaleFactor();
    let barHeight = Math.round(34 * scale);

    topBar = new St.BoxLayout({
        vertical: false,
        reactive: true,
        track_hover: true,
        text_direction: Clutter.TextDirection.LTR,
        style: "background-color: rgba(24, 24, 28, 0.94); border-bottom: 1px solid rgba(255, 255, 255, 0.12); padding: 0 10px;"
    });

    let { leftBtns, rightBtns } = getParsedButtonLayout();
    let validKinds = new Set(["minimize", "maximize", "close"]);

    let leftBox = new St.BoxLayout({
        vertical: false,
        y_align: Clutter.ActorAlign.CENTER
    });
    for (let k of leftBtns) {
        if (validKinds.has(k)) leftBox.add_child(createBarButton(k, win));
    }

    let titleLabel = new St.Label({
        text: win.get_title() || "",
        x_expand: true,
        x_align: Clutter.ActorAlign.CENTER,
        y_align: Clutter.ActorAlign.CENTER,
        style: "color: #ececec; font-size: 12px; font-weight: bold; padding: 0 12px;"
    });

    let rightBox = new St.BoxLayout({
        vertical: false,
        y_align: Clutter.ActorAlign.CENTER
    });
    for (let k of rightBtns) {
        if (validKinds.has(k)) rightBox.add_child(createBarButton(k, win));
    }

    topBar.add_child(leftBox);
    topBar.add_child(titleLabel);
    topBar.add_child(rightBox);

    topBar.set_position(mon.x, mon.y);
    topBar.set_size(mon.width, barHeight);
    topBar.hide();

    Main.layoutManager.addChrome(topBar, {
        visibleInFullscreen: true,
        affectsStruts: false,
        affectsInputRegion: true
    });

    topBarWindow = win;
    topBarVisible = false;
}

function shouldShowFloatingBarFor(win) {
    if (!cfg.floatingTopbar) return false;
    if (!isWindowAlive(win) || !win._macDedicated) return false;
    if (!win._macDedicated.useFullscreen || !win.is_fullscreen()) return false;
    if (cfg.floatingTopbarSkipCustom && win._macDedicated.customTitlebar) return false;
    return true;
}

function getActiveDedicatedBarCandidate() {
    let activeWs = global.workspace_manager.get_active_workspace();
    if (!activeWs) return null;

    let focusWin = global.display.focus_window;
    if (focusWin && focusWin.get_workspace() === activeWs && shouldShowFloatingBarFor(focusWin)) {
        return focusWin;
    }

    for (let win of trackedWindows.keys()) {
        if (win.get_workspace() === activeWs && shouldShowFloatingBarFor(win)) {
            return win;
        }
    }
    return null;
}

function pollFloatingBar() {
    let win = getActiveDedicatedBarCandidate();
    if (!win) {
        hideTopBar();
        stopBarPoller();
        return GLib.SOURCE_REMOVE;
    }

    let mon = getMonitorRect(win);
    let scale = getScaleFactor();
    let barHeight = Math.round(34 * scale);
    let [px, py] = global.get_pointer();
    let insideX = (px >= mon.x && px < mon.x + mon.width);

    if (!topBarVisible) {
        if (insideX && py >= mon.y && py <= mon.y + Math.max(4, 3 * scale)) {
            if (!topBar || topBarWindow !== win) {
                buildTopBarForWindow(win);
            } else {
                topBar.set_position(mon.x, mon.y);
                topBar.set_size(mon.width, barHeight);
            }
            cancelBarHideTimer();
            if (topBar) {
                topBar.show();
                topBarVisible = true;
            }
        }
    } else {
        let nearTop = insideX && (py >= mon.y && py <= mon.y + barHeight + 12 * scale);
        if (nearTop || (topBar && topBar.hover)) {
            cancelBarHideTimer();
        } else if (!barHideTimer) {
            barHideTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 180, () => {
                barHideTimer = 0;
                hideTopBar();
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    return GLib.SOURCE_CONTINUE;
}

function startBarPoller() {
    if (barPollTimer) return;
    barPollTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 90, pollFloatingBar);
}

function stopBarPoller() {
    if (barPollTimer) {
        try { GLib.source_remove(barPollTimer); } catch (e) {}
        barPollTimer = 0;
    }
}

function refreshFloatingBarPoller() {
    let win = getActiveDedicatedBarCandidate();
    if (win) {
        startBarPoller();
    } else {
        hideTopBar();
        stopBarPoller();
    }
}

function applyTargetPresentation(win, useFullscreen) {
    if (!isWindowAlive(win) || !win._macDedicated || win._macDedicated.isExiting) return;
    let targetRect = useFullscreen ? getMonitorRect(win) : getWorkAreaRect(win);
    let postSnapDelay = cfg.settleDelay > 0 ? 70 : 10;

    win.move_resize_frame(false, targetRect.x, targetRect.y, targetRect.width, targetRect.height);

    scheduleTimeout(postSnapDelay, () => {
        if (!isWindowAlive(win) || !win._macDedicated || win._macDedicated.isExiting) return;
        if (useFullscreen) {
            if (!win.is_fullscreen()) win.make_fullscreen();
        } else {
            if (win.get_maximized() !== Meta.MaximizeFlags.BOTH) {
                win.maximize(Meta.MaximizeFlags.BOTH);
            }
        }

        let actor = win.get_compositor_private();
        if (actor) actor.queue_redraw();
        win.activate(global.get_current_time());

        scheduleTimeout(180, () => {
            if (isWindowAlive(win) && win._macDedicated && !win._macDedicated.isExiting) {
                win._macBusy = false;
                refreshFloatingBarPoller();
                logDebug(`entered mode=${useFullscreen ? "fullscreen" : "maximize"} frame=${JSON.stringify(win.get_frame_rect())}`);
            }
        });
    });
}

function enterDedicatedWorkspace(win, wasMaximized) {
    let wsMgr = global.workspace_manager;
    let origWs = win.get_workspace();
    if (!origWs) return;

    let useFullscreen = (cfg.mode === "fullscreen");
    let preDelay = cfg.settleDelay > 0 ? 100 : 15;
    let customTitlebar = hasCustomTitlebar(win);

    let normalRect = null;
    if (win._macNormalRect && !isMatchingWorkAreaOrScreen(win._macNormalRect, win)) {
        normalRect = copyRect(win._macNormalRect);
    } else if (!wasMaximized) {
        let fr = win.get_frame_rect();
        if (fr && !isMatchingWorkAreaOrScreen(fr, win)) {
            normalRect = copyRect(fr);
            win._macNormalRect = copyRect(fr);
        }
    }

    win._macBusy = true;
    win._macDedicated = {
        origWs: origWs,
        wasMaximized: wasMaximized,
        useFullscreen: useFullscreen,
        customTitlebar: customTitlebar,
        normalRect: normalRect,
        isExiting: false,
        timerId: 0
    };

    logDebug(`enter start wasMax=${wasMaximized} mode=${cfg.mode} customBar=${customTitlebar} normalRect=${JSON.stringify(win._macDedicated.normalRect)}`);

    if (win.get_maximized() !== 0) {
        win.unmaximize(Meta.MaximizeFlags.BOTH);
    }

    let t = global.get_current_time();
    let newWs = wsMgr.append_new_workspace(false, t);
    win._macDedicated.dedWs = newWs;
    dedicatedWorkspaces.set(newWs, win);

    let wsName = getWorkspaceTitleForWindow(win);
    win._macDedicated.appName = wsName;
    win._macDedicated.wsName = wsName;
    try {
        Main.setWorkspaceName(newWs.index(), wsName);
        logDebug(`enter: workspace ${newWs.index()} named '${wsName}'`);
    } catch (e) {
        logDebug(`Failed to set workspace name: ${e}`);
    }

    win._macDedicated.wsSignalId = newWs.connect("window-added", (ws, addedWin) => {
        onWindowAddedToDedicated(ws, addedWin, win);
    });

    win._macDedicated.timerId = scheduleTimeout(preDelay, () => {
        if (!isWindowAlive(win) || !win._macDedicated || win._macDedicated.isExiting) return;
        win.change_workspace(newWs);
        newWs.activate(global.get_current_time());
        win.activate(global.get_current_time());

        win._macDedicated.timerId = scheduleTimeout(cfg.settleDelay, () => {
            if (!isWindowAlive(win) || !win._macDedicated || win._macDedicated.isExiting) return;
            applyTargetPresentation(win, useFullscreen);
        });
    });
}

function exitDedicatedWorkspace(win) {
    let data = win._macDedicated;
    if (!data || data.isExiting) return;
    data.isExiting = true;

    if (data.timerId) {
        try { GLib.source_remove(data.timerId); activeTimeouts.delete(data.timerId); } catch (e) {}
        data.timerId = 0;
    }

    if (data.wsSignalId && data.dedWs) {
        try { data.dedWs.disconnect(data.wsSignalId); } catch (e) {}
        data.wsSignalId = 0;
    }

    if (topBarWindow === win) {
        destroyTopBar();
    } else {
        hideTopBar();
    }
    stopBarPoller();

    win._macBusy = true;
    let preDelay = cfg.settleDelay > 0 ? 90 : 15;

    logDebug(`exit start wasMax=${data.wasMaximized} normalRect=${JSON.stringify(data.normalRect)}`);

    let wsMgr = global.workspace_manager;
    let targetWs = data.origWs;
    if (!targetWs || targetWs.index() < 0 || targetWs.index() >= wsMgr.get_n_workspaces()) {
        targetWs = wsMgr.get_workspace_by_index(0);
    }

    win.change_workspace(targetWs);
    targetWs.activate(global.get_current_time());
    win.activate(global.get_current_time());

    if (win.minimized) {
        win.unminimize();
    }
    if (win.is_fullscreen()) {
        win.unmake_fullscreen();
    }

    data.timerId = scheduleTimeout(preDelay, () => {
        if (!isWindowAlive(win)) {
            removeWorkspaceIfEmpty(data.dedWs, targetWs);
            dedicatedWorkspaces.delete(data.dedWs);
            return;
        }

        if (data.wasMaximized) {
            if (win.get_maximized() !== Meta.MaximizeFlags.BOTH) {
                win.maximize(Meta.MaximizeFlags.BOTH);
            }
        } else {
            if (win.get_maximized() !== 0) {
                win.unmaximize(Meta.MaximizeFlags.BOTH);
            }

            let wa = getWorkAreaRect(win);
            let r = data.normalRect;
            let gx, gy, gw, gh;

            if (r && r.width >= 100 && r.height >= 100 && !isMatchingWorkAreaOrScreen(r, win)) {
                gx = Math.max(wa.x, Math.min(r.x, wa.x + wa.width - 50));
                gy = Math.max(wa.y, Math.min(r.y, wa.y + wa.height - 50));
                gw = Math.min(r.width, wa.width);
                gh = Math.min(r.height, wa.height);
            } else {
                gw = Math.min(Math.round(wa.width * 0.75), 1400);
                gh = Math.min(Math.round(wa.height * 0.75), 900);
                gx = wa.x + Math.round((wa.width - gw) / 2);
                gy = wa.y + Math.round((wa.height - gh) / 2);
            }

            win.move_resize_frame(false, gx, gy, gw, gh);
            win.move_frame(false, gx, gy);
            win._macNormalRect = { x: gx, y: gy, width: gw, height: gh };
        }

        let actor = win.get_compositor_private();
        if (actor) actor.queue_redraw();
        win.activate(global.get_current_time());

        removeWorkspaceIfEmpty(data.dedWs, targetWs);
        dedicatedWorkspaces.delete(data.dedWs);

        data.timerId = scheduleTimeout(140, () => {
            if (isWindowAlive(win)) {
                win._macBusy = false;
                win._macDedicated = null;
                updateSavedRects(win);
                refreshFloatingBarPoller();
                logDebug(`exit done frame=${JSON.stringify(win.get_frame_rect())} max=${win.get_maximized()}`);
            }
        });
    });
}

function resyncDedicatedWindow(win) {
    if (!isWindowAlive(win) || !win._macDedicated || win._macBusy || win._macDedicated.isExiting) return;
    let data = win._macDedicated;
    let useFullscreen = data.useFullscreen;
    let preDelay = cfg.settleDelay > 0 ? 80 : 10;
    win._macBusy = true;

    // Do not trust frame_rect alone here. Cinnamon/Muffin can report a frame
    // matching the monitor while the fullscreen surface is still visually
    // displaced or clipped (notably with fractional scaling). Reapply the
    // known-good presentation sequence used by the first version instead.
    logDebug(`resyncing win='${win.get_title()}'`);

    if (win.is_fullscreen()) win.unmake_fullscreen();
    if (win.get_maximized() !== 0) win.unmaximize(Meta.MaximizeFlags.BOTH);

    scheduleTimeout(preDelay, () => {
        if (isWindowAlive(win) && win._macDedicated && !win._macDedicated.isExiting) {
            applyTargetPresentation(win, useFullscreen);
        }
    });
}

function onWorkspaceSwitched() {
    hideTopBar();
    refreshFloatingBarPoller();

    if (!cfg.resyncOnSwitch) return;
    let switchDelay = cfg.settleDelay > 0 ? 160 : 20;
    scheduleTimeout(switchDelay, () => {
        let activeWs = global.workspace_manager.get_active_workspace();
        if (!activeWs || !dedicatedWorkspaces.has(activeWs)) return;
        let dedWin = dedicatedWorkspaces.get(activeWs);
        if (dedWin && isWindowAlive(dedWin) && dedWin._macDedicated && !dedWin._macBusy && !dedWin._macDedicated.isExiting) {
            if (dedWin._macDedicated.dedWs === activeWs && dedWin.get_workspace() === activeWs) {
                resyncDedicatedWindow(dedWin);
            }
        }
        refreshFloatingBarPoller();
    });
}

function onWindowMaximizeChanged(win) {
    if (win._macBusy) return;
    let isFullMax = (win.get_maximized() === Meta.MaximizeFlags.BOTH);

    if (!win._macDedicated) {
        if (isFullMax && !win.is_fullscreen()) {
            let rect = (win._macNormalRect && !isMatchingWorkAreaOrScreen(win._macNormalRect, win))
                ? win._macNormalRect
                : win.get_frame_rect();
            if (isPointerOnMaximizeButton(rect) || isPointerOnMaximizeButton(win.get_frame_rect())) {
                enterDedicatedWorkspace(win, false);
            } else {
                scheduleTimeout(70, () => updateSavedRects(win));
            }
        } else if (!isFullMax && !win.is_fullscreen()) {
            let rect = win._macMaxRect || getWorkAreaRect(win);
            if (isPointerOnMaximizeButton(rect) || isPointerOnMaximizeButton(getWorkAreaRect(win))) {
                enterDedicatedWorkspace(win, true);
            }
        }
    } else if (!win._macDedicated.useFullscreen && !isFullMax && !win.is_fullscreen()) {
        exitDedicatedWorkspace(win);
    }
}

function onWindowMinimizedChanged(win) {
    if (win._macBusy) return;
    if (win._macDedicated && win.minimized) {
        exitDedicatedWorkspace(win);
    }
}

function onWindowFullscreenChanged(win) {
    if (win._macBusy) return;
    if (win._macDedicated && win._macDedicated.useFullscreen && !win.is_fullscreen()) {
        exitDedicatedWorkspace(win);
    }
}

function onWindowUnmanaged(win) {
    if (topBarWindow === win) {
        destroyTopBar();
    }
    let data = win._macDedicated;
    win._macDedicated = null;
    if (data) {
        if (data.wsSignalId && data.dedWs) {
            try { data.dedWs.disconnect(data.wsSignalId); } catch (e) {}
            data.wsSignalId = 0;
        }
        if (data.dedWs) dedicatedWorkspaces.delete(data.dedWs);
        scheduleTimeout(120, () => {
            let wsMgr = global.workspace_manager;
            let targetWs = data.origWs;
            if (!targetWs || targetWs.index() < 0 || targetWs.index() >= wsMgr.get_n_workspaces()) {
                targetWs = wsMgr.get_workspace_by_index(0);
            }
            if (targetWs) targetWs.activate(global.get_current_time());
            removeWorkspaceIfEmpty(data.dedWs, targetWs);
            refreshFloatingBarPoller();
        });
    }
    untrackWindow(win);
}

function onWindowTitleChanged(win) {
    if (!win || !win._macDedicated || win._macDedicated.isExiting) return;
    let dedWs = win._macDedicated.dedWs;
    if (!dedWs) return;

    let newName = getWorkspaceTitleForWindow(win);
    if (newName && newName !== win._macDedicated.wsName) {
        win._macDedicated.wsName = newName;
        win._macDedicated.appName = newName;
        try {
            Main.setWorkspaceName(dedWs.index(), newName);
            logDebug(`workspace ${dedWs.index()} title updated to '${newName}'`);
        } catch (e) {}
    }
}

function trackWindow(win) {
    if (!win || win.window_type !== Meta.WindowType.NORMAL || trackedWindows.has(win)) {
        return;
    }
    
    let ids = [
        win.connect("notify::maximized-horizontally", () => onWindowMaximizeChanged(win)),
        win.connect("notify::minimized", () => onWindowMinimizedChanged(win)),
        win.connect("notify::fullscreen", () => onWindowFullscreenChanged(win)),
        win.connect("notify::title", () => onWindowTitleChanged(win)),
        win.connect("position-changed", () => scheduleRectUpdate(win)),
        win.connect("size-changed", () => scheduleRectUpdate(win)),
        win.connect("unmanaged", () => onWindowUnmanaged(win))
    ];
    trackedWindows.set(win, ids);

    updateSavedRects(win);

    let currentWs = win.get_workspace();
    if (currentWs) {
        let dedWin = getDedicatedWindowForWorkspace(currentWs);
        if (dedWin && dedWin !== win && !isChildOrDialogOf(win, dedWin)) {
            onWindowAddedToDedicated(currentWs, win, dedWin);
        }
    }
}

function untrackWindow(win) {
    if (win && win._macRectTimer) {
        try {
            GLib.source_remove(win._macRectTimer);
            activeTimeouts.delete(win._macRectTimer);
        } catch (e) {}
        win._macRectTimer = 0;
    }
    let ids = trackedWindows.get(win);
    if (!ids) return;
    for (let id of ids) {
        try { win.disconnect(id); } catch (e) {}
    }
    trackedWindows.delete(win);
}

function toggleDedicatedWorkspace() {
    let activeWs = global.workspace_manager.get_active_workspace();
    let dedWin = activeWs ? getDedicatedWindowForWorkspace(activeWs) : null;
    let focusWin = global.display.focus_window;

    if (dedWin) {
        if (!dedWin._macBusy) {
            exitDedicatedWorkspace(dedWin);
        }
        return;
    }

    if (focusWin && focusWin._macDedicated) {
        if (!focusWin._macBusy) {
            exitDedicatedWorkspace(focusWin);
        }
        return;
    }

    if (focusWin && !focusWin.unmanaged && focusWin.window_type === Meta.WindowType.NORMAL) {
        if (!trackedWindows.has(focusWin)) {
            trackWindow(focusWin);
        }
        if (!focusWin._macBusy) {
            let wasMaximized = (focusWin.get_maximized() === Meta.MaximizeFlags.BOTH);
            enterDedicatedWorkspace(focusWin, wasMaximized);
        }
    }
}

function registerHotkeys() {
    try { Main.keybindingManager.removeHotKey(UUID + "-exit"); } catch (e) {}

    let keys = (cfg.exitHotkey || "").split("::").filter(k => k && k.trim());
    if (keys.length > 0) {
        Main.keybindingManager.addHotKey(UUID + "-exit", keys[0], () => {
            toggleDedicatedWorkspace();
        });
    }
}

function init(metadata) {
    extSettings = new Settings.ExtensionSettings(cfg, metadata.uuid);
    extSettings.bind("mode", "mode");
    extSettings.bind("resync-on-switch", "resyncOnSwitch");
    extSettings.bind("floating-topbar", "floatingTopbar", refreshFloatingBarPoller);
    extSettings.bind("floating-topbar-skip-custom", "floatingTopbarSkipCustom", refreshFloatingBarPoller);
    extSettings.bind("settle-delay", "settleDelay");
    extSettings.bind("restore-maximize-delay", "restoreMaximizeDelay");
    extSettings.bind("exit-hotkey", "exitHotkey", registerHotkeys);
    extSettings.bind("enable-logs", "enableLogs");
}

function enable() {
    for (let actor of global.get_window_actors()) {
        let win = actor.get_meta_window();
        if (win) trackWindow(win);
    }

    globalSignals.push({
        obj: global.display,
        id: global.display.connect("window-created", (display, win) => {
            scheduleTimeout(80, () => trackWindow(win));
        })
    });
    globalSignals.push({
        obj: global.window_manager,
        id: global.window_manager.connect("switch-workspace", () => onWorkspaceSwitched())
    });

    registerHotkeys();
    refreshFloatingBarPoller();
    logDebug("Extension enabled");
}

function disable() {
    stopBarPoller();
    destroyTopBar();
    clearAllTimeouts();
    try { Main.keybindingManager.removeHotKey(UUID + "-exit"); } catch (e) {}

    for (let sig of globalSignals) {
        try { sig.obj.disconnect(sig.id); } catch (e) {}
    }
    globalSignals = [];

    for (let [ws, win] of dedicatedWorkspaces.entries()) {
        if (win && win._macDedicated && win._macDedicated.wsSignalId) {
            try { ws.disconnect(win._macDedicated.wsSignalId); } catch (e) {}
            win._macDedicated.wsSignalId = 0;
        }
    }

    for (let win of Array.from(trackedWindows.keys())) {
        if (win._macDedicated) {
            exitDedicatedWorkspace(win);
        }
        untrackWindow(win);
    }
    dedicatedWorkspaces.clear();
}
