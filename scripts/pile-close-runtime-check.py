#!/usr/bin/env python3
"""Run after make compile; requires GNOME Shell with headless Wayland support."""

import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile


CLIENT = """
import Gtk from 'gi://Gtk?version=4.0';
import GLib from 'gi://GLib';
Gtk.init();
const windows = ['Pile A', 'Pile B', 'Pile C'].map(title => {
    const window = new Gtk.Window({title, default_width: 420, default_height: 310});
    window.set_child(new Gtk.Label({label: title}));
    window.present();
    return window;
});
const loop = new GLib.MainLoop(null, false);
GLib.timeout_add(GLib.PRIORITY_DEFAULT, 10000, () => { loop.quit(); return false; });
loop.run();
"""

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
                later(1200, () => this.close_front(windows));
                return false;
            });
        });
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
                if (windows.length > 1) this.close_front(windows);
                return false;
            });
        });
    }

    disable() {
        WindowAnimations.prototype.move = this.original;
    }
}
"""


def run_session(root):
    for schema, key, value in [
        ('org.gnome.shell', 'enabled-extensions', "['pop-shell@system76.com', 'pile-close-check@local']"),
        ('org.gnome.shell', 'disable-user-extensions', 'false'),
        ('org.gnome.shell.extensions.pop-shell', 'tile-by-default', 'false'),
        ('org.gnome.mutter', 'dynamic-workspaces', 'false'),
    ]:
        subprocess.run(['gsettings', 'set', schema, key, value], check=True)
    result = subprocess.run(
        ['timeout', '14s', 'gnome-shell', '--headless', '--wayland', '--no-x11',
         '--wayland-display', 'pile-check', '--virtual-monitor', '1280x900'],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
    )
    log = root / 'shell.log'
    log.write_text(result.stdout)
    print(f'GNOME log: {log}')
    failures = [line for line in result.stdout.splitlines()
                if 'JS ERROR' in line or 'Window animation unavailable' in line]
    for line in failures:
        print(line)
    if failures or result.stdout.count('[pile-close-check] PASS') != 2:
        raise SystemExit('FAIL: close/focus/resize regression; inspect the GNOME log')
    print('PASS: pile 3 -> 2 -> 1; queued focus changes produce one resize per survivor with fixed frame origins')


def main():
    if len(sys.argv) > 1:
        run_session(Path(sys.argv[1]))
        return
    build = Path(__file__).resolve().parents[1] / '_build'
    root = Path(tempfile.mkdtemp(prefix='pop-shell-pile-close-'))
    (root / 'runtime').mkdir(mode=0o700)
    extensions = root / 'data/gnome-shell/extensions'
    extension = extensions / 'pop-shell@system76.com'
    shutil.copytree(build, extension)
    test = extensions / 'pile-close-check@local'
    test.mkdir()
    test.joinpath('metadata.json').write_text(json.dumps({
        'uuid': test.name, 'name': 'Pile close regression check',
        'description': 'Isolated full-extension close and focus test',
        'shell-version': json.loads(build.joinpath('metadata.json').read_text())['shell-version'],
    }))
    test.joinpath('extension.js').write_text(CHECK)
    client = root / 'client.js'
    client.write_text(CLIENT)
    env = dict(os.environ, GSETTINGS_BACKEND='keyfile', GTK_A11Y='none', LIBGL_ALWAYS_SOFTWARE='1',
               GSETTINGS_SCHEMA_DIR=str(extension / 'schemas'), WAYLAND_DISPLAY='pile-check',
               PILE_CHECK_CLIENT=str(client),
               **{f'XDG_{name.upper()}_HOME': str(root / name) for name in ['config', 'data', 'cache', 'state']})
    env['XDG_RUNTIME_DIR'] = str(root / 'runtime')
    subprocess.run(['dbus-run-session', '--', sys.executable, __file__, str(root)], env=env, check=True)


if __name__ == '__main__':
    main()
