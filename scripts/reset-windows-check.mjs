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
const { Tiler, Direction } = await import('../target/tiling.js');
const { Orientation } = await import('../target/lib.js');
const { Keybindings } = await import('../target/keybindings.js');
const { FocusSelector } = await import('../target/focus.js');
const Tags = await import('../target/tags.js');

for (const index of [0, 1]) {
    const world = new World();
    const storage = world.register_storage();
    const entities = Array.from({ length: 2 }, () => world.create_entity());
    const previous = entities[index];
    const snapshot = [...previous];
    storage.insert(previous, 'previous');
    world.delete_entity(previous);
    const replacement = world.create_entity();
    storage.insert(replacement, 'replacement');
    assert.deepEqual(previous, snapshot, 'Reusing a slot must not rewrite an outstanding entity ID');
    assert.deepEqual(replacement, [snapshot[0], snapshot[1] + 1]);
    assert.equal(storage.get(previous), null);
    assert.equal(storage.get(replacement), 'replacement');
    assert.equal(world.capacity, 2, 'Slot zero must be reused like any other slot');
    assert.equal(world.length, 2);
}
console.log('ok  entity reuse preserves old IDs and rejects stale component lookups, including slot zero');

const ext = Object.assign(new World(), {
    dpi: 1, gap_outer: 8, gap_inner: 8, gap_inner_half: 4, grab_op: null,
    tiler: { window: null, resizing_window: false },
    settings: {
        smart_gaps: () => false, stack_offset_x: () => 12, stack_offset_y: () => 40,
        workspaces_only_on_primary: () => false, stacking_with_mouse: () => true,
        unmaximize_on_focus: () => true,
    },
    conf: { window_has_pile_title: () => false, window_shall_float: () => false },
    monitor_work_area: monitor => new Rectangle([monitor * 1000, 0, 1000, 800]),
    active_workspace: () => 0,
    previously_focused: () => null, should_ignore_workspace: () => false,
    workspace_id(window) { return this.monitors.get(window.entity); },
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
    const state = { minimized: false, maximized: false, fullscreen: false, moves: [] };
    const actor = new Widget();
    const meta = Object.assign(new Window(), {
        connect: () => 1, disconnect() {}, raise() {},
        get_compositor_private: () => actor,
        get_wm_class: () => 'Test', get_title: () => 'Test',
        has_focus: () => false,
        is_fullscreen: () => state.fullscreen,
        change_workspace_by_index(index) { state.workspace = index; },
        unminimize() { state.minimized = false; },
        unmaximize() { state.maximized = false; },
        unmake_fullscreen() { state.fullscreen = false; },
    });
    Object.defineProperty(meta, 'minimized', { get: () => state.minimized });
    const window = {
        entity, meta, state, stack: null, ignore_detach: false, prev_rect: rect.clone(),
        actor_exists: () => true, same_workspace: () => workspace === 0,
        is_maximized: () => state.maximized, rect: () => rect.clone(),
        title: () => 'Test', is_tilable: () => true, activate() {},
        move(_ext, target, complete) {
            rect = Rectangle.from_meta(target);
            state.moves.push(rect.clone());
            complete?.();
        },
    };
    ext.windows.insert(entity, window);
    ext.monitors.insert(entity, [monitor, workspace]);
    return window;
}

const a = makeWindow(), b = makeWindow(), c = makeWindow(1);
const other = makeWindow(1, 1);
tiler.attach_to_monitor(ext, a, [0, 0], false);
tiler.attach_to_window(ext, a, b, { orientation: Orientation.HORIZONTAL, swap: false });
tiler.attach_to_monitor(ext, other, [1, 1], false);
const otherParent = attached.get(other.entity);
const otherStack = other.stack;
const otherRect = other.rect();
const floatingRect = c.prev_rect;
ext.add_tag(c.entity, Tags.Floating);
a.state.maximized = true;
b.state.minimized = true;
c.state.fullscreen = true;
b.was_attached_to = forest.stacks.get(b.stack);

function checkPile(windows) {
    const root = forest.forks.get(attached.get(windows[0].entity));
    assert.equal(root.right, null);
    assert.equal(root.left.inner.kind, 3);
    const pile = forest.stacks.get(windows[0].stack);
    assert.equal(root.left.inner.entities, pile.entities, "The tree must read the pile's only array");
    assert.deepEqual(new Set(pile.entities), new Set(windows.map(window => window.entity)));
    assert.equal(pile.active, pile.entities.at(-1));
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

const root = forest.forks.get(attached.get(b.entity));
const pile = forest.stacks.get(b.stack);
const members = root.left.inner.entities;
pile.activate(a.entity);
pile.cycle(true);
assert.equal(members, pile.entities);
assert.equal(members.at(-1), pile.active);
const removed = members[0];
tiler.detach_window(ext, removed);
assert.equal(members.length, 2, 'Removing through the tree must splice the shared list only once');
assert.ok(!members.includes(removed));
const joined = makeWindow();
const front = pile.active;
forest.attach_stack(ext, root.left.inner, root, joined.entity, true);
assert.equal(members, pile.entities);
assert.equal(pile.active, front, 'Joining without focus must keep the current front');
assert.ok(root.left.is_in_stack(joined.entity));
const plain = makeWindow(1);
tiler.attach_to_monitor(ext, plain, [1, 0], false);
tiler.attach_swap(ext, pile.active, plain.entity);
assert.equal(members.at(-1), plain.entity);
assert.equal(pile.active, plain.entity);
assert.equal(new Set(members).size, members.length);
tiler.attach_swap(ext, plain.entity, other.entity);
assert.equal(members.at(-1), other.entity);
assert.equal(forest.stacks.get(plain.stack).active, plain.entity);
assert.equal(members, pile.entities);
console.log('ok  the tree shares one pile order through rotation, detach, attach and cross-pile swaps');

const keyboardTiler = new Tiler(ext);
keyboardTiler.overlay_watch = () => {};
for (const direction of [Direction.Left, Direction.Right, Direction.Up, Direction.Down]) {
    const workspace = direction + 3;
    const windows = [makeWindow(3, workspace), makeWindow(3, workspace), makeWindow(3, workspace)];
    tiler.reset_to_pile(ext, windows, [3, workspace]);
    const stack = forest.stacks.get(windows[0].stack);
    const members = stack.entities;
    const expected = members.slice(0, -1);
    const selected = ext.windows.get(stack.active);
    keyboardTiler.move_from_stack(ext, tiler.find_stack(selected.entity), selected, direction);
    assert.notEqual(selected.stack, null);
    assert.notEqual(selected.stack, windows.find(window => window !== selected).stack);
    assert.equal(stack.entities, members);
    assert.deepEqual(members, expected);
    assert.equal(stack.active, expected.at(-1));
    const parent = forest.forks.get(attached.get(selected.entity));
    const leaf = parent.find_branch(selected.entity);
    assert.equal(leaf.inner.kind, 3);
    assert.deepEqual(leaf.inner.entities, [selected.entity]);
    const expectedArea = direction === Direction.Left || direction === Direction.Up
        ? parent.area_of_left(ext) : parent.area_of_right(ext);
    assert.ok(selected.rect().eq(expectedArea));
    const horizontal = direction === Direction.Left || direction === Direction.Right;
    assert.equal(parent.is_horizontal(), horizontal);
    const length = horizontal ? parent.area.width : parent.area.height;
    assert.ok(Math.abs(parent.length_left - length / 2) < 1, 'A split must divide either axis evenly');
}
console.log('ok  directional movement detaches the front without changing the remaining pile order');


// Check ownership through the real tree rather than just the changed branch.
function checkForest() {
    const piles = new Set(), entities = new Set();
    for (const [root] of forest.toplevel.values()) {
        assert.equal(forest.parents.get(root), null);
        for (const branch of forest.iter(root)) {
            const inner = branch.inner;
            if (inner.kind === 1) {
                assert.ok(forest.forks.get(inner.entity));
                continue;
            }
            assert.equal(inner.kind, 3);
            const pile = forest.stacks.get(inner.idx);
            assert.equal(pile.entities, inner.entities);
            assert.ok(inner.entities.length > 0);
            assert.ok(!piles.has(pile));
            piles.add(pile);
            for (const entity of inner.entities) {
                assert.ok(!entities.has(String(entity)), 'A window must have exactly one pile');
                entities.add(String(entity));
                const window = ext.windows.get(entity);
                assert.equal(window.stack, inner.idx);
                assert.equal(forest.forks.get(attached.get(entity)).find_branch(entity), branch);
            }
        }
    }
    assert.deepEqual(new Set(forest.stacks.values()), piles, 'No orphan containers');
    for (const [entity, window] of ext.windows.iter()) {
        assert.equal(attached.get(entity) !== null, entities.has(String(entity)));
        assert.equal(window.stack !== null, entities.has(String(entity)));
    }
    for (const [entity, fork] of forest.forks.iter()) {
        for (const child of [fork.left, fork.right]) {
            if (child?.inner.kind === 1) assert.deepEqual(forest.parents.get(child.inner.entity), entity);
        }
    }
}
checkForest();

const fresh = [makeWindow(4), makeWindow(4), makeWindow(4)];
tiler.auto_tile(ext, fresh[0], true);
const singleton = tiler.find_stack(fresh[0].entity)[1];
const container = forest.stacks.get(fresh[0].stack);
assert.deepEqual(container.entities, [fresh[0].entity]);
assert.ok(fresh[0].rect().eq(new Rectangle([4008, 8, 984, 784])));
for (const window of fresh.slice(1)) tiler.auto_tile(ext, window, true);
assert.equal(tiler.find_stack(fresh[0].entity)[1], singleton);
assert.equal(new Set(fresh.map(window => window.stack)).size, 1);
for (const window of fresh.slice(1)) tiler.detach_window(ext, window.entity);
assert.equal(forest.stacks.get(fresh[0].stack), container);
assert.deepEqual(singleton.inner.entities, [fresh[0].entity]);
const oldIndex = fresh[0].stack;
const oldRoot = attached.get(fresh[0].entity);
fresh[0].was_attached_to = container;
tiler.detach_window(ext, fresh[0].entity);
assert.equal(forest.stacks.get(oldIndex), null);
assert.equal(forest.forks.get(oldRoot), null);
assert.equal(container.entities.length, 0);
checkForest();
console.log('ok  default placement grows one pile and closing 3→2→1→0 keeps or releases its container');

// A recycled arena slot must not become the original minimized pile.
const recycled = makeWindow(5);
tiler.auto_tile(ext, recycled, true);
assert.equal(recycled.stack, oldIndex);
tiler.restore_window(ext, fresh[0]);
assert.notEqual(fresh[0].stack, recycled.stack);
assert.equal(fresh[0].was_attached_to, undefined);
tiler.attach_to_window(ext, fresh[0], fresh[1], { auto: 0 });
const original = forest.stacks.get(fresh[0].stack);
fresh[1].was_attached_to = original;
tiler.detach_window(ext, fresh[1].entity);
tiler.restore_window(ext, fresh[1]);
assert.equal(forest.stacks.get(fresh[1].stack), original);
assert.equal(original.active, fresh[1].entity);
checkForest();
console.log('ok  restore rejoins the original live pile and ignores a recycled container number');

ext.tiler = keyboardTiler;
const pair = [makeWindow(6), makeWindow(6)];
tiler.reset_to_pile(ext, pair, [6, 0]);
const point = (area, side = 'center') => new Rectangle([
    side === 'left' ? area.x : side === 'right' ? area.x + area.width : area.x + area.width / 2,
    area.y + area.height / 2, 1, 1,
]);
tiler.place_or_stack(ext, pair[0], pair[1], point(tiler.drop_area(...pair), 'left'));
assert.notEqual(pair[0].stack, pair[1].stack);
const rootPair = forest.forks.get(attached.get(pair[0].entity));
assert.ok(pair[0].rect().x < pair[1].rect().x);
const nodes = [rootPair.left, rootPair.right];
tiler.place_or_stack(ext, pair[0], pair[1], point(tiler.drop_area(...pair), 'right'));
assert.equal(rootPair.left, nodes[1]);
assert.equal(rootPair.right, nodes[0]);
tiler.place_or_stack(ext, pair[0], pair[1], point(tiler.drop_area(...pair)));
assert.equal(pair[0].stack, pair[1].stack);
keyboardTiler.move_from_stack(ext, tiler.find_stack(pair[0].entity), pair[0], Direction.Left);
keyboardTiler.move_auto(ext, pair[0], pair[1]);
assert.equal(pair[0].stack, pair[1].stack);
keyboardTiler.move_from_stack(ext, tiler.find_stack(pair[0].entity), pair[0], Direction.Up);
keyboardTiler.move_auto(ext, pair[0], 7);
assert.equal(tiler.get_parent_fork(pair[0].entity).monitor, 7);
const leaf = tiler.find_stack(pair[1].entity)[1];
tiler.place_or_stack(ext, pair[1], pair[1], point(leaf.inner.rect, 'left'));
assert.equal(tiler.find_stack(pair[1].entity)[1], leaf);
assert.deepEqual(leaf.inner.entities, [pair[1].entity]);
checkForest();
console.log('ok  drag edges split or swap piles, centers join, and singleton keyboard moves join or cross monitors');

// Destroy a leaf beside a fork, then remove a nested leaf and check all associations.
const nested = [makeWindow(8), makeWindow(8), makeWindow(8), makeWindow(8)];
tiler.attach_to_monitor(ext, nested[0], [8, 0], false);
for (let i = 1; i < nested.length; i++) {
    tiler.attach_to_window(ext, nested[i - 1], nested[i], { orientation: Orientation.HORIZONTAL, swap: false });
}
const nestedRoot = forest.find_toplevel(ext, [8, 0]);
tiler.detach_window(ext, nested[0].entity);
assert.deepEqual(forest.find_toplevel(ext, [8, 0]), nestedRoot);
checkForest();
tiler.detach_window(ext, nested[2].entity);
checkForest();
const remainingRoot = forest.forks.get(nestedRoot);
const migrationArea = new Rectangle([9000, 0, 1500, 1100]);
const originalMigrationArea = migrationArea.clone();
for (const window of [nested[1], nested[3]]) window.state.moves.length = 0;
remainingRoot.migrate(ext, forest, migrationArea, 9, 2);
assert.ok(migrationArea.eq(originalMigrationArea), 'Migration must not modify the display work area');
assert.equal(remainingRoot.length_left, Math.round(remainingRoot.length() / 2));
for (const window of [nested[1], nested[3]]) {
    const pile = forest.stacks.get(window.stack);
    assert.equal(pile.monitor, 9);
    assert.equal(pile.workspace, 2);
    assert.equal(window.known_workspace, 2);
    assert.equal(window.state.workspace, 2);
    assert.deepEqual(ext.monitors.get(window.entity), [9, 2]);
    assert.equal(window.state.moves.length, 1, 'Migration submits only the final layout');
    const branch = remainingRoot.find_branch(window.entity);
    const expected = branch === remainingRoot.left ? remainingRoot.area_of_left(ext) : remainingRoot.area_of_right(ext);
    assert.ok(window.rect().eq(expected), 'Migration applies its new ratio before arranging windows');
}
checkForest();
console.log('ok  empty leaf collapse and monitor/workspace migration preserve all pile and parent associations');
const floating = makeWindow(10);
tiler.auto_tile(ext, floating, true);
ext.focus_window = () => floating;
ext.register_fn = callback => callback();
tiler.toggle_floating(ext);
assert.equal(floating.stack, null);
assert.equal(attached.get(floating.entity), null);
assert.ok(ext.contains_tag(floating.entity, Tags.Floating));
tiler.toggle_floating(ext);
assert.ok(!ext.contains_tag(floating.entity, Tags.Floating));
assert.deepEqual(tiler.find_stack(floating.entity)[1].inner.entities, [floating.entity]);
checkForest();
console.log('ok  floating leaves the tree and tiling again creates a singleton pile');
ext.settings.smart_gaps = () => true;
const smart = [makeWindow(11), makeWindow(11)];
tiler.attach_to_monitor(ext, smart[0], [11, 0], true);
tiler.attach_to_window(ext, smart[0], smart[1], { auto: 0 });
assert.ok(smart.every(window => window.smart_gapped));
keyboardTiler.move_from_stack(ext, tiler.find_stack(smart[0].entity), smart[0], Direction.Up);
const splitRoot = tiler.get_parent_fork(smart[0].entity);
assert.equal(splitRoot.smart_gapped, false);
assert.equal(splitRoot.area.height, 784);
assert.equal(splitRoot.length_left, 392);
assert.ok(smart.every(window => !window.smart_gapped));
tiler.place_or_stack(ext, smart[0], smart[1], point(tiler.drop_area(...smart)));
const mergedRoot = tiler.get_parent_fork(smart[0].entity);
assert.equal(mergedRoot.smart_gapped, true);
assert.equal(mergedRoot.area.height, 800);
assert.ok(smart.every(window => window.smart_gapped));
checkForest();
console.log('ok  smart gaps follow pile splits and merges while preserving an even split');

const cycling = [makeWindow(12), makeWindow(12), makeWindow(12), makeWindow(12)];
tiler.reset_to_pile(ext, cycling, [12, 0]);
keyboardTiler.move_from_stack(ext, tiler.find_stack(cycling[3].entity), cycling[3], Direction.Right);
const cyclingPile = forest.stacks.get(cycling[0].stack);
const sequence = cyclingPile.entities.slice();
let focused = ext.windows.get(cyclingPile.active);
ext.focus_window = () => focused;
for (const window of cycling) window.activate = () => focused = window;
const bindings = new Keybindings(ext).global;
let index = sequence.length - 1;
for (const [name, step] of [['pile-next', 1], ['pile-previous', -1]]) {
    for (let i = 0; i < sequence.length * 2 + 1; i++) {
        bindings[name]();
        index = (index + step + sequence.length) % sequence.length;
        assert.equal(focused.entity, sequence[index]);
        assert.equal(cyclingPile.active, focused.entity);
    }
}
focused = cycling[3];
bindings['pile-next']();
assert.equal(focused, cycling[3], 'A singleton must not navigate into its neighbour');
focused = makeWindow(12);
bindings['pile-previous']();
assert.equal(focused.stack, null, 'A floating window must stay outside the pile');
focused = null;
bindings['pile-next']();
checkForest();
console.log('ok  dedicated pile shortcuts wrap in both directions beside another tile and ignore singleton or untiled windows');

ext.should_ignore_workspace = monitor => monitor === 13;
const shared = [makeWindow(13, 2), makeWindow(13, 3), makeWindow(13, 1)];
tiler.attach_to_monitor(ext, shared[0], [13, 2], false);
const sharedRoot = tiler.get_parent_fork(shared[0].entity);
assert.equal(sharedRoot.workspace, 0);
for (const window of shared.slice(1)) {
    tiler.attach_to_workspace(ext, window, ext.workspace_id(window));
    assert.equal(window.stack, shared[0].stack);
}
for (const workspace of [0, 1, 2, 3]) {
    assert.deepEqual(forest.find_toplevel(ext, [13, workspace]), sharedRoot.entity);
    assert.ok(shared.includes(tiler.largest_on_workspace(ext, 13, workspace)));
}
const sharedPile = forest.stacks.get(shared[0].stack);
shared[1].was_attached_to = sharedPile;
tiler.detach_window(ext, shared[1].entity);
tiler.restore_window(ext, shared[1]);
assert.equal(forest.stacks.get(shared[1].stack), sharedPile);
assert.equal(sharedPile.workspace, 0);
assert.equal([...forest.forks.values()].filter(fork => fork.is_toplevel && fork.monitor === 13).length, 1);
keyboardTiler.move_from_stack(ext, tiler.find_stack(shared[2].entity), shared[2], Direction.Right);
const sharedBranches = [sharedRoot.left, sharedRoot.right];
const sharedArea = sharedRoot.area.clone();
const migrating = [makeWindow(15, 2), makeWindow(15, 2)];
tiler.attach_to_workspace(ext, migrating[0], [15, 2]);
tiler.attach_to_window(ext, migrating[0], migrating[1], { auto: 0 });
const migratingRoot = tiler.get_parent_fork(migrating[0].entity);
migratingRoot.migrate(ext, forest, ext.monitor_work_area(13), 13, 4);
assert.equal(forest.forks.get(migratingRoot.entity), null);
for (const window of migrating) {
    assert.equal(tiler.get_parent_fork(window.entity), sharedRoot);
    assert.deepEqual(ext.monitors.get(window.entity), [13, 0]);
    assert.equal(window.ignore_detach, false);
}
assert.deepEqual([sharedRoot.left, sharedRoot.right], sharedBranches, 'Merging preserves the destination tiles');
assert.ok(sharedRoot.area.eq(sharedArea));
assert.equal([...forest.forks.values()].filter(fork => fork.is_toplevel && fork.monitor === 13).length, 1);
const separate = [makeWindow(14, 2), makeWindow(14, 3)];
for (const window of separate) tiler.attach_to_workspace(ext, window, ext.workspace_id(window));
assert.notEqual(separate[0].stack, separate[1].stack);
assert.equal(tiler.get_parent_fork(separate[0].entity).workspace, 2);
assert.equal(tiler.get_parent_fork(separate[1].entity).workspace, 3);
checkForest();
console.log('ok  secondary placement, restore and migration share one tree while workspace-enabled monitors stay isolated');

const selector = new FocusSelector();
for (const [monitor, direction, forward, backward] of [
    [16, Direction.Right, 'right', 'left'],
    [17, Direction.Down, 'down', 'up'],
]) {
    const navigation = [makeWindow(monitor), makeWindow(monitor)];
    tiler.reset_to_pile(ext, navigation, [monitor, 0]);
    keyboardTiler.move_from_stack(ext, tiler.find_stack(navigation[1].entity), navigation[1], direction);
    const beforeSwap = navigation.map(window => window.rect());
    // Queue a swap without applying its native moves, as in the Shell event loop.
    for (const window of navigation) window.move = () => {};
    tiler.attach_swap(ext, navigation[0].entity, navigation[1].entity);
    assert.ok(navigation.every((window, i) => window.rect().eq(beforeSwap[i])));
    ext.active_window_list = () => navigation;
    assert.equal(selector[forward](ext, navigation[1]), navigation[0]);
    assert.equal(selector[backward](ext, navigation[0]), navigation[1]);
}
checkForest();
console.log('ok  directional focus follows tile ownership while a native swap is still queued');
console.log('ALL RESET WINDOWS CHECKS PASSED');
