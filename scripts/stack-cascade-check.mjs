// Checks the arrangement logic of src/stack.ts with mocked GNOME Shell globals.
//
//     make compile && node scripts/stack-cascade-check.mjs
//
// The offsets, sizes, drawn titles and display order of a cascade of stacked
// windows are verified against the geometry which the shell is given.

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

const geom = await import('../target/geom.js');
const stack_module = await import('../target/stack.js');
const { Stack } = stack_module;

let next_entity = 1;
function make_entity() {
    return [next_entity++, 1];
}

function make_window(entity, name, rect) {
    const state = { rect: { ...rect }, raises: 0, visible: true };
    const meta = {
        connect: () => 0,
        disconnect: () => {},
        get_wm_class: () => name,
        raise() {
            state.raises += 1;
        },
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
        grab_op: null,
        set_overlay: () => {},
        size_signals_block: () => {},
        size_signals_unblock: () => {},
        show_border_on_focused: () => {},
        active_workspace: () => 0,
        register: () => {},
        movements: { insert: () => {} },
    };
}

let failures = 0;
function check(label, ok, detail) {
    if (!ok) failures += 1;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail === undefined ? '' : ` — ${detail}`}`);
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

    const stack = new Stack(ext, windows[0].entity, 0, 0);
    stack.set_entities(windows.map((window) => window.entity));
    stack.set_area(area);

    return { ext, stack, windows };
}

const name_of = (windows, entity) => windows.find((w) => w.entity === entity).name;

// --- geometry -----------------------------------------------------------------
{
    const { stack, windows } = scenario([32, 32], AREA, ['a', 'b', 'c']);
    const rects = windows.map((w) => w.state.rect);

    check(
        '3 windows share one size',
        rects.every((r) => r.width === rects[0].width && r.height === rects[0].height),
        JSON.stringify(rects[0]),
    );

    check(
        'size is the area minus every offset',
        rects[0].width === AREA.width - 2 * 32 && rects[0].height === AREA.height - 2 * 32,
        `${rects[0].width}x${rects[0].height}`,
    );

    check(
        'each window is translated down-right',
        rects.every((r, i) => r.x === AREA.x + i * 32 && r.y === AREA.y + i * 32),
        rects.map((r) => `${r.x},${r.y}`).join(' '),
    );

    const front = rects[rects.length - 1];
    check(
        'the window in front ends at the bottom-right of the area',
        front.x + front.width === AREA.x + AREA.width && front.y + front.height === AREA.y + AREA.height,
        `${front.x + front.width},${front.y + front.height}`,
    );

    check(
        'the entire stack fits inside the area',
        rects.every(
            (r) =>
                r.x >= AREA.x &&
                r.y >= AREA.y &&
                r.x + r.width <= AREA.x + AREA.width &&
                r.y + r.height <= AREA.y + AREA.height,
        ),
    );

    check(
        'the left edge of every window behind is revealed',
        rects.slice(0, -1).every((r, i) => rects[i + 1].x > r.x),
    );

    check(
        'the title bar height of every window behind is revealed',
        rects.slice(0, -1).every((r, i) => rects[i + 1].y - r.y >= 32),
    );

    const one = scenario([32, 32], AREA, ['a']);
    check('one window fills the whole area', one.windows[0].state.rect.width === AREA.width);

    const expanded = stack.area_from_window(front);
    check(
        'round trip: expanding the front window restores the area',
        expanded.x === AREA.x &&
            expanded.y === AREA.y &&
            expanded.width === AREA.width &&
            expanded.height === AREA.height,
        JSON.stringify(expanded),
    );
}

// --- display order and z-order -------------------------------------------------
{
    const { stack, windows } = scenario([32, 32], AREA, ['a', 'b', 'c']);
    const order = () => stack.display.map((e) => name_of(windows, e)).join(',');

    // update_stack() activates the stack's window after adding them.
    stack.active = windows[0].entity;
    stack.auto_activate();

    check('the active window is displayed in front', order().endsWith('a'), order());

    const middle = stack.display[stack.display.length - 2];
    windows.forEach((w) => (w.state.raises = 0));
    stack.activate(middle);

    check('activating a window swaps it to the front', order().endsWith(name_of(windows, middle)), order());
    check('the window which was in front takes its place', stack.display[stack.display.length - 2] === windows[0].entity, order());
    check('the other windows keep their place', order().startsWith('c'), order());

    const activated = windows.find((w) => w.entity === middle);
    check(
        'the activated window is displayed at the front of the cascade',
        activated.state.rect.x === AREA.x + 2 * 32 && activated.state.rect.y === AREA.y + 2 * 32,
        JSON.stringify(activated.state.rect),
    );

    check(
        'windows are raised from the back to the front',
        stack.display.every((e) => windows.find((w) => w.entity === e).state.raises > 0),
    );

    // Activating the window which is already in front changes nothing.
    const before = order();
    const rects_before = windows.map((w) => JSON.stringify(w.state.rect));
    stack.activate(stack.display[stack.display.length - 1]);
    check('re-activating the window in front is a no-op', order() === before && windows.every((w, i) => JSON.stringify(w.state.rect) === rects_before[i]));
}

// --- cycling through a stack with the direction keys ---------------------------
{
    const { stack, windows } = scenario([32, 32], AREA, ['a', 'b', 'c']);
    const names = (entities) => entities.map((entity) => name_of(windows, entity));
    const order = () => names(stack.display).join(',');
    const front = () => names(stack.display)[stack.display.length - 1];

    stack.active = windows[0].entity;
    stack.auto_activate();

    const start_order = names(stack.display);
    const start = order();

    // Every press displays the window which is behind the one in front, until
    // the whole stack has been displayed.
    const fronts = [front()];
    let presses = 0;

    // Cycling forwards is the direction which Right and Down use.
    while (stack.cycle(true) !== null) {
        presses += 1;
        fronts.push(front());
    }

    check(
        'cycling forwards displays every window of the stack in front',
        new Set(fronts).size === windows.length,
        fronts.join(' -> '),
    );

    // The next window of the pile follows the window which is displayed in front,
    // which is the window at the back of the pile once the window in front is the
    // last of the pile.
    const expected = [start_order[start_order.length - 1], ...start_order.slice(0, -1)];

    check(
        'cycling forwards displays the window in front, then the windows of the pile from its back',
        fronts.join(',') === expected.join(','),
        `${fronts.join(',')} vs ${expected.join(',')}`,
    );

    check(
        'the direction keys leave the stack once every window has been displayed in front',
        presses === windows.length - 1,
        `${presses} rotations`,
    );

    // The extension resets the cycle once focus is shifted out of the stack.
    stack.reset_cycle();
    check('the stack can be cycled again after the cycle was reset', stack.cycle(true) !== null);

    // Cycling backwards must undo a forwards cycle.
    stack.reset_cycle();
    stack.cycle(true);
    const after_forward = order();
    stack.cycle(false);
    check('cycling backwards undoes a forwards cycle', order() === start, `${after_forward} -> ${order()}`);

    check('the window in front is always at the front of the cascade', (() => {
        stack.reset_cycle();
        stack.cycle(true);

        const entity = stack.display[stack.display.length - 1];
        const rect = windows.find((w) => w.entity === entity).state.rect;

        return rect.x === AREA.x + 2 * 32 && rect.y === AREA.y + 2 * 32;
    })());

    check('cycling raises the windows in the new order', (() => {
        stack.reset_cycle();
        windows.forEach((w) => (w.state.raises = 0));
        stack.cycle(true);

        return windows.every((w) => w.state.raises > 0);
    })());

    /** The window which is displayed in front, of a scenario with the given names */
    const front_of = (scenario) => scenario.stack.display[scenario.stack.display.length - 1];

    check('a stack of one window cannot be cycled', scenario([32, 32], AREA, ['solo']).stack.cycle(true) === null);

    check('a stack of two windows toggles between them, and is then left', (() => {
        const pair = scenario([32, 32], AREA, ['one', 'two']);
        pair.stack.active = pair.windows[0].entity;
        pair.stack.auto_activate();

        const first = front_of(pair);
        pair.stack.cycle(true);
        const second = front_of(pair);

        return first !== second && pair.stack.cycle(true) === null;
    })());

    check('displaying another window of the stack restarts the cycle', (() => {
        const trio = scenario([32, 32], AREA, ['a', 'b', 'c']);
        trio.stack.active = trio.windows[0].entity;
        trio.stack.auto_activate();

        // Cycle once, then display a window which is behind the one in front by
        // other means, which must allow the whole stack to be cycled again.
        trio.stack.cycle(true);
        trio.stack.activate(trio.stack.display[0]);

        let rotations = 0;
        while (trio.stack.cycle(true) !== null) rotations += 1;

        return rotations === trio.windows.length - 1;
    })());
}

// --- offsets are limited -------------------------------------------------------
{
    const small = { x: 0, y: 0, width: 300, height: 200 };
    const { windows } = scenario([256, 256], small, ['a', 'b', 'c', 'd', 'e']);
    const rects = windows.map((w) => w.state.rect);

    check(
        'huge offsets never shrink the stack below half of its area',
        rects[0].width >= small.width / 2 && rects[0].height >= small.height / 2,
        `${rects[0].width}x${rects[0].height}`,
    );

    check(
        'every window still fits inside the area',
        rects.every((r) => r.x >= 0 && r.y >= 0 && r.x + r.width <= small.width && r.y + r.height <= small.height),
    );

    check('offsets are still applied', rects[1].x > rects[0].x && rects[1].y > rects[0].y);
}

// --- windows joining and leaving a stack ---------------------------------------
{
    const { ext, stack, windows } = scenario([32, 32], AREA, ['a', 'b']);
    const extra = add_window(ext, 'c', AREA);
    stack.set_entities([...windows, extra].map((window) => window.entity));

    check(
        'a new window is displayed in front',
        stack.display[stack.display.length - 1] === extra.entity,
        stack.display.map((e) => name_of([...windows, extra], e)).join(','),
    );

    extra.state.rect = { ...AREA };
    stack.set_area(AREA);
    check(
        'the new window is cascaded once the stack is re-arranged',
        extra.state.rect.x === AREA.x + 2 * 32 && extra.state.rect.width === AREA.width - 2 * 32,
        JSON.stringify(extra.state.rect),
    );

    const removed = stack.entities[0];
    stack.remove(removed);
    check('a removed window is dropped from the display order', !stack.display.some((e) => e === removed), `${stack.display.length} left`);

    stack.remove(stack.entities[0]);
    stack.set_area(AREA);
    check(
        'the last remaining window fills the whole area',
        stack.ext.windows.get(stack.entities[0]).state.rect.width === AREA.width,
    );
}

// --- the pile order survives a rebuild ------------------------------------------
{
    const { stack, windows } = scenario([32, 32], AREA, ['a', 'b', 'c']);
    const order = () => stack.display.map((e) => name_of(windows, e)).join(',');

    stack.active = windows[0].entity;
    stack.auto_activate();
    stack.cycle(true);

    const arranged = order();

    // update_stack() replaces the windows of the stack whenever the tree
    // changes, which must not scramble the pile.
    stack.set_entities(windows.map((window) => window.entity));
    stack.set_area(AREA);
    stack.auto_activate();

    check('the order of the pile is kept when the stack is rebuilt', order() === arranged, `${arranged} -> ${order()}`);
}

// --- the distance which a window was dragged -------------------------------------
{
    // The distance is the largest of the distances along both axes, so that a drag
    // which only shakes a window by a little stays within the dead zone.
    check(
        'a drag along one axis is measured by that axis',
        geom.position_distance({ x: 100, y: 100, width: 50, height: 50 }, { x: 130, y: 100, width: 50, height: 50 }) === 30,
    );

    check(
        'a drag along both axes is measured by the longest of them',
        geom.position_distance({ x: 100, y: 100, width: 50, height: 50 }, { x: 110, y: 160, width: 50, height: 50 }) === 60,
    );

    check(
        'a window which was not moved was dragged by nothing',
        geom.position_distance({ x: 100, y: 100, width: 50, height: 50 }, { x: 100, y: 100, width: 20, height: 20 }) === 0,
    );

    check(
        'a dead zone of 40 keeps a drag of 39 inside of it, and one of 40 out of it',
        geom.position_distance({ x: 0, y: 0, width: 1, height: 1 }, { x: -39, y: 30, width: 1, height: 1 }) < 40 &&
            !(geom.position_distance({ x: 0, y: 0, width: 1, height: 1 }, { x: -40, y: 0, width: 1, height: 1 }) < 40),
    );
}

// --- the windows around a stack -------------------------------------------------
{
    // One window on the left half, and a pile of two on the right half.
    const left = { x: 0, y: 100, width: 960, height: 1080 };
    const pile = { x: 960, y: 100, width: 960, height: 1080 };

    check(
        'a window on the left of a stack is beside it',
        stack_module.shares_band(pile, left, true) && !stack_module.shares_band(pile, left, false),
        'it shares the band of the other axis only',
    );

    // A pile which occupies the top half, with a window below it.
    const top = { x: 0, y: 100, width: 1920, height: 540 };
    const below = { x: 0, y: 640, width: 1920, height: 540 };

    check(
        'a window below a stack is not beside it',
        stack_module.shares_band(top, below, false) && !stack_module.shares_band(top, below, true),
        'it shares the band of the other axis only',
    );

    check(
        'a window which overlaps the stack is in neither band',
        !stack_module.shares_band(pile, { x: 900, y: 200, width: 400, height: 400 }, true) &&
            !stack_module.shares_band(pile, { x: 900, y: 200, width: 400, height: 400 }, false),
    );

    check(
        'a window which touches a stack without overlapping it is not around it',
        !stack_module.shares_band(pile, left, false) &&
            !stack_module.shares_band(pile, { ...left, x: 960 - 960, width: 960 }, false),
    );

    check(
        'the windows of a pile are inside its area',
        [0, 1].every((idx) => {
            const slot = { x: pile.x + idx * 12, y: pile.y + idx * 40, width: pile.width - 12, height: pile.height - 40 };
            return !stack_module.shares_band(pile, slot, true) && !stack_module.shares_band(pile, slot, false);
        }),
    );
}

// --- titles drawn over the pile ------------------------------------------------
{
    const labels = () => actors.drawn_actors().filter((actor) => actor.style_class === 'pop-shell-pile-title');

    const { stack, windows } = scenario([32, 32], AREA, ['a', 'b', 'c'], ['a', 'b', 'c']);

    stack.active = windows[0].entity;
    stack.auto_activate();

    const drawn = () => stack.display.slice(0, -1).map((entity) => name_of(windows, entity)).sort();

    check(
        'the title of every window behind is drawn',
        labels().map((label) => label.text).sort().join(',') === drawn().join(','),
        labels().map((label) => label.text).join(','),
    );

    const front = name_of(windows, stack.display[stack.display.length - 1]);
    check('the title of the window in front is not drawn', !labels().some((label) => label.text === front));

    check('a drawn title is centered in the exposed part of its title bar', (() => {
        const behind = name_of(windows, stack.display[0]);
        const label = labels().find((label) => label.text === behind);
        const rect = windows.find((window) => window.name === behind).state.rect;

        const center_x = label.position.x + label.size.width / 2;
        const center_y = label.position.y + label.size.height / 2;

        return (
            Math.abs(center_x - (rect.x + rect.width / 2)) <= 0.5 &&
            Math.abs(center_y - (rect.y + 32 / 2)) <= 0.5 &&
            label.size.height === 16
        );
    })());

    check('a drawn title is centered within its label as well', (() => {
        const label = labels()[0];
        return label.clutter_text.x_align === 1 && label.clutter_text.y_align === 1;
    })());

    check('a drawn title is stacked above the windows of the stack', (() => {
        const container = labels()[0]?.get_parent();
        return container !== undefined && container.visible;
    })());

    check('the titles follow the pile when it is rotated', (() => {
        stack.cycle(true);
        const rotated = stack.display.slice(0, -1).map((entity) => name_of(windows, entity)).sort();
        return labels().map((label) => label.text).sort().join(',') === rotated.join(',');
    })());

    check('a window which is not selected by the rules has no drawn title', (() => {
        const untitled = scenario([32, 32], AREA, ['a', 'b', 'c'], ['b']);
        untitled.stack.active = untitled.windows[0].entity;
        untitled.stack.auto_activate();

        const texts = labels().map((label) => label.text);
        return texts.length === 1 && texts[0] === 'b';
    })());

    check('the titles are hidden once the stack may not be displayed', (() => {
        const hidden = scenario([32, 32], AREA, ['a', 'b', 'c'], ['a', 'b']);
        hidden.stack.active = hidden.windows[0].entity;
        hidden.stack.auto_activate();
        hidden.stack.set_visible(false);

        return labels().length === 0;
    })());

    check('a band which is too small to hold a title is left empty', (() => {
        const thin = scenario([32, 8], AREA, ['a', 'b', 'c'], ['a', 'b']);
        thin.stack.active = thin.windows[0].entity;
        thin.stack.auto_activate();

        return labels().length === 0;
    })());

    check('a window which leaves the stack loses its drawn title', (() => {
        const leaving = scenario([32, 32], AREA, ['a', 'b', 'c'], ['a', 'b', 'c']);
        leaving.stack.active = leaving.windows[0].entity;
        leaving.stack.auto_activate();

        // The window which is displayed behind the one in front leaves the stack.
        const entity = leaving.stack.display[0];
        const name = name_of(leaving.windows, entity);

        leaving.stack.remove(entity);

        return labels().length === 1 && !labels().some((label) => label.text === name);
    })());

    check('a window which a rebuild drops loses its drawn title', (() => {
        const rebuilt = scenario([32, 32], AREA, ['a', 'b', 'c'], ['a', 'b', 'c']);
        rebuilt.stack.active = rebuilt.windows[0].entity;
        rebuilt.stack.auto_activate();

        const dropped = name_of(rebuilt.windows, rebuilt.stack.display[0]);
        const kept = rebuilt.windows.filter((window) => window.name !== dropped);

        rebuilt.stack.set_entities(kept.map((window) => window.entity));

        return !labels().some((label) => label.text === dropped);
    })());

    check('the titles are removed with the stack', (() => {
        const removed = scenario([32, 32], AREA, ['a', 'b'], ['a', 'b']);
        removed.stack.active = removed.windows[0].entity;
        removed.stack.auto_activate();
        removed.stack.destroy();

        return labels().length === 0;
    })());
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
