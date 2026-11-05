#!/usr/bin/env python3
"""Exercise lock suspension and display recovery in a private GNOME session."""

from pathlib import Path
from runtime_check import run


CHECK = """
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import {AutoTiler} from '../pop-shell@system76.com/auto_tiler.js';
import {WindowAnimations} from '../pop-shell@system76.com/window_animation.js';

function check(condition, message) {
    if (!condition) throw new Error(message);
}
function delay(ms) {
    return new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
        resolve(); return false;
    }));
}
async function wait_for(description, condition) {
    const deadline = GLib.get_monotonic_time() + 3_000_000;
    while (!condition()) {
        check(GLib.get_monotonic_time() < deadline, 'Timed out waiting for ' + description);
        await delay(25);
    }
}
function display_config(method, params = null) {
    return new Promise((resolve, reject) => Gio.DBus.session.call('org.gnome.Mutter.DisplayConfig',
        '/org/gnome/Mutter/DisplayConfig', 'org.gnome.Mutter.DisplayConfig', method, params, null,
        Gio.DBusCallFlags.NONE, -1, null, (connection, result) => {
            try { resolve(connection.call_finish(result).deep_unpack()); }
            catch (error) { reject(error); }
        }));
}

export default class PileLockCheck extends Extension {
    enable() {
        this.original_reset = AutoTiler.prototype.reset_to_pile;
        this.original_move = WindowAnimations.prototype.move;
        this.locked_moves = 0;
        const test = this;
        AutoTiler.prototype.reset_to_pile = function(ext, ...args) {
            test.ext = ext;
            return test.original_reset.call(this, ext, ...args);
        };
        WindowAnimations.prototype.move = function(...args) {
            if (Main.sessionMode.isLocked) test.locked_moves++;
            return test.original_move.apply(this, args);
        };
        this.start().catch(error => {
            console.error(error);
            console.log('[pile-lock-check] FAIL ' + error.message);
            if (Main.sessionMode.isLocked) Main.screenShield.deactivate(false);
        });
    }

    async start() {
        await delay(1500);
        Main.overview.hide();
        Gio.Subprocess.new(['gjs', '-m', GLib.getenv('PILE_CHECK_CLIENT')], Gio.SubprocessFlags.NONE);
        let metas;
        await wait_for('mapped clients', () => {
            metas = global.get_window_actors().map(actor => actor.get_meta_window())
                .filter(meta => meta.get_title()?.startsWith('Pile '));
            return metas.length === 3 && metas.every(meta => meta.get_compositor_private()?.mapped);
        });
        Main.panel.statusArea['pop-shell'].menu._getMenuItems()
            .find(item => item.label?.text === 'Reset Windows').activate(null);
        await delay(600);
        const ext = this.ext, at = ext.auto_tiler;
        this.windows = metas.map(meta => ext.get_window(meta));
        const primary = global.display.get_primary_monitor();
        for (const monitor of [primary, 1 - primary]) {
            for (const window of this.windows) {
                window.ignore_detach = true;
                at.detach_window(ext, window.entity);
                window.meta.move_to_monitor(monitor);
                at.attach_to_workspace(ext, window, [monitor, 0]);
            }
            await delay(500);
            await this.lock_cycle('settled pile on monitor ' + monitor);
            await this.lock_cycle('queued rotation on monitor ' + monitor, {queued: true});
        }
        await this.lock_cycle('secondary display disconnect and recovery', {queued: true, reconnect: true});
        await this.lock_cycle('workspace added while locked', {add_workspace: true});
        await this.untiled_move();
        await this.untiled_move({disable_tiling: true});
    }

    async lock_cycle(name, {queued = false, reconnect = false, add_workspace = false} = {}) {
        const ext = this.ext, at = ext.auto_tiler;
        const pile = at.forest.stacks.get(this.windows[0].stack);
        const root = at.get_parent_fork(pile.active);
        if (queued) {
            pile.reset_cycle();
            pile.cycle(true);
            check(!ext.movements.is_empty(), 'Rotation did not queue any moves');
        }
        Main.screenShield.lock(false);
        await wait_for('extension suspension', () => Main.sessionMode.isLocked && !ext.animate_windows &&
            ext.movements.is_empty());
        this.locked_moves = 0;
        pile.restack();
        for (const window of this.windows) window.meta.raise();
        if (reconnect) await this.reconnect_displays();
        if (add_workspace) global.workspace_manager.append_new_workspace(false, global.get_current_time());
        // Exercise resumption when native geometry no longer matches the tree.
        const front = ext.windows.get(pile.active).rect();
        for (const window of this.windows) window.meta.move_frame(false, front.x, front.y);
        await delay(150);
        check(this.locked_moves === 0, 'Pile submitted geometry while the lock screen owned the displays');
        check(this.windows.every(window => {
            const rect = window.rect();
            return rect.x === front.x && rect.y === front.y;
        }), 'The recovery scenario did not start with overlapping native frames');
        Main.screenShield.deactivate(false);
        await wait_for('extension resumption', () => !Main.sessionMode.isLocked && ext.animate_windows);
        await wait_for('restored pile slots', () => {
            const rects = pile.entities.map(entity => ext.windows.get(entity).rect());
            return ext.movements.is_empty() && rects.every((rect, i) => i === 0 ||
                (rect.x > rects[i - 1].x && rect.y > rects[i - 1].y)) &&
                rects[0].x === pile.rect.x && rects[0].y === pile.rect.y &&
                rects.at(-1).x + rects.at(-1).width === pile.rect.x + pile.rect.width &&
                rects.at(-1).y + rects.at(-1).height === pile.rect.y + pile.rect.height;
        });
        check(this.windows.every(window => at.forest.stacks.get(window.stack) === pile &&
            at.get_parent_fork(window.entity) === root), 'Unlock rebuilt the pile membership');
        await delay(300);
        for (const window of this.windows) {
            const actor = window.meta.get_compositor_private();
            check(actor.opacity === 255 && actor.scale_x === 1 && actor.scale_y === 1,
                'Unlock retained an animation transform');
        }
        console.log('[pile-lock-check] PASS ' + name);
    }

    async untiled_move({disable_tiling = false} = {}) {
        const ext = this.ext, window = this.windows[0];
        if (disable_tiling) {
            ext.auto_tile_off();
        } else {
            window.activate(false);
            await wait_for('native focus', () => window.meta.has_focus());
            ext.on_focused(window);
            ext.auto_tiler.toggle_floating(ext);
        }
        await wait_for('untiled window', () => window.stack === null && ext.movements.is_empty());
        Main.screenShield.lock(false);
        await wait_for('extension suspension', () => Main.sessionMode.isLocked && !ext.animate_windows);
        const area = ext.monitor_work_area(window.meta.get_monitor());
        const target = {x: area.x + 100, y: area.y + 100, width: 500, height: 400};
        window.move(ext, target);
        await wait_for('untiled movement', () => window.rect().eq(target));
        Main.screenShield.deactivate(false);
        await wait_for('extension resumption', () => !Main.sessionMode.isLocked && ext.animate_windows);
        await delay(300);
        check(window.rect().eq(target), 'Unlock replaced an untiled movement');
        console.log('[pile-lock-check] PASS untiled movement with tiling ' + (disable_tiling ? 'disabled' : 'enabled'));
    }

    async reconnect_displays() {
        const [, monitors, logical] = await display_config('GetCurrentState');
        const configs = logical.map(([x, y, scale, transform, primary, specs]) => [
            x, y, scale, transform, primary, specs.map(spec => {
                const monitor = monitors.find(([other]) => other[0] === spec[0]);
                const mode = monitor[1].find(mode => mode[6]['is-current']?.deep_unpack());
                return [spec[0], mode[0], {}];
            }),
        ]);
        for (const config of [configs.filter(config => config[4]), configs]) {
            const [serial] = await display_config('GetCurrentState');
            await display_config('ApplyMonitorsConfig', new GLib.Variant('(uua(iiduba(ssa{sv}))a{sv})',
                [serial, 1, config, {}]));
            await delay(250);
        }
    }

    disable() {
        AutoTiler.prototype.reset_to_pile = this.original_reset;
        WindowAnimations.prototype.move = this.original_move;
    }
}
"""


if __name__ == '__main__':
    client = Path(__file__).with_name('pile-runtime-client.mjs').read_text()
    run(client, CHECK, 'pile-lock-check', 8, seconds=20, monitors=('1280x900', '1280x900'),
        session_modes=('user', 'unlock-dialog'))
