const Main = imports.ui.main;
const Settings = imports.ui.settings;
const Meta = imports.gi.Meta;
const GLib = imports.gi.GLib;
const Gio = imports.gi.Gio;
const St = imports.gi.St;
const Clutter = imports.gi.Clutter;

const UUID = "cinnamon-fullscreen-to-workspace@arashdayaniii";

let extSettings = null;
let trackedWindows = new Map();
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
    return win && trackedWindows.has(win);
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

    let inY = (py >= rect.y - 6 * scale && py <= rect.y + 56 * scale);
    let minD = Math.max(0, (idx * 24 - 2) * scale);
    let maxD = ((idx + 1) * 34 + 8) * scale;

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

function updateSavedRects(win) {
    if (!isWindowAlive(win) || win._macBusy || win._macDedicated) return;
    let r = win.get_frame_rect();
    if (!r || r.width <= 50 || r.height <= 50) return;

    if (isNormalState(win)) {
        win._macNormalRect = copyRect(r);
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

function removeWorkspaceIfEmpty(ws, fallbackWs) {
    if (!ws || ws === fallbackWs) return;
    let wsMgr = global.workspace_manager;
    if (wsMgr.get_n_workspaces() <= 1) return;

    let remaining = ws.list_windows().filter(
        w => !w.is_on_all_workspaces() && w.window_type === Meta.WindowType.NORMAL
    );
    if (remaining.length === 0) {
        wsMgr.remove_workspace(ws, global.get_current_time());
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
    if (!isWindowAlive(win)) return;
    let targetRect = useFullscreen ? getMonitorRect(win) : getWorkAreaRect(win);
    let postSnapDelay = cfg.settleDelay > 0 ? 70 : 10;

    win.move_resize_frame(true, targetRect.x, targetRect.y, targetRect.width, targetRect.height);

    scheduleTimeout(postSnapDelay, () => {
        if (!isWindowAlive(win)) return;
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
            if (isWindowAlive(win)) {
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

    win._macBusy = true;
    win._macDedicated = {
        origWs: origWs,
        wasMaximized: wasMaximized,
        useFullscreen: useFullscreen,
        customTitlebar: customTitlebar,
        normalRect: win._macNormalRect ? copyRect(win._macNormalRect) : null
    };

    logDebug(`enter start wasMax=${wasMaximized} mode=${cfg.mode} customBar=${customTitlebar} normalRect=${JSON.stringify(win._macDedicated.normalRect)}`);

    if (win.get_maximized() !== 0) {
        win.unmaximize(Meta.MaximizeFlags.BOTH);
    }

    let t = global.get_current_time();
    let newWs = wsMgr.append_new_workspace(false, t);
    win._macDedicated.dedWs = newWs;

    scheduleTimeout(preDelay, () => {
        if (!isWindowAlive(win) || !win._macDedicated) return;
        win.change_workspace(newWs);
        newWs.activate_with_focus(win, global.get_current_time());

        scheduleTimeout(cfg.settleDelay, () => {
            applyTargetPresentation(win, useFullscreen);
        });
    });
}

function exitDedicatedWorkspace(win) {
    let data = win._macDedicated;
    if (!data) return;

    if (topBarWindow === win) {
        destroyTopBar();
    } else {
        hideTopBar();
    }
    stopBarPoller();

    win._macDedicated = null;
    win._macBusy = true;
    let preDelay = cfg.settleDelay > 0 ? 110 : 15;

    logDebug(`exit start wasMax=${data.wasMaximized} normalRect=${JSON.stringify(data.normalRect)}`);

    if (win.minimized) {
        win.unminimize();
    }
    if (win.is_fullscreen()) {
        win.unmake_fullscreen();
    }
    if (win.get_maximized() !== 0) {
        win.unmaximize(Meta.MaximizeFlags.BOTH);
    }

    let wsMgr = global.workspace_manager;
    let targetWs = data.origWs;
    if (!targetWs || targetWs.index() < 0 || targetWs.index() >= wsMgr.get_n_workspaces()) {
        targetWs = wsMgr.get_workspace_by_index(0);
    }

    scheduleTimeout(preDelay, () => {
        if (!isWindowAlive(win)) return;
        win.change_workspace(targetWs);
        targetWs.activate_with_focus(win, global.get_current_time());

        scheduleTimeout(cfg.settleDelay, () => {
            if (!isWindowAlive(win)) return;

            if (win.get_maximized() !== 0) {
                win.unmaximize(Meta.MaximizeFlags.BOTH);
            }

            let wa = getWorkAreaRect(win);
            let r = data.normalRect;
            let gx, gy, gw, gh;
            if (r && r.width > 100 && r.height > 100) {
                gx = Math.max(wa.x, Math.min(r.x, wa.x + wa.width - 100));
                gy = Math.max(wa.y, Math.min(r.y, wa.y + wa.height - 100));
                gw = Math.min(r.width, wa.width);
                gh = Math.min(r.height, wa.height);
            } else {
                gx = wa.x + Math.round(wa.width * 0.05);
                gy = wa.y + Math.round(wa.height * 0.05);
                gw = Math.max(400, Math.round(wa.width * 0.9));
                gh = Math.max(300, Math.round(wa.height * 0.9));
            }

            win.move_resize_frame(true, gx, gy, gw, gh);
            win._macNormalRect = { x: gx, y: gy, width: gw, height: gh };

            let finishRestore = () => {
                if (!isWindowAlive(win)) return;
                let actor = win.get_compositor_private();
                if (actor) actor.queue_redraw();
                win.activate(global.get_current_time());
                removeWorkspaceIfEmpty(data.dedWs, targetWs);

                scheduleTimeout(180, () => {
                    if (isWindowAlive(win)) {
                        win._macBusy = false;
                        updateSavedRects(win);
                        refreshFloatingBarPoller();
                        logDebug(`exit done frame=${JSON.stringify(win.get_frame_rect())} max=${win.get_maximized()}`);
                    }
                });
            };

            if (data.wasMaximized) {
                scheduleTimeout(cfg.restoreMaximizeDelay, () => {
                    if (!isWindowAlive(win)) return;
                    win.maximize(Meta.MaximizeFlags.BOTH);
                    finishRestore();
                });
            } else {
                finishRestore();
            }
        });
    });
}

function resyncDedicatedWindow(win) {
    if (!isWindowAlive(win) || !win._macDedicated || win._macBusy) return;
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
        if (isWindowAlive(win) && win._macDedicated) {
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
        if (!activeWs) return;
        for (let win of trackedWindows.keys()) {
            if (win._macDedicated && !win._macBusy) {
                let ws = win.get_workspace();
                if (ws && ws === activeWs) {
                    resyncDedicatedWindow(win);
                }
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
            if (isPointerOnMaximizeButton(win._macNormalRect)) {
                enterDedicatedWorkspace(win, false);
            } else {
                scheduleTimeout(70, () => updateSavedRects(win));
            }
        } else if (!isFullMax && !win.is_fullscreen() && win._macMaxRect) {
            if (isPointerOnMaximizeButton(win._macMaxRect)) {
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

function trackWindow(win) {
    if (!win || win.window_type !== Meta.WindowType.NORMAL || trackedWindows.has(win)) {
        return;
    }
    updateSavedRects(win);

    let ids = [
        win.connect("notify::maximized-horizontally", () => onWindowMaximizeChanged(win)),
        win.connect("notify::minimized", () => onWindowMinimizedChanged(win)),
        win.connect("notify::fullscreen", () => onWindowFullscreenChanged(win)),
        win.connect("position-changed", () => scheduleRectUpdate(win)),
        win.connect("size-changed", () => scheduleRectUpdate(win)),
        win.connect("unmanaged", () => onWindowUnmanaged(win))
    ];
    trackedWindows.set(win, ids);
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

function registerHotkeys() {
    try { Main.keybindingManager.removeHotKey(UUID + "-exit"); } catch (e) {}

    let exitKeys = (cfg.exitHotkey || "").split("::").filter(k => k && k.trim());
    if (exitKeys.length > 0) {
        Main.keybindingManager.addHotKey(UUID + "-exit", exitKeys[0], () => {
            let win = global.display.focus_window;
            if (win && win._macDedicated && !win._macBusy) {
                exitDedicatedWorkspace(win);
            }
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

    globalSignals.push(
        global.display.connect("window-created", (display, win) => {
            scheduleTimeout(80, () => trackWindow(win));
        })
    );
    globalSignals.push(
        global.window_manager.connect("switch-workspace", () => onWorkspaceSwitched())
    );

    registerHotkeys();
    refreshFloatingBarPoller();
    logDebug("Extension enabled");
}

function disable() {
    stopBarPoller();
    destroyTopBar();
    clearAllTimeouts();
    try { Main.keybindingManager.removeHotKey(UUID + "-exit"); } catch (e) {}

    for (let id of globalSignals) {
        try { global.display.disconnect(id); } catch (e) {}
        try { global.window_manager.disconnect(id); } catch (e) {}
    }
    globalSignals = [];

    for (let win of Array.from(trackedWindows.keys())) {
        untrackWindow(win);
    }
}
