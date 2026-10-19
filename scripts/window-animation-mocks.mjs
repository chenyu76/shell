export class Signals {
    signals = new Map();
    nextId = 1;
    connect(name, callback) {
        const id = this.nextId++;
        this.signals.set(id, { name, callback });
        return id;
    }
    disconnect(id) { this.signals.delete(id); }
    emit(name) {
        for (const [id, signal] of [...this.signals]) {
            if (this.signals.has(id) && signal.name === name) signal.callback(this);
        }
    }
}

// GI boxed fields are accessible but non-enumerable; a spread copy loses them.
export class BoxedRectangle {
    constructor(rect) {
        for (const key of ['x', 'y', 'width', 'height']) {
            Object.defineProperty(this, key, { value: rect[key], writable: true });
        }
    }
}

export class Actor extends Signals {
    children = [];
    parent = null;
    mapped = true;
    animation = null;
    easeCalls = 0;
    transitions = new Map();
    destroyed = false;
    constructor(props = {}) {
        super();
        const defaults = { x: 0, y: 0, width: 100, height: 100, opacity: 255,
            translation_x: 0, translation_y: 0, scale_x: 1, scale_y: 1 };
        for (const [key, initial] of Object.entries(defaults)) {
            let value = initial;
            Object.defineProperty(this, key, {
                get: () => value,
                set: next => {
                    if (value === next) return;
                    value = next;
                    this.emit(`notify::${key.replaceAll('_', '-')}`);
                },
            });
        }
        Object.assign(this, props);
    }
    set_position(x, y) { this.x = x; this.y = y; }
    set_size(width, height) { this.width = width; this.height = height; }
    get_parent() { return this.parent; }
    add_child(child) { this.children.push(child); child.parent = this; }
    set_child_above_sibling() { }
    paint_to_content(rect) {
        if (!(rect instanceof BoxedRectangle)) throw new Error('Expected boxed rectangle');
        if (this.captureFails) throw new Error('No texture');
        const x = Math.max(rect.x, this.x);
        const y = Math.max(rect.y, this.y);
        const width = Math.min(rect.x + rect.width, this.x + this.width) - x;
        const height = Math.min(rect.y + rect.height, this.y + this.height) - y;
        return width > 0 && height > 0 ? { rect: { x, y, width, height } } : null;
    }
    get_transition(property) { return this.transitions.get(property) ?? null; }
    remove_transition(property) {
        const animation = this.transitions.get(property);
        this.transitions.delete(property);
        if (animation?.onStopped) {
            const callback = animation.onStopped;
            animation.onStopped = null;
            callback(false);
        }
    }
    ease(params) {
        this.easeCalls++;
        const { duration, mode, onStopped, ...targets } = params;
        this.animation = { duration, mode, onStopped, targets, start: {} };
        for (const key of Object.keys(targets)) {
            this.animation.start[key] = this[key];
            this.transitions.set(key.replaceAll('_', '-'), this.animation);
        }
        if (!settings.enable_animations || settings.slow_down_factor === 0) this.complete();
    }
    advance(progress) {
        const animation = this.animation;
        for (const [key, target] of Object.entries(animation.targets)) {
            this[key] = animation.start[key] + (target - animation.start[key]) * progress;
        }
    }
    complete() {
        const animation = this.animation;
        this.advance(1);
        for (const key of Object.keys(animation.targets)) this.transitions.delete(key.replaceAll('_', '-'));
        animation.onStopped?.(true);
    }
    destroy() {
        if (this.destroyed) return;
        this.destroyed = true;
        this.emit('destroy');
        if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1);
        this.parent = null;
        this.signals.clear();
        this.transitions.clear();
    }
}

export const settings = { enable_animations: true, slow_down_factor: 1, reduced_motion: 0 };
export const timers = new Map();
export const laters = new Map();
let nextSource = 1;
export let now = 0;
export function tick(microseconds) { now += microseconds; }
export function redraw() {
    const batch = [...laters.values()];
    laters.clear();
    for (const callback of batch) callback();
}
export function timeout() {
    const batch = [...timers.values()];
    timers.clear();
    for (const timer of batch) timer.callback();
}
export function reset() {
    settings.enable_animations = true;
    settings.slow_down_factor = 1;
    settings.reduced_motion = 0;
    timers.clear();
    laters.clear();
    now = 0;
}
export const compositor = { get_laters: () => ({
    add(_type, callback) { const id = nextSource++; laters.set(id, callback); return id; },
    remove(id) { laters.delete(id); },
}) };

export default {
    Widget: Actor,
    Settings: { get: () => settings },
    ReducedMotion: { REDUCE: 1 },
    AnimationMode: { EASE_OUT_QUAD: 3 },
    OffscreenRedirect: { ALWAYS: 1 },
    LaterType: { BEFORE_REDRAW: 0 },
    PRIORITY_DEFAULT: 0,
    SOURCE_REMOVE: false,
    get_monotonic_time: () => now,
    timeout_add(_priority, delay, callback) {
        const id = nextSource++;
        timers.set(id, { delay, callback });
        return id;
    },
    source_remove(id) { timers.delete(id); },
};
