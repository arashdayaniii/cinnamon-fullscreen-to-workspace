# Cinnamon Fullscreen To Workspace

A lightweight Cinnamon desktop extension for Linux Mint that brings macOS-style dedicated fullscreen workspaces to Cinnamon (`6.0` – `6.6+`, tested on **Linux Mint 22.3 / Cinnamon 6.6.9**).

## Overview

- **Keyboard Shortcut Driven (`Super + Shift + F`):**
  - Pressing the hotkey moves the focused window to a dedicated fullscreen workspace at the end of your workspace list, switches to it, and puts the window into true fullscreen mode.
  - Pressing the hotkey again returns the window back to its original workspace, restoring its previous size/state, and automatically removes the temporary empty workspace.
- **Native Maximize Behavior Preserved:**
  - Standard window button clicks and double-clicks on the titlebar remain 100% native Cinnamon behavior (maximizing and unmaximizing within the current workspace).
- **Automatic Application & Project-Named Workspaces:**
  - Workspaces are automatically named after the application (e.g. *Google Chrome*, *Terminal*).
  - For IDEs and code editors with project windows (e.g. *JetBrains Rider*, *IntelliJ IDEA*, *PyCharm*, *VS Code*, *Cursor*, *Sublime Text*, etc.), workspaces are dynamically named with the **Project Name - IDE Name** (e.g. *Vyly - Rider*, *my-project - Visual Studio Code*), keeping multiple project windows clearly organized in the Cinnamon workspace switcher and Expo overview.
- **Strict Workspace Exclusivity:**
  - The dedicated workspace is reserved exclusively for that single application. Any other applications opened while in this space are automatically redirected to your normal workspace, preserving complete focus. (App dialogs, popups, and modal sheets belonging to the application remain fully accessible inside the space).
- **Preserves Previous Window State (Normal or Maximized):**
  - If the window was normal-sized before entering the dedicated workspace, its exact frame geometry (`x, y, width, height`) is saved and restored when exiting.
  - If the window was already maximized on your main workspace, it remembers that state and cleanly restores back to maximized upon return.
- **Automatic Workspace Cleanup:**
  - Exiting the dedicated workspace (via hotkey, `F11`, minimizing, or closing the app) switches back to the original workspace and automatically removes the temporary empty workspace.

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

- **Toggle dedicated fullscreen workspace:** Press **`Super + Shift + F`** while focused on the window (or configure your own shortcut in settings).
- **Return to original workspace:**
  - Press **`Super + Shift + F`** again, or
  - Press **`F11`** (native fullscreen toggle), or
  - Minimize or close the window.
- **Switch between workspaces:** Use `Ctrl + Alt + Left/Right Arrow` (or your configured workspace shortcuts).

---

## Settings Explained

Open **Extensions → Cinnamon Fullscreen To Workspace → Configure (gear icon)**:

### 1. Auto-resync window geometry when switching back to a dedicated workspace (`resync-on-switch`)
- **Default:** `Enabled`
- **Why it exists:** Under Cinnamon on X11 with fractional display scaling (such as `125%`), switching away from a dedicated fullscreen workspace and returning to it can occasionally cause Muffin or Chromium/Electron apps (Chrome, VS Code) to shift or clip the window frame. When enabled, the extension automatically re-synchronizes the window geometry.

### 2. Workspace settle delay (`settle-delay`)
- **Range:** `0 ms` – `600 ms` *(Default: `100 ms`)*
- **Why it exists:** When moving a window across workspaces, Cinnamon plays workspace transitions and recalculates panel struts.
  - **`100 ms`** provides clean, reliable positioning on `125%` fractional scaling with Chrome, VS Code, and GTK apps.
  - **`0 ms`** can be used on `100%` display scaling for instant transitions.

### 3. Restore maximize delay (`restore-maximize-delay`)
- **Range:** `0 ms` – `400 ms` *(Default: `0 ms`)*
- **Why it exists:** When returning a window that was **already maximized** before entering its dedicated space, the extension first resets the window frame cleanly inside the original workspace's work area before re-applying `maximize()`. Keep it at `0 ms` if it already restores cleanly on your system.

### 4. Toggle dedicated workspace (`exit-hotkey`)
- **Default:** `Shift + Super + F`
- **Why it exists:** Global shortcut to send the focused window into its own dedicated fullscreen workspace or return it back to its original workspace.

### 5. Enable debug logging in `~/.xsession-errors` (`enable-logs`)
- **Default:** `Disabled`
- **Why it exists:** Prints transition events and state diagnostics prefixed with `[CinnamonFullscreenToWorkspace]` to `~/.xsession-errors` for troubleshooting.
