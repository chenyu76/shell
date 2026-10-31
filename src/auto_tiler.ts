import * as ecs from './ecs.js';
import * as lib from './lib.js';
import * as log from './log.js';
import * as node from './node.js';
import * as result from './result.js';
import * as geom from './geom.js';
import * as tiling from './tiling.js';

import type { Entity } from './ecs.js';
import type { Ext } from './extension.js';
import type { Forest, MoveBy, MoveByCursor } from './forest.js';
import type { Fork } from './fork.js';
import type { Rectangle } from './rectangle.js';
import type { Result } from './result.js';
import type { ShellWindow } from './window.js';

const { Ok, Err, ERR } = result;
const { NodeKind } = node;
import * as Tags from './tags.js';

export class AutoTiler {
    forest: Forest;
    attached: ecs.Storage<Entity>;

    constructor(forest: Forest, attached: ecs.Storage<Entity>) {
        this.forest = forest;
        this.attached = attached;
    }

    /** Rebuild the selected windows as one pile; the first window stays in front. */
    reset_to_pile(ext: Ext, windows: ReadonlyArray<ShellWindow>, [monitor, workspace]: [number, number]) {
        const first = windows[0];
        if (!first) return;

        for (const window of windows) this.prepare_for_pile(ext, window);

        const smart_gaps = ext.settings.smart_gaps();
        const [, fork] = this.forest.create_toplevel(
            ext, windows.map(window => window.entity), ext.monitor_work_area(monitor).clone(), [monitor, workspace],
        );
        this.update_toplevel(ext, fork, monitor, smart_gaps);
    }

    private prepare_for_pile(ext: Ext, window: ShellWindow) {
        // Rebuilding the tree must not restore each window's former floating geometry.
        window.ignore_detach = true;
        ext.size_signals_block(window);
        try {
            this.detach_window(ext, window.entity);
            ext.delete_tag(window.entity, Tags.Floating);
            ext.add_tag(window.entity, Tags.ForceTile);
            delete window.was_attached_to;
            ext.connect_window(window);

            if (window.meta.minimized) window.meta.unminimize();
            if (window.meta.is_fullscreen()) window.meta.unmake_fullscreen();
            if (window.is_maximized()) window.meta.unmaximize();
        } finally {
            window.ignore_detach = false;
            ext.size_signals_unblock(window);
        }
    }

    /** Swap window associations in the auto-tiler
     *
     * Call this when a window has swapped positions with another, so that we
     * may update the associations in the auto-tiler world.
     */
    attach_swap(ext: Ext, a: Entity, b: Entity) {
        const a_ent = this.attached.get(a),
            b_ent = this.attached.get(b);

        let a_win = ext.windows.get(a),
            b_win = ext.windows.get(b);

        if (!a_ent || !b_ent || !a_win || !b_win) return;

        const a_fork = this.forest.forks.get(a_ent),
            b_fork = this.forest.forks.get(b_ent);

        if (!a_fork || !b_fork) return;

        const a_stack = a_win.stack,
            b_stack = b_win.stack;
        if (a_stack === b_stack) return;

        if (ext.auto_tiler) {
            if (a_win.stack !== null) {
                const stack = ext.auto_tiler.forest.stacks.get(a_win.stack);
                if (stack) {
                    a = stack.active;
                    a_win = ext.windows.get(a);
                    if (!a_win) return;

                    stack.deactivate(a_win);
                }
            }

            if (b_win.stack !== null) {
                const stack = ext.auto_tiler.forest.stacks.get(b_win.stack);
                if (stack) {
                    b = stack.active;
                    b_win = ext.windows.get(b);
                    if (!b_win) return;

                    stack.deactivate(b_win);
                }
            }
        }

        const a_fn = a_fork.replace_window(ext, a_win, b_win);
        this.forest.on_attach(a_ent, b);

        const b_fn = b_fork.replace_window(ext, b_win, a_win);
        this.forest.on_attach(b_ent, a);

        if (a_fn) a_fn();
        if (b_fn) b_fn();

        a_win.stack = b_stack;
        b_win.stack = a_stack;

        a_win.meta.get_compositor_private()?.show();
        b_win.meta.get_compositor_private()?.show();

        this.tile(ext, a_fork, a_fork.area);
        this.tile(ext, b_fork, b_fork.area);
    }

    update_toplevel(ext: Ext, fork: Fork, monitor: number, smart_gaps: boolean) {
        let rect = ext.monitor_work_area(monitor);

        fork.smart_gapped = smart_gaps && fork.right === null;

        if (!fork.smart_gapped) {
            rect.x += ext.gap_outer;
            rect.y += ext.gap_outer;
            rect.width -= ext.gap_outer * 2;
            rect.height -= ext.gap_outer * 2;
        }

        for (const leaf of this.forest.iter(fork.entity, NodeKind.STACK)) {
            if (leaf.inner.kind !== NodeKind.STACK) continue;
            for (const entity of leaf.inner.entities) {
                ext.windows.with(entity, win => win.smart_gapped = fork.smart_gapped);
            }
        }

        fork.area = fork.set_area(rect.clone());
        fork.length_left = Math.round(fork.prev_ratio * fork.length());
        this.tile(ext, fork, fork.area);
    }

    /** Attaches `win` to an optionally-given monitor */
    attach_to_monitor(ext: Ext, win: ShellWindow, workspace_id: [number, number], smart_gaps: boolean) {
        let rect = ext.monitor_work_area(workspace_id[0]);

        if (!smart_gaps) {
            rect.x += ext.gap_outer;
            rect.y += ext.gap_outer;
            rect.width -= ext.gap_outer * 2;
            rect.height -= ext.gap_outer * 2;
        }

        const [, fork] = this.forest.create_toplevel(ext, [win.entity], rect.clone(), workspace_id);
        fork.smart_gapped = smart_gaps;
        win.smart_gapped = smart_gaps;

        this.tile(ext, fork, rect);
    }

    /** Tiles a window into another */
    attach_to_window(
        ext: Ext,
        attachee: ShellWindow,
        attacher: ShellWindow,
        move_by: MoveBy,
        stack_from_left: boolean = true,
    ): boolean {
        let attached = this.forest.attach_window(ext, attachee.entity, attacher.entity, move_by, stack_from_left);

        if (attached) {
            const [, fork] = attached;
            const monitor = ext.monitors.get(attachee.entity);
            if (monitor) {
                if (fork.is_toplevel && fork.smart_gapped && fork.right) {
                    fork.smart_gapped = false;
                    let rect = ext.monitor_work_area(fork.monitor);

                    rect.x += ext.gap_outer;
                    rect.y += ext.gap_outer;
                    rect.width -= ext.gap_outer * 2;
                    rect.height -= ext.gap_outer * 2;

                    const ratio = fork.length_left / fork.length();
                    fork.set_area(rect);
                    fork.length_left = Math.round(ratio * fork.length());
                }

                this.tile(ext, fork, fork.area.clone());
                return true;
            } else {
                log.error(`missing monitor association for Window(${attachee.entity})`);
            }
        }

        return false;
    }

    /** Tile a window onto a workspace */
    attach_to_workspace(ext: Ext, win: ShellWindow, id: [number, number]) {
        const toplevel = this.forest.find_toplevel(ext, id);

        if (toplevel) {
            const onto = this.forest.largest_window_on(ext, toplevel);
            if (onto) {
                if (this.attach_to_window(ext, onto, win, { auto: 0 })) {
                    return;
                }
            }
        }

        this.attach_to_monitor(ext, win, id, ext.settings.smart_gaps());
    }

    /** Automatically tiles a window into the window tree.
     *
     * ## Implementation Notes
     *
     * - First tries to tile onto the focused window
     * - Then tries to tile onto a monitor
     */
    auto_tile(ext: Ext, win: ShellWindow, ignore_focus: boolean = false) {
        const result = this.fetch_mode(ext, win, ignore_focus);
        this.detach_window(ext, win.entity);
        if (result.kind == ERR) {
            log.debug(`attach to workspace: ${result.value}`);
            this.attach_to_workspace(ext, win, ext.workspace_id(win));
        } else {
            log.debug(`attaching to window ${win.entity}`);
            this.attach_to_window(ext, result.value, win, { auto: 0 });
        }
    }

    /** Destroy all widgets owned by this object. Call before dropping. */
    destroy(ext: Ext) {
        for (const [, [fent]] of this.forest.toplevel) {
            for (const node of this.forest.iter(fent)) {
                if (node.inner.kind === NodeKind.STACK) {
                    for (const window of node.inner.entities) {
                        this.forest.on_detach(window);
                    }
                }
            }
        }

        for (const stack of this.forest.stacks.values()) stack.destroy();

        for (const window of ext.windows.values()) {
            window.stack = null;
            window.reassignment = false;
        }

        this.forest.stacks.truncate(0);
        ext.show_border_on_focused();
    }

    /** Restores into the original live pile, otherwise uses normal placement. */
    restore_window(ext: Ext, win: ShellWindow) {
        const previous = win.was_attached_to;
        delete win.was_attached_to;
        if (previous && previous.entities.length > 0) {
            const target = this.find_stack(previous.active);
            const [monitor, workspace] = ext.workspace_id(win);
            if (target && target[1].inner.kind === NodeKind.STACK &&
                this.forest.stacks.get(target[1].inner.idx) === previous &&
                previous.monitor === monitor && previous.workspace === lib.tiling_workspace(ext, monitor, workspace)) {
                const [fork, branch] = target;
                this.forest.attach_stack(ext, branch.inner as node.NodeStack, fork, win.entity, true);
                previous.activate(win.entity);
                this.tile(ext, fork, fork.area);
                return;
            }
        }
        this.auto_tile(ext, win, false);
    }

    /** Detaches the window from a tiling branch, if it is attached to one. */
    detach_window(ext: Ext, win: Entity, reflow: boolean = true) {
        this.attached.take_with(win, (prev_fork: Entity) => {
            const reflow_fork = this.forest.detach(ext, prev_fork, win);

            if (reflow_fork && reflow) {
                const fork = reflow_fork[1];
                if (fork.is_toplevel && ext.settings.smart_gaps() && fork.right === null) {
                    let rect = ext.monitor_work_area(fork.monitor);
                    fork.set_area(rect);
                    fork.smart_gapped = true;
                }

                this.tile(ext, fork, fork.area);
            }

            ext.windows.with(win, (info) => (info.ignore_detach = false));
        });
    }

    /** Dedicated pile navigation always wraps and never selects a neighbouring tile. */
    cycle_pile(ext: Ext, next: boolean) {
        const focused = ext.focus_window();
        if (!focused || focused.stack === null) return;
        const container = this.forest.stacks.get(focused.stack);
        if (!container || container.entities.length < 2) return;

        let entity = container.cycle(next);
        if (entity === null) {
            container.reset_cycle();
            entity = container.cycle(next);
        }
        if (entity !== null) ext.windows.get(entity)?.activate();
    }

    find_stack(entity: Entity): null | [Fork, node.Node, boolean] {
        const att = this.attached.get(entity);
        if (att) {
            const fork = this.forest.forks.get(att);
            if (fork) {
                if (fork.left.is_in_stack(entity)) {
                    return [fork, fork.left, true];
                } else if (fork.right?.is_in_stack(entity)) {
                    return [fork, fork.right, false];
                }
            }
        }

        return null;
    }

    /** Find the fork that belongs to a window */
    get_parent_fork(window: Entity): null | Fork {
        const entity = this.attached.get(window);
        if (entity === null) return null;

        const fork = this.forest.forks.get(entity);

        return fork;
    }

    largest_on_workspace(ext: Ext, monitor: number, workspace: number): null | ShellWindow {
        const workspace_id: [number, number] = [monitor, workspace];
        const toplevel = this.forest.find_toplevel(ext, workspace_id);
        if (toplevel) {
            return this.forest.largest_window_on(ext, toplevel);
        }

        return null;
    }

    /** Performed when a window that has been dropped is destined to be tiled
     *
     * ## Implementation Notes
     *
     * - If the window is dropped onto a window, tile onto it
     * - If no window is present, tile onto the monitor
     */
    on_drop(ext: Ext, win: ShellWindow, via_overview: boolean = false) {
        const [cursor, monitor] = ext.cursor_status();
        const workspace = ext.active_workspace();

        if (win.rect().contains(cursor)) {
            via_overview = false;
        }

        const attach_mon = () => {
            const attach_to = this.largest_on_workspace(ext, monitor, workspace);
            if (attach_to) {
                this.attach_to_window(ext, attach_to, win, { auto: 0 });
            } else {
                this.attach_to_monitor(ext, win, [monitor, workspace], ext.settings.smart_gaps());
            }
        };

        if (via_overview) {
            this.detach_window(ext, win.entity);
            attach_mon();
            return;
        }

        const attach_to = this.drop_target(ext, win, cursor, monitor, workspace);
        const fork = this.get_parent_fork(win.entity);
        if (!fork) return;
        const windowless = this.largest_on_workspace(ext, monitor, workspace) === null;

        if (!attach_to && !windowless) {
            this.tile(ext, fork, fork.area);
            return true;
        }

        if (windowless) {
            this.detach_window(ext, win.entity);
            this.attach_to_monitor(ext, win, [monitor, workspace], ext.settings.smart_gaps());
        } else if (attach_to) {
            this.place_or_stack(ext, win, attach_to, cursor);
        } else {
            this.detach_window(ext, win.entity);
            attach_mon();
        }
    }

    /** Shared by drag preview and drop so they choose the same destination. */
    drop_target(ext: Ext, win: ShellWindow, cursor: Rectangle, monitor: number, workspace: number): ShellWindow | null {
        for (const found of ext.windows_at_pointer(cursor, monitor, workspace)) {
            if (found !== win && this.attached.contains(found.entity)) return found;
        }
        const source = this.find_stack(win.entity);
        if (!source) return null;
        const [fork, branch, is_left] = source;
        if (fork.monitor !== monitor || fork.workspace !== lib.tiling_workspace(ext, monitor, workspace)) return null;
        const sibling = is_left ? fork.right : fork.left;
        if (branch.inner.kind === NodeKind.STACK && branch.inner.entities.length === 1 &&
            sibling?.inner.kind === NodeKind.STACK) {
            const container = this.forest.stacks.get(sibling.inner.idx);
            return container ? ext.windows.get(container.active) : null;
        }
        return null;
    }

    drop_area(win: ShellWindow, attach_to: ShellWindow): Rectangular {
        const source = this.find_stack(win.entity);
        const target = this.find_stack(attach_to.entity);
        if (!target) return attach_to.rect();
        const [fork, branch] = target;
        if (source && source[0] === fork && source[1] !== branch &&
            source[1].inner.kind === NodeKind.STACK && source[1].inner.entities.length === 1) {
            return fork.area;
        }
        return branch.inner.kind === NodeKind.STACK && branch.inner.rect
            ? branch.inner.rect : attach_to.rect();
    }

    place_or_stack(ext: Ext, win: ShellWindow, attach_to: ShellWindow, cursor: Rectangle): boolean {
        const target = this.find_stack(attach_to.entity);
        if (!target || target[1].inner.kind !== NodeKind.STACK) return false;
        const [fork, branch] = target;
        const source = this.find_stack(win.entity);
        const placement = cursor_placement(ext, this.drop_area(win, attach_to), cursor);

        if (source?.[1] === branch) {
            if (placement) {
                const { Left, Up, Right, Down } = tiling.Direction;
                const direction = placement.orientation === lib.Orientation.HORIZONTAL
                    ? (placement.swap ? Left : Right) : (placement.swap ? Up : Down);
                ext.tiler.move_from_stack(ext, target, win, direction);
            } else {
                this.tile(ext, fork, fork.area);
            }
            return true;
        }

        // Reposition an existing singleton sibling without rebuilding either pile.
        if (placement && source?.[0] === fork && source[1].inner.kind === NodeKind.STACK &&
            source[1].inner.entities.length === 1) {
            fork.set_orientation(placement.orientation);
            if (source[2] !== placement.swap) fork.swap_branches();
            this.tile(ext, fork, fork.area);
            return true;
        }

        win.ignore_detach = true;
        this.detach_window(ext, win.entity);
        return this.attach_to_window(ext, attach_to, win, placement ?? { auto: 0 });
    }

    /** Schedules a fork to be reflowed */
    reflow(ext: Ext, win: Entity) {
        const fork_entity = this.attached.get(win);
        if (!fork_entity) return;

        ext.register_fn(() => {
            const fork = this.forest.forks.get(fork_entity);
            if (fork) this.tile(ext, fork, fork.area);
        });
    }

    tile(ext: Ext, fork: Fork, area: Rectangle) {
        this.forest.tile(ext, fork, area);
    }

    toggle_floating(ext: Ext) {
        const focused = ext.focus_window();
        if (!focused) return;

        let wm_class = focused.meta.get_wm_class();
        let wm_title = focused.meta.get_title();
        let float_except = false;

        if (wm_class != null && wm_title != null) {
            float_except = ext.conf.window_shall_float(wm_class, wm_title);
        }

        if (float_except) {
            if (ext.contains_tag(focused.entity, Tags.ForceTile)) {
                ext.delete_tag(focused.entity, Tags.ForceTile);
                const fork_entity = this.attached.get(focused.entity);
                if (fork_entity) {
                    this.detach_window(ext, focused.entity);
                }
            } else {
                ext.add_tag(focused.entity, Tags.ForceTile);
                this.auto_tile(ext, focused, false);
            }
        } else {
            if (ext.contains_tag(focused.entity, Tags.Floating)) {
                ext.delete_tag(focused.entity, Tags.Floating);
                this.auto_tile(ext, focused, false);
            } else {
                const fork_entity = this.attached.get(focused.entity);
                if (fork_entity) {
                    this.detach_window(ext, focused.entity);
                    ext.add_tag(focused.entity, Tags.Floating);
                }
            }
        }

        ext.register_fn(() => focused.activate(true));
    }

    toggle_orientation(ext: Ext, window: ShellWindow) {
        const result = this.toggle_orientation_(ext, window);
        if (result.kind == ERR) {
            log.warn(`toggle_orientation: ${result.value}`);
        }
    }

    update_stack(ext: Ext, stack: node.NodeStack) {
        const container = this.forest.stacks.get(stack.idx);

        if (!stack.rect) {
            log.warn('stack rect was null');
            return;
        }

        if (!container || container.entities !== stack.entities) return;

        const fork = stack.entities.length ? this.get_parent_fork(stack.entities[0]) : null;
        for (const entity of stack.entities) {
            const window = ext.windows.get(entity);
            if (window) {
                window.stack = stack.idx;
                window.smart_gapped = fork?.smart_gapped ?? false;
            }
        }

        container.update_layout(stack.rect);
    }

    windows_are_siblings(a: Entity, b: Entity): Entity | null {
        const a_parent = this.attached.get(a);
        const b_parent = this.attached.get(b);

        if (a_parent !== null && null !== b_parent && ecs.entity_eq(a_parent, b_parent)) {
            return a_parent;
        }

        return null;
    }

    private fetch_mode(ext: Ext, win: ShellWindow, ignore_focus: boolean = false): Result<ShellWindow, string> {
        if (ignore_focus) {
            return Err('ignoring focus');
        }

        const prev = ext.previously_focused(win);

        if (!prev) {
            return Err('no window has been previously focused');
        }

        let onto = ext.windows.get(prev);

        if (!onto) {
            return Err('no focus window');
        }

        if (ecs.entity_eq(onto.entity, win.entity)) {
            return Err('tiled window and attach window are the same window');
        }

        if (!onto.is_tilable(ext)) {
            return Err('focused window is not tilable');
        }

        if (onto.meta.minimized) {
            return Err('previous window was minimized');
        }

        if (!this.attached.contains(onto.entity)) {
            return Err('focused window is not attached');
        }

        const [monitor, workspace] = ext.workspace_id(win);
        return onto.meta.get_monitor() === monitor &&
            lib.tiling_workspace(ext, monitor, onto.workspace_id()) === lib.tiling_workspace(ext, monitor, workspace)
            ? Ok(onto)
            : Err('window is not on the same monitor or workspace');
    }

    private toggle_orientation_(ext: Ext, focused: ShellWindow): Result<void, string> {
        if (focused.is_maximized()) {
            return Err('cannot toggle maximized window');
        }

        const fork_entity = this.attached.get(focused.entity);
        if (!fork_entity) {
            return Err(`window is not attached to the tree`);
        }

        const fork = this.forest.forks.get(fork_entity);
        if (!fork) {
            return Err("window's fork attachment does not exist");
        }

        if (!fork.right) return Ok(void 0);

        fork.toggle_orientation();
        this.forest.measure(ext, fork, fork.area);

        for (const child of this.forest.iter(fork_entity, NodeKind.FORK)) {
            const child_fork = this.forest.forks.get((child.inner as node.NodeFork).entity);
            if (child_fork) {
                child_fork.rebalance_orientation();
                this.forest.measure(ext, child_fork, child_fork.area);
            } else {
                log.error('toggle_orientation: Fork(${child.entity}) does not exist to have its orientation toggled');
            }
        }

        this.forest.arrange(ext);

        return Ok(void 0);
    }
}

/** Enables deriving the orientation that a window will be attached by the mouse position.
 *
 * A null indicates that the window should be stacked
 */
export function cursor_placement(ext: Ext, area: Rectangular, cursor: Rectangular): null | MoveByCursor {
    const { LEFT, RIGHT, TOP, BOTTOM } = geom.Side;
    const { HORIZONTAL, VERTICAL } = lib.Orientation;

    const [, side] = geom.nearest_side(ext, [cursor.x, cursor.y], area);

    let res: null | [lib.Orientation, boolean] =
        side === LEFT
            ? [HORIZONTAL, true]
            : side === RIGHT
            ? [HORIZONTAL, false]
            : side === TOP
            ? [VERTICAL, true]
            : side === BOTTOM
            ? [VERTICAL, false]
            : null;

    return res ? { orientation: res[0], swap: res[1] } : null;
}
