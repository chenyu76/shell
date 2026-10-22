// Checks the arrangement logic of src/stack.ts with mocked GNOME Shell globals.
//
//     make compile && node scripts/stack-cascade-check.mjs
//
// The offsets, sizes, drawn titles and display order of a cascade of stacked
// windows are verified against the geometry which the shell is given.

import assert from 'node:assert/strict';
import { register } from 'node:module';
import { STUB_URL } from './gi-stub-hooks.mjs';

// The Stack imports actors from the shell, which are stubbed before it is loaded.
register('./gi-stub-hooks.mjs', import.meta.url);

const actors = await import(STUB_URL);

globalThis.global = {
    display: { connect: () => 1, disconnect: () => {}, get_primary_monitor: () => 0 },
    workspace_manager: { get_active_workspace_index: () => 0 },
    window_group: {
        add_child: () => {},
        get_parent: () => null,
        set_child_above_sibling: () => {},
    },
};

const stack_module = await import('../target/stack.js');
const { Stack } = stack_module;

let next_entity = 1;
let next_signal = 1;
function make_entity() {
    return [next_entity++, 1];
}

function make_window(entity, name, rect) {
    const state = { rect: { ...rect }, moves: [], visible: true, signals: new Set() };
    const meta = {
        connect() {
            const id = next_signal++;
            state.signals.add(id);
            return id;
        },
        disconnect(id) {
            assert.ok(state.signals.delete(id), 'Disconnect must use the window that owns the signal');
        },
        get_wm_class: () => name,
        raise() {},
        get_compositor_private() {
            return {
                show() {
                    state.visible = true;
                },
                hide() {
                    state.visible = false;
                },
            };
        },
    };

    return {
        name,
        entity,
        meta,
        state,
        title: () => name,
        actor_exists: () => true,
        same_workspace: () => true,
        is_maximized: () => false,
        rect: () => ({ ...state.rect }),
        move(_ext, target, on_complete) {
            state.rect = { x: target.x, y: target.y, width: target.width, height: target.height };
            state.moves.push({ ...state.rect });
            if (on_complete) on_complete();
        },
    };
}

function make_ext(offsets, titled = new Array()) {
    const windows = new Map();
    return {
        dpi: 1,
        conf: { window_has_pile_title: (_wclass, title) => titled.includes(title) },
        windows: { get: (e) => windows.get(e[0]) ?? null, _map: windows },
        settings: {
            stack_offset_x: () => offsets[0],
            stack_offset_y: () => offsets[1],
            workspaces_only_on_primary: () => false,
        },
        tiler: { window: null },
        window_animations: { visual_rect: (window, fallback) => fallback ?? window.rect() },
        grab_op: null,
        set_overlay: () => {},
        size_signals_block: () => {},
        size_signals_unblock: () => {},
        show_border_on_focused: () => {},
        active_workspace: () => 0,
        register: () => {},
        movements: { insert: () => {}, get: () => null },
    };
}

function check(name, test) {
    test();
    console.log(`ok  ${name}`);
}

const AREA = { x: 100, y: 100, width: 800, height: 600 };

function add_window(ext, name, area) {
    const window = make_window(make_entity(), name, area);
    ext.windows._map.set(window.entity[0], window);
    return window;
}

function scenario(offsets, area, names, titled = new Array()) {
    // Each check inspects the actors of the stack which it created.
    actors.reset_actors();

    const ext = make_ext(offsets, titled);
    const windows = names.map((name) => add_window(ext, name, area));

    const stack = new Stack(ext, windows.at(-1).entity, 0, 0, windows.map(window => window.entity));
    stack.update_layout(area);

    return { ext, stack, windows };
}

const order = ({ stack, windows }) => stack.entities.map(entity => windows.find(w => w.entity === entity).name);
const rectangles = windows => windows.map(window => window.rect());
const labels = () => actors.drawn_actors().filter(actor => actor.style_class === 'pop-shell-pile-title');
const titles = () => labels().map(label => label.text).sort();

function assertLayout({ stack, ext }, area = AREA, dx = 32, dy = 32) {
    const last = stack.entities.length - 1;
    assert.deepEqual(stack.entities.map(entity => ext.windows.get(entity).rect()),
        stack.entities.map((_, index) => ({
            x: Math.round(area.x + index * dx), y: Math.round(area.y + index * dy),
            width: area.width - last * dx, height: area.height - last * dy,
        })));
}

check('cascade geometry and inverse area, including one window and limited offsets', () => {
    for (const [offsets, area, names, dx, dy] of [
        [[32, 32], AREA, ['a', 'b', 'c'], 32, 32],
        [[32, 32], AREA, ['solo'], 0, 0],
        [[0, 0], AREA, ['a', 'b'], 0, 0],
        [[256, 256], { x: 0, y: 0, width: 300, height: 200 }, ['a', 'b', 'c', 'd', 'e'], 37.5, 25],
    ]) {
        const s = scenario(offsets, area, names);
        assertLayout(s, area, dx, dy);
        // Inverse geometry uses rounded offsets; check the exact round trip at integral offsets.
        if (Number.isInteger(dx)) assert.deepEqual(s.stack.area_from_window(s.windows.at(-1).rect()), area);
    }
});

check('activation swaps the selected window with the front and survives a rebuild', () => {
    const s = scenario([32, 32], AREA, ['a', 'b', 'c']);
    s.stack.activate(s.windows[0].entity);
    assert.deepEqual(order(s), ['c', 'b', 'a']);
    s.stack.activate(s.windows[1].entity);
    assert.deepEqual(order(s), ['c', 'a', 'b']);
    assertLayout(s);
    const before = rectangles(s.windows);
    s.stack.activate(s.windows[1].entity);
    s.stack.update_layout(AREA);
    assert.deepEqual(order(s), ['c', 'a', 'b']);
    assert.deepEqual(rectangles(s.windows), before);
});

check('switching back before queued movement runs keeps the final slots', () => {
    const s = scenario([32, 32], AREA, ['a', 'b', 'c']);
    const pending = new Map();
    s.ext.movements = { get: entity => pending.get(entity) ?? null };
    for (const window of s.windows) window.move = (_ext, target) => pending.set(window.entity, { ...target });
    s.stack.activate(s.windows[0].entity);
    s.stack.activate(s.windows[2].entity);
    for (const [entity, rect] of pending) s.ext.windows.get(entity).state.rect = rect;
    assertLayout(s);
});

check('focus and layout changes wait for grab release, then restore the selected front', () => {
    const s = scenario([32, 32], AREA, ['a', 'b', 'c']);
    const before = rectangles(s.windows);
    for (const window of s.windows) window.state.moves.length = 0;
    s.ext.grab_op = { entity: s.windows[0].entity };
    s.stack.activate(s.windows[0].entity);
    s.stack.update_layout(AREA);
    assert.equal(s.stack.active, s.windows[0].entity);
    assert.deepEqual(rectangles(s.windows), before);
    assert.ok(s.windows.every(window => window.state.moves.length === 0));
    s.ext.grab_op = null;
    s.stack.restack();
    assert.equal(s.stack.entities.at(-1), s.windows[0].entity);
    assertLayout(s);
});

check('cycling visits each window once, supports reverse and restarts after activation', () => {
    const s = scenario([32, 32], AREA, ['a', 'b', 'c']);
    s.stack.activate(s.windows[0].entity);
    const start = order(s);
    for (const front of ['c', 'b']) {
        assert.notEqual(s.stack.cycle(true), null);
        assert.equal(order(s).at(-1), front);
        assertLayout(s);
    }
    assert.equal(s.stack.cycle(true), null);
    s.stack.reset_cycle();
    assert.notEqual(s.stack.cycle(true), null);
    s.stack.reset_cycle();
    s.stack.cycle(true);
    s.stack.cycle(false);
    assert.deepEqual(order(s), start);
    s.stack.activate(s.stack.entities[0]);
    for (let i = 0; i < 2; i++) assert.notEqual(s.stack.cycle(true), null);
    assert.equal(s.stack.cycle(true), null);
    assert.equal(scenario([32, 32], AREA, ['solo']).stack.cycle(true), null);
});

check('front signal handlers follow rotation, replacement and removal without stale bindings', () => {
    const s = scenario([32, 32], AREA, ['a', 'b', 'c']);
    const members = s.stack.entities;
    s.stack.cycle(true);
    assert.equal(s.stack.entities, members);
    assert.equal(s.stack.active, members.at(-1));
    assert.ok(s.windows.every(window => window.state.signals.size === (window.entity === s.stack.active ? 2 : 0)));
    const oldFront = s.stack.active;
    const replacement = add_window(s.ext, 'replacement', AREA);
    s.stack.replace(replacement);
    assert.equal(s.stack.entities, members);
    assert.equal(s.stack.active, replacement.entity);
    assert.ok(!members.includes(oldFront));
    assert.equal(s.ext.windows.get(oldFront).state.signals.size, 0);
    s.stack.remove(replacement.entity);
    assert.equal(replacement.state.signals.size, 0);
    s.stack.update_layout(AREA);
    s.stack.destroy();
    assert.equal(members.length, 0);
    assert.ok([...s.windows, replacement].every(window => window.state.signals.size === 0));
});

check('joining and closing windows submit only the final geometry, down to one survivor', () => {
    for (const count of [2, 3]) {
        for (const front of [false, true]) {
            const s = scenario([32, 32], AREA, ['a', 'b'].slice(0, count - 1));
            const extra = add_window(s.ext, 'new', AREA);
            s.stack.add(extra.entity);
            s.stack.update_layout(AREA);
            s.stack.activate(extra.entity);
            assert.equal(s.stack.entities.at(-1), extra.entity);
            assertLayout(s);
            const closing = front ? s.stack.entities.at(-1) : s.stack.entities[0];
            s.stack.remove(closing);
            s.ext.windows._map.delete(closing[0]);
            const survivors = [...s.windows, extra].filter(window => window.entity !== closing);
            for (const window of survivors) window.state.moves.length = 0;
            s.stack.update_layout(AREA);
            assert.ok(!s.stack.entities.includes(closing));
            assert.ok(survivors.every(window => window.state.moves.length === 1));
            assertLayout(s);
        }
    }
});

check('changing area preserves the active window and skips intermediate arrangements', () => {
    const s = scenario([32, 32], AREA, ['a', 'b', 'c']);
    s.stack.activate(s.windows[0].entity);
    for (const window of s.windows) window.state.moves.length = 0;
    const area = { ...AREA, x: AREA.x + 100, width: AREA.width + 120 };
    s.stack.update_layout(area);
    assert.ok(s.windows.every(window => window.state.moves.length === 1));
    assert.equal(s.stack.entities.at(-1), s.windows[0].entity);
    assertLayout(s, area);
});

check('closing a front selected by rotation or clicking preserves survivor order and origins', () => {
    for (const rotated of [true, false]) {
        const s = scenario([32, 32], AREA, rotated ? ['a', 'b', 'c'] : ['a', 'b', 'c', 'd']);
        if (rotated) s.stack.cycle(true);
        else s.stack.activate(s.windows[0].entity);
        const expected = s.stack.entities.slice(0, -1);
        const before = new Map(expected.map(entity => [entity, s.ext.windows.get(entity).rect()]));
        const closing = s.stack.entities.at(-1);
        s.stack.remove(closing);
        s.ext.windows._map.delete(closing[0]);
        for (const entity of expected) s.ext.windows.get(entity).state.moves.length = 0;
        s.stack.update_layout(AREA);
        assert.deepEqual(s.stack.entities, expected, 'Closing must not promote an arbitrary member');
        assert.equal(s.stack.active, expected.at(-1));
        // Deliver the subsequent focus notification for the newly exposed front.
        s.stack.activate(expected.at(-1));
        for (const entity of expected) {
            const window = s.ext.windows.get(entity);
            assert.equal(window.rect().x, before.get(entity).x);
            assert.equal(window.rect().y, before.get(entity).y);
            assert.equal(window.state.moves.length, 1, 'A survivor should resize once without a position swap');
        }
        assertLayout(s);
    }
});

check('navigation bands distinguish horizontal and vertical neighbours from overlapping windows', () => {
    const pile = { x: 960, y: 100, width: 960, height: 1080 };
    for (const [other, horizontal, vertical] of [
        [{ x: 0, y: 100, width: 960, height: 1080 }, true, false],
        [{ x: 960, y: 1180, width: 960, height: 540 }, false, true],
        [{ x: 900, y: 200, width: 400, height: 400 }, false, false],
        [{ x: 0, y: 1180, width: 960, height: 540 }, false, false],
        [{ x: 972, y: 140, width: 948, height: 1040 }, false, false],
    ]) {
        assert.equal(stack_module.shares_band(pile, other, true), horizontal);
        assert.equal(stack_module.shares_band(pile, other, false), vertical);
    }
});

check('titles label only eligible background windows and follow rotation', () => {
    const s = scenario([32, 32], AREA, ['a', 'b', 'c'], ['a', 'b', 'c']);
    s.stack.activate(s.windows[0].entity);
    assert.deepEqual(titles(), ['b', 'c']);
    const behind = s.ext.windows.get(s.stack.entities[0]);
    const label = labels().find(label => label.text === behind.name);
    assert.ok(Math.abs(label.position.x + label.size.width / 2 - behind.rect().x - behind.rect().width / 2) <= 0.5);
    assert.ok(Math.abs(label.position.y + label.size.height / 2 - behind.rect().y - 16) <= 0.5);
    assert.equal(label.clutter_text.x_align, 1);
    assert.equal(label.clutter_text.y_align, 1);
    s.stack.cycle(true);
    assert.deepEqual(titles(), order(s).slice(0, -1).sort());
    const ruled = scenario([32, 32], AREA, ['a', 'b', 'c'], ['b']);
    ruled.stack.activate(ruled.windows[0].entity);
    assert.deepEqual(titles(), ['b']);
});

check('titles follow animated visual geometry without moving windows or reloading text', () => {
    const s = scenario([32, 32], AREA, ['a', 'b', 'c'], ['a', 'b', 'c']);
    const behind = s.ext.windows.get(s.stack.entities[0]);
    const visual = { ...behind.rect(), x: behind.rect().x + 55, y: behind.rect().y + 33 };
    const before = rectangles(s.windows);
    s.ext.window_animations.visual_rect = (window, fallback) => window === behind ? visual : fallback ?? window.rect();
    behind.title = () => { throw new Error('Animation frames must not reload title text'); };
    s.stack.update_animation_layout();
    const label = labels().find(label => label.text === behind.name);
    assert.ok(Math.abs(label.position.x + label.size.width / 2 - visual.x - visual.width / 2) <= 0.5);
    assert.ok(Math.abs(label.position.y + label.size.height / 2 - visual.y - 16) <= 0.5);
    assert.deepEqual(rectangles(s.windows), before);
});

check('titles disappear when hidden, removed, destroyed or too small', () => {
    for (const action of ['hide', 'remove', 'destroy', 'thin']) {
        const s = scenario([32, action === 'thin' ? 8 : 32], AREA, ['a', 'b', 'c'], ['a', 'b', 'c']);
        const dropped = s.stack.entities[0];
        const name = s.ext.windows.get(dropped).name;
        if (action === 'hide') s.stack.set_visible(false);
        if (action === 'remove') s.stack.remove(dropped);
        if (action === 'destroy') s.stack.destroy();
        assert.deepEqual(titles(), action === 'remove'
            ? order(s).slice(0, -1).filter(title => title !== name).sort() : []);
    }
});

console.log('ALL STACK CHECKS PASSED');
