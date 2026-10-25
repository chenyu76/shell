#!/usr/bin/env python3
"""After make compile, verify unified pile lifecycle with real Wayland windows."""

from pathlib import Path
from runtime_check import run


CHECK = """
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import {AutoTiler} from '../pop-shell@system76.com/auto_tiler.js';
import {Direction} from '../pop-shell@system76.com/tiling.js';

function check(condition, message) {
    if (!condition) throw new Error(message);
}
function later(ms, callback) {
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => { callback(); return false; });
}

export default class PileModelCheck extends Extension {
    enable() {
        this.original = AutoTiler.prototype.reset_to_pile;
        const test = this;
        AutoTiler.prototype.reset_to_pile = function(ext, ...args) {
            test.ext = ext;
            return test.original.call(this, ext, ...args);
        };
        later(1500, () => {
            Main.overview.hide();
            Gio.Subprocess.new(['gjs', '-m', GLib.getenv('PILE_CHECK_CLIENT')], Gio.SubprocessFlags.NONE);
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
                const metas = global.get_window_actors().map(actor => actor.get_meta_window())
                    .filter(meta => meta.get_title()?.startsWith('Pile '));
                if (metas.length !== 3 || metas.some(meta => !meta.get_compositor_private()?.mapped)) return true;
                Main.panel.statusArea['pop-shell'].menu._getMenuItems()
                    .find(item => item.label?.text === 'Reset Windows').activate(null);
                this.windows = metas.map(meta => this.ext.get_window(meta));
                later(600, () => this.start());
                return false;
            });
        });
    }

    verify(name, condition, next) {
        later(500, () => {
            check(condition(), name);
            const {forest, attached} = this.ext.auto_tiler;
            for (const [root] of forest.toplevel.values()) {
                for (const branch of forest.iter(root)) {
                    if (branch.inner.kind === 1) continue;
                    check(branch.inner.kind === 3 && branch.inner.entities.length > 0, 'Invalid pile leaf');
                    const pile = forest.stacks.get(branch.inner.idx);
                    check(pile.entities === branch.inner.entities, 'Pile order is not shared');
                    for (const entity of pile.entities) {
                        check(this.ext.windows.get(entity).stack === branch.inner.idx, 'Wrong pile association');
                        check(forest.forks.get(attached.get(entity)).find_branch(entity) === branch, 'Wrong parent');
                    }
                }
            }
            console.log('[pile-model-check] PASS ' + name);
            next?.();
        });
    }

    start() {
        const ext = this.ext, at = ext.auto_tiler;
        const [a, b, c] = this.windows;
        for (const window of this.windows) {
            window.ignore_detach = true;
            at.detach_window(ext, window.entity);
        }
        at.auto_tile(ext, a, true);
        const single = at.forest.stacks.get(a.stack);
        this.verify('first window is a full-area singleton', () =>
            single.entities.length === 1 && a.rect().eq(single.rect), () => {
            at.auto_tile(ext, b, true);
            at.auto_tile(ext, c, true);
            this.verify('normal auto-tiling joins singleton and multi-window piles', () =>
                this.windows.every(window => at.forest.stacks.get(window.stack) === single) && single.entities.length === 3,
                () => {
                ext.tiler.move_from_stack(ext, at.find_stack(a.entity), a, Direction.Up);
                const detached = at.forest.stacks.get(a.stack);
                this.verify('directional split creates a singleton above the remaining pile', () =>
                    detached !== single && detached.entities.length === 1 && a.rect().eq(detached.rect) &&
                    a.rect().y + a.rect().height <= single.rect.y, () => {
                    a.meta.minimize();
                    b.meta.minimize();
                    this.verify('minimizing removes an empty pile and retains a surviving singleton', () =>
                        a.stack === null && b.stack === null && detached.entities.length === 0 &&
                        single.entities.length === 1 && c.rect().eq(single.rect), () => {
                        a.meta.unminimize();
                        b.meta.unminimize();
                        this.verify('unminimizing rejoins a live pile or uses automatic placement', () =>
                            this.windows.every(window => at.forest.stacks.get(window.stack) === single) &&
                            single.entities.length === 3, () => {
                            this.float(a);
                            this.verify('floating leaves the tiling tree', () =>
                                a.stack === null && !at.attached.contains(a.entity) && ext.is_floating(a), () => {
                                this.float(a);
                                this.verify('tiling a floating window rejoins its destination pile', () =>
                                    a.stack === c.stack && !ext.is_floating(a));
                            });
                        });
                    });
                });
            });
        });
    }

    float(window) {
        // The isolated compositor has no interactive seat to select a window.
        const original = this.ext.focus_window;
        this.ext.focus_window = () => window;
        try { this.ext.auto_tiler.toggle_floating(this.ext); }
        finally { this.ext.focus_window = original; }
    }

    disable() {
        AutoTiler.prototype.reset_to_pile = this.original;
    }
}
"""


if __name__ == '__main__':
    run(Path(__file__).with_name('pile-runtime-client.mjs').read_text(), CHECK, 'pile-model-check', 7,
        seconds=14, full_extension=True)
