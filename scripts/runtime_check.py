"""Private D-Bus/XDG harness shared by the headless Wayland regression checks."""

import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile


def run_session(root, marker, passes, seconds, full_extension, monitors):
    enabled = ['pile-close-check@local']
    if full_extension:
        enabled.insert(0, 'pop-shell@system76.com')
    for schema, key, value in [
        ('org.gnome.shell', 'enabled-extensions', str(enabled)),
        ('org.gnome.shell', 'disable-user-extensions', 'false'),
        ('org.gnome.shell.extensions.pop-shell', 'tile-by-default', 'false'),
        ('org.gnome.mutter', 'dynamic-workspaces', 'false'),
    ]:
        subprocess.run(['gsettings', 'set', schema, key, value], check=True)
    result = subprocess.run(
        ['timeout', f'{seconds}s', 'gnome-shell', '--headless', '--wayland', '--no-x11',
         '--wayland-display', 'pile-check',
         *[argument for size in monitors for argument in ('--virtual-monitor', size)]],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
    )
    log = root / 'shell.log'
    log.write_text(result.stdout)
    print(f'GNOME log: {log}')
    failures = [line for line in result.stdout.splitlines()
                if 'JS ERROR' in line or 'Window animation unavailable' in line or f'[{marker}] FAIL' in line]
    for line in failures:
        print(line)
    if result.returncode not in (0, 124) or failures or result.stdout.count(f'[{marker}] PASS') != passes:
        raise SystemExit(f'FAIL: {marker}; inspect the GNOME log')
    print(f'PASS: {marker} ({passes} scenarios)')


def run(client_source, check, marker, passes, seconds=14, full_extension=True, monitors=('1280x900',),
        session_modes=('user',)):
    build = Path(__file__).resolve().parents[1] / '_build'
    root = Path(tempfile.mkdtemp(prefix='pop-shell-check-'))
    (root / 'runtime').mkdir(mode=0o700)
    extensions = root / 'data/gnome-shell/extensions'
    extension = extensions / 'pop-shell@system76.com'
    shutil.copytree(build, extension)
    test = extensions / 'pile-close-check@local'
    test.mkdir()
    test.joinpath('metadata.json').write_text(json.dumps({
        'uuid': test.name, 'name': 'Pop Shell regression check',
        'description': 'Isolated Wayland regression test',
        'shell-version': json.loads(build.joinpath('metadata.json').read_text())['shell-version'],
        'session-modes': session_modes,
    }))
    test.joinpath('extension.js').write_text(check)
    client = root / 'client.js'
    client.write_text(client_source)
    env = dict(os.environ, GSETTINGS_BACKEND='keyfile', GTK_A11Y='none', LIBGL_ALWAYS_SOFTWARE='1',
               GSETTINGS_SCHEMA_DIR=str(extension / 'schemas'), WAYLAND_DISPLAY='pile-check',
               PILE_CHECK_CLIENT=str(client),
               **{f'XDG_{name.upper()}_HOME': str(root / name) for name in ['config', 'data', 'cache', 'state']})
    env['XDG_RUNTIME_DIR'] = str(root / 'runtime')
    subprocess.run(['dbus-run-session', '--', sys.executable, __file__, str(root), marker,
                    str(passes), str(seconds), str(int(full_extension)), *monitors], env=env, check=True)


if __name__ == '__main__':
    run_session(Path(sys.argv[1]), sys.argv[2], int(sys.argv[3]), int(sys.argv[4]), bool(int(sys.argv[5])),
                sys.argv[6:])
