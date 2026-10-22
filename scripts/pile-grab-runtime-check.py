#!/usr/bin/env python3
"""After make compile, exercise pile focus/grab callbacks in isolated GNOME."""

from pathlib import Path
from runtime_check import run


CHECK = """
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import {WindowAnimations} from '../pop-shell@system76.com/window_animation.js';

function later(ms, callback) {
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => { callback(); return false; });
}
function check(condition, message) {
    if (!condition) throw new Error(message);
}
function rect(meta) {
    const r = meta.get_frame_rect();
    return {x: r.x, y: r.y, width: r.width, height: r.height};
}
function same(a, b) {
    return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

export default class PileGrabCheck extends Extension {
    enable() {
        this.calls = new Map();
        this.original = WindowAnimations.prototype.move;
        const test = this;
        WindowAnimations.prototype.move = function(window, target, animated) {
            test.ext = window.ext;
            test.calls.set(window, (test.calls.get(window) ?? 0) + 1);
            return test.original.call(this, window, target, animated);
        };
        this.cases = [
            {name: 'back window with a queued focus swap', index: 0, queued: true},
            {name: 'middle window without displacement', index: 1},
            {name: 'front window without displacement', index: 2},
            {name: 'drag inside the dead zone', index: 0, delta: 2},
            {name: 'keyboard move without displacement', index: 0, op: Meta.GrabOp.KEYBOARD_MOVING},
            {name: 'resize grab without displacement', index: 1, op: Meta.GrabOp.RESIZING_SE},
        ];
        later(1500, () => {
            Main.overview.hide();
            Gio.Subprocess.new(['gjs', '-m', GLib.getenv('PILE_CHECK_CLIENT')], Gio.SubprocessFlags.NONE);
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
                const windows = global.get_window_actors().map(actor => actor.get_meta_window())
                    .filter(meta => meta.get_title()?.startsWith('Pile '));
                if (windows.length !== 3 || windows.some(meta => !meta.get_compositor_private()?.mapped)) return true;
                this.windows = windows;
                Main.panel.statusArea['pop-shell'].menu._getMenuItems()
                    .find(item => item.label?.text === 'Reset Windows').activate(null);
                later(1200, () => this.next());
                return false;
            });
        });
    }

    next() {
        const step = this.cases.shift();
        if (!step) return;
        const ext = this.ext;
        const stack = ext.auto_tiler.forest.stacks.get(ext.get_window(this.windows[0]).stack);
        const component = ext.windows.get(stack.entities[step.index]);
        const before = new Map(this.windows.map(meta => [meta, rect(meta)]));
        const slots = [...before.values()].sort((a, b) => a.x - b.x);
        const op = step.op ?? Meta.GrabOp.MOVING;
        this.calls.clear();
        // Headless GNOME has no interactive seat: deliver the same callbacks as
        // focus/grab signals explicitly. All real geometry and rendering stay live.
        if (step.queued) {
            ext.on_focused(component);
            check(ext.movements.get(component.entity) !== null, 'No focus swap was queued');
        }
        ext.on_grab_start(component.meta, op);
        check(ext.grab_op !== null, 'Grab did not start');
        for (const entity of stack.entities) {
            check(ext.movements.get(entity) === null, 'Pre-grab movement survived grab start');
        }
        component.meta.raise();
        component.meta.activate(global.get_current_time());
        ext.on_focused(component);
        if (step.delta) {
            const r = before.get(component.meta);
            component.meta.move_frame(true, r.x + step.delta, r.y + step.delta);
        }
        later(250, () => {
            check(this.calls.size === 0, 'Pile layout moved windows while a member was grabbed');
            for (const meta of this.windows) {
                const expected = {...before.get(meta)};
                if (meta === component.meta && step.delta) {
                    expected.x += step.delta;
                    expected.y += step.delta;
                }
                check(same(rect(meta), expected), 'Grab displaced a window before release');
            }
            ext.on_grab_end(component.meta, op);
            check(ext.grab_op === null && !component.grab, 'Grab was not cleared');
            later(600, () => {
                check(stack.active[0] === component.entity[0], 'Clicked window did not stay in front');
                for (let i = 0; i < stack.entities.length; i++) {
                    const window = ext.windows.get(stack.entities[i]);
                    check(same(rect(window.meta), slots[i]), 'Release left a pile window in the wrong slot');
                    const actor = window.meta.get_compositor_private();
                    check(actor.opacity === 255 && actor.scale_x === 1 && actor.scale_y === 1,
                        'Release left an unfinished animation');
                }
                console.log('[pile-grab-check] PASS ' + step.name);
                this.next();
            });
        });
    }

    disable() {
        WindowAnimations.prototype.move = this.original;
    }
}
"""


if __name__ == '__main__':
    run(Path(__file__).with_name('pile-runtime-client.mjs').read_text(), CHECK, 'pile-grab-check', 6,
        seconds=16, full_extension=True)
