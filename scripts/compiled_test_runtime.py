"""Private owned runtime paths for compiled Electron fixtures.

HOME isolation alone cannot protect the production ControlSocket. Callers supply
an explicit private disposable root; no developer-specific directory is used.
"""
from contextlib import contextmanager
import os
from pathlib import Path
import stat
from fixture_owned import owned_home


@contextmanager
def isolated_runtime(project_root, clean_env, inherited=None):
    """Yield an allowlisted env with a unique 0700 runtime and owned cleanup.

    Resolve display connectivity before changing XDG_RUNTIME_DIR. No session D-Bus
    or credential/configuration environment is inherited by this helper.
    """
    inherited = os.environ if inherited is None else inherited
    display = Path(inherited.get('WAYLAND_DISPLAY', 'wayland-0'))
    if not display.is_absolute():
        parent = Path(inherited.get('XDG_RUNTIME_DIR', ''))
        if not parent.is_absolute():
            raise ValueError('Absolute parent runtime required for relative display')
        display = parent / display
    display = display.resolve()
    if not stat.S_ISSOCK(display.stat().st_mode):
        raise ValueError('Wayland display must be a socket')
    with owned_home(Path(project_root)) as private:
        runtime, temporary = private / 'r', private / 't'
        runtime.mkdir(mode=0o700)
        temporary.mkdir(mode=0o700)
        if len(os.fsencode(runtime / 'herald-os/control.sock')) > 103:
            raise ValueError('Choose a shorter private root for Unix sockets')
        env = dict(clean_env)
        env.update({'XDG_RUNTIME_DIR': str(runtime), 'WAYLAND_DISPLAY': str(display),
                    'TMPDIR': str(temporary)})
        yield env
