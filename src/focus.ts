import * as Ecs from './ecs.js';
import * as Geom from './geom.js';

import type { ShellWindow } from './window.js';
import type { Ext } from './extension.js';

export enum FocusPosition {
    TopLeft = 'Top Left',
    TopRight = 'Top Right',
    BottomLeft = 'Bottom Left',
    BottomRight = 'Bottom Right',
    Center = 'Center',
}

interface FocusCandidate {
    window: ShellWindow;
    area: Rectangular;
}

/** Tiled navigation follows the tree even while native geometry is still queued. */
export function window_area(ext: Ext, window: ShellWindow): Rectangular {
    const stack = window.stack === null ? null : ext.auto_tiler?.forest.stacks.get(window.stack);
    return stack?.rect ?? window.rect();
}

export class FocusSelector {
    /** Selects the closest window in a direction, ignoring the windows which the filter rejects */
    private select(
        ext: Ext,
        direction: (area: Rectangular, candidates: Array<FocusCandidate>) => Array<FocusCandidate>,
        window: ShellWindow | null,
        filter?: (window: ShellWindow) => boolean,
    ): ShellWindow | null {
        window = window ?? ext.focus_window();
        if (window) {
            // A stack is represented by the window which it displays in front, as
            // the windows behind it are hidden by that window.
            let window_list = ext.active_window_list().filter((window) => !window.meta.minimized && in_front(ext, window));

            if (filter) window_list = window_list.filter(filter);

            const candidates = window_list.map(window => ({ window, area: window_area(ext, window) }));
            return direction(window_area(ext, window), candidates)[0]?.window ?? null;
        }

        return null;
    }

    down(ext: Ext, window: ShellWindow | null, filter?: (window: ShellWindow) => boolean): ShellWindow | null {
        return this.select(ext, window_down, window, filter);
    }

    left(ext: Ext, window: ShellWindow | null, filter?: (window: ShellWindow) => boolean): ShellWindow | null {
        return this.select(ext, window_left, window, filter);
    }

    right(ext: Ext, window: ShellWindow | null, filter?: (window: ShellWindow) => boolean): ShellWindow | null {
        return this.select(ext, window_right, window, filter);
    }

    up(ext: Ext, window: ShellWindow | null, filter?: (window: ShellWindow) => boolean): ShellWindow | null {
        return this.select(ext, window_up, window, filter);
    }
}

/** Whether this window is displayed in front of the stack which it belongs to */
function in_front(ext: Ext, window: ShellWindow): boolean {
    if (window.stack === null) return true;

    const stack = ext.auto_tiler?.forest.stacks.get(window.stack);
    if (!stack) return true;

    return Ecs.entity_eq(stack.active, window.entity);
}

function window_down(focused: Rectangular, windows: Array<FocusCandidate>) {
    return windows
        .filter(({ area }) => area.y > focused.y)
        .sort((a, b) => Geom.directional_distance(a.area, focused, Geom.north, Geom.south) -
            Geom.directional_distance(b.area, focused, Geom.north, Geom.south));
}

function window_left(focused: Rectangular, windows: Array<FocusCandidate>) {
    return windows
        .filter(({ area }) => area.x < focused.x)
        .sort((a, b) => Geom.directional_distance(a.area, focused, Geom.east, Geom.west) -
            Geom.directional_distance(b.area, focused, Geom.east, Geom.west));
}

function window_right(focused: Rectangular, windows: Array<FocusCandidate>) {
    return windows
        .filter(({ area }) => area.x > focused.x)
        .sort((a, b) => Geom.directional_distance(a.area, focused, Geom.west, Geom.east) -
            Geom.directional_distance(b.area, focused, Geom.west, Geom.east));
}

function window_up(focused: Rectangular, windows: Array<FocusCandidate>) {
    return windows
        .filter(({ area }) => area.y < focused.y)
        .sort((a, b) => Geom.directional_distance(a.area, focused, Geom.south, Geom.north) -
            Geom.directional_distance(b.area, focused, Geom.south, Geom.north));
}
