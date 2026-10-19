// Run after make compile: node scripts/window-animation-check.mjs
import assert from 'node:assert/strict';
import { register } from 'node:module';
import * as mocks from './window-animation-mocks.mjs';
register('./window-animation-stubs.mjs', import.meta.url);
globalThis.global = { compositor: mocks.compositor };
globalThis.popShellExtension = { getSettings: () => ({ get_uint: () => 0 }) };
const { WindowAnimations } = await import('../target/window_animation.js');

const BEFORE = { x: 100, y: 100, width: 400, height: 300 };
const TARGET = { x: 600, y: 200, width: 600, height: 400 };
function scenario({ async = false, shadow = 0, reset = true } = {}) {
    if (reset) mocks.reset();
    const actor = new mocks.Actor();
    const group = new mocks.Actor();
    group.add_child(actor);
    let frame = { ...BEFORE };
    let requested;
    let submitted = 0;
    const layout_batches = [];
    const buffer = () => ({ x: frame.x - shadow, y: frame.y - shadow,
        width: frame.width + shadow * 2, height: frame.height + shadow * 2 });
    const commitActor = () => {
        const rect = buffer();
        actor.set_position(rect.x, rect.y);
        actor.set_size(rect.width, rect.height);
    };
    const meta = new mocks.Signals();
    Object.assign(meta, {
        get_compositor_private: () => actor,
        get_frame_rect: () => new mocks.BoxedRectangle(frame),
        get_buffer_rect: () => new mocks.BoxedRectangle(buffer()),
        move_resize_frame(_userOp, x, y, width, height) {
            submitted++;
            requested = { x, y, width, height };
            if (!async) commit();
        },
    });
    const window = { meta };
    const animations = new WindowAnimations(windows => {
        layout_batches.push([...windows]);
    });
    function commit(rect = requested, actorToo = true) {
        const previous = frame;
        frame = { ...rect };
        if (frame.x !== previous.x || frame.y !== previous.y) meta.emit('position-changed');
        if (frame.width !== previous.width || frame.height !== previous.height) meta.emit('size-changed');
        if (actorToo) commitActor();
    }
    commitActor();
    const assert_clean = () => {
        assert.equal(actor.opacity, 255);
        assert.equal(actor.translation_x, 0);
        assert.equal(actor.translation_y, 0);
        assert.equal(actor.scale_x, 1);
        assert.equal(actor.scale_y, 1);
        assert.equal(actor.signals.size, 0);
        assert.equal(meta.signals.size, 0);
        assert.equal(group.children.length, 1);
        assert.equal(mocks.timers.size, 0);
        assert.equal(mocks.laters.size, 0);
    };
    return { animations, window, actor, group, meta, commit, commitActor, assert_clean, layout_batches,
        submitted: () => submitted };
}

function rectEqual(actual, expected) {
    for (const key of ['x', 'y', 'width', 'height']) {
        assert.ok(Math.abs(actual[key] - expected[key]) < 0.001, `${key}: ${actual[key]} != ${expected[key]}`);
    }
}
let checks = 0;
function check(name, test) { test(); checks++; console.log(`ok  ${name}`); }

check('move submits once and transitions from the old frame, including shadows', () => {
    const s = scenario({ shadow: 12 });
    s.animations.move(s.window, TARGET, true);
    assert.equal(s.submitted(), 1);
    assert.equal(s.actor.opacity, 0);
    mocks.redraw();
    assert.equal(s.actor.opacity, 255);
    assert.equal(s.actor.animation.duration, 250);
    rectEqual(s.animations.visual_rect(s.window), BEFORE);
    s.actor.advance(0.5);
    mocks.redraw();
    rectEqual(s.animations.visual_rect(s.window), { x: 350, y: 150, width: 500, height: 350 });
    assert.ok(s.layout_batches.length > 1);
    s.actor.complete();
    rectEqual(s.animations.visual_rect(s.window), TARGET);
    mocks.redraw();
    s.assert_clean();
});

check('animation setup failures still submit the real movement once', () => {
    const s = scenario();
    const connect = s.actor.connect;
    s.actor.connect = function (signal, callback) {
        if (signal === 'notify::width') throw new Error('Signal registration failed');
        return connect.call(this, signal, callback);
    };
    s.animations.move(s.window, TARGET, true);
    assert.equal(s.submitted(), 1);
    rectEqual(s.animations.visual_rect(s.window), TARGET);
    mocks.redraw();
    s.assert_clean();
});

check('real movement errors propagate unchanged and release animation resources', () => {
    const s = scenario();
    const error = new Error('Geometry submission failed');
    let attempts = 0;
    s.meta.move_resize_frame = () => { attempts++; throw error; };
    assert.throws(() => s.animations.move(s.window, TARGET, true), actual => actual === error);
    assert.equal(attempts, 1);
    mocks.redraw();
    s.assert_clean();
});

for (const enabled of [false, true]) {
    check(`a minimum-sized window still moves when asked to shrink below its minimum (animation=${enabled})`, () => {
        const s = scenario();
        s.meta.get_min_size = () => [true, BEFORE.width, BEFORE.height];
        s.meta.client_rect_to_frame_rect = rect => rect;
        const resize = s.meta.move_resize_frame;
        s.meta.move_resize_frame = (userOp, x, y, width, height) => {
            // Real Mutter drops the whole operation in this case, including x/y.
            if (width < BEFORE.width || height < BEFORE.height) return;
            resize(userOp, x, y, width, height);
        };
        const target = { ...TARGET, width: 250, height: 200 };
        s.animations.move(s.window, target, enabled);
        const expected = { ...TARGET, width: BEFORE.width, height: BEFORE.height };
        rectEqual(s.meta.get_frame_rect(), expected);
        assert.equal(s.submitted(), 1);
        assert.equal(target.width, 250, 'The caller still owns its requested layout');
        mocks.redraw();
        if (enabled) {
            assert.equal(s.actor.easeCalls, 1, 'A clamped position-only move must not wait for a resize');
            s.actor.complete();
        }
        mocks.redraw();
        s.assert_clean();
    });
}

check('minimum client sizes include server-side frame borders', () => {
    const s = scenario();
    s.meta.get_min_size = () => [true, 400, 300];
    s.meta.client_rect_to_frame_rect = rect => ({ ...rect, width: rect.width + 10, height: rect.height + 30 });
    s.animations.move(s.window, { ...TARGET, width: 200, height: 100 }, false);
    rectEqual(s.meta.get_frame_rect(), { ...TARGET, width: 410, height: 330 });
    mocks.redraw();
    s.assert_clean();
});

check('unknown minimum sizes leave compositor constraints in charge', () => {
    const s = scenario();
    s.meta.get_min_size = () => [false, 0, 0];
    s.animations.move(s.window, TARGET, false);
    rectEqual(s.meta.get_frame_rect(), TARGET);
    mocks.redraw();
    s.assert_clean();
});

check('minimum client sizes exclude client-side shadows', () => {
    const s = scenario({ shadow: 12 });
    s.meta.get_min_size = () => [true, BEFORE.width + 24, BEFORE.height + 24];
    s.meta.client_rect_to_frame_rect = rect => ({ ...rect, width: rect.width - 24, height: rect.height - 24 });
    s.animations.move(s.window, { ...TARGET, width: 200, height: 100 }, false);
    rectEqual(s.meta.get_frame_rect(), { ...TARGET, width: BEFORE.width, height: BEFORE.height });
    mocks.redraw();
    s.assert_clean();
});

check('Wayland waits for both geometry and the actor allocation, using constrained geometry', () => {
    const s = scenario({ async: true });
    s.animations.move(s.window, TARGET, true);
    mocks.redraw();
    assert.equal(s.actor.animation, null);
    const constrained = { ...TARGET, width: 650 };
    s.commit(constrained, false);
    mocks.redraw();
    assert.equal(s.actor.animation, null);
    s.commitActor();
    mocks.redraw();
    rectEqual(s.animations.visual_rect(s.window), BEFORE);
    s.actor.complete();
    rectEqual(s.animations.visual_rect(s.window), constrained);
    assert.equal(s.submitted(), 1);
    mocks.redraw();
    s.assert_clean();
});

check('unresponsive or rejected configure restores the real window after the timeout', () => {
    const s = scenario({ async: true });
    s.animations.move(s.window, TARGET, true);
    assert.equal([...mocks.timers.values()][0].delay, 500);
    mocks.redraw();
    mocks.timeout();
    mocks.redraw();
    s.assert_clean();
});

check('continuous movement retargets from the currently displayed frame', () => {
    const s = scenario();
    s.animations.move(s.window, TARGET, true);
    mocks.redraw();
    s.actor.advance(0.5);
    const intermediate = s.animations.visual_rect(s.window);
    const stopped = s.actor.animation.onStopped;
    s.animations.move(s.window, { ...TARGET, x: 900 }, true);
    const clone = s.group.children[1];
    s.animations.move(s.window, { ...TARGET, x: 1000, width: 700 }, true);
    stopped(false);
    assert.equal(s.group.children[1], clone);
    assert.equal(s.group.children.length, 2);
    mocks.redraw();
    assert.equal(s.actor.easeCalls, 2);
    assert.equal(s.actor.animation.duration, 250);
    rectEqual(s.animations.visual_rect(s.window), intermediate);
    s.actor.complete();
    rectEqual(s.animations.visual_rect(s.window), { ...TARGET, x: 1000, width: 700 });
    mocks.redraw();
    s.assert_clean();
});

check('rapid movement can also replace a pending Wayland configure', () => {
    const s = scenario({ async: true });
    s.animations.move(s.window, TARGET, true);
    s.animations.move(s.window, { ...TARGET, x: 900 }, true);
    assert.equal(s.group.children.length, 2);
    s.commit();
    mocks.redraw();
    rectEqual(s.animations.visual_rect(s.window), BEFORE);
    s.animations.cancel_all();
    mocks.redraw();
    s.assert_clean();
});

check('same-frame requests reuse one snapshot and animate only the final geometry', () => {
    const s = scenario();
    s.animations.move(s.window, { ...BEFORE, x: TARGET.x, y: TARGET.y }, true);
    const clone = s.group.children[1];
    const signals = [...s.actor.signals.keys()];
    const timeout = [...mocks.timers.keys()];
    const final = { ...TARGET, x: 900, width: 700 };
    s.animations.move(s.window, { ...TARGET, x: 800 }, true);
    s.animations.move(s.window, final, true);
    assert.equal(s.group.children[1], clone);
    assert.deepEqual([...s.actor.signals.keys()], signals);
    assert.deepEqual([...mocks.timers.keys()], timeout);
    assert.equal(s.actor.easeCalls, 0);
    assert.equal(s.submitted(), 3);
    mocks.redraw();
    assert.equal(s.actor.easeCalls, 1);
    assert.equal(clone.easeCalls, 1);
    rectEqual(s.animations.visual_rect(s.window), BEFORE);
    s.actor.complete();
    rectEqual(s.animations.visual_rect(s.window), final);
    mocks.redraw();
    s.assert_clean();
});

check('a move arriving before a resize waits and transitions both together', () => {
    const s = scenario({ async: true, shadow: 12 });
    s.animations.move(s.window, TARGET, true);
    s.commit({ ...BEFORE, x: TARGET.x, y: TARGET.y });
    mocks.redraw();
    assert.equal(s.actor.easeCalls, 0);
    assert.equal(s.actor.opacity, 0);
    rectEqual(s.animations.visual_rect(s.window), BEFORE);
    s.commit(TARGET, false);
    mocks.redraw();
    assert.equal(s.actor.easeCalls, 0);
    s.commitActor();
    mocks.redraw();
    assert.equal(s.actor.easeCalls, 1);
    s.actor.advance(0.5);
    rectEqual(s.animations.visual_rect(s.window), { x: 350, y: 150, width: 500, height: 350 });
    s.actor.complete();
    mocks.redraw();
    s.assert_clean();
});

check('position-only requests start on the next redraw without waiting for a resize', () => {
    const s = scenario();
    const target = { ...BEFORE, x: 600, y: 200 };
    s.animations.move(s.window, target, true);
    mocks.redraw();
    assert.equal(s.actor.easeCalls, 1);
    s.actor.complete();
    rectEqual(s.animations.visual_rect(s.window), target);
    mocks.redraw();
    s.assert_clean();
});

for (const anchor of ['top-left', 'bottom-right']) {
    check(`a resize preserves its ${anchor} anchor throughout the transition`, () => {
        const s = scenario({ shadow: 12 });
        const target = { ...BEFORE, width: 600, height: 400 };
        if (anchor === 'bottom-right') {
            target.x -= target.width - BEFORE.width;
            target.y -= target.height - BEFORE.height;
        }
        s.animations.move(s.window, target, true);
        mocks.redraw();
        for (const progress of [0, 0.25, 0.5, 0.75, 1]) {
            s.actor.advance(progress);
            const rect = s.animations.visual_rect(s.window);
            const right = anchor === 'bottom-right';
            assert.ok(Math.abs(rect.x + (right ? rect.width : 0) - BEFORE.x - (right ? BEFORE.width : 0)) < 0.001);
            assert.ok(Math.abs(rect.y + (right ? rect.height : 0) - BEFORE.y - (right ? BEFORE.height : 0)) < 0.001);
        }
        assert.equal(s.actor.easeCalls, 1);
        s.actor.complete();
        mocks.redraw();
        s.assert_clean();
    });
}

check('duplicate requests preserve the pending snapshot and its original timeout', () => {
    const s = scenario({ async: true });
    s.animations.move(s.window, TARGET, true);
    const clone = s.group.children[1];
    const timeout = [...mocks.timers.keys()];
    mocks.redraw();
    mocks.tick(450_000);
    s.animations.move(s.window, TARGET, true);
    assert.equal(s.group.children[1], clone);
    assert.deepEqual([...mocks.timers.keys()], timeout);
    mocks.timeout();
    mocks.redraw();
    s.assert_clean();
});

check('a rejected resize after a position update times out without a second animation', () => {
    const s = scenario({ async: true });
    s.animations.move(s.window, TARGET, true);
    const actual = { ...BEFORE, x: TARGET.x, y: TARGET.y };
    s.commit(actual);
    mocks.redraw();
    mocks.timeout();
    assert.equal(s.actor.easeCalls, 0);
    rectEqual(s.animations.visual_rect(s.window), actual);
    mocks.redraw();
    s.assert_clean();
});

check('a pending request reversed to the original geometry needs no animation', () => {
    const s = scenario({ async: true });
    s.animations.move(s.window, TARGET, true);
    s.animations.move(s.window, BEFORE, true);
    s.commit();
    mocks.redraw();
    assert.equal(s.actor.easeCalls, 0);
    mocks.redraw();
    s.assert_clean();
});

check('repeated requests preserve a running transition to constrained geometry', () => {
    const s = scenario({ async: true });
    s.animations.move(s.window, TARGET, true);
    const constrained = { ...TARGET, width: 650 };
    s.commit(constrained);
    mocks.redraw();
    const animation = s.actor.animation;
    s.actor.advance(0.5);
    const visual = s.animations.visual_rect(s.window);
    s.animations.move(s.window, TARGET, true);
    assert.equal(s.actor.animation, animation);
    assert.equal(s.actor.easeCalls, 1);
    rectEqual(s.animations.visual_rect(s.window), visual);
    s.actor.complete();
    mocks.redraw();
    s.assert_clean();
});

check('duplicate boxed geometry notifications preserve an existing transition', () => {
    const s = scenario();
    s.animations.move(s.window, TARGET, true);
    mocks.redraw();
    const animation = s.actor.animation;
    s.animations.move(s.window, TARGET, true);
    assert.equal(s.actor.animation, animation);
    s.meta.emit('size-changed');
    assert.equal(s.group.children.length, 2);
    s.animations.cancel_all();
    mocks.redraw();
    s.assert_clean();
});

for (const setting of ['enable_animations', 'reduced_motion', 'slow_down_factor']) {
    check(`system ${setting} can skip or cancel motion without delaying geometry`, () => {
        const s = scenario();
        mocks.settings[setting] = setting === 'reduced_motion' ? 1 : 0;
        s.animations.move(s.window, TARGET, true);
        assert.equal(s.submitted(), 1);
        assert.equal(s.actor.animation, null);
        mocks.redraw();
        s.assert_clean();

        const active = scenario();
        active.animations.move(active.window, TARGET, true);
        mocks.redraw();
        mocks.settings[setting] = setting === 'reduced_motion' ? 1 : 0;
        active.animations.settings_changed();
        mocks.redraw();
        active.assert_clean();
    });
}

for (const signal of ['workspace-changed', 'notify::minimized', 'notify::fullscreen', 'unmanaged']) {
    check(`${signal} cleans up pending and running animations`, () => {
        for (const running of [false, true]) {
            const s = scenario();
            s.animations.move(s.window, TARGET, true);
            if (running) mocks.redraw();
            s.meta.emit(signal);
            mocks.redraw();
            s.assert_clean();
        }
    });
}

check('actor destruction removes snapshots, sources and handlers', () => {
    const s = scenario();
    s.animations.move(s.window, TARGET, true);
    s.actor.destroy();
    assert.equal(s.group.children.length, 0);
    assert.equal(s.meta.signals.size, 0);
    assert.equal(mocks.timers.size, 0);
    assert.equal(mocks.laters.size, 0);
});

check('native transitions and missing textures are left intact', () => {
    for (const reason of ['opacity', 'scale-x', 'captureFails', 'unmapped']) {
        const s = scenario();
        if (reason === 'captureFails') s.actor.captureFails = true;
        else if (reason === 'unmapped') s.actor.mapped = false;
        else s.actor.transitions.set(reason, { native: true });
        s.animations.move(s.window, TARGET, true);
        assert.equal(s.actor.animation, null);
        assert.equal(s.submitted(), 1);
        if (reason === 'opacity' || reason === 'scale-x') assert.ok(s.actor.get_transition(reason).native);
        mocks.redraw();
        s.assert_clean();
    }
});

check('native state changes cancel and briefly inhibit overlapping plugin animation', () => {
    const s = scenario();
    s.animations.move(s.window, TARGET, true);
    mocks.redraw();
    s.animations.native_change(s.window);
    s.actor.animation = null;
    s.animations.move(s.window, BEFORE, true);
    assert.equal(s.actor.animation, null);
    mocks.tick(501_000);
    s.animations.move(s.window, TARGET, true);
    mocks.redraw();
    assert.ok(s.actor.animation);
    s.animations.cancel_all();
    mocks.redraw();
    s.assert_clean();
});

check('a client resize during animation reveals its actual geometry', () => {
    const s = scenario();
    s.animations.move(s.window, TARGET, true);
    mocks.redraw();
    s.commit({ ...TARGET, width: 700 });
    mocks.redraw();
    s.assert_clean();
});

check('disabled moves and cancellation preserve unrelated native effects', () => {
    const s = scenario();
    s.animations.move(s.window, TARGET, false);
    assert.equal(s.submitted(), 1);
    assert.equal(s.actor.animation, null);
    s.animations.move(s.window, BEFORE, true);
    mocks.redraw();
    s.actor.transitions.set('opacity', { native: true });
    s.animations.cancel_all();
    assert.ok(s.actor.get_transition('opacity').native);
    mocks.redraw();
    s.assert_clean();
});

check('one controller independently animates and cleans up multiple windows', () => {
    const a = scenario();
    const b = scenario({ async: true, reset: false });
    a.animations.move(a.window, TARGET, true);
    a.animations.move(b.window, TARGET, true);
    mocks.redraw();
    assert.ok(a.actor.animation);
    assert.equal(b.actor.animation, null);
    a.animations.cancel(a.window);
    b.commit();
    mocks.redraw();
    assert.ok(b.actor.animation);
    a.animations.cancel_all();
    mocks.redraw();
    a.assert_clean();
    b.assert_clean();
});

check('property notifications from multiple windows produce one layout batch per redraw', () => {
    const a = scenario();
    const b = scenario({ reset: false });
    a.animations.move(a.window, TARGET, true);
    a.animations.move(b.window, TARGET, true);
    mocks.redraw();
    mocks.redraw();
    const batches = a.layout_batches.length;
    a.actor.advance(0.5);
    b.actor.advance(0.5);
    assert.equal(a.layout_batches.length, batches);
    mocks.redraw();
    assert.equal(a.layout_batches.length, batches + 1);
    assert.deepEqual(new Set(a.layout_batches.at(-1)), new Set([a.window, b.window]));
    a.animations.cancel_all();
    assert.equal(mocks.laters.size, 0);
    mocks.redraw();
    a.assert_clean();
    b.assert_clean();
});

console.log(`ALL ${checks} ANIMATION CHECKS PASSED`);
