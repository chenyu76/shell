// Run after make compile: node scripts/reset-windows-check.mjs
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { STUB_URL } from './gi-stub-hooks.mjs';
register('./reset-windows-stubs.mjs', import.meta.url);
const { Window, Widget } = await import(STUB_URL);
globalThis.global = {
    display: { get_primary_monitor: () => 0, connect: () => 1, disconnect() {} },
    workspace_manager: { get_active_workspace_index: () => 0 },
    window_group: { add_child() {}, set_child_above_sibling() {} },
};
globalThis.popShellExtension = { getSettings: () => ({ get_uint: () => 0 }) };
const { World } = await import('../target/ecs.js');
const { Forest } = await import('../target/forest.js');
const { AutoTiler } = await import('../target/auto_tiler.js');
const { Rectangle } = await import('../target/rectangle.js');
const Tags = await import('../target/tags.js');

const ext = Object.assign(new World(), {
    dpi: 1, gap_outer: 8, gap_inner: 8, gap_inner_half: 4, grab_op: null,
    tiler: { window: null, resizing_window: false },
    settings: {
        smart_gaps: () => false, stack_offset_x: () => 12, stack_offset_y: () => 40,
        workspaces_only_on_primary: () => false,
    },
    conf: { window_has_pile_title: () => false },
    monitor_work_area: monitor => new Rectangle([monitor * 1000, 0, 1000, 800]),
    active_workspace: () => 0,
    window_animations: { visual_rect: (window, fallback) => fallback ?? window.rect() },
    movements: { get: () => null },
    connect_window() {},
    size_signals_block(window) { this.add_tag(window.entity, Tags.Blocked); },
    size_signals_unblock(window) { this.delete_tag(window.entity, Tags.Blocked); },
    show_border_on_focused() {},
});
ext.windows = ext.register_storage();
ext.monitors = ext.register_storage();
const attached = ext.register_storage();
const forest = new Forest()
    .connect_on_attach((parent, entity) => attached.insert(entity, parent))
    .connect_on_detach(entity => {
        const window = ext.windows.get(entity);
        if (!window.ignore_detach) window.prev_rect = null;
    });
const tiler = new AutoTiler(forest, attached);
ext.auto_tiler = tiler;

function makeWindow(monitor = 0, workspace = 0) {
    const entity = ext.create_entity();
    let rect = new Rectangle([monitor * 1000 + 50, 50, 420, 310]);
    const state = { minimized: false, maximized: false, fullscreen: false };
    const actor = new Widget();
    const meta = Object.assign(new Window(), {
        connect: () => 1, disconnect() {}, raise() {},
        get_compositor_private: () => actor,
        get_wm_class: () => 'Test',
        is_fullscreen: () => state.fullscreen,
        unminimize() { state.minimized = false; },
        unmaximize() { state.maximized = false; },
        unmake_fullscreen() { state.fullscreen = false; },
    });
    Object.defineProperty(meta, 'minimized', { get: () => state.minimized });
    const window = {
        entity, meta, state, stack: null, ignore_detach: false, prev_rect: rect.clone(),
        actor_exists: () => true, same_workspace: () => workspace === 0,
        is_maximized: () => state.maximized, rect: () => rect.clone(),
        title: () => 'Test',
        move(_ext, target, complete) { rect = Rectangle.from_meta(target); complete?.(); },
    };
    ext.windows.insert(entity, window);
    ext.monitors.insert(entity, [monitor, workspace]);
    return window;
}

const a = makeWindow(), b = makeWindow(), c = makeWindow(1);
const other = makeWindow(1, 1);
tiler.attach_to_monitor(ext, a, [0, 0], false);
tiler.attach_to_window(ext, a, b, { auto: 0 });
tiler.create_stack(ext, a);
tiler.attach_to_monitor(ext, other, [1, 1], false);
tiler.create_stack(ext, other);
const otherParent = attached.get(other.entity);
const otherStack = other.stack;
const otherRect = other.rect();
const floatingRect = c.prev_rect;
ext.add_tag(c.entity, Tags.Floating);
a.state.maximized = true;
b.state.minimized = true;
c.state.fullscreen = true;
b.was_attached_to = [attached.get(b.entity), false];

function checkPile(windows) {
    const root = forest.forks.get(attached.get(windows[0].entity));
    assert.equal(root.right, null);
    assert.equal(root.left.inner.kind, 3);
    assert.deepEqual(root.left.inner.entities, windows.map(window => window.entity));
    assert.equal([...forest.forks.values()].filter(fork => fork.workspace === 0).length, 1);
    assert.equal(new Set(windows.map(window => window.stack)).size, 1);
    for (const window of windows) {
        assert.equal(window.ignore_detach, false);
        assert.equal(ext.contains_tag(window.entity, Tags.Floating), false);
        assert.equal(ext.contains_tag(window.entity, Tags.ForceTile), true);
        assert.equal(ext.contains_tag(window.entity, Tags.Blocked), false);
    }
    assert.deepEqual(attached.get(other.entity), otherParent);
    assert.equal(other.stack, otherStack);
    assert.ok(other.rect().eq(otherRect));
}

tiler.reset_to_pile(ext, [b, a, c], [0, 0]);
checkPile([b, a, c]);
assert.equal(a.state.maximized, false);
assert.equal(b.state.minimized, false);
assert.equal(c.state.fullscreen, false);
assert.equal(b.was_attached_to, undefined);
assert.equal(c.prev_rect, floatingRect);
assert.equal(forest.stacks.get(b.stack).active, b.entity);
assert.ok([a, b, c].every(window => window.rect().width === 960 && window.rect().height === 704));
console.log('ok  mixed layouts, floating and hidden windows become one pile without changing another workspace');

tiler.reset_to_pile(ext, [b, a, c], [0, 0]);
checkPile([b, a, c]);
assert.equal([...forest.stacks.values()].length, 2);
console.log('ok  repeated reset replaces the old pile without leaving roots or containers');

tiler.reset_to_pile(ext, [], [0, 0]);
checkPile([b, a, c]);
const single = makeWindow(2, 2);
tiler.reset_to_pile(ext, [single], [2, 2]);
assert.equal(forest.forks.get(attached.get(single.entity)).left.inner.kind, 3);
assert.ok(single.rect().eq(new Rectangle([2008, 8, 984, 784])));
console.log('ok  empty resets are harmless and a single window remains a valid pile');
console.log('ALL RESET WINDOWS CHECKS PASSED');
