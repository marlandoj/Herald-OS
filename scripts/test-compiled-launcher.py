"""Sanitized-runtime contract tests. Artifact contents are non-executable standins."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

class LauncherTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='cl-', dir=Path('/tmp').resolve())
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.project = self.root / 'project'
        self.runtime = self.root / 'runtime'
        for name in ('project/node_modules/electron/dist/electron',
                     'project/apps/desktop/dist/electron/main.mjs',
                     'project/scripts/credential-electron-fixture.cjs',
                     'runtime/venv/bin/python', 'runtime/hermes_cli/config.py',
                     'runtime/hermes_cli/main.py', 'runtime/hermes_cli/__init__.py',
                     'runtime/hermes_cli/subcommands/dashboard.py'):
            file = self.root / name
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_text('non-executable synthetic artifact')
            file.chmod(0o700)
        (self.runtime / 'venv/pyvenv.cfg').write_text('home = /usr/bin\ninclude-system-site-packages = false\n')
        self.manifest()
        spec = importlib.util.spec_from_file_location('compiled_launcher', Path(__file__).with_name('test-credential-electron.py'))
        if spec is None or spec.loader is None:
            raise RuntimeError('Fixture launcher module missing')
        self.launcher = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.launcher)

    def manifest(self):
        files = {str(p.relative_to(self.root)): hashlib.sha256(p.read_bytes()).hexdigest()
                 for tree in (self.project, self.runtime) for p in tree.rglob('*') if p.is_file()}
        (self.root / 'fixture-manifest.json').write_text(json.dumps({'schema': 1, 'files': files}))

    def test_unprovisioned_or_external_runtime_rejected_before_home_or_spawn(self):
        for mode in ('missing', 'external', 'missing-python', 'tampered', 'dotenv', 'pth'):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory(dir=self.root) as scratch:
                # Each scenario uses its own copied synthetic tree.
                import shutil
                root = Path(scratch)
                shutil.copytree(self.project, root / 'project')
                shutil.copytree(self.runtime, root / 'runtime')
                shutil.copyfile(self.root / 'fixture-manifest.json', root / 'fixture-manifest.json')
                if mode == 'missing': (root / 'fixture-manifest.json').unlink()
                elif mode == 'external':
                    shutil.rmtree(root / 'runtime')
                    (root / 'runtime').symlink_to(self.runtime, target_is_directory=True)
                elif mode == 'missing-python': (root / 'runtime/venv/bin/python').unlink()
                elif mode == 'tampered': (root / 'runtime/hermes_cli/main.py').write_text('changed')
                else: (root / 'runtime' / ('.env' if mode == 'dotenv' else 'editable.pth')).write_text('unsafe')
                before = sorted(p.name for p in root.iterdir())
                with patch.object(subprocess, 'run', side_effect=AssertionError('Must reject before spawn')) as spawn:
                    with self.assertRaises((ValueError, OSError)):
                        self.launcher.run_fixture(root, root / 'project', '/absent-display')
                    spawn.assert_not_called()
                self.assertEqual(sorted(p.name for p in root.iterdir()), before)

    @unittest.skipUnless(sys.platform == 'linux', 'Requires Linux atomic no-overwrite cleanup')
    def test_positive_plan_pins_runtime_and_namespaced_home_without_inherited_env(self):
        display = self.root / 'wayland-test'
        with socket.socket(socket.AF_UNIX) as server:
            server.bind(str(display))
            def intercepted(argv, **kwargs):
                self.assertEqual(argv[0], '/usr/bin/bwrap')
                self.assertIn('--unshare-all', argv)
                pairs = {argv[i+1]: argv[i+2] for i, arg in enumerate(argv) if arg == '--setenv'}
                self.assertEqual(pairs['HERALD_OS_HERMES_ROOT'], '/fixture/runtime')
                self.assertEqual(pairs['HERMES_HOME'], '/fixture/home')
                self.assertEqual(pairs['PATH'], '/usr/bin:/bin')
                self.assertNotIn('DBUS_SESSION_BUS_ADDRESS', pairs)
                self.assertNotIn('OPENAI_API_KEY', pairs)
                self.assertNotIn('/var/home/hermes', '\n'.join(argv))
                self.assertEqual(argv[-3], '--class=herald-factory-credential-test')
                homes = [p for p in self.root.iterdir() if p.name.startswith('f-')]
                self.assertEqual(len(homes), 1)
                self.assertEqual((homes[0] / '.env').stat().st_mode & 0o777, 0o644)
                return subprocess.CompletedProcess(argv, 0, 'PASS: compiled credential IPC intercepted standin\n', '')
            with patch.dict(os.environ, {'OPENAI_API_KEY': 'inherited-canary', 'PATH': '/real/bin'}, clear=True), patch.object(subprocess, 'run', side_effect=intercepted) as spawn, patch('builtins.print'):
                self.assertTrue(self.launcher.run_fixture(self.root, self.project, display))
                spawn.assert_called_once()
        self.assertFalse(any(p.name.startswith('f-') for p in self.root.iterdir()))

    def test_open_or_absent_venv_is_rejected_even_with_matching_manifest(self):
        config = self.runtime / 'venv/pyvenv.cfg'
        for mode in ('missing', 'true'):
            with self.subTest(mode=mode):
                if config.exists(): config.unlink()
                if mode == 'true': config.write_text('include-system-site-packages = true\n')
                self.manifest()
                with self.assertRaises(ValueError):
                    self.launcher.validate_sandbox(self.root, self.project)

    @unittest.skipUnless(sys.platform == 'linux', 'Requires Linux atomic no-overwrite cleanup')
    def test_cleanup_failure_never_emits_a_success_summary(self):
        from contextlib import contextmanager
        from fixture_owned import owned_home
        @contextmanager
        def uncertain_cleanup(root):
            with owned_home(root) as home:
                yield home
            raise ValueError('Cleanup uncertainty')
        display = self.root / 'wayland-test'
        with socket.socket(socket.AF_UNIX) as server:
            server.bind(str(display))
            result = subprocess.CompletedProcess([], 0, 'PASS: compiled credential IPC intercepted standin\n', '')
            with patch.object(subprocess, 'run', return_value=result), patch.object(self.launcher, 'owned_home', uncertain_cleanup), patch('builtins.print') as summary:
                with self.assertRaisesRegex(ValueError, 'Cleanup uncertainty'):
                    self.launcher.run_fixture(self.root, self.project, display)
                summary.assert_not_called()

    @unittest.skipUnless(sys.platform == 'linux', 'Requires Linux atomic no-overwrite cleanup')
    def test_home_cleanup_after_intercepted_timeout(self):
        display = self.root / 'wayland-test'
        with socket.socket(socket.AF_UNIX) as server:
            server.bind(str(display))
            with patch.object(subprocess, 'run', side_effect=subprocess.TimeoutExpired('intercepted', 1)):
                with self.assertRaises(subprocess.TimeoutExpired):
                    self.launcher.run_fixture(self.root, self.project, display)
        self.assertFalse(any(p.name.startswith('f-') for p in self.root.iterdir()))

if __name__ == '__main__':
    unittest.main(verbosity=2)
