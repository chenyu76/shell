import type { Entity } from './ecs.js';
import type { Ext } from './extension.js';
import type { ShellWindow } from './window.js';

import * as Ecs from './ecs.js';

/** The smallest portion of a stack's area which its windows may be reduced to. */
const MIN_STACK_FRACTION = 0.5;

/** The smallest size in pixels which a window of a stack may be reduced to. */
const MIN_WINDOW_SIZE = 64;

function contains(entities: Array<Entity>, entity: Entity): boolean {
    return entities.some((compare) => Ecs.entity_eq(compare, entity));
}

/** Limits an offset so that the windows of a stack do not shrink below the minimums above. */
function clamp_offset(offset: number, length: number, count: number): number {
    if (count < 2) return 0;

    const minimum = Math.max(MIN_WINDOW_SIZE, length * MIN_STACK_FRACTION);
    const maximum = Math.max(0, (length - minimum) / (count - 1));

    return Math.max(0, Math.min(offset, maximum));
}

/** A stack of windows which are displayed as a cascading pile
 *
 * Every window of a stack has the same size, and each window is translated
 * further to the bottom-right than the window behind it. This keeps the title
 * bar and the left edge of every window which is not displayed in front visible.
 *
 * The window which has the focus is displayed in front, where it is completely
 * visible. Displaying another window swaps its place with the window in front,
 * whereas the direction keys rotate the pile, displaying every window in turn.
 */
export class Stack {
    ext: Ext;

    /** The window which is displayed in front of the others */
    active: Entity;

    /** The position of the active window in `entities` */
    active_id: number = 0;

    /** The windows of this stack, in the order which they are navigated in */
    entities: Array<Entity> = new Array();

    /** The windows of this stack in the order which they are displayed in, from the back to the front */
    display: Array<Entity> = new Array();

    monitor: number;

    workspace: number;

    /** The area which the windows of this stack are arranged within */
    private rect: Rectangular = { width: 0, height: 0, x: 0, y: 0 };

    /** Whether the windows may be displayed, disabled while one of them is fullscreen */
    private visible: boolean = true;

    /** Prevents a re-entrant arrangement, which raising a window may trigger */
    private arranging: boolean = false;

    /** Whether the windows must be raised, in order to match the display order */
    private reorder: boolean = true;

    /** How often the pile was rotated in a row, and in which direction */
    private cycled: number = 0;
    private cycled_forward: boolean = true;

    /** The offsets which the current arrangement was computed with */
    private offsets_used: [number, number] = [0, 0];

    private active_signals: [SignalID, SignalID] | null = null;

    private restacker: SignalID = global.display.connect('restacked', () => this.restack());

    constructor(ext: Ext, active: Entity, workspace: number, monitor: number) {
        this.ext = ext;
        this.active = active;
        this.monitor = monitor;
        this.workspace = workspace;
    }

    /** Sets the windows which are in this stack
     *
     * The order in which the windows are displayed is kept, and windows which
     * joined the stack are displayed in front of the others.
     */
    set_entities(entities: Array<Entity>) {
        this.active_disconnect();

        this.entities = entities.slice();

        this.display = this.display.filter((entity) => contains(this.entities, entity));

        for (const entity of this.entities) {
            if (!contains(this.display, entity)) this.display.push(entity);
        }

        this.reorder = true;
    }

    /** Displays a window of the stack in front of the others
     *
     * `cycled` is set while the direction keys rotate the stack, which continues
     * the current cycle instead of starting a new one.
     */
    activate(entity: Entity, cycled: boolean = false) {
        if (this.arranging) return;

        const window = this.ext.windows.get(entity);
        if (!window) return;

        // Another window is displayed in front by other means than the direction
        // keys, so the whole stack may be cycled again.
        if (!cycled && !Ecs.entity_eq(entity, this.active)) {
            this.reset_cycle();
        }

        const id = this.entities.findIndex((compare) => Ecs.entity_eq(compare, entity));
        if (id !== -1) this.active_id = id;

        const permitted = this.permitted_to_show();

        this.active_connect(window.meta, entity);
        this.promote(entity);
        this.reset_visibility(permitted);
        this.arrange();
    }

    /** Displays the active window in front of the others
     *
     * This is called after the windows of the stack were set, and falls back to
     * the last window when the active one left the stack.
     */
    auto_activate(): null | Entity {
        if (this.entities.length === 0) return null;

        if (this.entities.length <= this.active_id) {
            this.active_id = this.entities.length - 1;
        }

        const entity = this.entities[this.active_id];

        this.activate(entity);
        return entity;
    }

    /** Displays the next window of the stack in front of the others
     *
     * The pile is rotated, so that every window takes its turn in front of the
     * others. Cycling forwards displays the window which is directly behind the
     * window in front, and moves the window in front to the back of the pile,
     * whereas cycling backwards undoes a cycle.
     *
     * Returns null when the stack holds fewer than two windows, or once the whole
     * stack has been displayed in front, which means that focus may be shifted
     * out of the stack instead.
     */
    cycle(forward: boolean): null | Entity {
        const count = this.display.length;

        if (this.arranging || count < 2) return null;

        if (forward === this.cycled_forward) {
            if (this.cycled >= count - 1) return null;

            this.cycled += 1;
        } else {
            // Cycling backwards undoes one of the rotations which were made in the
            // other direction.
            this.cycled_forward = forward;
            this.cycled = Math.max(0, this.cycled - 1);
        }

        if (forward) {
            this.display.unshift(this.display.pop() as Entity);
        } else {
            this.display.push(this.display.shift() as Entity);
        }

        this.reorder = true;

        const entity = this.display[count - 1];

        this.activate(entity, true);
        return entity;
    }

    /** Allows the direction keys to cycle through the whole stack once more */
    reset_cycle() {
        this.cycled = 0;
        this.cycled_forward = true;
    }

    /** Removes a window from the stack, returning the position which it had */
    remove(entity: Entity): null | number {
        const idx = this.entities.findIndex((compare) => Ecs.entity_eq(compare, entity));
        if (idx === -1) return null;

        this.entities.splice(idx, 1);
        this.display = this.display.filter((compare) => !Ecs.entity_eq(compare, entity));

        if (this.active_id > idx) this.active_id -= 1;

        // The window is no longer hidden behind the others.
        const window = this.ext.windows.get(entity);

        if (window && this.workspace === this.ext.active_workspace()) {
            window.meta.get_compositor_private()?.show();
        }

        return idx;
    }

    /** Replaces the window which is displayed in front with another window */
    replace(window: ShellWindow) {
        const previous = this.entities[this.active_id];
        if (!previous || !window.meta.get_compositor_private()) return;

        const replace = (entity: Entity) => (Ecs.entity_eq(entity, previous) ? window.entity : entity);

        this.entities = this.entities.map(replace);
        this.display = this.display.map(replace);

        this.activate(window.entity);
    }

    /** Disconnects this stack, and displays its windows again */
    destroy() {
        global.display.disconnect(this.restacker);
        this.active_disconnect();

        for (const entity of this.entities.splice(0)) {
            const window = this.ext.windows.get(entity);
            if (!window) continue;

            if (this.workspace === this.ext.active_workspace()) {
                window.meta.get_compositor_private()?.show();
                window.stack = null;
            }
        }

        this.display = new Array();
    }

    /** Disconnects the change handlers of a window which is leaving the stack */
    deactivate(w: ShellWindow) {
        if (Ecs.entity_eq(this.active, w.entity)) this.active_disconnect();
    }

    /** The area which this stack occupies, given the frame rect of the window in front
     *
     * The arrangement is inverted with the offsets which it was last computed
     * with, which lets a stack be resized by the frame of its window in front.
     */
    area_from_window(rect: Rectangular): Rectangular {
        const count = this.entities.length;
        if (count < 2) return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };

        const [dx, dy] = this.offsets_used;

        return {
            x: rect.x - (count - 1) * dx,
            y: rect.y - (count - 1) * dy,
            width: rect.width + (count - 1) * dx,
            height: rect.height + (count - 1) * dy,
        };
    }

    /** Sets the area which the windows of this stack are arranged within */
    set_area(rect: Rectangular) {
        this.rect = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
        this.arrange();
    }

    /** Displays every window of the stack, or hides it when it may not be shown */
    reset_visibility(permitted: boolean) {
        for (const entity of this.entities) {
            const actor = this.ext.windows.get(entity)?.meta.get_compositor_private() ?? null;
            if (!actor) continue;

            if (permitted && (this.visible || Ecs.entity_eq(entity, this.active))) {
                actor.show();
            } else {
                actor.hide();
            }
        }
    }

    /** Whether the windows of this stack may be displayed on the active workspace */
    permitted_to_show(): boolean {
        const workspace = global.workspace_manager.get_active_workspace_index();
        const primary = global.display.get_primary_monitor();
        const only_primary = this.ext.settings.workspaces_only_on_primary();

        return workspace === this.workspace || (only_primary && this.monitor != primary);
    }

    /** Re-arranges the stack, and updates the visibility of its windows */
    restack() {
        this.on_grab(() => {
            const permitted = this.permitted_to_show();

            this.reset_visibility(permitted);

            if (permitted) this.arrange();
        });
    }

    /** Sets whether the windows may be displayed, which fullscreen windows disable */
    set_visible(visible: boolean) {
        this.visible = visible;
        this.reset_visibility(this.permitted_to_show());
    }

    /** Displays a window in front of the others, swapping it with the window in front */
    private promote(entity: Entity) {
        const front = this.display.length - 1;
        const current = this.display.findIndex((compare) => Ecs.entity_eq(compare, entity));

        if (current === -1 || current === front) return;

        this.display[current] = this.display[front];
        this.display[front] = entity;
        this.reorder = true;
    }

    /** The offsets which separate each window of the pile from the window behind it
     *
     * The offsets are limited, so that the entire pile remains within the area
     * which the stack occupies.
     */
    private offsets(area: Rectangular, count: number): [number, number] {
        const { settings, dpi } = this.ext;

        return [
            clamp_offset(settings.stack_offset_x() * dpi, area.width, count),
            clamp_offset(settings.stack_offset_y() * dpi, area.height, count),
        ];
    }

    /** Computes the geometry of every window of the pile */
    private window_rects(): Array<Rectangular> {
        const count = this.display.length;
        const { x, y, width, height } = this.rect;
        const rects: Array<Rectangular> = new Array(count);

        if (count === 0) return rects;

        if (count === 1) {
            rects[0] = { x, y, width, height };
            return rects;
        }

        const [dx, dy] = this.offsets(this.rect, count);

        this.offsets_used = [Math.round(dx), Math.round(dy)];

        const w = Math.round(width - (count - 1) * dx);
        const h = Math.round(height - (count - 1) * dy);

        for (let i = 0; i < count; i += 1) {
            rects[i] = { x: Math.round(x + i * dx), y: Math.round(y + i * dy), width: w, height: h };
        }

        return rects;
    }

    /** Moves the windows of the stack into their cascaded positions */
    private arrange() {
        if (this.arranging || this.display.length === 0) return;
        if (this.rect.width <= 0 || this.rect.height <= 0) return;

        this.arranging = true;

        try {
            const rects = this.window_rects();
            const windows = this.display.map((entity) => this.ext.windows.get(entity));

            for (const [idx, window] of windows.entries()) {
                if (window && window.actor_exists()) this.move_window(window, rects[idx]);
            }

            if (this.reorder) {
                this.reorder = false;

                // Raise the windows from the back to the front, so that they are
                // stacked in the same order as they are displayed in.
                for (const window of windows) {
                    if (window && window.actor_exists()) window.meta.raise();
                }
            }
        } finally {
            this.arranging = false;
        }
    }

    private move_window(window: ShellWindow, rect: Rectangular) {
        const current = window.rect();

        if (
            current.x === rect.x &&
            current.y === rect.y &&
            current.width === rect.width &&
            current.height === rect.height
        ) {
            return;
        }

        // A window which is maximized on another workspace refuses to move, which
        // would otherwise leave its size signals blocked.
        if (!window.same_workspace() && window.is_maximized()) return;

        const ext = this.ext;

        ext.size_signals_block(window);
        window.move(ext, rect, () => {
            // Keep the tiling overlay in sync with the window which is being moved.
            if (ext.tiler.window !== null && Ecs.entity_eq(ext.tiler.window, window.entity)) {
                ext.set_overlay(window.rect());
            }

            ext.size_signals_unblock(window);
        });
    }

    /** Connects the change handlers to a window which is displayed in front */
    private active_connect(window: Meta.Window, active: Entity) {
        this.active_disconnect();

        this.active = active;

        const update_border = () =>
            this.on_grab(() => {
                if (this.ext.windows.get(this.active)) {
                    this.ext.show_border_on_focused();
                } else {
                    this.active_disconnect();
                }
            });

        this.active_signals = [
            window.connect('size-changed', update_border),
            window.connect('position-changed', update_border),
        ];
    }

    /** Disconnects the change handlers of the active window */
    private active_disconnect() {
        const window = this.ext.windows.get(this.active);

        if (this.active_signals && window) {
            for (const signal of this.active_signals) window.meta.disconnect(signal);
        }

        this.active_signals = null;
    }

    /** Runs the callback, unless a window of this stack is being dragged */
    private on_grab(callback: () => void) {
        const grab = this.ext.grab_op;

        if (grab !== null && Ecs.entity_eq(grab.entity, this.active)) return;

        callback();
    }
}
