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

export class FocusSelector {
    /** Selects the closest window in a direction, ignoring the windows which the filter rejects */
    select(
        ext: Ext,
        direction: (a: ShellWindow, b: Array<ShellWindow>) => Array<ShellWindow>,
        window: ShellWindow | null,
        filter?: (window: ShellWindow) => boolean,
    ): ShellWindow | null {
        window = window ?? ext.focus_window();
        if (window) {
            let window_list = ext.active_window_list();

            if (filter) window_list = window_list.filter(filter);

            return select(direction, window, window_list);
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

function select(
    windows: (a: ShellWindow, b: Array<ShellWindow>) => Array<ShellWindow>,
    focused: ShellWindow,
    window_list: Array<ShellWindow>,
): ShellWindow | null {
    const array = windows(focused, window_list);
    return array.length > 0 ? array[0] : null;
}

function window_down(focused: ShellWindow, windows: Array<ShellWindow>) {
    return windows
        .filter((win) => !win.meta.minimized && win.meta.get_frame_rect().y > focused.meta.get_frame_rect().y)
        .sort((a, b) => Geom.downward_distance(a.meta, focused.meta) - Geom.downward_distance(b.meta, focused.meta));
}

function window_left(focused: ShellWindow, windows: Array<ShellWindow>) {
    return windows
        .filter((win) => !win.meta.minimized && win.meta.get_frame_rect().x < focused.meta.get_frame_rect().x)
        .sort((a, b) => Geom.leftward_distance(a.meta, focused.meta) - Geom.leftward_distance(b.meta, focused.meta));
}

function window_right(focused: ShellWindow, windows: Array<ShellWindow>) {
    return windows
        .filter((win) => !win.meta.minimized && win.meta.get_frame_rect().x > focused.meta.get_frame_rect().x)
        .sort((a, b) => Geom.rightward_distance(a.meta, focused.meta) - Geom.rightward_distance(b.meta, focused.meta));
}

function window_up(focused: ShellWindow, windows: Array<ShellWindow>) {
    return windows
        .filter((win) => !win.meta.minimized && win.meta.get_frame_rect().y < focused.meta.get_frame_rect().y)
        .sort((a, b) => Geom.upward_distance(a.meta, focused.meta) - Geom.upward_distance(b.meta, focused.meta));
}
