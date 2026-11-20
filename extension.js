// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-
/**
 * Cinnamon Fullscreen To Workspace
 * Dual-Workspace Architecture (NORMAL vs APP_SPACE) for Cinnamon 6.0 - 6.6+ on X11
 */

const Main = imports.ui.main;
const Settings = imports.ui.settings;
const Meta = imports.gi.Meta;
const Clutter = imports.gi.Clutter;
const St = imports.gi.St;
const GLib = imports.gi.GLib;
const Cinnamon = imports.gi.Cinnamon;
const DND = imports.ui.dnd;
const ExpoThumbnail = imports.ui.expoThumbnail;
const Panel = imports.ui.panel;

const UUID = "cinnamon-fullscreen-to-workspace@arashdayaniii";

let extSettings = null;
let activeTimeouts = new Set();
let globalSignals = [];

// Dual-Workspace State: Map keyed by Meta.Workspace reference
// Value: { ownerWindow, returnWorkspace, appName, wasMaximized, savedMaximizedFlags, savedFloatingRect, isExiting, wsSignalId }
const appSpaces = new Map();

// Window Tracking: Map keyed by Meta.Window reference -> array of signal connection IDs
const trackedWindows = new Map();

// Edge trigger actors and backups for panel hover reveal
let edgeTriggers = [];
const panelStateBackups = new Map();

// Original prototypes and methods backup for clean restoration on disable
let origExpoThumbnailInit = null;
let origExpoRefreshTitle = null;
let origExpoOnTitleKeyPress = null;
let origExpoHandleDragOver = null;
let origExpoHandleDragOut = null;
let origExpoAcceptDrop = null;
let origExpoRemove = null;
let origGetWorkspaceName = null;
let origHasDefaultWorkspaceName = null;

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
    return win && !win.unmanaged;
}

function copyRect(r) {
    if (!r) return { x: 0, y: 0, width: 800, height: 600 };
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
    return isWindowAlive(win) && win.get_maximized() === 0 && !win.is_fullscreen() && !win.minimized;
}

function updateSavedFloatingRect(win) {
    if (!isWindowAlive(win) || !isNormalState(win)) return;
    let ws = null;
    try { ws = win.get_workspace(); } catch (e) {}
    if (ws && appSpaces.has(ws)) return;

    let fr = win.get_frame_rect();
    if (fr && fr.width > 100 && fr.height > 100) {
        win._savedFloatingRect = copyRect(fr);
    }
}

function getCleanAppName(win) {
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

function isAppSpace(ws) {
    return ws ? appSpaces.has(ws) : false;
}

function getOwnerWindowForWorkspace(ws) {
    if (!ws || !appSpaces.has(ws)) return null;
    let data = appSpaces.get(ws);
    return (data && isWindowAlive(data.ownerWindow)) ? data.ownerWindow : null;
}

function isOwnerInAppSpace(win) {
    if (!isWindowAlive(win)) return false;
    for (let data of appSpaces.values()) {
        if (data.ownerWindow === win && !data.isExiting) return true;
    }
    return false;
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

function getNearestNormalWorkspace(preferredWs) {
    let wsMgr = global.workspace_manager;
    let n = wsMgr.get_n_workspaces();

    if (preferredWs && !appSpaces.has(preferredWs)) {
        let idx = -1;
        try { idx = preferredWs.index(); } catch (e) {}
        if (idx >= 0 && idx < n && wsMgr.get_workspace_by_index(idx) === preferredWs) {
            return preferredWs;
        }
    }

    let centerIdx = (preferredWs && preferredWs.index() >= 0 && preferredWs.index() < n) ?
        preferredWs.index() :
        wsMgr.get_active_workspace_index();

    for (let dist = 1; dist < n; dist++) {
        let left = centerIdx - dist;
        if (left >= 0) {
            let ws = wsMgr.get_workspace_by_index(left);
            if (ws && !appSpaces.has(ws)) return ws;
        }
        let right = centerIdx + dist;
        if (right < n) {
            let ws = wsMgr.get_workspace_by_index(right);
            if (ws && !appSpaces.has(ws)) return ws;
        }
    }

    if (centerIdx >= 0 && centerIdx < n) {
        let ws = wsMgr.get_workspace_by_index(centerIdx);
        if (ws && !appSpaces.has(ws)) return ws;
    }

    // Guarantee that at least one NORMAL workspace always exists
    let newWs = wsMgr.append_new_workspace(false, global.get_current_time());
    return newWs;
}

function verifyFullscreen(win) {
    if (!isWindowAlive(win)) return;
    let mon = getMonitorRect(win);
    let fr = win.get_frame_rect();

    if (!win.is_fullscreen()) {
        win.make_fullscreen();
    }

    if (fr && (fr.x !== mon.x || fr.y !== mon.y || fr.width < mon.width || fr.height < mon.height)) {
        win.move_resize_frame(false, mon.x, mon.y, mon.width, mon.height);
        if (!win.is_fullscreen()) {
            win.make_fullscreen();
        }
    }

    let actor = win.get_compositor_private();
    if (actor) actor.queue_redraw();
    win.activate(global.get_current_time());
}

function enterAppSpace(win) {
    if (!isWindowAlive(win) || win.window_type !== Meta.WindowType.NORMAL) return;

    let origWs = win.get_workspace();
    if (!origWs) return;

    let wasMaximized = (win.get_maximized() !== 0);
    let savedMaximizedFlags = win.get_maximized();
    let floatingRect = null;

    if (!wasMaximized) {
        let fr = win.get_frame_rect();
        if (fr && fr.width > 100 && fr.height > 100) {
            floatingRect = copyRect(fr);
            win._savedFloatingRect = copyRect(fr);
        }
    } else if (win._savedFloatingRect) {
        floatingRect = copyRect(win._savedFloatingRect);
    } else {
        let wa = getWorkAreaRect(win);
        let gw = Math.min(Math.round(wa.width * 0.75), 1400);
        let gh = Math.min(Math.round(wa.height * 0.75), 900);
        floatingRect = {
            x: wa.x + Math.round((wa.width - gw) / 2),
            y: wa.y + Math.round((wa.height - gh) / 2),
            width: gw,
            height: gh
        };
    }

    // Do NOT unmaximize beforehand: Muffin and EWMH transition directly from maximized to fullscreen
    // without triggering an intermediate floating resize and client size-negotiation race!

    let wsMgr = global.workspace_manager;
    let activeIdx = origWs.index();
    let newWs = wsMgr.append_new_workspace(false, global.get_current_time());
    wsMgr.reorder_workspace(newWs, activeIdx + 1);

    let appName = getCleanAppName(win);

    let appData = {
        ownerWindow: win,
        returnWorkspace: origWs,
        appName: appName,
        wasMaximized: wasMaximized,
        savedMaximizedFlags: savedMaximizedFlags,
        savedFloatingRect: floatingRect,
        isExiting: false,
        wsSignalId: 0
    };

    // Register in appSpaces before moving the window
    appSpaces.set(newWs, appData);

    try {
        Main.setWorkspaceName(newWs.index(), appName);
    } catch (e) {
        logDebug(`Failed to set workspace name: ${e}`);
    }

    appData.wsSignalId = newWs.connect('window-added', (ws, addedWin) => {
        onWindowAddedToAppSpace(ws, addedWin);
    });

    win.change_workspace(newWs);
    newWs.activate(global.get_current_time());
    win.activate(global.get_current_time());

    // Once on the new workspace, enforce fullscreen cleanly
    scheduleTimeout(30, () => {
        if (!isWindowAlive(win) || appData.isExiting) return;
        win.make_fullscreen();
        verifyFullscreen(win);
    });

    // Multi-pass verification to eliminate Terminal PResizeInc and Electron CSD gaps
    scheduleTimeout(90, () => {
        if (!isWindowAlive(win) || appData.isExiting) return;
        verifyFullscreen(win);
    });
    scheduleTimeout(200, () => {
        if (!isWindowAlive(win) || appData.isExiting) return;
        verifyFullscreen(win);
    });

    logDebug(`Entered App Space for '${appName}' on workspace index ${newWs.index()}`);
}

function exitAppSpace(win) {
    if (!win) return;

    let targetWsEntry = null;
    for (let [ws, data] of appSpaces.entries()) {
        if (data.ownerWindow === win) {
            targetWsEntry = [ws, data];
            break;
        }
    }
    if (!targetWsEntry) return;

    let [appWs, data] = targetWsEntry;
    if (data.isExiting) return;
    data.isExiting = true;

    if (data.wsSignalId && appWs) {
        try { appWs.disconnect(data.wsSignalId); } catch (e) {}
        data.wsSignalId = 0;
    }

    let targetWs = getNearestNormalWorkspace(data.returnWorkspace);

    if (isWindowAlive(win)) {
        // 1. Move to returnWorkspace and activate it FIRST so panels & workarea are active on targetWs
        win.change_workspace(targetWs);
        targetWs.activate(global.get_current_time());
        win.activate(global.get_current_time());

        // 2. Call unmake_fullscreen
        if (win.is_fullscreen()) {
            win.unmake_fullscreen();
        }

        // 3. Settle tick for Muffin to finish un-fullscreening and recalculate workarea
        scheduleTimeout(50, () => {
            if (!isWindowAlive(win)) return;

            if (data.wasMaximized) {
                // Restore maximized state directly without move_resize_frame
                win.maximize(data.savedMaximizedFlags || Meta.MaximizeFlags.BOTH);
            } else {
                win.unmaximize(Meta.MaximizeFlags.BOTH);
                let wa = getWorkAreaRect(win);
                let r = data.savedFloatingRect || { width: 900, height: 600, x: wa.x + 50, y: wa.y + 50 };
                let gx = Math.max(wa.x, Math.min(r.x, wa.x + wa.width - 50));
                let gy = Math.max(wa.y, Math.min(r.y, wa.y + wa.height - 50));
                let gw = Math.min(r.width, wa.width);
                let gh = Math.min(r.height, wa.height);
                win.move_resize_frame(false, gx, gy, gw, gh);
                win._savedFloatingRect = { x: gx, y: gy, width: gw, height: gh };
            }

            let actor = win.get_compositor_private();
            if (actor) actor.queue_redraw();
            win.activate(global.get_current_time());
        });
    }

    appSpaces.delete(appWs);

    // Remove the App Space workspace after the window has returned and settled
    scheduleTimeout(100, () => {
        try {
            if (typeof Main._removeWorkspace === "function") {
                Main._removeWorkspace(appWs);
            } else {
                Main.setWorkspaceName(appWs.index(), "");
                global.workspace_manager.remove_workspace(appWs, global.get_current_time());
            }
        } catch (e) {
            try { global.workspace_manager.remove_workspace(appWs, global.get_current_time()); } catch (err) {}
        }
    });

    logDebug(`Exited App Space for '${data.appName}', returned to workspace ${targetWs.index()}`);
}

function toggleDedicatedWorkspace() {
    let activeWs = global.workspace_manager.get_active_workspace();
    let ownerWin = activeWs ? getOwnerWindowForWorkspace(activeWs) : null;
    let focusWin = global.display.focus_window;

    if (ownerWin) {
        exitAppSpace(ownerWin);
        return;
    }

    if (focusWin && isOwnerInAppSpace(focusWin)) {
        exitAppSpace(focusWin);
        return;
    }

    if (focusWin && isWindowAlive(focusWin) && focusWin.window_type === Meta.WindowType.NORMAL) {
        if (!trackedWindows.has(focusWin)) {
            trackWindow(focusWin);
        }
        enterAppSpace(focusWin);
    }
}

function handleNewWindowIsolation(win) {
    if (!isWindowAlive(win) || win.window_type !== Meta.WindowType.NORMAL) return;

    let activeWs = global.workspace_manager.get_active_workspace();
    if (!activeWs || !appSpaces.has(activeWs)) return;

    let data = appSpaces.get(activeWs);
    let ownerWin = data.ownerWindow;

    if (win === ownerWin || isChildOrDialogOf(win, ownerWin)) return;

    logDebug(`Strict Isolation: unrelated window '${win.get_title()}' created in App Space. Routing to normal workspace.`);

    let targetWs = getNearestNormalWorkspace(data.returnWorkspace || activeWs);
    win.change_workspace(targetWs);
    targetWs.activate(global.get_current_time());
    scheduleTimeout(40, () => {
        try {
            if (isWindowAlive(win)) win.activate(global.get_current_time());
        } catch (e) {}
    });
}

function onWindowAddedToAppSpace(ws, win) {
    if (!ws || !win || win.unmanaged) return;
    if (!appSpaces.has(ws)) return;

    let data = appSpaces.get(ws);
    let ownerWin = data.ownerWindow;

    if (win === ownerWin || isChildOrDialogOf(win, ownerWin)) return;

    if (win.is_on_all_workspaces()) {
        try { win.unstick(); } catch (e) {}
    }

    scheduleTimeout(20, () => {
        if (!isWindowAlive(win)) return;
        let curWs = null;
        try { curWs = win.get_workspace(); } catch (e) {}
        if (curWs !== ws) return;

        let targetWs = getNearestNormalWorkspace(data.returnWorkspace || ws);
        win.change_workspace(targetWs);

        if (global.workspace_manager.get_active_workspace() === ws) {
            targetWs.activate(global.get_current_time());
            scheduleTimeout(40, () => {
                try {
                    if (isWindowAlive(win)) win.activate(global.get_current_time());
                } catch (e) {}
            });
        }
    });
}

function onWindowMinimized(win) {
    if (!isWindowAlive(win)) return;
    let ws = null;
    try { ws = win.get_workspace(); } catch (e) {}
    if (ws && appSpaces.has(ws)) {
        let data = appSpaces.get(ws);
        if (data && data.ownerWindow === win && win.minimized) {
            logDebug(`Prevented minimizing owner window '${win.get_title()}' in App Space.`);
            win.unminimize();
        }
    }
}

function onWindowFullscreenChanged(win) {
    if (!isWindowAlive(win)) return;
    let ws = null;
    try { ws = win.get_workspace(); } catch (e) {}
    if (ws && appSpaces.has(ws)) {
        let data = appSpaces.get(ws);
        if (data && data.ownerWindow === win && !data.isExiting && !win.is_fullscreen()) {
            logDebug(`Owner window '${win.get_title()}' un-fullscreened externally (F11). Exiting App Space.`);
            exitAppSpace(win);
        }
    }
}

function onWindowUnmanaged(win) {
    for (let [ws, data] of Array.from(appSpaces.entries())) {
        if (data.ownerWindow === win) {
            logDebug(`Owner window '${data.appName}' closed. Cleaning up App Space.`);
            appSpaces.delete(ws);
            let targetWs = getNearestNormalWorkspace(data.returnWorkspace);
            if (targetWs) targetWs.activate(global.get_current_time());
            scheduleTimeout(40, () => {
                try {
                    Main._removeWorkspace(ws);
                } catch (e) {
                    try { global.workspace_manager.remove_workspace(ws, global.get_current_time()); } catch (err) {}
                }
            });
            break;
        }
    }
    untrackWindow(win);
}

function trackWindow(win) {
    if (!win || win.window_type !== Meta.WindowType.NORMAL || trackedWindows.has(win)) {
        return;
    }

    let ids = [
        win.connect("notify::minimized", () => onWindowMinimized(win)),
        win.connect("notify::fullscreen", () => onWindowFullscreenChanged(win)),
        win.connect("position-changed", () => updateSavedFloatingRect(win)),
        win.connect("size-changed", () => updateSavedFloatingRect(win)),
        win.connect("unmanaged", () => onWindowUnmanaged(win))
    ];
    trackedWindows.set(win, ids);

    updateSavedFloatingRect(win);

    let curWs = null;
    try { curWs = win.get_workspace(); } catch (e) {}
    if (curWs && appSpaces.has(curWs)) {
        onWindowAddedToAppSpace(curWs, win);
    }
}

function untrackWindow(win) {
    let ids = trackedWindows.get(win);
    if (!ids) return;
    for (let id of ids) {
        try { win.disconnect(id); } catch (e) {}
    }
    trackedWindows.delete(win);
}

// ==========================================
// EDGE-HOVER PANEL REVEAL (Auto-Show / Hide)
// ==========================================

function tearDownEdgeTriggers() {
    for (let item of edgeTriggers) {
        if (item.dwellTimer) {
            try { GLib.source_remove(item.dwellTimer); } catch (e) {}
        }
        for (let sigId of item.signals) {
            try { item.trigger.disconnect(sigId); } catch (e) {}
        }
        try { Main.layoutManager.removeChrome(item.trigger); } catch (e) {}
        try { item.trigger.destroy(); } catch (e) {}
    }
    edgeTriggers = [];

    for (let [panel, backup] of panelStateBackups.entries()) {
        try {
            if (panel && !panel._destroyed && panel.actor) {
                panel._appSpaceRevealed = false;
                Main.layoutManager._chrome.modifyActorParams(panel.actor, {
                    visibleInFullscreen: backup.visibleInFullscreen,
                    affectsStruts: backup.affectsStruts
                });
                panel._processPanelAutoHide();
                Main.layoutManager._chrome._updateVisibility();
            }
        } catch (e) {}
    }
    panelStateBackups.clear();
}

function setupEdgeTriggers() {
    tearDownEdgeTriggers();

    if (!Main.panelManager || !Main.panelManager.panels) return;

    for (let panel of Main.panelManager.panels) {
        if (!panel || panel._destroyed || !panel.actor) continue;

        let monIdx = panel.monitorIndex;
        let mon = global.display.get_monitor_geometry(monIdx);
        if (!mon || mon.width <= 0 || mon.height <= 0) continue;

        if (!panelStateBackups.has(panel)) {
            panelStateBackups.set(panel, {
                visibleInFullscreen: false,
                affectsStruts: panel._autohideSettings === "false"
            });
        }

        let edgeThickness = 3;
        let tx = mon.x, ty = mon.y, tw = mon.width, th = mon.height;
        let pos = panel.panelPosition;

        if (pos === Panel.PanelLoc.top) {
            tx = mon.x; ty = mon.y; tw = mon.width; th = edgeThickness;
        } else if (pos === Panel.PanelLoc.bottom) {
            tx = mon.x; ty = mon.y + mon.height - edgeThickness; tw = mon.width; th = edgeThickness;
        } else if (pos === Panel.PanelLoc.left) {
            tx = mon.x; ty = mon.y; tw = edgeThickness; th = mon.height;
        } else if (pos === Panel.PanelLoc.right) {
            tx = mon.x + mon.width - edgeThickness; ty = mon.y; tw = edgeThickness; th = mon.height;
        }

        let trigger = new St.Widget({
            reactive: true,
            track_hover: true,
            important: true,
            style: "background-color: transparent;"
        });
        trigger.set_position(tx, ty);
        trigger.set_size(tw, th);

        Main.layoutManager.addChrome(trigger, {
            visibleInFullscreen: true,
            affectsInputRegion: true,
            affectsStruts: false
        });

        let triggerData = {
            trigger: trigger,
            panel: panel,
            dwellTimer: 0,
            signals: []
        };

        triggerData.signals.push(trigger.connect('enter-event', () => onTriggerEnter(triggerData)));
        triggerData.signals.push(trigger.connect('leave-event', () => onTriggerLeave(triggerData)));

        edgeTriggers.push(triggerData);
    }
}

function onTriggerEnter(data) {
    let activeWs = global.workspace_manager.get_active_workspace();
    if (!activeWs || !appSpaces.has(activeWs)) return;

    if (data.panel._appSpaceRevealed) return;

    if (data.dwellTimer) {
        try { GLib.source_remove(data.dwellTimer); } catch (e) {}
    }

    data.dwellTimer = scheduleTimeout(220, () => {
        data.dwellTimer = 0;
        revealAppSpacePanel(data);
    });
}

function onTriggerLeave(data) {
    if (data.dwellTimer) {
        try { GLib.source_remove(data.dwellTimer); } catch (e) {}
        data.dwellTimer = 0;
    }
}

function revealAppSpacePanel(data) {
    let panel = data.panel;
    if (!panel || panel._destroyed || !panel.actor) return;

    let activeWs = global.workspace_manager.get_active_workspace();
    if (!activeWs || !appSpaces.has(activeWs)) return;

    panel._appSpaceRevealed = true;

    Main.layoutManager._chrome.modifyActorParams(panel.actor, {
        visibleInFullscreen: true,
        affectsStruts: false
    });
    Main.layoutManager._chrome._updateVisibility();
    Main.uiGroup.set_child_above_sibling(panel.actor, null);

    if (typeof panel._showPanel === "function") {
        panel._showPanel();
    }

    startPanelLeaveWatcher(data);
}

function startPanelLeaveWatcher(data) {
    let panel = data.panel;
    if (!panel || !panel.actor) return;

    function checkAndHide() {
        if (!panel._appSpaceRevealed) return;

        let activeWs = global.workspace_manager.get_active_workspace();
        if (!activeWs || !appSpaces.has(activeWs)) {
            hideAppSpacePanel(data, true);
            return;
        }

        let mouseOnPanel = false;
        try { mouseOnPanel = panel._mouseOnPanel(); } catch (e) {}
        if (mouseOnPanel) return;

        let hasMenus = false;
        try {
            if (typeof panel._panelHasOpenMenus === "function") {
                hasMenus = panel._panelHasOpenMenus();
            }
        } catch (e) {}
        if (!hasMenus && global.menuStack && global.menuStack.length > 0) {
            hasMenus = global.menuStack.some(m => m && m.isOpen);
        }
        if (hasMenus) return;

        // Mouse left panel and no menus open: hide immediately (snappy response)
        hideAppSpacePanel(data, false);
    }

    // Connect leave-event on panel actor for immediate trigger with 40ms debounce
    let leaveId = panel.actor.connect('leave-event', () => {
        scheduleTimeout(40, checkAndHide);
    });

    // Check with fast 40ms polling interval while revealed to catch menu closes
    let pollInterval = 40;
    scheduleTimeout(pollInterval, function poll() {
        if (!panel._appSpaceRevealed) {
            try { panel.actor.disconnect(leaveId); } catch (e) {}
            return;
        }
        checkAndHide();
        if (panel._appSpaceRevealed) {
            scheduleTimeout(pollInterval, poll);
        } else {
            try { panel.actor.disconnect(leaveId); } catch (e) {}
        }
    });
}

function hideAppSpacePanel(data, immediate) {
    let panel = data.panel;
    if (!panel || panel._destroyed || !panel.actor) return;
    if (!panel._appSpaceRevealed) return;

    panel._appSpaceRevealed = false;

    if (typeof panel._hidePanel === "function") {
        panel._hidePanel();
    }

    let delay = immediate ? 0 : 260;
    scheduleTimeout(delay, () => {
        try {
            if (!panel._appSpaceRevealed) {
                Main.layoutManager._chrome.modifyActorParams(panel.actor, {
                    visibleInFullscreen: false,
                    affectsStruts: false
                });
                Main.layoutManager._chrome._updateVisibility();
            }
        } catch (e) {}
    });
}

function onWorkspaceSwitched() {
    let activeWs = global.workspace_manager.get_active_workspace();
    let isApp = activeWs && appSpaces.has(activeWs);

    if (!isApp) {
        for (let data of edgeTriggers) {
            if (data.panel && data.panel._appSpaceRevealed) {
                hideAppSpacePanel(data, true);
            }
            let backup = panelStateBackups.get(data.panel);
            if (backup && data.panel && data.panel.actor) {
                Main.layoutManager._chrome.modifyActorParams(data.panel.actor, {
                    visibleInFullscreen: backup.visibleInFullscreen,
                    affectsStruts: backup.affectsStruts
                });
                data.panel._processPanelAutoHide();
            }
        }
        Main.layoutManager._chrome._updateVisibility();
    } else {
        let data = appSpaces.get(activeWs);
        if (data && data.ownerWindow && cfg.resyncOnSwitch) {
            scheduleTimeout(cfg.settleDelay, () => {
                verifyFullscreen(data.ownerWindow);
            });
        }
    }
}

// ==========================================
// EXPO & WORKSPACE REORDERING DND
// ==========================================

function clearAllDropTargets() {
    if (Main.expo && Main.expo._thumbnailsBox && Main.expo._thumbnailsBox.thumbnails) {
        for (let th of Main.expo._thumbnailsBox.thumbnails) {
            if (th && th.frame) {
                th.frame.remove_style_class_name('expo-workspace-drop-target');
            }
        }
    }
}

function syncExpoThumbnails() {
    if (Main.expo && Main.expo._thumbnailsBox && Main.expo._thumbnailsBox.thumbnails) {
        let box = Main.expo._thumbnailsBox;
        box.thumbnails.sort((a, b) => a.metaWorkspace.index() - b.metaWorkspace.index());
        box.kbThumbnailIndex = global.workspace_manager.get_active_workspace_index();
        box.thumbnails.forEach(th => th.refreshTitle());
        box.actor.queue_relayout();
    }
}

function reorderWorkspace(ws, targetIndex) {
    if (!ws) return;
    let wsMgr = global.workspace_manager;
    let fromIndex = ws.index();
    if (fromIndex === targetIndex || targetIndex < 0 || targetIndex >= wsMgr.n_workspaces) return;

    let names = Main.workspace_names.slice();
    while (names.length < wsMgr.n_workspaces) {
        names.push("");
    }
    let [movedName] = names.splice(fromIndex, 1);
    names.splice(targetIndex, 0, movedName || "");
    Main.workspace_names = names;
    Main._trimWorkspaceNames();
    Main.wmSettings.set_strv("workspace-names", Main.workspace_names);

    wsMgr.reorder_workspace(ws, targetIndex);
    syncExpoThumbnails();
}

function setupThumbnailDND(thumbnail) {
    if (!thumbnail || thumbnail._customDndInitialized) return;
    thumbnail._customDndInitialized = true;

    thumbnail.isWorkspaceCard = true;
    thumbnail.actor._delegate = thumbnail;
    thumbnail.frame._delegate = thumbnail;
    thumbnail.title._delegate = thumbnail;

    thumbnail.getDragActor = function() {
        let ws = this.metaWorkspace;
        let wsName = isAppSpace(ws) ?
            appSpaces.get(ws).appName :
            Main.getWorkspaceName(ws.index());

        let box = new St.BoxLayout({
            style_class: 'expo-workspace-drag-actor',
            vertical: true
        });
        let label = new St.Label({
            style_class: 'expo-workspace-drag-label',
            text: wsName
        });
        box.add_actor(label);
        return box;
    };

    thumbnail.getDragActorSource = function() {
        return this.actor;
    };

    // Use manualMode: true so DND does not connect button-press-event itself
    thumbnail._actorDraggable = DND.makeDraggable(thumbnail.actor, {
        restoreOnSuccess: false,
        manualMode: true
    });
    thumbnail._actorDraggable.connect('drag-end', clearAllDropTargets);
    thumbnail._actorDraggable.connect('drag-cancelled', clearAllDropTargets);

    thumbnail._titleDraggable = DND.makeDraggable(thumbnail.title, {
        restoreOnSuccess: false,
        manualMode: true
    });
    thumbnail._titleDraggable.connect('drag-end', clearAllDropTargets);
    thumbnail._titleDraggable.connect('drag-cancelled', clearAllDropTargets);

    // Captured event on thumbnail.actor: runs in capture phase BEFORE the stock button-press-event
    thumbnail._capturedId = thumbnail.actor.connect('captured-event', (actor, event) => {
        if (event.type() === Clutter.EventType.BUTTON_PRESS && event.get_button() === 1) {
            let isApp = isAppSpace(thumbnail.metaWorkspace);

            // On NORMAL workspaces, allow window clones to receive their own DND press!
            if (!isApp) {
                let source = event.get_source();
                let isClone = false;
                let a = source;
                while (a && a !== thumbnail.actor) {
                    if (a._delegate && a._delegate instanceof ExpoThumbnail.ExpoWindowClone) {
                        isClone = true;
                        break;
                    }
                    a = a.get_parent();
                }
                if (isClone) {
                    return false;
                }
            }

            // For card drags (all APP_SPACE clicks, or empty card clicks on NORMAL workspaces)
            if (thumbnail._actorDraggable) {
                thumbnail._actorDraggable._onButtonPress(actor, event);
            }
        }
        return false;
    });

    // Captured event on thumbnail.title for dragging workspace from title header
    thumbnail._titleCapturedId = thumbnail.title.connect('captured-event', (actor, event) => {
        if (event.type() === Clutter.EventType.BUTTON_PRESS && event.get_button() === 1) {
            if (thumbnail._titleDraggable) {
                thumbnail._titleDraggable._onButtonPress(actor, event);
            }
        }
        return false;
    });
}

function cleanUpThumbnailDND(thumbnail) {
    if (!thumbnail) return;
    if (thumbnail._capturedId && thumbnail.actor) {
        try { thumbnail.actor.disconnect(thumbnail._capturedId); } catch (e) {}
        thumbnail._capturedId = 0;
    }
    if (thumbnail._titleCapturedId && thumbnail.title) {
        try { thumbnail.title.disconnect(thumbnail._titleCapturedId); } catch (e) {}
        thumbnail._titleCapturedId = 0;
    }
    if (thumbnail._actorDraggable) {
        try { thumbnail._actorDraggable.disconnectAll(); } catch (e) {}
        delete thumbnail._actorDraggable;
    }
    if (thumbnail._titleDraggable) {
        try { thumbnail._titleDraggable.disconnectAll(); } catch (e) {}
        delete thumbnail._titleDraggable;
    }
    delete thumbnail._customDndInitialized;
    delete thumbnail.isWorkspaceCard;
}

// ==========================================
// KEYBINDINGS & LIFECYCLE
// ==========================================

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
    // 1. Hook Expo Workspace Thumbnail prototype methods
    origExpoThumbnailInit = ExpoThumbnail.ExpoWorkspaceThumbnail.prototype._init;
    ExpoThumbnail.ExpoWorkspaceThumbnail.prototype._init = function(metaWorkspace, box) {
        // ALWAYS run origExpoThumbnailInit FIRST so this.actor, this.frame, this.title, etc. exist!
        origExpoThumbnailInit.apply(this, arguments);
        setupThumbnailDND(this);
    };

    origExpoRefreshTitle = ExpoThumbnail.ExpoWorkspaceThumbnail.prototype.refreshTitle;
    ExpoThumbnail.ExpoWorkspaceThumbnail.prototype.refreshTitle = function() {
        origExpoRefreshTitle.apply(this, arguments);
        if (isAppSpace(this.metaWorkspace)) {
            let data = appSpaces.get(this.metaWorkspace);
            if (data && data.appName) {
                this.title.set_text(data.appName);
            }
            this.frame.add_style_class_name('app-space-card');
            if (this.titleText) this.titleText.editable = false;
            // On App Space: inhibit window clone DND so dragging anywhere on the card drags the workspace card!
            if (this.windows) {
                for (let clone of this.windows) {
                    if (clone._draggable) clone._draggable.inhibit = true;
                }
            }
        } else {
            this.frame.remove_style_class_name('app-space-card');
            if (this.titleText) this.titleText.editable = true;
            // On Normal workspace: window clone DND is active for moving windows between workspaces!
            if (this.windows) {
                for (let clone of this.windows) {
                    if (clone._draggable) clone._draggable.inhibit = false;
                }
            }
        }
    };

    origExpoOnTitleKeyPress = ExpoThumbnail.ExpoWorkspaceThumbnail.prototype.onTitleKeyPressEvent;
    ExpoThumbnail.ExpoWorkspaceThumbnail.prototype.onTitleKeyPressEvent = function(actor, event) {
        if (isAppSpace(this.metaWorkspace)) return true;
        return origExpoOnTitleKeyPress.apply(this, arguments);
    };

    origExpoHandleDragOver = ExpoThumbnail.ExpoWorkspaceThumbnail.prototype.handleDragOver;
    ExpoThumbnail.ExpoWorkspaceThumbnail.prototype.handleDragOver = function(source, actor, x, y, time) {
        if (source && source.isWorkspaceCard) {
            if (source === this || source.metaWorkspace === this.metaWorkspace) {
                return DND.DragMotionResult.CONTINUE;
            }
            if (this.frame) {
                this.frame.add_style_class_name('expo-workspace-drop-target');
            }
            return DND.DragMotionResult.MOVE_DROP;
        }

        // Block dropping unrelated windows onto an App Space
        if (source && source.metaWindow && isAppSpace(this.metaWorkspace)) {
            let ownerWin = getOwnerWindowForWorkspace(this.metaWorkspace);
            if (source.metaWindow !== ownerWin && !isChildOrDialogOf(source.metaWindow, ownerWin)) {
                return DND.DragMotionResult.CONTINUE;
            }
        }

        return origExpoHandleDragOver.apply(this, arguments);
    };

    origExpoHandleDragOut = ExpoThumbnail.ExpoWorkspaceThumbnail.prototype.handleDragOut;
    ExpoThumbnail.ExpoWorkspaceThumbnail.prototype.handleDragOut = function(source, actor) {
        if (this.frame) {
            this.frame.remove_style_class_name('expo-workspace-drop-target');
        }
        if (origExpoHandleDragOut) {
            origExpoHandleDragOut.apply(this, arguments);
        }
    };

    origExpoAcceptDrop = ExpoThumbnail.ExpoWorkspaceThumbnail.prototype.acceptDrop;
    ExpoThumbnail.ExpoWorkspaceThumbnail.prototype.acceptDrop = function(source, actor, x, y, time) {
        if (source && source.isWorkspaceCard) {
            clearAllDropTargets();
            if (source === this || source.metaWorkspace === this.metaWorkspace) {
                return false;
            }
            let fromIndex = source.metaWorkspace.index();
            let toIndex = this.metaWorkspace.index();
            logDebug(`Expo DND Drop: reordering workspace ${fromIndex} -> ${toIndex}`);
            reorderWorkspace(source.metaWorkspace, toIndex);
            return true;
        }

        return origExpoAcceptDrop.apply(this, arguments);
    };

    origExpoRemove = ExpoThumbnail.ExpoWorkspaceThumbnail.prototype.remove;
    ExpoThumbnail.ExpoWorkspaceThumbnail.prototype.remove = function() {
        if (isAppSpace(this.metaWorkspace)) {
            let ownerWin = getOwnerWindowForWorkspace(this.metaWorkspace);
            if (ownerWin) {
                exitAppSpace(ownerWin);
                return;
            }
        }
        return origExpoRemove.apply(this, arguments);
    };

    // 2. Hook Main workspace name functions
    origGetWorkspaceName = Main.getWorkspaceName;
    Main.getWorkspaceName = function(index) {
        let ws = global.workspace_manager.get_workspace_by_index(index);
        if (ws && appSpaces.has(ws)) {
            return appSpaces.get(ws).appName;
        }
        return origGetWorkspaceName.call(Main, index);
    };

    origHasDefaultWorkspaceName = Main.hasDefaultWorkspaceName;
    Main.hasDefaultWorkspaceName = function(index) {
        let ws = global.workspace_manager.get_workspace_by_index(index);
        if (ws && appSpaces.has(ws)) {
            return false;
        }
        return origHasDefaultWorkspaceName.call(Main, index);
    };

    // Setup existing thumbnails if Expo is currently open
    if (Main.expo && Main.expo._thumbnailsBox && Main.expo._thumbnailsBox.thumbnails) {
        for (let th of Main.expo._thumbnailsBox.thumbnails) {
            setupThumbnailDND(th);
            th.refreshTitle();
        }
    }

    // 3. Track existing windows
    for (let actor of global.get_window_actors()) {
        let win = actor.get_meta_window();
        if (win) trackWindow(win);
    }

    // 4. Connect global signals
    globalSignals.push({
        obj: global.display,
        id: global.display.connect('window-created', (display, win) => {
            scheduleTimeout(50, () => {
                if (win && !win.unmanaged) {
                    trackWindow(win);
                    handleNewWindowIsolation(win);
                }
            });
        })
    });

    globalSignals.push({
        obj: global.window_manager,
        id: global.window_manager.connect('switch-workspace', () => {
            onWorkspaceSwitched();
        })
    });

    globalSignals.push({
        obj: global.workspace_manager,
        id: global.workspace_manager.connect('workspaces-reordered', () => {
            syncExpoThumbnails();
        })
    });

    globalSignals.push({
        obj: Main.layoutManager,
        id: Main.layoutManager.connect('monitors-changed', () => {
            setupEdgeTriggers();
        })
    });

    // 5. Setup panel edge triggers
    setupEdgeTriggers();

    // 6. Register hotkey
    registerHotkeys();

    logDebug("Extension 2.0.2 enabled successfully");
}

function disable() {
    clearAllTimeouts();

    try { Main.keybindingManager.removeHotKey(UUID + "-exit"); } catch (e) {}

    for (let sig of globalSignals) {
        try { sig.obj.disconnect(sig.id); } catch (e) {}
    }
    globalSignals = [];

    tearDownEdgeTriggers();

    // Restore patched prototypes
    if (origExpoThumbnailInit) ExpoThumbnail.ExpoWorkspaceThumbnail.prototype._init = origExpoThumbnailInit;
    if (origExpoRefreshTitle) ExpoThumbnail.ExpoWorkspaceThumbnail.prototype.refreshTitle = origExpoRefreshTitle;
    if (origExpoOnTitleKeyPress) ExpoThumbnail.ExpoWorkspaceThumbnail.prototype.onTitleKeyPressEvent = origExpoOnTitleKeyPress;
    if (origExpoHandleDragOver) ExpoThumbnail.ExpoWorkspaceThumbnail.prototype.handleDragOver = origExpoHandleDragOver;
    if (origExpoHandleDragOut) ExpoThumbnail.ExpoWorkspaceThumbnail.prototype.handleDragOut = origExpoHandleDragOut;
    if (origExpoAcceptDrop) ExpoThumbnail.ExpoWorkspaceThumbnail.prototype.acceptDrop = origExpoAcceptDrop;
    if (origExpoRemove) ExpoThumbnail.ExpoWorkspaceThumbnail.prototype.remove = origExpoRemove;

    if (origGetWorkspaceName) Main.getWorkspaceName = origGetWorkspaceName;
    if (origHasDefaultWorkspaceName) Main.hasDefaultWorkspaceName = origHasDefaultWorkspaceName;

    if (Main.expo && Main.expo._thumbnailsBox && Main.expo._thumbnailsBox.thumbnails) {
        for (let th of Main.expo._thumbnailsBox.thumbnails) {
            cleanUpThumbnailDND(th);
            th.refreshTitle();
        }
    }

    // Cleanly exit all active App Spaces
    for (let [ws, data] of Array.from(appSpaces.entries())) {
        if (data.ownerWindow && !data.ownerWindow.unmanaged) {
            exitAppSpace(data.ownerWindow);
        } else {
            appSpaces.delete(ws);
            try { Main._removeWorkspace(ws); } catch(e) { global.workspace_manager.remove_workspace(ws, global.get_current_time()); }
        }
    }
    appSpaces.clear();

    for (let win of Array.from(trackedWindows.keys())) {
        untrackWindow(win);
    }
    trackedWindows.clear();

    logDebug("Extension disabled cleanly");
}
