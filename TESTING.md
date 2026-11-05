# Testing

## Build and Node checks

Build once before running checks. Node checks use the compiled modules and stub
only the GNOME boundary; they do not verify rendering or native event delivery.

```sh
make compile
node scripts/stack-cascade-check.mjs
node scripts/reset-windows-check.mjs
node scripts/window-animation-check.mjs
```

| Check | Coverage |
| --- | --- |
| `stack-cascade-check.mjs` | Pile geometry, cycling, grab ordering, titles and signal cleanup. |
| `reset-windows-check.mjs` | Workspace isolation, tree membership, splits, swaps, migration and entity reuse. |
| `window-animation-check.mjs` | Asynchronous geometry, constraints, retargeting, cancellation and resource cleanup. |

## Native GNOME checks

These require GNOME 51 with headless Wayland support, GJS, GTK 4, `dbus-run-session`
and `timeout`. Each check uses a private D-Bus session and temporary XDG settings,
leaving the current desktop unchanged. The harness prints the saved GNOME log path.

```sh
python3 scripts/constrained-window-runtime-check.py
python3 scripts/pile-close-runtime-check.py
python3 scripts/pile-grab-runtime-check.py
python3 scripts/multi-monitor-runtime-check.py
python3 scripts/pile-lock-runtime-check.py
```

| Check | Coverage |
| --- | --- |
| `constrained-window-runtime-check.py` | Minimum-sized Wayland windows still move; decorated and undecorated windows, animations on and off. |
| `pile-close-runtime-check.py` | Closing a rotated pile's front preserves survivor origins and produces one resize animation. |
| `pile-grab-runtime-check.py` | Clicks, short drags and move/resize grabs hold the pile still and restore its slots after release. |
| `multi-monitor-runtime-check.py` | All four focus directions, empty-direction cycling and wraparound, cross-screen focus, shared secondary layouts, raise-only clicks and workspace changes. |
| `pile-lock-runtime-check.py` | Lock/unlock restores overlapping native frames, including queued rotations, display reconnection and untiled movements. |

Focus and grab callbacks are delivered explicitly because the headless compositor
has no interactive seat. These checks exercise real windows and geometry but do
not simulate physical keyboard or mouse input. The lock check deliberately moves
native frames to the same origin while locked to verify recovery without Reset Windows.

## Desktop verification

Use Wayland and XWayland applications, at least two monitors, and the active hint.
Repeat display checks with horizontal and vertical layouts and different scales.

- [ ] With a neighbour on just one side, that direction leaves the pile and the other directions cycle it. Test all four sides, repeated keys and cross-screen focus.
- [ ] Click the exposed edge of back and middle windows, including a press/release without displacement and a small titlebar drag. Every window keeps a clickable edge afterward.
- [ ] Drag below and above the dead zone; only the latter changes placement. Drag between displays after switching workspaces.
- [ ] Move, split, swap and resize windows with keyboard and mouse. Minimize and restore them; float and retile them; empty a pile down to its last window.
- [ ] Close front and background windows during an animation. The remaining windows resize together without a jump or leftover snapshot.
- [ ] Maximize, fullscreen, minimize, enter overview or disable the extension during movement. Native effects finish without a stuck transform or invisible window. Also test with system animations disabled.
- [ ] Lock during a pile rotation, then unlock. Repeat with displays sleeping or reconnecting. Piles retain exposed edges, membership and usable shortcuts.
- [ ] Change the primary monitor, unplug/reconnect a display, and switch workspace mode. Check placement, gaps and the active hint on each screen.
- [ ] Reset Windows preserves the focused front window and other workspaces, including when tiling was disabled. Dialogs and windows pinned to all workspaces stay out of the reset.
- [ ] Toggle tiling with ordinary, floating, minimized, maximized and fullscreen windows present. Hidden windows remain on their own workspaces.
- [ ] Preferences applies pile offsets, gaps, active hint appearance and the unmaximize-on-focus option immediately and preserves them after restart.
- [ ] Pile title rules add, update and remove drawn titles; floating exceptions still work after editing either list.
- [ ] With tiling disabled, directional focus, movement, resizing and swaps still work. Confirm title-bar hiding and a launcher search as smoke checks.

## Logs

```sh
journalctl -o cat -n 0 -f "$(which gnome-shell)"
```

Inspect `pop-shell:` messages and JS errors together with the action that triggered them.
