import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import St from 'gi://St';
import * as log from './log.js';
import type { ShellWindow } from './window.js';

const DURATION = 250;
const UPDATE_TIMEOUT = 500;
const TRANSFORMS = ['translation-x', 'translation-y', 'scale-x', 'scale-y'];

interface Animation {
    window: ShellWindow;
    actor: Clutter.Actor;
    clone: Clutter.Actor;
    source: Rectangular;
    before: Rectangular;
    requested: Rectangular;
    target: Rectangular | null;
    opacity: number;
    timeout: number | null;
    later: number | null;
    signals: Array<[GObject.Object, number]>;
}

function equal(a: Rectangular, b: Rectangular): boolean {
    return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

function same_size(a: Rectangular, b: Rectangular): boolean {
    return a.width === b.width && a.height === b.height;
}

// GI boxed fields are not enumerable; a spread copy would lose them.
function copy_rect(rect: Rectangular): Rectangular {
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}

function valid(rect: Rectangular): boolean {
    return [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) && rect.width > 0 && rect.height > 0;
}

function has_native_effect(actor: Clutter.Actor): boolean {
    return actor.translation_x !== 0 || actor.translation_y !== 0 || actor.scale_x !== 1 || actor.scale_y !== 1 ||
        [...TRANSFORMS, 'opacity'].some((property) => actor.get_transition(property));
}

/** Visual transitions only: the movement queue and its callbacks never wait for these. */
export class WindowAnimations {
    private animations = new Map<ShellWindow, Animation>();
    private inhibited = new WeakMap<ShellWindow, number>();
    private dirty_windows = new Set<ShellWindow>();
    private layout_later: number | null = null;

    constructor(private update_layout: (windows: ReadonlySet<ShellWindow>) => void) { }

    /** The frame currently on screen, including an interrupted transition. */
    visual_rect(window: ShellWindow, fallback?: Rectangular): Rectangular {
        const state = this.animations.get(window);
        if (!state) return fallback ?? window.meta.get_frame_rect();
        if (state.target === null) return state.source;

        const frame = window.meta.get_frame_rect();
        const actor = state.actor;
        const buffer = window.meta.get_buffer_rect();
        return {
            x: actor.x + actor.translation_x + (frame.x - buffer.x) * actor.scale_x,
            y: actor.y + actor.translation_y + (frame.y - buffer.y) * actor.scale_y,
            width: frame.width * actor.scale_x,
            height: frame.height * actor.scale_y,
        };
    }

    /** Submit the real geometry once, then animate the compositor's actual result. */
    move(window: ShellWindow, target: Rectangular, enabled: boolean) {
        const meta = window.meta;
        const before = meta.get_frame_rect();
        const minimum = meta.get_min_size?.();
        if (minimum?.[0]) {
            // Convert client size hints to frame geometry: include server-side
            // borders and exclude client-side shadows.
            const client = meta.get_frame_rect();
            client.width = minimum[1];
            client.height = minimum[2];
            const frame = meta.client_rect_to_frame_rect(client);
            // Mutter can drop the move as well as the resize when a Wayland
            // request is below the minimum and the client is already that size.
            target = {
                x: target.x, y: target.y,
                width: minimum[1] > 0 ? Math.max(target.width, frame.width) : target.width,
                height: minimum[2] > 0 ? Math.max(target.height, frame.height) : target.height,
            };
        }

        try {
            this.prepare(window, before, target, enabled);
        } catch (error) {
            this.cancel(window);
            log.warn(`Window animation unavailable: ${error}`);
        }

        // Animation failures may fall back; real movement failures must reach the caller.
        try {
            meta.move_resize_frame(true, target.x, target.y, target.width, target.height);
        } catch (error) {
            this.cancel(window);
            throw error;
        }
    }

    private prepare(window: ShellWindow, before: Rectangular, target: Rectangular, enabled: boolean) {
        const actor = window.meta.get_compositor_private();
        const source = this.visual_rect(window);
        const previous = this.animations.get(window);
        const owned = previous !== undefined;
        const eligible = enabled && actor?.mapped && (actor.opacity > 0 || owned) && valid(source) && valid(target) &&
            this.motion_enabled() && GLib.get_monotonic_time() >= (this.inhibited.get(window) ?? 0) &&
            // Leave transforms owned by Shell (map/maximize/fullscreen/etc.) alone.
            (owned || !has_native_effect(actor));

        if (!eligible || !actor) {
            this.cancel(window);
            return;
        }
        if (previous?.actor === actor) {
            if (equal(previous.requested, target)) return;
            if (previous.target === null) {
                previous.before = before;
                previous.requested = copy_rect(target);
                this.geometry_changed(previous);
                return;
            }
        }

        // Mutter clips against the untransformed allocation. Reset our old
        // transform before capture, then display that content at `source`.
        this.cancel(window);
        if (!previous && equal(before, target)) return;

        const parent = actor.get_parent();
        if (!parent) return;
        const clone = this.create_snapshot(actor, before, source);
        if (!clone) return;

        const state: Animation = {
            window, actor, clone, source, before, requested: copy_rect(target), target: null, opacity: actor.opacity,
            timeout: null, later: null, signals: [],
        };
        this.animations.set(window, state);
        parent.add_child(clone);
        parent.set_child_above_sibling(clone, actor);
        this.connect_signals(state);

        // Cover asynchronous Wayland configure/commit with the old picture.
        actor.opacity = 0;
        this.queue_layout(window);
        state.timeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, UPDATE_TIMEOUT, () => {
            state.timeout = null;
            this.finish(state);
            return GLib.SOURCE_REMOVE;
        });
        this.geometry_changed(state);
    }

    private create_snapshot(
        actor: Meta.WindowActor,
        before: Rectangular,
        source: Rectangular,
    ): Clutter.Actor | null {
        let content;
        try {
            // Preserve Mutter's boxed rectangle type across GNOME versions.
            content = actor.paint_to_content(before);
        } catch {
            // A window without a texture must still be moved normally.
            return null;
        }
        return content ? new St.Widget({
            content, reactive: false,
            x: source.x, y: source.y, width: source.width, height: source.height,
            offscreen_redirect: Clutter.OffscreenRedirect.ALWAYS,
        }) : null;
    }

    private connect_signals(state: Animation) {
        const { window, actor } = state;
        const connect = (object: GObject.Object, signal: string, callback: () => void) => {
            state.signals.push([object, object.connect(signal, callback)]);
        };
        connect(actor, 'destroy', () => this.finish(state, true));
        for (const signal of ['unmanaged', 'workspace-changed', 'notify::minimized', 'notify::fullscreen']) {
            connect(window.meta, signal, () => this.cancel(window));
        }
        for (const signal of ['position-changed', 'size-changed']) {
            connect(window.meta, signal, () => this.geometry_changed(state));
        }
        for (const property of ['x', 'y', 'width', 'height']) {
            connect(actor, `notify::${property}`, () => this.geometry_changed(state));
        }
        for (const property of TRANSFORMS) {
            connect(actor, `notify::${property}`, () => {
                if (this.animations.get(window) === state && state.target !== null) this.queue_layout(window);
            });
        }
    }

    private motion_enabled(): boolean {
        const settings = St.Settings.get();
        return settings.enable_animations && settings.slow_down_factor > 0 &&
            (St.ReducedMotion === undefined || settings.reduced_motion !== St.ReducedMotion.REDUCE);
    }

    private geometry_changed(state: Animation) {
        if (this.animations.get(state.window) !== state) return;
        // A second client resize invalidates the inverse scale. Reveal the actual window.
        if (state.target !== null) {
            const target = state.window.meta.get_frame_rect();
            const buffer = state.window.meta.get_buffer_rect();
            if (!equal(target, state.target) || !this.actor_ready(state.actor, buffer)) {
                this.finish(state);
            }
            return;
        }
        if (state.later !== null) return;
        state.later = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            state.later = null;
            if (this.animations.get(state.window) === state) {
                try {
                    this.start(state);
                } catch (error) {
                    this.finish(state);
                    log.warn(`Window animation unavailable: ${error}`);
                }
            }
            return false;
        });
    }

    private start(state: Animation) {
        const { window, actor, source, clone } = state;
        const target = window.meta.get_frame_rect();
        const buffer = window.meta.get_buffer_rect();
        if (!this.motion_enabled() || !valid(target) || !actor.mapped) {
            this.finish(state);
            return;
        }
        // Do not assume move_resize_frame synchronously resizes a Wayland surface.
        if (equal(target, state.before) && !equal(target, state.requested)) return;
        // A compositor-side move can arrive before the client's resized buffer.
        if (!same_size(state.before, state.requested) && same_size(target, state.before)) return;
        if (!this.actor_ready(actor, buffer)) return;
        if (equal(source, target)) {
            this.finish(state);
            return;
        }

        if (state.timeout !== null) GLib.source_remove(state.timeout);
        state.timeout = null;
        const scale_x = source.width / target.width;
        const scale_y = source.height / target.height;
        // Frame and buffer origins differ for CSD shadows and server-side borders.
        actor.scale_x = scale_x;
        actor.scale_y = scale_y;
        actor.translation_x = source.x - actor.x - (target.x - buffer.x) * scale_x;
        actor.translation_y = source.y - actor.y - (target.y - buffer.y) * scale_y;
        actor.opacity = state.opacity;
        state.target = copy_rect(target);
        this.queue_layout(window);

        clone.ease({
            x: target.x, y: target.y,
            scale_x: target.width / source.width, scale_y: target.height / source.height,
            opacity: 0, duration: DURATION, mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
        actor.ease({
            translation_x: 0, translation_y: 0, scale_x: 1, scale_y: 1,
            duration: DURATION, mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onStopped: () => this.finish(state),
        });
    }

    private actor_ready(actor: Clutter.Actor, buffer: Rectangular): boolean {
        return Math.abs(actor.width - buffer.width) <= 1 && Math.abs(actor.height - buffer.height) <= 1 &&
            Math.abs(actor.x - buffer.x) <= 1 && Math.abs(actor.y - buffer.y) <= 1;
    }

    /** Coalesce property notifications from all windows before the next redraw. */
    private queue_layout(window: ShellWindow) {
        this.dirty_windows.add(window);
        if (this.layout_later !== null) return;
        this.layout_later = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            this.layout_later = null;
            this.flush_layout();
            return false;
        });
    }

    private flush_layout() {
        if (this.layout_later !== null) {
            global.compositor.get_laters().remove(this.layout_later);
            this.layout_later = null;
        }
        if (this.dirty_windows.size === 0) return;
        const windows = this.dirty_windows;
        this.dirty_windows = new Set();
        this.update_layout(windows);
    }

    settings_changed() {
        if (!this.motion_enabled()) this.cancel_all();
    }

    /** A native state change owns the actor until its own transition has settled. */
    native_change(window: ShellWindow) {
        this.cancel(window);
        const factor = St.Settings.get().slow_down_factor;
        this.inhibited.set(window, GLib.get_monotonic_time() + Math.max(UPDATE_TIMEOUT, DURATION * factor) * 1000);
    }

    cancel(window: ShellWindow) {
        const state = this.animations.get(window);
        if (state) this.finish(state);
    }

    cancel_all() {
        for (const state of this.animations.values()) this.finish(state);
        this.flush_layout();
    }

    private finish(state: Animation, destroyed = false) {
        if (this.animations.get(state.window) !== state) return;
        // Remove ownership first: stopping a transition invokes onStopped synchronously.
        this.animations.delete(state.window);
        if (state.timeout !== null) GLib.source_remove(state.timeout);
        if (state.later !== null) global.compositor.get_laters().remove(state.later);
        for (const [object, id] of state.signals) object.disconnect(id);
        state.clone.destroy();
        if (destroyed) {
            this.dirty_windows.delete(state.window);
            if (this.dirty_windows.size === 0) this.flush_layout();
        } else {
            if (state.target !== null) {
                for (const property of TRANSFORMS) state.actor.remove_transition(property);
                state.actor.translation_x = state.actor.translation_y = 0;
                state.actor.scale_x = state.actor.scale_y = 1;
            } else {
                state.actor.opacity = state.opacity;
            }
            this.queue_layout(state.window);
        }
    }
}
