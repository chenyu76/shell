#!/usr/bin/env python3
"""After make compile, verify minimum-sized Wayland windows in isolated GNOME."""

import importlib.util
from pathlib import Path
import subprocess
import sys


CLIENT = """
import Gtk from 'gi://Gtk?version=4.0';
import GLib from 'gi://GLib';
Gtk.init();
const windows = [false, true].map(decorated => {
    const window = new Gtk.Window({title: 'Minimum Size Check ' + decorated, decorated,
        default_width: 942, default_height: 720});
    const content = new Gtk.Label({label: 'Minimum-sized Wayland window'});
    content.set_size_request(942, 720);
    window.set_child(content);
    window.present();
    return window;
});
new GLib.MainLoop(null, false).run();
"""

CHECK = """
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import {WindowAnimations} from '../pop-shell@system76.com/window_animation.js';

function later(ms, callback) {
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => { callback(); return false; });
}
function check(condition, message) {
    if (!condition) throw new Error(message);
}
export default class MinimumSizeCheck extends Extension {
    enable() {
        this.animations = new WindowAnimations(() => {});
        later(1500, () => {
            Main.overview.hide();
            Gio.Subprocess.new(['gjs', '-m', GLib.getenv('PILE_CHECK_CLIENT')], Gio.SubprocessFlags.NONE);
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
                this.remaining = global.get_window_actors().map(actor => actor.get_meta_window())
                    .filter(meta => meta.get_title()?.startsWith('Minimum Size Check'));
                if (this.remaining.length !== 2 || this.remaining.some(meta => !meta.get_compositor_private()?.mapped)) return true;
                later(500, () => this.move(this.remaining.shift(), false));
                return false;
            });
        });
    }

    move(meta, animated) {
        const x = animated ? 300 : 200;
        const y = animated ? 150 : 100;
        const clientMinimum = meta.get_frame_rect();
        const [, width, height] = meta.get_min_size();
        clientMinimum.width = width;
        clientMinimum.height = height;
        const minimum = meta.client_rect_to_frame_rect(clientMinimum);
        // Request the same impossible size as the affected WeChat window.
        this.animations.move({meta}, {x, y, width: 942, height: 506}, animated);
        later(750, () => {
            const frame = meta.get_frame_rect();
            const actor = meta.get_compositor_private();
            check(frame.x === x && frame.y === y, 'Minimum-size constraint swallowed the move');
            check(frame.width === minimum.width && frame.height === minimum.height,
                'Minimum frame size was not respected');
            check(actor.opacity === 255 && actor.scale_x === 1 && actor.scale_y === 1,
                'Animation did not restore the actor');
            console.log('[minimum-size-check] PASS animated=' + animated);
            if (!animated) this.move(meta, true);
            else if (this.remaining.length) this.move(this.remaining.shift(), false);
        });
    }

    disable() {
        this.animations.cancel_all();
    }
}
"""


def run_session(root):
    # Only the test extension is enabled; it imports the real movement controller.
    subprocess.run(['gsettings', 'set', 'org.gnome.shell', 'enabled-extensions',
                    "['pile-close-check@local']"], check=True)
    subprocess.run(['gsettings', 'set', 'org.gnome.shell', 'disable-user-extensions', 'false'], check=True)
    result = subprocess.run(
        ['timeout', '10s', 'gnome-shell', '--headless', '--wayland', '--no-x11',
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
    if failures or result.stdout.count('[minimum-size-check] PASS') != 4:
        raise SystemExit('FAIL: minimum-sized window movement; inspect the GNOME log')
    print('PASS: minimum-sized Wayland windows move with/without CSD and with animations enabled/disabled')


if __name__ == '__main__':
    # Reuse the private D-Bus/XDG session and build-copy setup of the close check.
    sys.dont_write_bytecode = True
    spec = importlib.util.spec_from_file_location('pile_check', Path(__file__).with_name('pile-close-runtime-check.py'))
    harness = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(harness)
    harness.__file__ = __file__
    harness.CLIENT = CLIENT
    harness.CHECK = CHECK
    harness.run_session = run_session
    harness.main()
