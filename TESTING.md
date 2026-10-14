# Testing

This document provides a guideline for testing and verifying the expected behaviors of the project. When a patch is ready for testing, the checklists may be copied and marked as they are proven to be working.

## Logs

To begin watching logs, open a terminal with the following command:

```
journalctl -o cat -n 0 -f "$(which gnome-shell)" | grep -v warning
```

Note that because the logs are from GNOME Shell, there will be messages from all installed extensions, and GNOME Shell itself. Pop Shell is fairly chatty though, so the majority of the logs should be from Pop Shell. Pop Shell logs are usually prepended with `pop-shell:`, but sometimes GNOME has internal errors and warnings surrounding those logs that could be useful for pointing to an issue that we can resolve in Pop Shell.

## Checklists

Tasks for a tester to verify when approving a patch. Use complex window layouts and at least two displays. Turn on active hint during testing.

## With tiling enabled

### Tiling

- [ ] Super direction keys changes focus in the correct direction
- [ ] Windows moved with the keyboard tile into place
- [ ] Windows moved with the mouse tile into place
- [ ] Windows swap with the keyboard (test with different size windows)
- [ ] Windows can be resized with the keyboard (Test resizing four windows above, below, right, and left to ensure shortcut consistency)
- [ ] Windows can be resized with the mouse
- [ ] Minimizing a window detaches it from the tree and re-tiles remaining windows
- [ ] Unminimizing a window re-tiles the window
- [ ] Maximizing with the keyboard (`Super` `M`) covers tiled windows
- [ ] Unmaximizing with keyboard (`Super` `M`) re-tiles into place
- [ ] Maximizing with the mouse covers tiled windows
- [ ] Unmaximizing with mouse re-tiles into place
- [ ] Full-screening removes the active hint and full-screens on one display 
- [ ] Unfull-screening adds the active hint and re-tiles into place
- [ ] Maximizing a YouTube video fills the screen and unmaximizing retiles the browser in place
- [ ] VIM shortcuts work as direction keys
- [ ] `Super` `O` changes window orientation
- [ ] `Super` `G` floats and then re-tiles a window
- [ ] Float a window with `Super` `G`. It should be movable and resizeable in window management mode with keyboard keys
- [ ] `Super` `Q` Closes a window
- [ ] Turn off auto-tiling. New windows launch floating.
- [ ] Turn on auto-tiling. Windows automatically tile.
- [ ] Disabling and enabling auto-tiling correctly handles minimized, maximized, fullscreen, floating, and non-floating windows (This test needs a better definition, steps, or to be separated out.)

### Stacking

- [ ] Windows can be moved into a stack.
- [ ] Windows can be moved out of a stack.
- [ ] Windows inside and outside of a stack can be swapped multiple times and in both directions.
- [ ] Moving the last window out of a stack works as expected.
- [ ] Stacks can be resized with the keyboard.
- [ ] Stacks can be resized with the mouse.
- [ ] Lock and unlock the screen-- stacks should still exist and windows should not have moved.
- [ ] Full-screen an application within the stack, then quit the application-- the remaining windows should be visible.
- [ ] Every window of the stack is visible as a cascading pile, and the entire pile fits inside of the stack's area.
- [ ] Clicking a window of the stack displays it completely, in front of the other windows of the stack.
- [ ] A stack which has windows to its left or right is cycled with `Super` + `Up`/`Down`, while `Super` + `Left`/`Right` moves focus between the tiles.
- [ ] A stack which has windows above or below it is cycled with `Super` + `Left`/`Right`, while `Super` + `Up`/`Down` moves focus between the tiles.
- [ ] A stack which has windows both beside it and above or below it is not cycled, and every direction key moves focus between the tiles.
- [ ] Cycling brings every window of the stack to the front in turn, forwards with `Right`/`Down` and backwards with `Left`/`Up`.
- [ ] Once every window of the stack has been displayed in front, the next press displays the windows again from the start.
- [ ] The direction keys which move focus between the tiles land on the window which the neighbouring stack displays in front, and never on the window behind it.
- [ ] A stack which fills the display is still cycled by every direction key, as there is no tile to move focus to.
- [ ] Focus can still be shifted out of a stack which holds a single window.
- [ ] Cycling a stack which fills the display keeps displaying the next window, since there is no window to shift focus to.
- [ ] Changing the stack offsets in the preferences re-arranges the stacks, and a value of `0` displays the windows on top of one another.
- [ ] Adding and removing windows from a stack does not scramble the order of the pile.

### Window Titles in Piles

- [ ] "Window Titles in Piles" in the panel menu opens the rules editor on the list of the same name, and the editor lists the rules of floating windows when it is opened from "Floating Window Exceptions".
- [ ] Selecting a window from the editor adds a rule for the window or for its application to the list which the editor was opened with, and returns to that list.
- [ ] Deleting a rule from either list updates the shell, and the drawn titles are redrawn.
- [ ] Adding a window with "Window Titles in Piles" draws its title over the part of its title bar which the window behind it exposes, once it is stacked behind another window.
- [ ] The drawn title is centered in the exposed part of the title bar, both horizontally and vertically.
- [ ] The window which is displayed in front is never drawn over, as it displays its own title bar.
- [ ] The drawn titles follow the windows when the pile is rotated, when the offsets are changed, and when a window is added to or removed from the stack.
- [ ] A window whose title changes updates the drawn title.
- [ ] The drawn titles are hidden by a window which is dragged, by a fullscreen window in the stack, and by switching to another workspace.
- [ ] The rules of "Window Titles in Piles" are kept when the Floating Window Exceptions editor saves the configuration.

The arrangement of a stack can additionally be checked without a running shell:

```
make compile && node scripts/stack-cascade-check.mjs
```

### Workspaces

- [ ] Windows can be moved to another workspace with the keyboard
- [ ] Windows can be moved to another workspace with the mouse
- [ ] Windows can be moved to workspaces between existing workspaces
- [ ] Moving windows to another workspace re-tiled the previous and new workspace
- [ ] Active hint is present on the new workspace and once the window is returned to its previous workspace
- [ ] Floating windows move across workspaces
- [ ] Remove windows from the 2nd worspace in a 3 workspace setup. The 3rd workspace becomes the 2nd workspace, and tiling is unaffected by the move.

### Displays

- [ ] Windows move across displays in adjustment mode with direction keys
- [ ] Windows move across displays with the mouse
- [ ] Changing the primary display moves the top bar. Window heights adjust on all monitors for the new position.
- [ ] Unplug a display - windows from the display retile on a new workspace on the remaining display
- [ ] Plug an additional display into a laptop - windows and workspaces don't changes
- [ ] NOTE: Add vertical monitor layout test

### Launcher

- [ ] All windows on all workspaces appear on launch
- [ ] Choosing an app on another workspace moves workspaces and focus to that app
- [ ] Launching an application works
- [ ] Typing text and then removing it will re-show those windows
- [ ] Search works for applications and windows
- [ ] Search works for GNOME settings panels
- [ ] Search for "Extensions". There should be only one entry.
- [ ] The overlay hint correctly highlights the selected window
- [ ] Open windows are sorted above applications (e.g. "web browser")
- [ ] t: executes a command in a terminal
- [ ] : executes a command in sh
- [ ] = calculates an equation
- [ ] Search results are as expected:
    - `cal` returns Calendar and Calculator before Color
    - `pops` returns Popsicle first
    - `shop` returns the Pop!_Shop first

### Window Titles

- [ ] Disabling window titles using global (Pop Shell) option works for Shell Shortcuts, LibreOffice, etc.
- [ ] Disabling window titles in Firefox works (Check debian and flatpak packages)

### Floating Exceptions

- [ ] Add a window to floating exceptions-- it should float immediately.
- [ ] Close and re-open the window-- it should float when opened.
- [ ] Add an app to floating exceptions-- it should float immediately.
- [ ] Close and re-open the app-- it should float when opened.

## With Tiling Disabled

### Tiling

- [ ] Super direction keys changes focus in the correct direction
- [ ] Windows can be moved with the keyboard
- [ ] Windows can be moved with the mouse
- [ ] Windows swap with the keyboard (test with different size windows)
- [ ] Windows can be resized with the keyboard
- [ ] Windows can be resized with the mouse
- [ ] Windows can be half-tiled left and right with `Ctrl``Super``left`/`right`

### Displays

- [ ] Windows move across displays in adjustment mode with directions keys
- [ ] Windows move across displays with the mouse

### Miscellaneous

- [ ] Close all windows-- no icons should be active in the GNOME launcher.
- [ ] Open a window, enable tiling, stack the window, move to a different workspace, and disable tiling. The window should not become visible on the empty workspace.
- [ ] With tiling still disabled, minimize the single window. The active hint should go away.
- [ ] Maximize a window, then open another app with the Activities overview. The newly-opened app should be visible and focused.
- [ ] Maximize a window, then open another app with the launcher. The newly-opened app should be visible and focused.
