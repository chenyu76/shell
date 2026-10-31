#!/usr/bin/env python3
"""Exercise navigation, shared secondary trees and raised windows in real GNOME."""

from pathlib import Path
from runtime_check import run


CHECK = """
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import {AutoTiler} from '../pop-shell@system76.com/auto_tiler.js';
import {Direction} from '../pop-shell@system76.com/tiling.js';
import {Rectangle} from '../pop-shell@system76.com/rectangle.js';
import {entity_eq} from '../pop-shell@system76.com/ecs.js';

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
function pass(name) { console.log('[multi-monitor-check] PASS ' + name); }

export default class MultiMonitorCheck extends Extension {
    enable() {
        this.original = AutoTiler.prototype.reset_to_pile;
        const test = this;
        AutoTiler.prototype.reset_to_pile = function(ext, ...args) {
            test.ext = ext;
            return test.original.call(this, ext, ...args);
        };
        this.start().catch(error => {
            console.error(error);
            console.log('[multi-monitor-check] FAIL ' + error.message);
        });
    }

    async start() {
        await delay(1500);
        Main.overview.hide();
        const mutter = new Gio.Settings({schema_id: 'org.gnome.mutter'});
        mutter.set_boolean('workspaces-only-on-primary', true);
        new Gio.Settings({schema_id: 'org.gnome.desktop.wm.preferences'}).set_int('num-workspaces', 2);
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
        const ext = this.ext, at = ext.auto_tiler, forest = at.forest;
        const windows = metas.map(meta => ext.get_window(meta));
        const [a, b, c] = windows;
        const primary = global.display.get_primary_monitor(), secondary = 1 - primary;
        check(global.display.get_n_monitors() === 2, 'Two virtual monitors are required');
        for (const window of windows) {
            window.ignore_detach = true;
            at.detach_window(ext, window.entity);
            window.meta.move_to_monitor(primary);
        }
        at.attach_to_workspace(ext, a, [primary, 0]);
        b.meta.move_to_monitor(secondary);
        at.attach_to_workspace(ext, b, [secondary, 0]);
        at.attach_to_workspace(ext, c, [primary, 0]);
        await delay(600);

        const primaryArea = ext.monitor_work_area(primary), secondaryArea = ext.monitor_work_area(secondary);
        const outward = secondaryArea.x > primaryArea.x ? Direction.Right : Direction.Left;
        const inward = outward === Direction.Right ? Direction.Left : Direction.Right;
        const primaryFront = ext.windows.get(forest.stacks.get(a.stack).active);
        await this.navigate(primaryFront, outward, b);
        await this.navigate(b, inward, primaryFront);
        pass('directions cross monitors from both multi-window and singleton piles');

        const front = forest.stacks.get(a.stack).active;
        await this.navigate(ext.windows.get(front), Direction.Down);
        check(forest.stacks.get(a.stack).active !== front, 'Free axis did not cycle the pile');
        pass('the free axis still cycles a pile beside another monitor');

        // Keep one primary window on the new workspace and drop it onto the
        // workspace-independent secondary monitor through the real drop path.
        global.workspace_manager.get_workspace_by_index(1).activate(global.get_current_time());
        c.meta.change_workspace_by_index(1, false);
        await delay(600);
        const pointer = ext.cursor_status;
        ext.cursor_status = () => [new Rectangle([
            secondaryArea.x + secondaryArea.width / 2, secondaryArea.y + secondaryArea.height / 2, 1, 1,
        ]), secondary];
        try { at.on_drop(ext, c, true); }
        finally { ext.cursor_status = pointer; }
        await delay(700);
        check(b.stack === c.stack, 'Drop created an overlapping secondary pile');
        check([...forest.forks.values()].filter(fork => fork.is_toplevel && fork.monitor === secondary).length === 1,
            'Secondary monitor owns duplicate layout trees');
        const pile = forest.stacks.get(b.stack);
        check(pile.workspace === 0, 'Secondary tree was assigned a workspace');
        check(forest.find_toplevel(ext, [secondary, 1]) !== null, 'Active workspace cannot find the shared tree');
        check(at.largest_on_workspace(ext, secondary, 1) !== null, 'Drop preview cannot find the shared tree');
        const back = ext.windows.get(pile.entities[0]);
        const cursor = new Rectangle([back.rect().x + 1, back.rect().y + 1, 1, 1]);
        check([...ext.windows_at_pointer(cursor, secondary, 1)].includes(back),
            'Pointer lookup lost a secondary window from a different workspace');
        check(b.same_workspace(), 'Visible secondary window was treated as off-workspace');
        pass('a drop after switching workspaces joins the existing secondary pile');

        // No focus callback: raising an already focused client still needs to
        // promote its pile slot, including after a native titlebar grab.
        for (const grabbed of [false, true]) {
            const clicked = ext.windows.get(pile.entities[0]);
            await this.focus(clicked);
            const other = ext.windows.get(pile.entities.find(entity => !entity_eq(entity, clicked.entity)));
            pile.activate(other.entity);
            await wait_for('background slot', () => ext.movements.is_empty() && clicked.rect().x < other.rect().x);
            check(clicked.meta.has_focus() && !entity_eq(pile.active, clicked.entity),
                'The click must start with a focused window in a background slot');
            if (grabbed) ext.on_grab_start(clicked.meta, Meta.GrabOp.MOVING);
            clicked.meta.raise();
            if (grabbed) ext.on_grab_end(clicked.meta, Meta.GrabOp.MOVING);
            await delay(500);
            check(pile.active === clicked.entity, 'Raised window did not become the pile front');
            const slots = pile.entities.map(entity => ext.windows.get(entity).rect());
            check(slots[0].x < slots[1].x && slots[0].y < slots[1].y,
                'Raised window covered the other window without changing slots');
            check(clicked.rect().eq(slots.at(-1)), 'Raised window was left in its background slot');
            other.meta.raise();
            check(pile.active === clicked.entity, 'An unfocused raise replaced the selected pile window');
            clicked.meta.raise();
        }
        pass('raise-only clicks update geometry with and without a native grab');

        const source = at.get_parent_fork(a.entity);
        source.migrate(ext, forest, secondaryArea.clone(), secondary, 1);
        await delay(600);
        check(windows.every(window => window.stack === b.stack), 'Migration created a second secondary pile');
        check([...forest.forks.values()].filter(fork => fork.is_toplevel && fork.monitor === secondary).length === 1,
            'Migration retained an overlapping layout tree');
        pass('migration into a populated secondary display merges its layout trees');

        const order = [...pile.entities];
        const background = ext.windows.get(order[0]);
        ext.monitors.insert(background.entity, [secondary, 1 - background.workspace_id()]);
        ext.on_workspace_changed(background);
        check(pile.entities.length === order.length && pile.entities.every((entity, i) => entity_eq(entity, order[i])),
            'A shared-workspace notification detached and reordered a pile member');
        pass('shared-workspace events preserve membership and pile order');

        mutter.set_boolean('workspaces-only-on-primary', false);
        await wait_for('workspace-aware secondary layout', () => !ext.settings.workspaces_only_on_primary() &&
            windows.every(window => !window.meta.is_on_all_workspaces() &&
                at.get_parent_fork(window.entity).workspace === window.workspace_id()));
        const secondaryWorkspace = b.workspace_id();
        const movedWorkspace = 1 - secondaryWorkspace;
        c.reassignment = true;
        c.meta.change_workspace_by_index(movedWorkspace, false);
        // A geometry callback may refresh this cache before the workspace event runs.
        ext.monitors.insert(c.entity, ext.workspace_id(c));
        await wait_for('separate secondary workspaces', () => b.stack !== c.stack &&
            forest.find_toplevel(ext, [secondary, secondaryWorkspace]) !== null &&
            forest.find_toplevel(ext, [secondary, movedWorkspace]) !== null);
        check(!c.reassignment, 'New attachment retained an obsolete monitor migration');
        mutter.set_boolean('workspaces-only-on-primary', true);
        await wait_for('shared secondary workspace', () => windows.every(window => window.stack === b.stack) &&
            [...forest.toplevel.values()].filter(([, [monitor]]) => monitor === secondary).length === 1);
        pass('workspace mode changes regroup existing secondary windows');

        const sharedRoot = forest.find_toplevel(ext, [secondary, 1]);
        ext.on_workspace_index_changed(0, 1);
        check(forest.stacks.get(b.stack).workspace === 0 && entity_eq(forest.find_toplevel(ext, [secondary, 1]), sharedRoot),
            'Primary workspace reindexing changed the shared secondary tree');
        pass('workspace reindexing preserves the secondary tree');
    }

    async focus(window) {
        window.activate(false);
        await wait_for('focus on ' + window.title(), () => window.meta.has_focus());
        // Headless Mutter changes focus, but has no seat to deliver Shell's callback.
        this.ext.on_focused(window);
        await wait_for('focused layout', () => this.ext.movements.is_empty());
    }

    async navigate(source, direction, expected) {
        const ext = this.ext;
        await this.focus(source);
        ext.stack_cycle(direction);
        const target = expected ?? ext.windows.get(ext.auto_tiler.forest.stacks.get(source.stack).active);
        await wait_for('directional focus on ' + target.title(), () => target.meta.has_focus());
        ext.on_focused(target);
    }

    disable() { AutoTiler.prototype.reset_to_pile = this.original; }
}
"""


if __name__ == '__main__':
    client = Path(__file__).with_name('pile-runtime-client.mjs').read_text()
    run(client, CHECK, 'multi-monitor-check', 8, seconds=18, monitors=('1280x900', '1280x900'))
