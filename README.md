# Cinnamon Fullscreen To Workspace

A Cinnamon desktop extension for Linux Mint that brings macOS-style dedicated fullscreen spaces to Cinnamon (`6.0` – `6.6+`, tested on **Linux Mint 22.3 / Cinnamon 6.6.9**).

## Overview

On macOS, clicking a window's fullscreen button moves that application into its own isolated Space with the panel hidden, while double-clicking the titlebar maximizes/zooms the window inside the current Space.

**Cinnamon Fullscreen To Workspace** brings that exact workflow to Cinnamon:

- **Click Maximize / Restore Button (`⬜` / `❐`):**
  - Appends a new dedicated workspace at the end of your workspace list, moves only that window there, switches to it, and puts the window into fullscreen (or maximized) mode with panels hidden.
- **Double-Click the Titlebar:**
  - Keeps native Cinnamon behavior and toggles Maximize inside the **current** workspace.
- **Preserves Previous Window State (Normal or Maximized):**
  - If the window was normal-sized before clicking Maximize, its exact frame geometry (`x, y, width, height`) is saved and restored when exiting.
  - If the window was already maximized on your main workspace, clicking `❐` sends it directly to a dedicated fullscreen workspace and remembers that it was maximized—restoring it cleanly back to maximized state upon return.
- **Automatic Workspace Cleanup:**
  - Exiting the dedicated workspace (via hotkey, `F11`, `Alt+F11`, minimizing, or closing the app) switches back to the original workspace and automatically removes the temporary empty workspace.
- **RTL & Custom Button Layout Aware:**
  - Automatically reads `org.cinnamon.desktop.wm.preferences` (`button-layout`) and RTL layout direction, working seamlessly whether window buttons are on the right (Mint default) or on the left (macOS layout).

---

## Installation

### Option 1: Install via Git
```bash
mkdir -p ~/.local/share/cinnamon/extensions
git clone https://github.com/arashdayaniii/cinnamon-fullscreen-to-workspace.git ~/.local/share/cinnamon/extensions/cinnamon-fullscreen-to-workspace@arashdayaniii
```

### Option 2: Manual Installation
1. Copy the `cinnamon-fullscreen-to-workspace@arashdayaniii` folder to:
   ```text
   ~/.local/share/cinnamon/extensions/cinnamon-fullscreen-to-workspace@arashdayaniii
   ```
2. Reload Cinnamon: press `Alt + F2`, type `r`, and press `Enter` (or log out and log back in).
3. Open **Extensions** from the Linux Mint menu, select **Cinnamon Fullscreen To Workspace**, and click `+` to enable it.

---

## Usage

- **Send a window to a dedicated fullscreen workspace:** Click the **Maximize / Restore** button in the window titlebar.
- **Maximize in the current workspace:** Double-click the draggable area of the window titlebar.
- **Switch between workspaces:** Use `Ctrl + Alt + Left/Right Arrow` (or your configured workspace shortcuts).
- **Return to the original workspace:**
  - Press **`Super + Shift + F`** (works across all applications), or
  - Use the application's native fullscreen shortcut (`F11` or `Alt + F11`), or
  - Minimize or close the window.

> **Note for `Maximize` mode:** If you set the presentation mode to `Maximize` instead of `Fullscreen`, right-click your Cinnamon panel → **Panel settings** → set **Panel visibility** to **Intelligently hide panel** so the taskbar hides automatically on dedicated workspaces.

---

## Settings Explained

Open **Extensions → Cinnamon Fullscreen To Workspace → Configure (gear icon)** to customize every setting:

### 1. Dedicated workspace presentation mode (`mode`)
- **Options:**
  - `Fullscreen (True fullscreen, panels auto-hidden)` *(default)*
  - `Maximize (Keep titlebar buttons + use smart panel hide)`
- **Why it exists:** `Fullscreen` hides panels and window borders for a true macOS-like fullscreen space. `Maximize` keeps window titlebar buttons visible (helpful if you prefer exiting with a mouse click) and works together with Cinnamon's *Intelligently hide panel* option.

### 2. Auto-resync window geometry when switching back to a dedicated workspace (`resync-on-switch`)
- **Default:** `Enabled`
- **Why it exists:** Under Cinnamon on X11 with fractional display scaling (such as `125%`), switching away from a dedicated fullscreen workspace and returning to it can occasionally cause Muffin or Chromium/Electron apps (Chrome, VS Code) to shift or clip the window frame. When enabled, the extension checks the window's state and frame coordinates upon switching back: if everything already matches the monitor cleanly, it only refreshes focus/redraw without leaving fullscreen (avoiding any panel flicker); if a mismatch is detected, it automatically re-synchronizes the window geometry.

### 3. Workspace settle delay (`settle-delay`)
- **Range:** `0 ms` – `600 ms` *(Default: `100 ms`)*
- **Why it exists:** When moving a window across workspaces, Cinnamon plays workspace transitions and recalculates panel struts. Applying fullscreen or resizing immediately mid-transition on fractional scaling (`125%`, `150%`) or Chromium/GTK apps can cause window content to render offset from `(0, 0)`.
  - **`100 ms`** provides clean, reliable positioning on `125%` fractional scaling with Chrome, VS Code, and GTK apps.
  - **`0 ms`** can be used on `100%` display scaling for instant transitions.
  - Increase to **`200–350 ms`** if you observe frame offsets on slower hardware or higher scaling factors.

### 4. Restore maximize delay (`restore-maximize-delay`)
- **Range:** `0 ms` – `400 ms` *(Default: `0 ms`)*
- **Why it exists:** When returning a window that was **already maximized** before entering its dedicated space, the extension first resets the window frame cleanly inside the original workspace's work area (`move_resize_frame`) before re-applying `maximize()`. On some systems with fractional scaling, calling `maximize()` immediately after resetting geometry can leave a slight horizontal offset; adding a small delay (e.g., `50–100 ms`) prevents that. Keep it at `0 ms` if it already restores cleanly on your system.

### 5. Exit dedicated workspace (`exit-hotkey`)
- **Default:** `Shift + Super + F`
- **Why it exists:** True fullscreen mode hides the window's titlebar buttons, and not every application supports `F11`. This global shortcut provides one consistent key combination to exit fullscreen and return any focused window to its original workspace.

### 6. Enable debug logging in `~/.xsession-errors` (`enable-logs`)
- **Default:** `Disabled`
- **Why it exists:** Prints button hit-testing details, saved geometries, and transition events prefixed with `[MacFullscreenSpaces]` to `~/.xsession-errors` for troubleshooting.

---

## Troubleshooting

- **Double-clicking the titlebar triggers a dedicated workspace (or clicking Maximize does not):**
  - Make sure **Titlebar double-click action** in **System Settings → Windows → Titlebar** is set to **Toggle Maximize**.
  - Check `gsettings get org.cinnamon.desktop.wm.preferences button-layout` to verify your button layout includes `maximize`.
- **Fullscreen rendering glitches on 125% fractional scaling:**
  - Disable fullscreen unredirection in Muffin:
    ```bash
    gsettings set org.cinnamon.muffin unredirect-fullscreen-windows false
    ```
  - Adjust `Workspace settle delay` (e.g., `100–250 ms`) and `Restore maximize delay` (e.g., `0–90 ms`), and keep `Auto-resync window geometry` enabled.