// Checks the arrangement logic of src/stack.ts with mocked GNOME Shell globals.
//
//     make compile && node scripts/stack-cascade-check.mjs
//
// The offsets, sizes and display order of a cascade of stacked windows are
// verified against the geometry which the shell is given.
globalThis.global = {
    display: { connect: () => 1, disconnect: () => {}, get_primary_monitor: () => 0 },
    workspace_manager: { get_active_workspace_index: () => 0 },
};

const { Stack } = await import('../target/stack.js');

let next_entity = 1;
function make_entity() {
    return [next_entity++, 1];
}

function make_window(entity, name, rect) {
    const state = { rect: { ...rect }, raises: 0, visible: true };
    const meta = {
        connect: () => 0,
        disconnect: () => {},
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

function make_ext(offsets) {
    const windows = new Map();
    return {
        dpi: 1,
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

function scenario(offsets, area, names) {
    const ext = make_ext(offsets);
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

    while (stack.cycle(true) !== null) {
        presses += 1;
        fronts.push(front());
    }

    check(
        'cycling forwards displays every window of the stack in front',
        new Set(fronts).size === windows.length,
        fronts.join(' -> '),
    );

    check(
        'cycling forwards displays the windows from the front of the pile to the back',
        fronts.join(',') === [...start_order].reverse().join(','),
        `${fronts.join(',')} vs ${[...start_order].reverse().join(',')}`,
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

        // Cycle once, then display a window of the stack by other means, which
        // must allow the whole stack to be cycled again.
        trio.stack.cycle(true);
        trio.stack.activate(trio.windows[2].entity);

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

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
