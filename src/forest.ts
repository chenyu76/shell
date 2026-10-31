import * as arena from './arena.js';
import * as Ecs from './ecs.js';
import * as Lib from './lib.js';
import * as log from './log.js';
import * as movement from './movement.js';
import * as Node from './node.js';
import * as Fork from './fork.js';

import type { Entity } from './ecs.js';
import type { Rectangle } from './rectangle.js';
import type { ShellWindow } from './window.js';
import type { Ext } from './extension.js';
import { Stack } from './stack.js';

const { Arena } = arena;
const { Movement } = movement;

const { DOWN, UP, LEFT, RIGHT } = Movement;

export interface MoveByCursor {
    orientation: Lib.Orientation;
    swap: boolean;
}

export interface MoveByAuto {
    auto: number;
}

export type MoveBy = MoveByCursor | MoveByAuto;

/** A collection of forks separated into trees
 *
 * Each display on each workspace has their own unique tree. A tree is a
 * collection of starting from an uppermost fork, and branching into
 * deeply-nested sub-forks.
 *
 * Each fork represents two nodes and an orientation, whereby a node may either
 * be a pile or another fork. As windows are attached to other windows,
 * forks will be dynamically removed and created to accomodate the new
 * arrangement.
 */
export class Forest extends Ecs.World {
    /** Maintains a list of top-level forks. */
    toplevel: Map<String, [Entity, [number, number]]> = new Map();

    /** Piles awaiting layout, deduplicated across measurements. */
    stack_updates: Set<Node.NodeStack> = new Set();

    /** The storage for holding all fork associations. */
    forks: Ecs.Storage<Fork.Fork> = this.register_storage();

    /** Child-parent associations are stored here. */
    parents: Ecs.Storage<Entity> = this.register_storage();

    /** Needed when we're storing the entities in a map, because JS limitations. */
    string_reps: Ecs.Storage<string> = this.register_storage();

    stacks: arena.Arena<Stack> = new Arena();

    /** The callback to execute when a window has been attached to a fork. */
    on_attach: (parent: Entity, child: Entity) => void = () => {};

    /** Likewise for detachments */
    on_detach: (child: Entity) => void = () => {};

    constructor() {
        super();
    }

    measure(ext: Ext, fork: Fork.Fork, area: Rectangle) {
        fork.measure(this, ext, area);
    }

    /** Measures and arranges piles within the supplied area. */
    tile(ext: Ext, fork: Fork.Fork, area: Rectangle) {
        this.measure(ext, fork, area);
        this.arrange(ext);
    }

    arrange(ext: Ext) {
        const updates = Array.from(this.stack_updates);
        this.stack_updates.clear();
        for (const stack of updates) ext.auto_tiler?.update_stack(ext, stack);
    }

    /** Creates the only kind of leaf, assigning every member to its container. */
    create_stack(ext: Ext, entities: ReadonlyArray<Entity>, workspace: number, monitor: number): Node.Node {
        const container = new Stack(ext, entities[0], workspace, monitor, entities);
        const index = this.stacks.insert(container);
        for (const entity of entities) ext.windows.with(entity, window => window.stack = index);
        return Node.Node.stacked(container, index);
    }

    attach_stack(
        ext: Ext,
        stack: Node.NodeStack,
        fork: Fork.Fork,
        new_entity: Entity,
        stack_from_left: boolean,
    ): [Entity, Fork.Fork] | null {
        const container = this.stacks.get(stack.idx);
        if (container) {
            const window = ext.windows.get(new_entity);
            if (window) {
                window.stack = stack.idx;

                container.add(new_entity, !stack_from_left);

                this.on_attach(fork.entity, new_entity);

                ext.auto_tiler?.update_stack(ext, stack);

                if (window.meta.has_focus()) {
                    container.activate(new_entity);
                }

                return [fork.entity, fork];
            } else {
                log.warn('attempted to attach window to stack that does not exist');
            }
        } else {
            log.warn('attempted to attach to stack that does not exist');
        }

        return null;
    }

    /** Attaches a `new` window to the fork which `onto` is attached to. */
    attach_window(
        ext: Ext,
        onto_entity: Entity,
        new_entity: Entity,
        place_by: MoveBy,
        stack_from_left: boolean,
    ): [Entity, Fork.Fork] | null {
        for (const [entity, fork] of this.forks.iter()) {
            const branch = fork.find_branch(onto_entity);
            if (!branch || branch.inner.kind !== Node.NodeKind.STACK) continue;
            if ('auto' in place_by) {
                return this.attach_stack(ext, branch.inner, fork, new_entity, stack_from_left);
            }

            const new_node = this.create_stack(ext, [new_entity], fork.workspace, fork.monitor);
            const area = branch === fork.left ? fork.area_of_left(ext) : fork.area_of_right(ext);
            let target = fork;
            if (fork.right) {
                const [child, split] = this.create_fork(branch, new_node, area, fork.workspace, fork.monitor);
                if (branch === fork.left) fork.left = Node.Node.fork(child);
                else fork.right = Node.Node.fork(child);
                this.parents.insert(child, entity);
                target = split;
            } else {
                fork.right = new_node;
            }
            if ('swap' in place_by) {
                target.set_orientation(place_by.orientation);
                if (place_by.swap) target.swap_branches();
            }
            // The split has an explicit new ratio; do not convert the old axis ratio.
            target.orientation_changed = false;
            target.set_ratio(target.length() / 2);
            this.reassign_sibling(branch, target.entity);
            this.on_attach(target.entity, new_entity);
            return [entity, fork];
        }
        return null;
    }

    /** Assigns the callback to trigger when a window is attached to a fork */
    connect_on_attach(callback: (parent: Entity, child: Entity) => void): this {
        this.on_attach = callback;
        return this;
    }

    connect_on_detach(callback: (child: Entity) => void): this {
        this.on_detach = callback;
        return this;
    }

    /** Creates a new fork entity in the world */
    create_entity(): Entity {
        const entity = super.create_entity();
        this.string_reps.insert(entity, `${entity}`);
        return entity;
    }

    /** Create a fork from pile or fork branches. */
    create_fork(
        left: Node.Node,
        right: Node.Node | null,
        area: Rectangle,
        workspace: WorkspaceID,
        monitor: MonitorID,
    ): [Entity, Fork.Fork] {
        const entity = this.create_entity();
        let orient = area.width > area.height ? Lib.Orientation.HORIZONTAL : Lib.Orientation.VERTICAL;
        let fork = new Fork.Fork(entity, left, right, area, workspace, monitor, orient);
        this.forks.insert(entity, fork);
        return [entity, fork];
    }

    /** Create a new top level fork */
    create_toplevel(ext: Ext, windows: ReadonlyArray<Entity>, area: Rectangle, id: [MonitorID, WorkspaceID]): [Entity, Fork.Fork] {
        id = [id[0], Lib.tiling_workspace(ext, id[0], id[1])];
        const leaf = this.create_stack(ext, windows, id[1], id[0]);
        const [entity, fork] = this.create_fork(leaf, null, area, id[1], id[0]);
        for (const window of windows) this.on_attach(entity, window);

        this.string_reps.with(entity, (sid) => {
            fork.set_toplevel(this, entity, sid, id);
        });

        return [entity, fork];
    }

    /** Deletes a fork entity from the world, performing any cleanup necessary */
    delete_entity(entity: Entity) {
        const fork = this.forks.remove(entity);
        if (fork && fork.is_toplevel) {
            const id = this.string_reps.get(entity);
            if (id) this.toplevel.delete(id);
        }

        super.delete_entity(entity);
    }

    /** Detaches an entity from the a fork, re-arranging the fork's tree as necessary */
    detach(ext: Ext, fork_entity: Entity, window: Entity): [Entity, Fork.Fork] | null {
        const fork = this.forks.get(fork_entity);
        if (!fork) return null;

        const branch = fork.find_branch(window);
        if (!branch || branch.inner.kind !== Node.NodeKind.STACK) return null;
        const stack = branch.inner;
        const container = this.stacks.get(stack.idx);
        if (!container || container.remove(window) === null) return null;
        ext.windows.with(window, win => win.stack = null);
        this.on_detach(window);

        // Removing a member never changes the tree while the pile is nonempty.
        if (stack.entities.length > 0) return [fork_entity, fork];
        this.stack_updates.delete(stack);
        this.stacks.remove(stack.idx)?.destroy();

        const sibling = branch === fork.left ? fork.right : fork.left;
        if (!sibling) {
            this.delete_entity(fork_entity);
            return null;
        }
        const parent = this.parents.get(fork_entity);
        if (parent) {
            const pfork = this.reassign_child_to_parent(fork_entity, parent, sibling);
            return pfork ? [parent, pfork] : null;
        }
        if (sibling.inner.kind === Node.NodeKind.FORK) {
            this.reassign_children_to_parent(fork_entity, sibling.inner.entity, fork);
        } else {
            fork.left = sibling;
            fork.right = null;
            this.reassign_sibling(sibling, fork_entity);
        }
        return [fork_entity, fork];
    }

    /** Creates a string representation of every fork in the world */
    fmt(ext: Ext) {
        let fmt = '';

        for (const [entity] of this.toplevel.values()) {
            const fork = this.forks.get(entity);

            fmt += ' ';
            if (fork) {
                fmt += this.display_fork(ext, entity, fork, 1) + '\n';
            } else {
                fmt += `Fork(${entity}) Invalid\n`;
            }
        }

        return fmt;
    }

    /** Finds the layout tree for a monitor and workspace. */
    find_toplevel(ext: Ext, [src_mon, src_work]: [number, number]): Entity | null {
        src_work = Lib.tiling_workspace(ext, src_mon, src_work);
        for (const [entity, [monitor, workspace]] of this.toplevel.values()) {
            if (monitor == src_mon && workspace == src_work) {
                return entity;
            }
        }

        return null;
    }

    /** Grows a sibling a fork. */
    private grow_sibling(
        ext: Ext,
        fork_e: Entity,
        fork_c: Fork.Fork,
        is_left: boolean,
        movement: movement.Movement,
        crect: Rectangle,
    ) {
        const resize_fork = () => this.resize_fork_(ext, fork_e, crect, movement, false);

        if (fork_c.is_horizontal()) {
            if ((movement & (DOWN | UP)) != 0) {
                resize_fork();
            } else if (is_left) {
                if ((movement & RIGHT) != 0) {
                    this.readjust_fork_ratio_by_left(ext, crect.width, fork_c);
                } else {
                    resize_fork();
                }
            } else if ((movement & RIGHT) != 0) {
                resize_fork();
            } else {
                this.readjust_fork_ratio_by_right(ext, crect.width, fork_c, fork_c.area.width);
            }
        } else {
            if ((movement & (LEFT | RIGHT)) != 0) {
                resize_fork();
            } else if (is_left) {
                if ((movement & DOWN) != 0) {
                    this.readjust_fork_ratio_by_left(ext, crect.height, fork_c);
                } else {
                    resize_fork();
                }
            } else if ((movement & DOWN) != 0) {
                resize_fork();
            } else {
                this.readjust_fork_ratio_by_right(ext, crect.height, fork_c, fork_c.area.height);
            }
        }
    }

    /** Walks the tree starting at a given fork entity, and filtering by node kind. */
    *iter(entity: Entity, kind: Node.NodeKind | null = null): IterableIterator<Node.Node> {
        let fork = this.forks.get(entity);
        let forks = new Array(2);

        while (fork) {
            if (fork.left.inner.kind === 1) {
                forks.push(this.forks.get(fork.left.inner.entity));
            }

            if (kind === null || fork.left.inner.kind === kind) {
                yield fork.left;
            }

            if (fork.right) {
                if (fork.right.inner.kind === 1) {
                    forks.push(this.forks.get(fork.right.inner.entity));
                }

                if (kind === null || fork.right.inner.kind == kind) {
                    yield fork.right;
                }
            }

            fork = forks.pop();
        }
    }

    /** Finds the largest tilable window on a monitor + workspace. */
    largest_window_on(ext: Ext, entity: Entity): ShellWindow | null {
        let largest_window = null;
        let largest_size = 0;

        let window_compare = (entity: Entity) => {
            const window = ext.windows.get(entity);
            if (window && window.is_tilable(ext)) {
                const rect = window.rect();
                const size = rect.width * rect.height;
                if (size > largest_size) {
                    largest_size = size;
                    largest_window = window;
                }
            }
        };

        for (const node of this.iter(entity)) {
            switch (node.inner.kind) {
                case 3:
                    window_compare(node.inner.entities[0]);
            }
        }

        return largest_window;
    }

    /** Resize a window from a given fork based on a supplied movement. */
    resize(ext: Ext, fork_e: Entity, fork_c: Fork.Fork, win_e: Entity, movement: movement.Movement, crect: Rectangle) {
        const is_left = fork_c.left.is_in_stack(win_e);

        ((movement & Movement.SHRINK) != 0 ? this.shrink_sibling : this.grow_sibling).call(
            this,
            ext,
            fork_e,
            fork_c,
            is_left,
            movement,
            crect,
        );
    }

    /**
     * Reassigns the child of a fork to the parent
     */
    private reassign_child_to_parent(child_entity: Entity, parent_entity: Entity, branch: Node.Node): Fork.Fork | null {
        const parent = this.forks.get(parent_entity);

        if (parent) {
            if (parent.left.is_fork(child_entity)) {
                parent.left = branch;
            } else {
                parent.right = branch;
            }

            this.reassign_sibling(branch, parent_entity);
            this.delete_entity(child_entity);
        }

        return parent;
    }

    /**
     * Reassigns a sibling fork or all members of a pile.
     *
     * - If the sibling is a fork, reassign the parent.
     * - If it is a pile, update each member with on_attach
     */
    private reassign_sibling(sibling: Node.Node, parent: Entity) {
        switch (sibling.inner.kind) {
            case 1:
                this.parents.insert(sibling.inner.entity, parent);
                break;
            case 3:
                for (const entity of sibling.inner.entities) {
                    this.on_attach(parent, entity);
                }
        }
    }

    /**
     * Reassigns children of the child entity to the parent entity
     *
     * Each fork has a left and optional right child entity
     */
    private reassign_children_to_parent(parent_entity: Entity, child_entity: Entity, p_fork: Fork.Fork) {
        const c_fork = this.forks.get(child_entity);

        if (c_fork) {
            p_fork.left = c_fork.left;
            p_fork.right = c_fork.right;

            this.reassign_sibling(p_fork.left, parent_entity);
            if (p_fork.right) this.reassign_sibling(p_fork.right, parent_entity);

            this.delete_entity(child_entity);
        } else {
            log.error(`Fork(${child_entity}) does not exist`);
        }
    }

    /** Readjusts the division of space between the left and right siblings of a fork */
    private readjust_fork_ratio_by_left(ext: Ext, left_length: number, fork: Fork.Fork) {
        fork.set_ratio(left_length).measure(this, ext, fork.area);
    }

    /** Readjusts the division of space between the left and right siblings of a fork
     *
     * Determines the size of the left sibling based on the new length of the right sibling
     */
    private readjust_fork_ratio_by_right(ext: Ext, right_length: number, fork: Fork.Fork, fork_length: number) {
        this.readjust_fork_ratio_by_left(ext, fork_length - right_length, fork);
    }

    /** Resizes a fork in the direction that a movement requests */
    private resize_fork_(ext: Ext, child_e: Entity, crect: Rectangle, mov: movement.Movement, shrunk: boolean) {
        let parent = this.parents.get(child_e),
            child: Fork.Fork = this.forks.get(child_e) as Fork.Fork;

        if (!parent) {
            child.measure(this, ext, child.area);
            return;
        }

        const src_node = this.forks.get(child_e);
        if (!src_node) return;

        let is_left: boolean = child.left.is_fork(child_e),
            length: number;

        while (parent !== null) {
            child = this.forks.get(parent) as Fork.Fork;
            is_left = child.left.is_fork(child_e);

            if (child.area.contains(crect)) {
                if ((mov & UP) !== 0) {
                    if (shrunk) {
                        if (child.area.y + child.area.height > src_node.area.y + src_node.area.height) {
                            break;
                        }
                    } else if (!child.is_horizontal() || !is_left) {
                        break;
                    }
                } else if ((mov & DOWN) !== 0) {
                    if (shrunk) {
                        if (child.area.y < src_node.area.y) {
                            break;
                        }
                    } else if (child.is_horizontal() || is_left) {
                        break;
                    }
                } else if ((mov & LEFT) !== 0) {
                    if (shrunk) {
                        if (child.area.x + child.area.width > src_node.area.x + src_node.area.width) {
                            break;
                        }
                    } else if (!child.is_horizontal() || !is_left) {
                        break;
                    }
                } else if ((mov & RIGHT) !== 0) {
                    if (shrunk) {
                        if (child.area.x < src_node.area.x) {
                            break;
                        }
                    } else if (!child.is_horizontal() || is_left) {
                        break;
                    }
                }
            }

            child_e = parent;
            parent = this.parents.get(child_e);
        }

        if (child.is_horizontal()) {
            length = is_left ? crect.x + crect.width - child.area.x : crect.x - child.area.x;
        } else {
            length = is_left ? crect.y + crect.height - child.area.y : child.area.height - crect.height;
        }

        child.set_ratio(length);

        child.measure(this, ext, child.area);
    }

    /** Shrinks the sibling of a fork, possibly shrinking the fork itself */
    private shrink_sibling(
        ext: Ext,
        fork_e: Entity,
        fork_c: Fork.Fork,
        is_left: boolean,
        movement: movement.Movement,
        crect: Rectangle,
    ) {
        const resize_fork = () => this.resize_fork_(ext, fork_e, crect, movement, true);

        if (fork_c.area) {
            if (fork_c.is_horizontal()) {
                if ((movement & (DOWN | UP)) != 0) {
                    resize_fork();
                } else if (is_left) {
                    if ((movement & LEFT) != 0) {
                        this.readjust_fork_ratio_by_left(ext, crect.width, fork_c);
                    } else {
                        resize_fork();
                    }
                } else if ((movement & LEFT) != 0) {
                    resize_fork();
                } else {
                    this.readjust_fork_ratio_by_right(ext, crect.width, fork_c, fork_c.area.array[2]);
                }
            } else {
                if ((movement & (LEFT | RIGHT)) != 0) {
                    resize_fork();
                } else if (is_left) {
                    if ((movement & UP) != 0) {
                        this.readjust_fork_ratio_by_left(ext, crect.height, fork_c);
                    } else {
                        resize_fork();
                    }
                } else if ((movement & UP) != 0) {
                    resize_fork();
                } else {
                    this.readjust_fork_ratio_by_right(ext, crect.height, fork_c, fork_c.area.array[3]);
                }
            }
        }
    }

    private display_branch(ext: Ext, branch: Node.Node, scope: number): string {
        switch (branch.inner.kind) {
            case 1:
                const fork = this.forks.get(branch.inner.entity);
                return fork ? this.display_fork(ext, branch.inner.entity, fork, scope + 1) : 'Missing Fork';
            case 3:
                let fmt = 'Stack(';

                for (const entity of branch.inner.entities) {
                    const window = ext.windows.get(entity);
                    fmt += `Window(${entity}) (${window ? window.rect().fmt() : 'unknown area'}), `;
                }

                return fmt + ')';
        }
    }

    display_fork(ext: Ext, entity: Entity, fork: Fork.Fork, scope: number): string {
        let fmt = `Fork(${entity}) [${fork.area ? fork.area.array : 'unknown'}]: {\n`;

        fmt += ' '.repeat((1 + scope) * 2) + `workspace: (${fork.workspace}),\n`;
        fmt += ' '.repeat((1 + scope) * 2) + 'left: ' + this.display_branch(ext, fork.left, scope) + ',\n';
        fmt += ' '.repeat((1 + scope) * 2) + 'parent: ' + this.parents.get(fork.entity) + ',\n';

        if (fork.right) {
            fmt += ' '.repeat((1 + scope) * 2) + 'right: ' + this.display_branch(ext, fork.right, scope) + ',\n';
        }

        fmt += ' '.repeat(scope * 2) + '}';
        return fmt;
    }
}
