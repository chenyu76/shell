import type { Forest } from './forest.js';
import type { Entity } from './ecs.js';
import type { Ext } from './extension.js';
import type { Rectangle } from './rectangle.js';
import type { Node } from './node.js';

import * as Ecs from './ecs.js';
import * as Lib from './lib.js';
import * as node from './node.js';
import * as Rect from './rectangle.js';
import { ShellWindow } from './window.js';

const XPOS = 0;
const YPOS = 1;
const WIDTH = 2;
const HEIGHT = 3;

/** A tiling fork contains two children nodes.
 *
 * These nodes are piles or sub-forks.
 */
export class Fork {
    left: Node;
    right: Node | null;
    area: Rectangle;
    entity: Entity;
    on_primary_display: boolean;
    workspace: number;
    length_left: number;
    prev_length_left: number;
    prev_ratio: number = 0.5;
    monitor: number;
    minimum_ratio: number = 0.1;
    orientation: Lib.Orientation = Lib.Orientation.HORIZONTAL;

    orientation_changed: boolean = false;
    is_toplevel: boolean = false;

    smart_gapped: boolean = false;

    /** Tracks toggle count so that we may swap branches when toggled twice */
    private n_toggled: number = 0;

    constructor(
        entity: Entity,
        left: Node,
        right: Node | null,
        area: Rectangle,
        workspace: WorkspaceID,
        monitor: MonitorID,
        orient: Lib.Orientation,
    ) {
        this.on_primary_display = global.display.get_primary_monitor() === monitor;
        this.area = area;
        this.left = left;
        this.right = right;
        this.workspace = workspace;
        this.length_left = orient === Lib.Orientation.HORIZONTAL ? this.area.width / 2 : this.area.height / 2;
        this.prev_length_left = this.length_left;
        this.entity = entity;
        this.orientation = orient;
        this.monitor = monitor;
    }

    /** The calculated left area of this fork */
    area_of_left(ext: Ext): Rect.Rectangle {
        return new Rect.Rectangle(
            this.is_horizontal()
                ? [this.area.x, this.area.y, this.length_left - ext.gap_inner_half, this.area.height]
                : [this.area.x, this.area.y, this.area.width, this.length_left - ext.gap_inner_half],
        );
    }

    /** The calculated right area of this fork */
    area_of_right(ext: Ext): Rect.Rectangle {
        const offset = this.length_left + ext.gap_inner_half;
        return new Rect.Rectangle(
            this.is_horizontal()
                ? [this.area.x + offset, this.area.y, this.area.width - offset, this.area.height]
                : [this.area.x, this.area.y + offset, this.area.width, this.area.height - offset],
        );
    }

    depth(): number {
        return this.is_horizontal() ? this.area.height : this.area.width;
    }

    find_branch(entity: Entity): Node | null {
        const locate = (branch: Node): Node | null => {
            switch (branch.inner.kind) {
                case 3:
                    for (const e of branch.inner.entities) {
                        if (Ecs.entity_eq(e, entity)) {
                            return branch;
                        }
                    }
            }

            return null;
        };

        const node = locate(this.left);
        if (node) return node;

        return this.right ? locate(this.right) : null;
    }

    /** If this fork has a horizontal orientation */
    is_horizontal(): boolean {
        return Lib.Orientation.HORIZONTAL == this.orientation;
    }

    length(): number {
        return this.is_horizontal() ? this.area.width : this.area.height;
    }

    /** Replaces the association of a window in a fork with another */
    replace_window(ext: Ext, a: ShellWindow, b: ShellWindow): null | (() => void) {
        const branch = this.find_branch(a.entity);
        if (!branch || branch.inner.kind !== node.NodeKind.STACK) return null;
        const pile = branch.inner;
        return () => node.stack_replace(ext, pile, b);
    }

    /** Sets a new area for this fork */
    set_area(area: Rectangle): Rectangle {
        this.area = area;
        return this.area;
    }

    /** Sets the ratio of this fork
     *
     * Ensures that the ratio is never smaller or larger than the constraints.
     */
    set_ratio(left_length: number): Fork {
        const fork_len = this.is_horizontal() ? this.area.width : this.area.height;
        const clamped = Math.round(Math.max(256, Math.min(fork_len - 256, left_length)));
        this.prev_length_left = clamped;
        this.length_left = clamped;
        return this;
    }

    /** Defines this fork as a top level fork, and records it in the forest */
    set_toplevel(tiler: Forest, entity: Entity, string: string, id: [number, number]): Fork {
        this.is_toplevel = true;
        tiler.toplevel.set(string, [entity, id]);
        return this;
    }

    /** Calculates the future arrangement of windows in this fork */
    measure(tiler: Forest, ext: Ext, area: Rectangle) {
        let ratio = null;

        let manually_moved = ext.grab_op !== null || ext.tiler.resizing_window;

        if (!this.is_toplevel) {
            if (this.orientation_changed) {
                this.orientation_changed = false;
                ratio = this.length_left / this.depth();
            } else {
                ratio = this.length_left / this.length();
            }

            this.area = this.set_area(area.clone());
        } else if (this.orientation_changed) {
            this.orientation_changed = false;
            ratio = this.length_left / this.depth();
        }

        if (ratio) {
            this.length_left = Math.round(ratio * this.length());
            if (manually_moved) this.prev_ratio = ratio;
        } else if (manually_moved) {
            this.prev_ratio = this.length_left / this.length();
        }

        if (this.right) {
            const [l, p, startpos] = this.is_horizontal() ? [WIDTH, XPOS, this.area.x] : [HEIGHT, YPOS, this.area.y];

            let region = this.area.clone();

            const half = this.area.array[l] / 2;

            let length;
            if (this.length_left > half - 32 && this.length_left < half + 32) {
                length = half;
            } else {
                const diff = (startpos + this.length_left) % 32;
                length = this.length_left - diff + (diff > 16 ? 32 : 0);
                if (length == 0) length = 32;
            }

            region.array[l] = length - ext.gap_inner_half;

            this.left.measure(tiler, ext, region);

            region.array[p] = region.array[p] + length + ext.gap_inner_half;
            region.array[l] = this.area.array[l] - length - ext.gap_inner_half;

            this.right.measure(tiler, ext, region);
        } else {
            this.left.measure(tiler, ext, this.area);
        }
    }

    migrate(ext: Ext, forest: Forest, area: Rectangle, monitor: number, workspace: number) {
        if (ext.auto_tiler && this.is_toplevel) {
            workspace = Lib.tiling_workspace(ext, monitor, workspace);
            const destination = ext.should_ignore_workspace(monitor) ? forest.find_toplevel(ext, [monitor, workspace]) : null;
            const merge = destination !== null && !Ecs.entity_eq(destination, this.entity);
            const primary = global.display.get_primary_monitor() === monitor;

            const blocked: Array<ShellWindow> = [];

            if (!merge) {
                this.monitor = monitor;
                this.workspace = workspace;
                this.on_primary_display = primary;
                forest.toplevel.set(forest.string_reps.get(this.entity) as string, [this.entity, [monitor, workspace]]);
            }

            for (const child of forest.iter(this.entity)) {
                switch (child.inner.kind) {
                    case node.NodeKind.FORK:
                        if (merge) break;
                        const cfork = forest.forks.get(child.inner.entity);
                        if (!cfork) continue;
                        cfork.workspace = workspace;
                        cfork.monitor = monitor;
                        cfork.on_primary_display = primary;
                        break;
                    case node.NodeKind.STACK:
                        const stack = forest.stacks.get(child.inner.idx);
                        if (stack && !merge) {
                            stack.workspace = workspace;
                            stack.monitor = monitor;
                        }
                        for (const entity of child.inner.entities) {
                            const window = ext.windows.get(entity);

                            if (window) {
                                ext.size_signals_block(window);
                                window.reassignment = false;
                                window.known_workspace = workspace;
                                window.meta.change_workspace_by_index(workspace, true);
                                ext.monitors.insert(window.entity, [monitor, workspace]);
                                blocked.push(window);
                            }
                        }
                }
            }

            if (merge) {
                // A workspace-independent display cannot retain a second tree.
                for (const window of blocked) {
                    window.ignore_detach = true;
                    ext.auto_tiler.detach_window(ext, window.entity, false);
                    ext.auto_tiler.attach_to_workspace(ext, window, [monitor, workspace]);
                }
            } else {
                const target_area = area.clone();
                target_area.x += ext.gap_outer;
                target_area.y += ext.gap_outer;
                target_area.width -= ext.gap_outer * 2;
                target_area.height -= ext.gap_outer * 2;

                this.set_area(target_area);
                this.set_ratio(this.length() / 2);
                forest.tile(ext, this, target_area);
            }

            for (const window of blocked) {
                ext.size_signals_unblock(window);
            }
        }
    }

    rebalance_orientation() {
        this.set_orientation(
            this.area.height > this.area.width ? Lib.Orientation.VERTICAL : Lib.Orientation.HORIZONTAL,
        );
    }

    set_orientation(o: Lib.Orientation) {
        if (o !== this.orientation) {
            this.orientation = o;
            this.orientation_changed = true;
        }
    }

    /** Swaps the left branch with the right branch, if there is a right branch */
    swap_branches() {
        if (this.right) {
            const temp = this.left;
            this.left = this.right;
            this.right = temp;
        }
    }

    /** Toggles the orientation of this fork */
    toggle_orientation() {
        this.orientation =
            Lib.Orientation.HORIZONTAL === this.orientation ? Lib.Orientation.VERTICAL : Lib.Orientation.HORIZONTAL;

        this.orientation_changed = true;
        if (this.n_toggled === 1) {
            if (this.right) {
                const tmp = this.right;
                this.right = this.left;
                this.left = tmp;
            }
            this.n_toggled = 0;
        } else {
            this.n_toggled += 1;
        }
    }
}
