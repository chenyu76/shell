import * as Ecs from './ecs.js';

import type { Forest } from './forest.js';
import type { Entity } from './ecs.js';
import type { Ext } from './extension.js';
import type { Rectangle } from './rectangle.js';
import type { Stack } from './stack.js';
import { ShellWindow } from './window.js';

/** A tiling node is either a fork or a pile, including singleton piles. */
export enum NodeKind {
    FORK = 1,
    STACK = 3,
}

/** Fetch the string representation of this value */
function node_variant_as_string(value: NodeKind): string {
    return value == NodeKind.FORK ? 'NodeVariant::Fork' : 'NodeVariant::Stack';
}

/** Identifies this node as a fork */
export interface NodeFork {
    kind: 1;
    entity: Entity;
}

export interface NodeStack {
    kind: 3;
    idx: number;
    /** Borrows Stack.entities; the tree never owns a second membership order. */
    readonly entities: ReadonlyArray<Entity>;
    rect: Rectangle | null;
}

export function stack_replace(ext: Ext, node: NodeStack, window: ShellWindow) {
    if (!ext.auto_tiler) return;

    const stack = ext.auto_tiler.forest.stacks.get(node.idx);
    if (!stack) return;

    stack.replace(window);
}

export type NodeADT = NodeFork | NodeStack;

/** A tiling node refers to a pile or another fork. */
export class Node {
    /** The actual data for this node */
    inner: NodeADT;

    constructor(inner: NodeADT) {
        this.inner = inner;
    }

    /** Create a fork variant of a `Node` */
    static fork(entity: Entity): Node {
        return new Node({ kind: NodeKind.FORK, entity });
    }

    static stacked(stack: Stack, idx: number): Node {
        const node = new Node({
            kind: NodeKind.STACK,
            entities: stack.entities,
            idx,
            rect: null,
        });

        return node;
    }

    /** Generates a string representation of the this value. */
    display(fmt: string): string {
        fmt += `{\n    kind: ${node_variant_as_string(this.inner.kind)},\n    `;

        switch (this.inner.kind) {
            // Fork
            case 1:
                fmt += `entity: (${this.inner.entity})\n  }`;
                return fmt;
            // Stack
            case 3:
                fmt += `entities: ${this.inner.entities}\n  }`;
                return fmt;
        }
    }

    /** Check if the entity exists as a child of this stack */
    is_in_stack(entity: Entity): boolean {
        if (this.inner.kind === 3) {
            for (const compare of this.inner.entities) {
                if (Ecs.entity_eq(entity, compare)) return true;
            }
        }

        return false;
    }

    /** Asks if this fork is the fork we are looking for */
    is_fork(entity: Entity): boolean {
        return this.inner.kind === 1 && Ecs.entity_eq(this.inner.entity, entity);
    }

    /** Calculates the future arrangement of windows in this node */
    measure(tiler: Forest, ext: Ext, area: Rectangle) {
        switch (this.inner.kind) {
            // Fork
            case 1:
                const fork = tiler.forks.get(this.inner.entity);
                if (fork) {
                    fork.measure(tiler, ext, area);
                }

                break;
            // Stack
            case 3:
                // The windows of a stack are arranged by the stack itself, which
                // divides the area between the windows and cascades them.
                this.inner.rect = area.clone();

                if (ext.auto_tiler) {
                    tiler.stack_updates.add(this.inner);
                }
        }
    }
}
