import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

const CONF_DIR: string = GLib.get_user_config_dir() + '/pop-shell';
export var CONF_FILE: string = CONF_DIR + '/config.json';

export interface FloatRule {
    class?: string;
    title?: string;
    disabled?: boolean;
}

interface Ok<T> {
    tag: 0;
    value: T;
}

interface Error {
    tag: 1;
    why: string;
}

type Result<T> = Ok<T> | Error;

export const DEFAULT_FLOAT_RULES: Array<FloatRule> = [
    { class: 'Authy Desktop' },
    { class: 'Com.github.amezin.ddterm' },
    { class: 'Com.github.donadigo.eddy' },
    { class: 'Conky' },
    { title: 'Discord Updater' },
    { class: 'Enpass', title: 'Enpass Assistant' },
    { class: 'Floating Window Exceptions' },
    { class: 'Gjs', title: 'Settings' },
    { class: 'Gnome-initial-setup' },
    { class: 'Gnome-terminal', title: 'Preferences – General' },
    { class: 'Guake' },
    { class: 'Io.elementary.sideload' },
    { title: 'JavaEmbeddedFrame' },
    { class: 'KotatogramDesktop', title: 'Media viewer' },
    { class: 'Mozilla VPN' },
    { class: 'update-manager', title: 'Software Updater' },
    { class: 'Solaar' },
    { class: 'Steam', title: '^((?!Steam).)*$' },
    { class: 'Steam', title: '^.*(Guard|Login).*' },
    { class: 'TelegramDesktop', title: 'Media viewer' },
    { class: 'Zotero', title: 'Quick Format Citation' },
    { class: 'firefox', title: '^(?!.*Mozilla Firefox).*$' },
    { class: 'gnome-screenshot' },
    { class: 'ibus-.*' },
    { class: 'jetbrains-toolbox' },
    { class: 'jetbrains-webstorm', title: 'Customize WebStorm' },
    { class: 'jetbrains-webstorm', title: 'License Activation' },
    { class: 'jetbrains-webstorm', title: 'Welcome to WebStorm' },
    { class: 'krunner' },
    { class: 'pritunl' },
    { class: 're.sonny.Junction' },
    { class: 'system76-driver' },
    { class: 'tilda' },
    { class: 'zoom' },
    { class: '^.*action=join.*$' },
    { class: 'gjs' },
];

export interface WindowRule {
    class?: string;
    title?: string;
    disabled?: boolean;
}

/**
 * These windows will skip showing in Overview, Thumbnails or SwitcherList
 * And any rule here should be added on the DEFAULT_RULES above
 */
export const SKIPTASKBAR_EXCEPTIONS: Array<WindowRule> = [
    { class: 'Conky' },
    { class: 'gjs' },
    { class: 'Guake' },
    { class: 'Com.github.amezin.ddterm' },
    { class: 'plank' },
];

export interface FloatRule {
    class?: string;
    title?: string;
}

/** The list of rules which a window may be added to */
export enum RuleTarget {
    /** Windows which float instead of tiling */
    Float,
    /** Windows whose title is drawn over the pile when they are not displayed in front */
    PileTitle,
}

/** The name of the list which a target adds rules to, which is also its key in the config file */
export function rule_target_name(target: RuleTarget): string {
    return target === RuleTarget.Float ? 'float' : 'pile_titles';
}

/** The list which the name of a target refers to */
export function rule_target_from_name(name: string): RuleTarget {
    return name === rule_target_name(RuleTarget.PileTitle) ? RuleTarget.PileTitle : RuleTarget.Float;
}

/** Whether any of these rules matches the window, which may not have a class or a title yet */
function rules_match(rules: Array<WindowRule>, wclass: string | null, title: string | null): boolean {
    for (const rule of rules) {
        if (rule.class && !new RegExp(rule.class, 'i').test(wclass ?? '')) continue;
        if (rule.title && !new RegExp(rule.title, 'i').test(title ?? '')) continue;

        return !rule.disabled;
    }

    return false;
}

/** Adds a rule to a list, unless an equal one is already in it */
function push_rule(rules: Array<WindowRule>, rule: WindowRule): boolean {
    for (const compare of rules) {
        if (compare.class === rule.class && compare.title === rule.title) return false;
    }

    rules.push(rule);
    return true;
}

export class Config {
    /** List of windows that should float, regardless of their WM hints */
    float: Array<FloatRule> = [];

    /**
     * List of Windows with skip taskbar true but still hidden in Overview,
     * Switchers, Workspace Thumbnails
     */
    skiptaskbarhidden: Array<WindowRule> = [];

    /**
     * List of windows whose title is drawn over the exposed part of their title
     * bar while they are stacked behind another window
     */
    pile_titles: Array<WindowRule> = [];

    /** Logs window details on focus of window */
    log_on_focus: boolean = false;

    /** Adds a rule for the selected window to one of the rule lists */
    add_rule(target: RuleTarget, wmclass: string, title: null | string = null) {
        const rule = title === null ? { class: wmclass } : { class: wmclass, title };

        if (push_rule(this.rules(target), rule)) this.sync_to_disk();
    }

    /** Removes the rules of one of the rule lists which match this window */
    remove_rule(target: RuleTarget, wmclass: string | undefined, title: string | undefined) {
        const rules = this.rules(target);

        for (let idx = rules.length - 1; idx >= 0; idx -= 1) {
            if (rules[idx].class === wmclass && rules[idx].title === title) rules.splice(idx, 1);
        }

        this.sync_to_disk();
    }

    /** The list which a target adds rules to */
    private rules(target: RuleTarget): Array<WindowRule> {
        return target === RuleTarget.Float ? this.float : this.pile_titles;
    }

    /** Whether this window is drawn over the pile when it is not displayed in front */
    window_has_pile_title(wclass: string | null, title: string | null): boolean {
        return rules_match(this.pile_titles, wclass, title);
    }

    window_shall_float(wclass: string, title: string): boolean {
        return rules_match(this.float.concat(DEFAULT_FLOAT_RULES), wclass, title);
    }

    skiptaskbar_shall_hide(meta_window: any) {
        if (!meta_window.is_skip_taskbar()) return false;

        return rules_match(
            this.skiptaskbarhidden.concat(SKIPTASKBAR_EXCEPTIONS),
            meta_window.get_wm_class(),
            meta_window.get_title(),
        );
    }

    reload() {
        const conf = Config.from_config();

        if (conf.tag === 0) {
            let c = conf.value;
            this.float = c.float;
            this.pile_titles = c.pile_titles ?? [];
            this.log_on_focus = c.log_on_focus;
        } else {
            log(`error loading conf: ${conf.why}`);
        }
    }

    rule_disabled(rule: FloatRule): boolean {
        for (const value of this.float.values()) {
            if (value.disabled && rule.class === value.class && value.title === rule.title) {
                return true;
            }
        }

        return false;
    }

    to_json(): string {
        return JSON.stringify(this, set_to_json, 2);
    }

    toggle_system_exception(wmclass: string | undefined, wmtitle: string | undefined, disabled: boolean) {
        if (disabled) {
            for (const value of DEFAULT_FLOAT_RULES) {
                if (value.class === wmclass && value.title === wmtitle) {
                    value.disabled = disabled;
                    this.float.push(value);
                    this.sync_to_disk();
                    return;
                }
            }
        }

        let index = 0;
        let found = false;
        for (const value of this.float) {
            if (value.class === wmclass && value.title === wmtitle) {
                found = true;
                break;
            }
            index += 1;
        }

        if (found) swap_remove(this.float, index);

        this.sync_to_disk();
    }

    static from_json(json: string): Config {
        try {
            return JSON.parse(json);
        } catch (error) {
            return new Config();
        }
    }

    private static from_config(): Result<Config> {
        const stream = Config.read();
        if (stream.tag === 1) return stream;
        let value = Config.from_json(stream.value);
        return { tag: 0, value };
    }

    private static gio_file(): Result<any> {
        try {
            const conf = Gio.File.new_for_path(CONF_FILE);

            if (!conf.query_exists(null)) {
                const dir = Gio.File.new_for_path(CONF_DIR);
                if (!dir.query_exists(null) && !dir.make_directory(null)) {
                    return { tag: 1, why: 'failed to create pop-shell config directory' };
                }

                const example = new Config();
                example.float.push({ class: 'pop-shell-example', title: 'pop-shell-example' });

                conf.create(Gio.FileCreateFlags.NONE, null).write_all(JSON.stringify(example, undefined, 2), null);
            }

            return { tag: 0, value: conf };
        } catch (why) {
            return { tag: 1, why: `Gio.File I/O error: ${why}` };
        }
    }

    private static read(): Result<string> {
        try {
            const file = Config.gio_file();
            if (file.tag === 1) return file;

            const [, buffer] = file.value.load_contents(null);

            return { tag: 0, value: imports.byteArray.toString(buffer) };
        } catch (why) {
            return { tag: 1, why: `failed to read pop-shell config: ${why}` };
        }
    }

    private static write(data: string): Result<null> {
        try {
            const file = Config.gio_file();
            if (file.tag === 1) return file;

            file.value.replace_contents(data, null, false, Gio.FileCreateFlags.NONE, null);

            return { tag: 0, value: file.value };
        } catch (why) {
            return { tag: 1, why: `failed to write to config: ${why}` };
        }
    }

    sync_to_disk() {
        Config.write(this.to_json());
    }
}

function set_to_json(_key: string, value: any) {
    if (typeof value === 'object' && value instanceof Set) {
        return [...value];
    }
    return value;
}

function swap_remove<T>(array: Array<T>, index: number): T | undefined {
    array[index] = array[array.length - 1];
    return array.pop();
}
