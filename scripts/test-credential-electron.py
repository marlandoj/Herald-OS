"""Opt-in compiled credential fixture in an explicitly provisioned sandbox.

Prerequisite (Linux; caller provisions and source-reviews this, not this script):
- A canonical current-user 0700 sandbox containing project/ (independent rebuilt
  checkout plus Electron dependencies) and runtime/ (tracked public Hermes source,
  copied interpreter and closed venv). Never use installed/live trees or profiles.
- Only independent single-link regular files and safe owned directories are
  supported. No symlinks, credential-store filenames or .pth import hooks. Resolve
  dependency links only after reviewing their public origins; do not copy homes.
- runtime/venv/pyvenv.cfg must disable system site packages. The source package,
  main/config/dashboard modules and venv/bin/python must be present. The venv's
  base interpreter/libraries must work using only the read-only /usr mount.
- fixture-manifest.json is {"schema":1,"files":{"project/relative/path":"sha256",
  "runtime/relative/path":"sha256", ...}} covering EVERY regular file in both
  trees. Freeze these caller-audited inputs against concurrent mutation. Hash
  consistency is not independent approval or proof of safe runtime provenance.
- Supply --sandbox, --project <sandbox>/project and --wayland-display explicitly.
  Missing prerequisites fail before home allocation or any application spawn.

After separate review/authorization, the opt-in path launches through networkless
bwrap with only /usr, read-only project/runtime, one display socket and a uniquely
owned writable home mounted. Runtime resolution is pinned to /fixture/runtime;
no inherited PATH/profile, installed home or D-Bus is mounted. Source-root dotenv
is absent/read-only and all profile/cleanup writes belong to the unique home.
Importing this module performs no writes and starts no application.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import secrets
import stat
import subprocess

from fixture_owned import directory_fd, owned_home, write_new


def validate_sandbox(sandbox, project):
    sandbox, project = Path(sandbox), Path(project)
    with directory_fd(sandbox, private=True):
        pass
    if project != sandbox / 'project':
        raise ValueError('Explicit sandbox/project required; external checkouts are prohibited')
    runtime = sandbox / 'runtime'
    # Validate no-follow metadata before reading ANY manifest/source bytes.
    inventory = {}
    for tree in (project, runtime):
        with directory_fd(tree):
            pass
        for parent, dirs, files in os.walk(tree, followlinks=False):
            with directory_fd(Path(parent)):
                pass
            for name in dirs:
                with directory_fd(Path(parent) / name):
                    pass
            for name in files:
                file = Path(parent) / name
                info = file.lstat()
                if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                        or info.st_nlink != 1 or info.st_mode & 0o022):
                    raise ValueError('Only independently copied regular fixture artifacts allowed')
                if name in ('.env', 'auth.json', 'config.yaml') or name.endswith('.pth'):
                    raise ValueError('Credential stores and editable import hooks are prohibited')
                inventory[str(file.relative_to(sandbox))] = file
    manifest_file = sandbox / 'fixture-manifest.json'
    info = manifest_file.lstat()
    if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
            or info.st_nlink != 1 or info.st_mode & 0o022):
        raise ValueError('Unsafe fixture manifest')
    manifest = json.loads(manifest_file.read_text())
    if (manifest.get('schema') != 1 or not isinstance(manifest.get('files'), dict)
            or set(manifest['files']) != set(inventory)):
        raise ValueError('Complete frozen fixture manifest required')
    for name, file in inventory.items():
        if hashlib.sha256(file.read_bytes()).hexdigest() != manifest['files'][name]:
            raise ValueError('Fixture artifact differs from manifest')
    required = ('project/node_modules/electron/dist/electron',
                'project/apps/desktop/dist/electron/main.mjs',
                'project/scripts/credential-electron-fixture.cjs',
                'runtime/venv/bin/python', 'runtime/venv/pyvenv.cfg',
                'runtime/hermes_cli/__init__.py', 'runtime/hermes_cli/config.py',
                'runtime/hermes_cli/main.py', 'runtime/hermes_cli/subcommands/dashboard.py')
    if any(name not in inventory for name in required):
        raise ValueError('Rebuilt project and sanitized runtime source/venv required')
    venv_config = dict(line.lower().split('=', 1) for line in (runtime / 'venv/pyvenv.cfg').read_text().splitlines() if '=' in line)
    venv_config = {key.strip(): value.strip() for key, value in venv_config.items()}
    if venv_config.get('include-system-site-packages') != 'false':
        raise ValueError('Closed disposable virtual environment required')
    for name in (required[0], 'runtime/venv/bin/python'):
        if not os.access(inventory[name], os.X_OK):
            raise ValueError('Provisioned fixture executable required')
    return runtime


def fixture_command(project, runtime, home, display):
    env = {'HOME': '/fixture/home', 'HERMES_HOME': '/fixture/home',
           'HERALD_OS_HERMES_ROOT': '/fixture/runtime',
           'CREDENTIAL_FIXTURE_PROJECT': '/fixture/project',
           'CREDENTIAL_FIXTURE_TOKEN': (home / '.fixture-owner').read_text(),
           'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8',
           'XDG_CONFIG_HOME': '/fixture/home/config', 'XDG_DATA_HOME': '/fixture/home/data',
           'XDG_STATE_HOME': '/fixture/home/state', 'XDG_CACHE_HOME': '/fixture/home/cache',
           'XDG_RUNTIME_DIR': '/fixture/home/run', 'TMPDIR': '/fixture/home/tmp',
           'WAYLAND_DISPLAY': '/fixture/display', 'HERALD_OS_SHELL_MODE': 'desktop',
           'HERALD_OS_KIOSK': '0', 'DO_NOT_TRACK': '1', 'HERMES_TELEMETRY_ENABLED': 'false',
           'ELECTRON_OZONE_PLATFORM_HINT': 'wayland', 'PYTHONDONTWRITEBYTECODE': '1',
           'PYTHONNOUSERSITE': '1'}
    cmd = ['/usr/bin/bwrap', '--unshare-all', '--die-with-parent', '--new-session', '--clearenv',
           '--ro-bind', '/usr', '/usr', '--symlink', 'usr/bin', '/bin', '--symlink', 'usr/lib64', '/lib64',
           '--symlink', 'usr/lib', '/lib', '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp',
           '--dir', '/etc', '--ro-bind', str(project), '/fixture/project',
           '--ro-bind', str(runtime), '/fixture/runtime', '--bind', str(home), '/fixture/home',
           '--ro-bind', str(display), '/fixture/display']
    for key, value in env.items():
        cmd += ['--setenv', key, value]
    return cmd + ['--chdir', '/fixture/project', '/fixture/project/node_modules/electron/dist/electron',
                  '/fixture/project/scripts/credential-electron-fixture.cjs',
                  '--class=herald-factory-credential-test', '--ozone-platform=wayland', '--disable-gpu']


def run_fixture(sandbox, project, display):
    sandbox, project = Path(sandbox), Path(project)
    runtime = validate_sandbox(sandbox, project)
    display = Path(display).resolve(strict=True)
    if not stat.S_ISSOCK(display.stat().st_mode):
        raise ValueError('Explicit Wayland socket required')
    with owned_home(sandbox) as home:
        seed = secrets.token_hex(24)
        write_new(home / '.env', f'# integration fixture\nOPENAI_API_KEY={seed}\nUNRELATED_SETTING=retained\n', 0o644)
        write_new(home / 'config.yaml', f'auxiliary:\n  vision:\n    api_key: {seed}\nproviders:\n  fixture:\n    api_key: ${{OPENAI_API_KEY}}\ncustom_providers:\n  - name: fixture\n    api_key: {seed}\n', 0o644)
        write_new(home / 'auth.json', json.dumps({'credential_pool': {'openai': [
            {'id': 'fixture', 'source': 'env:OPENAI_API_KEY', 'access_token': seed}]}}), 0o644)
        for name in ('run', 'tmp'):
            (home / name).mkdir(mode=0o700)
        run = subprocess.run(fixture_command(project, runtime, home, display),
                             env={'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8'},
                             capture_output=True, text=True, timeout=240)
        lines = [line for line in (run.stdout + '\n' + run.stderr).splitlines()
                 if line.startswith(('PASS: compiled credential IPC', 'FAIL: compiled credential regression'))]
        passed = run.returncode == 0 and any(line.startswith('PASS:') for line in lines) and not any(line.startswith('FAIL:') for line in lines)
    # Only report success after owned-home cleanup has actually completed.
    # Fixed summary only: upstream stdout/stderr may contain synthetic secrets.
    print(json.dumps({'compiled_fixture_passed': passed, 'exit_code': run.returncode}))
    return passed


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--sandbox', required=True, type=Path)
    parser.add_argument('--project', required=True, type=Path)
    parser.add_argument('--wayland-display', required=True, type=Path)
    args = parser.parse_args()
    try:
        return 0 if run_fixture(args.sandbox, args.project, args.wayland_display) else 1
    except (OSError, ValueError, subprocess.TimeoutExpired):
        print('FAIL: explicit sanitized fixture prerequisite or execution failed')
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
