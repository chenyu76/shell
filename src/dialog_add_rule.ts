import * as Lib from './lib.js';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';

/** Asks whether a rule is added for one window, or for every window of its application */
export class AddRuleDialog {
    dialog: Shell.ModalDialog = new ModalDialog.ModalDialog({
        styleClass: 'pop-shell-search modal-dialog',
        destroyOnClose: false,
        shellReactive: true,
        shouldFadeIn: false,
        shouldFadeOut: false,
    });

    constructor(
        description: string,
        cancel: () => void,
        this_app: () => void,
        current_window: () => void,
        on_close: () => void,
    ) {
        let title = St.Label.new('Add Window Rule');
        title.set_x_align(Clutter.ActorAlign.CENTER);
        title.set_style('font-weight: bold');

        let desc = St.Label.new(description);
        desc.set_x_align(Clutter.ActorAlign.CENTER);

        let l = this.dialog.contentLayout;

        l.add_child(title);
        l.add_child(desc);

        this.dialog.contentLayout.width = Math.max(Lib.current_monitor().width / 4, 640);

        this.dialog.addButton({
            label: 'Cancel',
            action: () => {
                cancel();
                on_close();
                this.close();
            },
            key: Clutter.KEY_Escape,
        });

        this.dialog.addButton({
            label: "This App's Windows",
            action: () => {
                this_app();
                on_close();
                this.close();
            },
        });

        this.dialog.addButton({
            label: 'Current Window Only',
            action: () => {
                current_window();
                on_close();
                this.close();
            },
        });
    }

    close() {
        this.dialog.close(global.get_current_time());
    }

    show() {
        this.dialog.show();
    }

    open() {
        this.dialog.open(global.get_current_time(), false);
        this.show();
    }
}
