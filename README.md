# Mac-Style Fullscreen Spaces

A Cinnamon desktop extension for Linux Mint that brings macOS-style dedicated fullscreen spaces to Cinnamon (`6.0` – `6.6+`, tested on **Linux Mint 22.3 / Cinnamon 6.6.9**).

## What It Does

On macOS, clicking a window's green fullscreen button moves that app into its own isolated Space with the panel hidden, while double-clicking the titlebar maximizes/zooms the window inside the current Space.

**Mac-Style Fullscreen Spaces** brings that exact workflow to Cinnamon:

- **Click Maximize / Restore Button (`⬜` / `❐`):**
  - Appends a new dedicated workspace at the end of your workspace list, moves only that window there, switches to it, and puts the window into fullscreen (or maximized) mode with panels hidden.
- **Double-Click the Titlebar:**
  - Keeps standard Cinnamon behavior and maximizes/unmaximizes the window inside the **current** workspace.
- **Works From Both Normal and Already-Maximized Windows:**
  - If the window was normal-sized, its exact coordinates (`x, y, width, height`) are saved before entering the dedicated workspace and restored upon exit.
  - If the window was already maximized in your main workspace, clicking `❐` sends it directly to its own dedicated fullscreen workspace and remembers that it was maximized—so when you return, it cleanly restores back to maximized state.
- **Automatic Cleanup:**
  - Exiting the dedicated workspace (via shortcut, `F11`, `Alt+F11`, minimizing, or closing the app) returns focus to your previous workspace and automatically removes the empty temporary workspace.
- **RTL & Custom Button Layout Support:**
  - Automatically reads `org.cinnamon.desktop.wm.preferences` (`button-layout`) and RTL layout direction, supporting both Mint's default right-side buttons and macOS-style left-side buttons.

---

## Installation

### Option 1: Install via Git
```bash
mkdir -p ~/.local/share/cinnamon/extensions
git clone https://github.com/YOUR_USERNAME/mac-fullscreen-spaces.git ~/.local/share/cinnamon/extensions/cinnamon-fullscreen-to-workspace@arashdayaniii
```

### Option 2: Manual Installation
1. Copy the `cinnamon-fullscreen-to-workspace@arashdayaniii` folder to:
   ```text
   ~/.local/share/cinnamon/extensions/cinnamon-fullscreen-to-workspace@arashdayaniii
   ```
2. Reload Cinnamon: press `Alt + F2`, type `r`, and press `Enter` (or log out and log back in).
3. Open **Extensions** from the Linux Mint menu, select **Mac-Style Fullscreen Spaces**, and click `+` to enable it.

---

## Usage

- **Send a window to a dedicated fullscreen workspace:** Click the **Maximize / Restore** button in the window titlebar.
- **Maximize in the current workspace:** Double-click the draggable area of the window titlebar.
- **Switch between workspaces:** Use `Ctrl + Alt + Left/Right Arrow` (or your configured workspace shortcuts).
- **Return to the original workspace:**
  - Press **`Super + Shift + F`** (works across all applications), or
  - Use the app's fullscreen shortcut (`F11` or `Alt + F11`), or
  - Minimize or close the window.

> **Note for `Maximize` mode:** If you change the presentation mode to `Maximize` instead of `Fullscreen`, right-click your Cinnamon panel → **Panel settings** → set **Panel visibility** to **Intelligently hide panel** so the taskbar hides automatically on dedicated workspaces.

---

## Settings Explained

Open **Extensions → Mac-Style Fullscreen Spaces → Configure (gear icon)** to adjust any setting:

### 1. Dedicated workspace presentation mode (`mode`)
- **Options:**
  - `Fullscreen (True fullscreen, panels auto-hidden)` *(default)*
  - `Maximize (Keep titlebar buttons + use smart panel hide)`
- **Why it exists:** `Fullscreen` hides panels and window borders for a true macOS-like full-screen space. `Maximize` keeps the window titlebar buttons visible (if you prefer exiting with a mouse click) and pairs with Cinnamon's *Intelligently hide panel* option.

### 2. Auto-resync window geometry when switching back to a dedicated workspace (`resync-on-switch`)
- **Default:** `Enabled`
- **Why it exists:** Under Cinnamon on X11 with fractional display scaling (such as `125%`), switching away from a dedicated fullscreen workspace and switching back can cause Muffin or Chromium/Electron apps (Chrome, VS Code) to render slightly shifted or clipped. Enabling this automatically re-synchronizes the window geometry when you switch back to its dedicated workspace. If you use `100%` display scaling and do not experience render offsets, you can disable this.

### 3. Workspace settle delay (`settle-delay`)
- **Range:** `0 ms` – `600 ms` *(Default: `100 ms`)*
- **Why it exists:** When moving a window to another workspace, Cinnamon runs workspace transitions and recalculates panel struts. Applying fullscreen or resizing immediately mid-transition on fractional scaling (`125%`, `150%`) or Chromium/GTK apps can leave the window content offset from `(0, 0)`.
  - **`100 ms`** works reliably on `125%` fractional scaling with Chromium/Electron and GTK apps.
  - **`0 ms`** can be used on `100%` display scaling for near-instant transitions.
  - Increase to **`200–350 ms`** if you still notice frame offsets on slower hardware or higher scaling factors.

### 4. Restore maximize delay (`restore-maximize-delay`)
- **Range:** `0 ms` – `400 ms` *(Default: `0 ms`)*
- **Why it exists:** When exiting a dedicated workspace for a window that was **already maximized** on the original workspace, the extension first resets the window frame cleanly inside the work area (`move_resize_frame`) before re-applying `maximize()`. On some systems with fractional scaling, calling `maximize()` immediately in the same frame after resetting geometry can leave a slight horizontal offset; adding a small delay (e.g. `50–100 ms`) prevents that. Leave at `0 ms` if it already restores cleanly on your system.

### 5. Exit dedicated workspace (`exit-hotkey`)
- **Default:** `Shift + Super + F`
- **Why it exists:** True fullscreen mode hides the window's titlebar buttons, and not every application supports `F11`. This global shortcut guarantees a single consistent key combination to exit fullscreen and return any focused window to its original workspace.

### 6. Enable debug logging in `~/.xsession-errors` (`enable-logs`)
- **Default:** `Disabled`
- **Why it exists:** Outputs hit-testing details, saved geometries, and transition events prefixed with `[MacFullscreenSpaces]` to `~/.xsession-errors` for troubleshooting.

---

## Troubleshooting

- **Double-clicking the titlebar sends the window to a new workspace (or clicking Maximize does not):**
  - Ensure **Titlebar double-click action** in **System Settings → Windows → Titlebar** is set to **Toggle Maximize**.
  - Check `gsettings get org.cinnamon.desktop.wm.preferences button-layout` to verify your button layout includes `maximize`.
- **Fullscreen rendering glitches on 125% fractional scaling:**
  - Try disabling fullscreen unredirection in Muffin:
    ```bash
    gsettings set org.cinnamon.muffin unredirect-fullscreen-windows false
    ```
  - Increase `Workspace settle delay` to `150–250 ms` and `Restore maximize delay` to `50–100 ms`, and keep `Auto-resync window geometry` enabled.