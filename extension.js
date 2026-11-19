const Main = imports.ui.main;
const Settings = imports.ui.settings;
const Meta = imports.gi.Meta;
const GLib = imports.gi.GLib;
const Cinnamon = imports.gi.Cinnamon;

const UUID = "cinnamon-fullscreen-to-workspace@arashdayaniii";

let extSettings = null;
var trackedWindows = new Map();
var dedicatedWorkspaces = new Map();
let globalSignals = [];
let activeTimeouts = new Set();

let cfg = {
    resyncOnSwitch: true,
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

    logDebug(`Disallowed window '${addedWin.get_title()}' added to dedicated workspace '${Main.getWorkspaceName(ws.index())}'. Ejecting...`);

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

function applyTargetPresentation(win) {
    if (!isWindowAlive(win) || !win._macDedicated || win._macDedicated.isExiting) return;
    let targetRect = getMonitorRect(win);
    let postSnapDelay = cfg.settleDelay > 0 ? 70 : 10;

    win.move_resize_frame(false, targetRect.x, targetRect.y, targetRect.width, targetRect.height);

    scheduleTimeout(postSnapDelay, () => {
        if (!isWindowAlive(win) || !win._macDedicated || win._macDedicated.isExiting) return;
        if (!win.is_fullscreen()) win.make_fullscreen();

        let actor = win.get_compositor_private();
        if (actor) actor.queue_redraw();
        win.activate(global.get_current_time());

        scheduleTimeout(180, () => {
            if (isWindowAlive(win) && win._macDedicated && !win._macDedicated.isExiting) {
                win._macBusy = false;
                logDebug(`entered fullscreen frame=${JSON.stringify(win.get_frame_rect())}`);
            }
        });
    });
}

function enterDedicatedWorkspace(win, wasMaximized) {
    let wsMgr = global.workspace_manager;
    let origWs = win.get_workspace();
    if (!origWs) return;

    let preDelay = cfg.settleDelay > 0 ? 100 : 15;

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
        normalRect: normalRect,
        isExiting: false,
        timerId: 0
    };

    logDebug(`enter start wasMax=${wasMaximized} normalRect=${JSON.stringify(win._macDedicated.normalRect)}`);

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
            applyTargetPresentation(win);
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
                logDebug(`exit done frame=${JSON.stringify(win.get_frame_rect())} max=${win.get_maximized()}`);
            }
        });
    });
}

function resyncDedicatedWindow(win) {
    if (!isWindowAlive(win) || !win._macDedicated || win._macBusy || win._macDedicated.isExiting) return;
    let preDelay = cfg.settleDelay > 0 ? 80 : 10;
    win._macBusy = true;

    logDebug(`resyncing win='${win.get_title()}'`);

    if (win.is_fullscreen()) win.unmake_fullscreen();
    if (win.get_maximized() !== 0) win.unmaximize(Meta.MaximizeFlags.BOTH);

    scheduleTimeout(preDelay, () => {
        if (isWindowAlive(win) && win._macDedicated && !win._macDedicated.isExiting) {
            applyTargetPresentation(win);
        }
    });
}

function onWorkspaceSwitched() {
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
    });
}

function onWindowMaximizeChanged(win) {
    if (win._macBusy || win._macDedicated) return;
    scheduleTimeout(70, () => updateSavedRects(win));
}

function onWindowMinimizedChanged(win) {
    if (win._macBusy) return;
    if (win._macDedicated && win.minimized) {
        exitDedicatedWorkspace(win);
    }
}

function onWindowFullscreenChanged(win) {
    if (win._macBusy) return;
    if (win._macDedicated && !win.is_fullscreen()) {
        exitDedicatedWorkspace(win);
    }
}

function onWindowUnmanaged(win) {
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
    extSettings.bind("resync-on-switch", "resyncOnSwitch");
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
    logDebug("Extension enabled");
}

function disable() {
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
