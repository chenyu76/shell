import Gtk from 'gi://Gtk';

import Gio from 'gi://Gio';
import Gdk from 'gi://Gdk';
import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import * as settings from './settings.js';
import * as log from './log.js';
import * as focus from './focus.js';

const Settings = Gio.Settings;

interface AppWidgets {
    drag_dead_zone: any;
    fullscreen_launcher: any;
    stacking_with_mouse: any;
    inner_gap: any;
    mouse_cursor_follows_active_window: any;
    outer_gap: any;
    show_skip_taskbar: any;
    smart_gaps: any;
    snap_to_grid: any;
    stack_offset_x: any;
    stack_offset_y: any;
    window_titles: any;
    mouse_cursor_focus_position: any;
    log_level: any;
    max_window_width: any;
    active_hint: any;
    active_hint_border_radius: any;
    hint_color: any;
}

export default class PopShellPreferences extends ExtensionPreferences {
    getPreferencesWidget() {
        globalThis.popShellExtension = this;
        let dialog = settings_dialog_new();
        if (dialog.show_all) {
            dialog.show_all();
        } else {
            dialog.show();
        }
        log.debug(JSON.stringify(dialog));
        return new Gtk.ScrolledWindow({
            child: dialog,
            hscrollbar_policy: Gtk.PolicyType.NEVER,
            min_content_height: 480,
            max_content_height: 600,
            propagate_natural_height: true,
        });
    }
}

function settings_dialog_new(): Gtk.Container {
    let [app, grid] = settings_dialog_view();

    let ext = new settings.ExtensionSettings();

    app.window_titles.set_active(ext.show_title());
    app.window_titles.connect('state-set', (_widget: any, state: boolean) => {
        ext.set_show_title(state);
        Settings.sync();
    });

    app.snap_to_grid.set_active(ext.snap_to_grid());
    app.snap_to_grid.connect('state-set', (_widget: any, state: boolean) => {
        ext.set_snap_to_grid(state);
        Settings.sync();
    });

    app.smart_gaps.set_active(ext.smart_gaps());
    app.smart_gaps.connect('state-set', (_widget: any, state: boolean) => {
        ext.set_smart_gaps(state);
        Settings.sync();
    });

    app.outer_gap.set_text(String(ext.gap_outer()));
    app.outer_gap.connect('activate', (widget: any) => {
        let parsed = parseInt((widget.get_text() as string).trim());
        if (!isNaN(parsed)) {
            ext.set_gap_outer(parsed);
            Settings.sync();
        }
    });

    app.inner_gap.set_text(String(ext.gap_inner()));
    app.inner_gap.connect('activate', (widget: any) => {
        let parsed = parseInt((widget.get_text() as string).trim());
        if (!isNaN(parsed)) {
            ext.set_gap_inner(parsed);
            Settings.sync();
        }
    });

    app.log_level.set_active(ext.log_level());
    app.log_level.connect('changed', () => {
        let active_id = app.log_level.get_active_id();
        ext.set_log_level(active_id);
    });

    app.show_skip_taskbar.set_active(ext.show_skiptaskbar());
    app.show_skip_taskbar.connect('state-set', (_widget: any, state: boolean) => {
        ext.set_show_skiptaskbar(state);
        Settings.sync();
    });

    app.mouse_cursor_follows_active_window.set_active(ext.mouse_cursor_follows_active_window());
    app.mouse_cursor_follows_active_window.connect('state-set', (_widget: any, state: boolean) => {
        ext.set_mouse_cursor_follows_active_window(state);
        Settings.sync();
    });

    app.mouse_cursor_focus_position.set_active(ext.mouse_cursor_focus_location());
    app.mouse_cursor_focus_position.connect('changed', () => {
        let active_id = app.mouse_cursor_focus_position.get_active_id();
        ext.set_mouse_cursor_focus_location(active_id);
    });

    app.fullscreen_launcher.set_active(ext.fullscreen_launcher());
    app.fullscreen_launcher.connect('state-set', (_widget: any, state: boolean) => {
        ext.set_fullscreen_launcher(state);
        Settings.sync();
    });

    app.stacking_with_mouse.set_active(ext.stacking_with_mouse());
    app.stacking_with_mouse.connect('state-set', (_widget: any, state: boolean) => {
        ext.set_stacking_with_mouse(state);
        Settings.sync();
    });

    app.max_window_width.set_text(String(ext.max_window_width()));
    app.max_window_width.connect('activate', (widget: any) => {
        let parsed = parseInt((widget.get_text() as string).trim());
        if (!isNaN(parsed)) {
            ext.set_max_window_width(parsed);
            Settings.sync();
        }
    });

    app.drag_dead_zone.set_text(String(ext.drag_dead_zone()));
    app.drag_dead_zone.connect('activate', (widget: any) => {
        let parsed = parseInt((widget.get_text() as string).trim());
        if (!isNaN(parsed)) {
            ext.set_drag_dead_zone(parsed);
            Settings.sync();
        }
    });

    app.stack_offset_x.set_text(String(ext.stack_offset_x()));
    app.stack_offset_x.connect('activate', (widget: any) => {
        let parsed = parseInt((widget.get_text() as string).trim());
        if (!isNaN(parsed)) {
            ext.set_stack_offset_x(parsed);
            Settings.sync();
        }
    });

    app.stack_offset_y.set_text(String(ext.stack_offset_y()));
    app.stack_offset_y.connect('activate', (widget: any) => {
        let parsed = parseInt((widget.get_text() as string).trim());
        if (!isNaN(parsed)) {
            ext.set_stack_offset_y(parsed);
            Settings.sync();
        }
    });

    ext.ext.bind('active-hint', app.active_hint, 'active', Gio.SettingsBindFlags.DEFAULT);
    ext.ext.bind('active-hint-border-radius', app.active_hint_border_radius, 'value', Gio.SettingsBindFlags.DEFAULT);
    const color = new Gdk.RGBA();
    color.parse(ext.hint_color_rgba());
    app.hint_color.set_rgba(color);
    app.hint_color.connect('notify::rgba', () => {
        ext.set_hint_color_rgba(app.hint_color.get_rgba().to_string());
    });

    return grid;
}

function settings_dialog_view(): [AppWidgets, Gtk.Container] {
    const grid = new Gtk.Grid({
        column_spacing: 12,
        row_spacing: 12,
        margin_start: 10,
        margin_end: 10,
        margin_bottom: 10,
        margin_top: 10,
    });

    const win_label = new Gtk.Label({
        label: 'Show Window Titles',
        xalign: 0.0,
        hexpand: true,
    });

    const snap_label = new Gtk.Label({
        label: 'Snap to Grid (Floating Mode)',
        xalign: 0.0,
    });

    const smart_label = new Gtk.Label({
        label: 'Smart Gaps',
        xalign: 0.0,
    });

    const show_skip_taskbar_label = new Gtk.Label({
        label: 'Show Minimize to Tray Windows',
        xalign: 0.0,
    });

    const mouse_cursor_follows_active_window_label = new Gtk.Label({
        label: 'Mouse Cursor Follows Active Window',
        xalign: 0.0,
    });

    const fullscreen_launcher_label = new Gtk.Label({
        label: 'Allow launcher over fullscreen window',
        xalign: 0.0,
    });

    const stacking_with_mouse = new Gtk.Label({
        label: 'Allow stacking with mouse',
        xalign: 0.0,
    });

    const max_window_width_label = new Gtk.Label({
        label: 'Max window width (in pixels); 0 to disable',
        xalign: 0.0,
    });

    const drag_dead_zone_label = new Gtk.Label({
        label: 'Window drag dead zone (in pixels)',
        xalign: 0.0,
    });

    const settings = {
        fullscreen_launcher: new Gtk.Switch({ halign: Gtk.Align.END }),
        stacking_with_mouse: new Gtk.Switch({ halign: Gtk.Align.END }),
        smart_gaps: new Gtk.Switch({ halign: Gtk.Align.END }),
        snap_to_grid: new Gtk.Switch({ halign: Gtk.Align.END }),
        window_titles: new Gtk.Switch({ halign: Gtk.Align.END }),
        show_skip_taskbar: new Gtk.Switch({ halign: Gtk.Align.END }),
        mouse_cursor_follows_active_window: new Gtk.Switch({ halign: Gtk.Align.END }),
        mouse_cursor_focus_position: build_combo(grid, 7, focus.FocusPosition, 'Mouse Cursor Focus Position'),
        log_level: build_combo(grid, 8, log.LOG_LEVELS, 'Log Level'),
        outer_gap: number_entry(),
        inner_gap: number_entry(),
        max_window_width: number_entry(),
        stack_offset_x: number_entry(),
        stack_offset_y: number_entry(),
        drag_dead_zone: number_entry(),
        active_hint: new Gtk.Switch({ halign: Gtk.Align.END }),
        active_hint_border_radius: new Gtk.SpinButton({
            adjustment: new Gtk.Adjustment({ lower: 0, upper: 30, step_increment: 1, page_increment: 5 }),
            numeric: true,
            halign: Gtk.Align.END,
        }),
        hint_color: new Gtk.ColorDialogButton({
            dialog: new Gtk.ColorDialog({ with_alpha: true }), halign: Gtk.Align.END,
        }),
    };

    grid.attach(win_label, 0, 0, 1, 1);
    grid.attach(settings.window_titles, 1, 0, 1, 1);

    grid.attach(snap_label, 0, 1, 1, 1);
    grid.attach(settings.snap_to_grid, 1, 1, 1, 1);

    grid.attach(smart_label, 0, 2, 1, 1);
    grid.attach(settings.smart_gaps, 1, 2, 1, 1);

    grid.attach(fullscreen_launcher_label, 0, 3, 1, 1);
    grid.attach(settings.fullscreen_launcher, 1, 3, 1, 1);

    grid.attach(stacking_with_mouse, 0, 4, 1, 1);
    grid.attach(settings.stacking_with_mouse, 1, 4, 1, 1);

    grid.attach(show_skip_taskbar_label, 0, 5, 1, 1);
    grid.attach(settings.show_skip_taskbar, 1, 5, 1, 1);

    grid.attach(mouse_cursor_follows_active_window_label, 0, 6, 1, 1);
    grid.attach(settings.mouse_cursor_follows_active_window, 1, 6, 1, 1);

    settings_section(grid, 9, 'Gaps (in pixels)', [
        ['Outer', settings.outer_gap],
        ['Inner', settings.inner_gap],
    ]);

    grid.attach(max_window_width_label, 0, 12, 1, 1);
    grid.attach(settings.max_window_width, 1, 12, 1, 1);

    settings_section(grid, 13, 'Stacked Window Offset (in pixels)', [
        ['Horizontal', settings.stack_offset_x],
        ['Vertical', settings.stack_offset_y],
    ]);

    grid.attach(drag_dead_zone_label, 0, 16, 1, 1);
    grid.attach(settings.drag_dead_zone, 1, 16, 1, 1);

    settings_section(grid, 17, 'Active Hint', [
        ['Show Active Hint', settings.active_hint],
        ['Active Border Radius', settings.active_hint_border_radius],
        ['Active Hint Color', settings.hint_color],
    ]);

    return [settings, grid];
}

function number_entry(): Gtk.Widget {
    return new Gtk.Entry({ input_purpose: Gtk.InputPurpose.NUMBER });
}

/** Keep section headings and indented setting labels consistent across control types. */
function settings_section(grid: any, top: number, title: string, rows: ReadonlyArray<readonly [string, Gtk.Widget]>) {
    grid.attach(new Gtk.Label({ label: title, xalign: 0.0, margin_top: 12 }), 0, top, 2, 1);
    for (const [index, [label, widget]] of rows.entries()) {
        grid.attach(new Gtk.Label({ label, xalign: 0.0, margin_start: 24 }), 0, top + index + 1, 1, 1);
        grid.attach(widget, 1, top + index + 1, 1, 1);
    }
}

function build_combo(grid: any, top_index: number, iter_enum: any, label: string) {
    let label_ = new Gtk.Label({
        label: label,
        halign: Gtk.Align.START,
    });

    grid.attach(label_, 0, top_index, 1, 1);

    let combo = new Gtk.ComboBoxText();

    for (const [index, key] of Object.keys(iter_enum).entries()) {
        if (typeof iter_enum[key] == 'string') {
            combo.append(`${index}`, iter_enum[key]);
        }
    }

    grid.attach(combo, 1, top_index, 1, 1);
    return combo;
}
