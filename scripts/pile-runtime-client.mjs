import Gtk from 'gi://Gtk?version=4.0';
import GLib from 'gi://GLib';
Gtk.init();
const windows = ['Pile A', 'Pile B', 'Pile C'].map(title => {
    const window = new Gtk.Window({title, default_width: 420, default_height: 310});
    window.set_child(new Gtk.Label({label: title}));
    window.present();
    return window;
});
// The harness bounds the session; keep clients alive until the compositor exits.
new GLib.MainLoop(null, false).run();
