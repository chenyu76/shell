#!/usr/bin/env python3
"""Run after make compile; requires GNOME Shell with headless Wayland support."""

from pathlib import Path
from runtime_check import run


CHECK = """
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import {WindowAnimations} from '../pop-shell@system76.com/window_animation.js';

function check(condition, message) {
    if (!condition) throw new Error(message);
}
function later(delay, callback) {
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => { callback(); return false; });
}

export default class PileCloseCheck extends Extension {
    enable() {
        const original = WindowAnimations.prototype.move;
        this.original = original;
        const test = this;
        WindowAnimations.prototype.move = function(window, target, enabled) {
            test.ext = window.ext;
            return original.call(this, window, target, enabled);
        };
        later(1500, () => {
            Main.overview.hide();
            Gio.Subprocess.new(['gjs', '-m', GLib.getenv('PILE_CHECK_CLIENT')], Gio.SubprocessFlags.NONE);
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
                const windows = global.get_window_actors().map(actor => actor.get_meta_window())
                    .filter(meta => meta.get_title()?.startsWith('Pile '));
                if (windows.length !== 3 || windows.some(meta => !meta.get_compositor_private()?.mapped)) return true;
                Main.panel.statusArea['pop-shell'].menu._getMenuItems()
                    .find(item => item.label?.text === 'Reset Windows').activate(null);
                later(1200, () => this.rotate_and_close(windows));
                return false;
            });
        });
    }

    rotate_and_close(windows) {
        const ext = this.ext;
        const stack = ext.auto_tiler.forest.stacks.get(ext.get_window(windows[0]).stack);
        // Make display order differ from membership order before closing.
        const entity = stack.cycle(false);
        const front = ext.windows.get(entity);
        front.activate(false);
        ext.on_focused(front);
        later(400, () => this.close_front(windows));
    }

    close_front(windows) {
        windows.sort((a, b) => a.get_frame_rect().x - b.get_frame_rect().x);
        const closing = windows.pop();
        const successor = windows.at(-1);
        const ext = this.ext;
        ext.on_focused(ext.get_window(closing));
        later(400, () => {
            const component = ext.get_window(closing);
            const survivors = windows.map(meta => ext.get_window(meta));
            const before = survivors.map(window => window.meta.get_frame_rect());
            const calls = new Map(survivors.map(window => [window, 0]));
            const original_ease = new Map();
            for (const window of survivors) {
                const actor = window.meta.get_compositor_private();
                const ease = actor.ease;
                original_ease.set(actor, ease);
                actor.ease = function(params) {
                    calls.set(window, calls.get(window) + 1);
                    return ease.call(this, params);
                };
            }
            closing.connect('unmanaged', () => {
                check(component.destroying, 'Layout removal waited for actor destruction');
                check(ext.auto_tiler.attached.get(component.entity) === null, 'Closing window is still tiled');
                // A headless session has no interactive seat; deliver the normal queued focus event explicitly.
                ext.register_fn(() => ext.on_focused(ext.get_window(successor)));
            });
            closing.delete(global.get_current_time());
            let samples = 0;
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 25, () => {
                survivors.forEach((window, index) => {
                    const rect = ext.window_animations.visual_rect(window);
                    check(Math.abs(rect.x - before[index].x) < 0.5, 'Resize moved the fixed left edge');
                    check(Math.abs(rect.y - before[index].y) < 0.5, 'Resize moved the fixed top edge');
                });
                if (++samples < 24) return true;
                for (const window of survivors) {
                    const actor = window.meta.get_compositor_private();
                    actor.ease = original_ease.get(actor);
                    check(calls.get(window) === 1, 'Survivor did not receive exactly one transition');
                    check(actor.opacity === 255 && actor.scale_x === 1 && actor.scale_y === 1, 'Actor was not restored');
                }
                check(ext.windows.get(component.entity) === null, 'Destroyed component was retained');
                check(survivors.every((window, index) => {
                    const rect = window.meta.get_frame_rect();
                    return rect.width > before[index].width && rect.height > before[index].height;
                }), 'Survivors did not expand');
                console.log('[pile-close-check] PASS ' + survivors.length);
                if (windows.length > 1) this.rotate_and_close(windows);
                return false;
            });
        });
    }

    disable() {
        WindowAnimations.prototype.move = this.original;
    }
}
"""


if __name__ == '__main__':
    run(Path(__file__).with_name('pile-runtime-client.mjs').read_text(), CHECK, 'pile-close-check', 2,
        seconds=14)
