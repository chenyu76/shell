// Lets the checks in this directory import the compiled modules of the extension
// in plain Node, by mapping the gi:// modules which only exist inside GNOME Shell
// to a stub which records what the extension asks of them.
//
// scripts/stack-cascade-check.mjs registers these hooks before it imports
// target/stack.js, so no command line flags are needed.

const STUB = `
const actors = new Array();

/** The parts of an St actor which the arrangement of a stack uses */
class Actor {
    constructor(props = {}) {
        this.visible = true;
        this.children = new Array();
        this.parent = null;
        this.position = { x: 0, y: 0 };
        this.size = { width: 0, height: 0 };
        this.text = props.text ?? '';
        this.style_class = props.style_class ?? '';
        this.x_align = props.x_align ?? null;
        this.y_align = props.y_align ?? null;
        this.clutter_text = {
            ellipsize: null,
            x_align: null,
            y_align: null,
            set_ellipsize(value) {
                this.ellipsize = value;
            },
            set_x_align(value) {
                this.x_align = value;
            },
            set_y_align(value) {
                this.y_align = value;
            },
        };

        actors.push(this);
    }

    add_child(child) {
        this.children.push(child);
        child.parent = this;
    }

    destroy() {
        const idx = actors.indexOf(this);
        if (idx !== -1) actors.splice(idx, 1);
    }

    get_parent() {
        return this.parent;
    }

    get_preferred_width() {
        return [this.text.length * 7, this.text.length * 7];
    }

    get_preferred_height() {
        return [16, 16];
    }

    hide() {
        this.visible = false;
    }

    set_position(x, y) {
        this.position = { x, y };
    }

    set_size(width, height) {
        this.size = { width, height };
    }

    show() {
        this.visible = true;
    }
}

export class Label extends Actor {}
export class Widget extends Actor {}

export const ActorAlign = { START: 0, CENTER: 1, END: 2 };
export const EllipsizeMode = { NONE: 0, START: 1, MIDDLE: 2, END: 3 };

/** The actors which were created, so a check can inspect what was drawn */
export function drawn_actors() {
    return actors;
}

/** Forgets the actors of the previous check */
export function reset_actors() {
    actors.splice(0);
}

export default { ActorAlign, EllipsizeMode, Label, Widget, drawn_actors, reset_actors };
`;

/** An inline module which stands in for every gi:// module the extension imports */
export const STUB_URL = `data:text/javascript,${encodeURIComponent(STUB)}`;

export function resolve(specifier, context, next) {
    if (specifier.startsWith('gi://')) {
        return { url: STUB_URL, format: 'module', shortCircuit: true };
    }

    return next(specifier, context);
}
