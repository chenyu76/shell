#!/usr/bin/gjs --module

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=3.0';
import Pango from 'gi://Pango';

/** The directory that this script is executed from. */
const SCRIPT_DIR = GLib.path_get_dirname(new Error().stack!.split(':')[0].slice(1));

/** Add our directory so we can import modules from it. */
imports.searchPath.push(SCRIPT_DIR);

import * as config from './config.js';

const WM_CLASS_ID = 'pop-shell-exceptions';

interface SelectWindow {
    tag: 0;
    target: config.RuleTarget;
}

enum ViewNum {
    Float = 0,
    Exceptions = 1,
    PileTitles = 2,
}

interface SwitchTo {
    tag: 1;
    view: ViewNum;
}

interface ToggleException {
    tag: 2;
    wmclass: string | undefined;
    wmtitle: string | undefined;
    enable: boolean;
}

interface RemoveRule {
    tag: 3;
    target: config.RuleTarget;
    wmclass: string | undefined;
    wmtitle: string | undefined;
}

type Event = SelectWindow | SwitchTo | ToggleException | RemoveRule;

interface View {
    widget: any;

    callback: (event: Event) => void;
}

/** A button which opens another view, with a title and a description */
function next_button(name: string, description_text: string): any {
    let title = Gtk.Label.new(name);
    title.set_xalign(0);

    let description = Gtk.Label.new(description_text);
    description.set_xalign(0);
    description.get_style_context().add_class('dim-label');

    let icon = Gtk.Image.new_from_icon_name('go-next-symbolic', Gtk.IconSize.BUTTON);
    icon.set_hexpand(true);
    icon.set_halign(Gtk.Align.END);

    let layout = Gtk.Grid.new();
    layout.set_row_spacing(4);
    layout.set_border_width(12);
    layout.attach(title, 0, 0, 1, 1);
    layout.attach(description, 0, 1, 1, 1);
    layout.attach(icon, 1, 0, 1, 2);

    let button = Gtk.Button.new();
    button.relief = Gtk.ReliefStyle.NONE;
    button.add(layout);

    return button;
}

export class RulesView implements View {
    widget: any;

    callback: (event: Event) => void = () => {};

    private list: any;
    private target: config.RuleTarget;

    constructor(
        target: config.RuleTarget,
        description: string,
        next?: { name: string; description: string; view: ViewNum },
    ) {
        this.target = target;

        let select = Gtk.Button.new_with_label('Select');
        select.set_halign(Gtk.Align.CENTER);
        select.connect('clicked', () => this.callback({ tag: 0, target }));
        select.set_margin_bottom(12);

        this.list = Gtk.ListBox.new();
        this.list.set_selection_mode(Gtk.SelectionMode.NONE);
        this.list.set_header_func(list_header_func);

        if (next) {
            let button = next_button(next.name, next.description);
            button.connect('clicked', () => this.callback({ tag: 1, view: next.view }));
            this.list.add(button);
        }

        let scroller = new Gtk.ScrolledWindow();
        scroller.hscrollbar_policy = Gtk.PolicyType.NEVER;
        scroller.set_propagate_natural_width(true);
        scroller.set_propagate_natural_height(true);
        scroller.add(this.list);

        let list_frame = Gtk.Frame.new(null);
        list_frame.add(scroller);

        let desc = new Gtk.Label({ label: description });
        desc.set_line_wrap(true);
        desc.set_halign(Gtk.Align.CENTER);
        desc.set_justify(Gtk.Justification.CENTER);
        desc.set_max_width_chars(55);
        desc.set_margin_top(12);

        this.widget = Gtk.Box.new(Gtk.Orientation.VERTICAL, 24);
        this.widget.add(desc);
        this.widget.add(select);
        this.widget.add(list_frame);
    }

    add_rule(wmclass: string | undefined, wmtitle: string | undefined) {
        let label = Gtk.Label.new(wmtitle === undefined ? wmclass : `${wmclass} / ${wmtitle}`);
        label.set_xalign(0);
        label.set_hexpand(true);
        label.set_ellipsize(Pango.EllipsizeMode.END);

        let button = Gtk.Button.new_from_icon_name('edit-delete', Gtk.IconSize.BUTTON);
        button.set_valign(Gtk.Align.CENTER);

        let widget = Gtk.Box.new(Gtk.Orientation.HORIZONTAL, 24);
        widget.add(label);
        widget.add(button);
        widget.set_border_width(12);
        widget.set_margin_start(12);
        widget.show_all();

        button.connect('clicked', () => {
            widget.destroy();
            this.callback({ tag: 3, target: this.target, wmclass, wmtitle });
        });

        this.list.add(widget);
    }
}

export class ExceptionsView implements View {
    widget: any;
    callback: (event: Event) => void = () => {};

    exceptions: any = Gtk.ListBox.new();

    constructor() {
        let desc_title = Gtk.Label.new('<b>System Exceptions</b>');
        desc_title.set_use_markup(true);
        desc_title.set_xalign(0);

        let desc_desc = Gtk.Label.new('Updated based on validated user reports.');
        desc_desc.set_xalign(0);
        desc_desc.get_style_context().add_class('dim-label');
        desc_desc.set_margin_bottom(6);

        let scroller = new Gtk.ScrolledWindow();
        scroller.hscrollbar_policy = Gtk.PolicyType.NEVER;
        scroller.set_propagate_natural_width(true);
        scroller.set_propagate_natural_height(true);
        scroller.add(this.exceptions);

        let exceptions_frame = Gtk.Frame.new(null);
        exceptions_frame.add(scroller);

        this.exceptions.set_selection_mode(Gtk.SelectionMode.NONE);
        this.exceptions.set_header_func(list_header_func);

        this.widget = Gtk.Box.new(Gtk.Orientation.VERTICAL, 6);
        this.widget.add(desc_title);
        this.widget.add(desc_desc);
        this.widget.add(exceptions_frame);
    }

    add_rule(wmclass: string | undefined, wmtitle: string | undefined, enabled: boolean) {
        let label = Gtk.Label.new(wmtitle === undefined ? wmclass : `${wmclass} / ${wmtitle}`);
        label.set_xalign(0);
        label.set_hexpand(true);
        label.set_ellipsize(Pango.EllipsizeMode.END);

        let button = Gtk.Switch.new();
        button.set_valign(Gtk.Align.CENTER);
        button.set_state(enabled);
        button.connect('notify::state', () => {
            this.callback({ tag: 2, wmclass, wmtitle, enable: button.get_state() });
        });

        let widget = Gtk.Box.new(Gtk.Orientation.HORIZONTAL, 24);
        widget.add(label);
        widget.add(button);
        widget.show_all();
        widget.set_border_width(12);

        this.exceptions.add(widget);
    }
}

class App {
    float_view: RulesView = new RulesView(config.RuleTarget.Float, 'Add exceptions by selecting currently running applications and windows.', {
        name: 'System Exceptions',
        description: 'Updated based on validated user reports.',
        view: ViewNum.Exceptions,
    });

    title_view: RulesView = new RulesView(
        config.RuleTarget.PileTitle,
        'Draw the title of these windows over the pile while they are stacked behind another window.',
        {
            name: 'Floating Window Exceptions',
            description: 'Windows which float instead of tiling.',
            view: ViewNum.Float,
        },
    );

    exceptions_view: ExceptionsView = new ExceptionsView();

    stack: any = Gtk.Stack.new();
    window: any;
    headerbar: any;
    back: any;
    config: config.Config = new config.Config();

    constructor() {
        this.stack.set_border_width(16);
        this.stack.add(this.float_view.widget);
        this.stack.add(this.exceptions_view.widget);
        this.stack.add(this.title_view.widget);

        let back = Gtk.Button.new_from_icon_name('go-previous-symbolic', Gtk.IconSize.BUTTON);

        const TITLE = 'Floating Window Exceptions';

        let win = new Gtk.Dialog({ use_header_bar: true });
        let headerbar = win.get_header_bar();
        headerbar.set_show_close_button(true);
        headerbar.set_title(TITLE);
        headerbar.pack_start(back);

        this.headerbar = headerbar;
        this.back = back;

        Gtk.Window.set_default_icon_name('application-default');

        win.set_wmclass(WM_CLASS_ID, TITLE);

        win.set_default_size(550, 700);
        win.get_content_area().add(this.stack);
        win.show_all();
        win.connect('delete-event', () => Gtk.main_quit());

        this.config.reload();

        for (const value of config.DEFAULT_FLOAT_RULES.values()) {
            let wmtitle = value.title ?? undefined;
            let wmclass = value.class ?? undefined;

            let disabled = this.config.rule_disabled({ class: wmclass, title: wmtitle });
            this.exceptions_view.add_rule(wmclass, wmtitle, !disabled);
        }

        for (const value of Array.from<any>(this.config.float)) {
            let wmtitle = value.title ?? undefined;
            let wmclass = value.class ?? undefined;
            if (!value.disabled) this.float_view.add_rule(wmclass, wmtitle);
        }

        for (const value of Array.from<any>(this.config.pile_titles)) {
            let wmtitle = value.title ?? undefined;
            let wmclass = value.class ?? undefined;
            if (!value.disabled) this.title_view.add_rule(wmclass, wmtitle);
        }

        // The shell opens the list which the menu item which started this program
        // belongs to, and there is no list without a target.
        const opened = ARGV[0] === config.rule_target_name(config.RuleTarget.PileTitle) ? ViewNum.PileTitles : ViewNum.Float;

        this.show(opened);

        let event_handler = (event: Event) => {
            switch (event.tag) {
                // SelectWindow
                case 0:
                    println(`SELECT ${config.rule_target_name(event.target)}`);
                    Gtk.main_quit();
                    break;

                // SwitchTo
                case 1:
                    this.show(event.view);
                    break;

                // ToggleException
                case 2:
                    log(`toggling exception ${event.enable}`);
                    this.config.toggle_system_exception(event.wmclass, event.wmtitle, !event.enable);
                    println('MODIFIED');
                    break;

                // RemoveRule
                case 3:
                    log(`removing rule`);
                    this.config.remove_rule(event.target, event.wmclass, event.wmtitle);
                    println('MODIFIED');
                    break;
            }
        };

        this.float_view.callback = event_handler;
        this.exceptions_view.callback = event_handler;
        this.title_view.callback = event_handler;
        back.connect('clicked', () => event_handler({ tag: 1, view: ViewNum.Float }));
    }

    /** Displays one of the lists */
    private show(view: ViewNum) {
        // Only the list which the program was opened with has no way back to it.
        if (view === ViewNum.Float) this.back.hide();
        else this.back.show();

        switch (view) {
            case ViewNum.Float:
                this.stack.set_visible_child(this.float_view.widget);
                this.headerbar.set_title('Floating Window Exceptions');
                break;
            case ViewNum.Exceptions:
                this.stack.set_visible_child(this.exceptions_view.widget);
                this.headerbar.set_title('System Exceptions');
                break;
            case ViewNum.PileTitles:
                this.stack.set_visible_child(this.title_view.widget);
                this.headerbar.set_title('Window Titles in Piles');
                break;
        }
    }
}

function list_header_func(row: any, before: null | any) {
    if (before) {
        row.set_header(Gtk.Separator.new(Gtk.Orientation.HORIZONTAL));
    }
}

/** We'll use stdout for printing events for the shell to handle */
const STDOUT = new Gio.DataOutputStream({
    base_stream: new Gio.UnixOutputStream({ fd: 1 }),
});

/** Utility function for printing a message to stdout with an added newline */
function println(message: string) {
    STDOUT.put_string(message + '\n', null);
}

/** Initialize GTK and start the application */
function main() {
    GLib.set_prgname(WM_CLASS_ID);
    GLib.set_application_name('Pop Shell Floating Window Exceptions');

    Gtk.init(null);

    new App();

    Gtk.main();
}

main();
