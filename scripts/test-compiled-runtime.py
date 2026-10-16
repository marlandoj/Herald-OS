"""Behavioral tests for private compiled-fixture socket environments."""
import os
from pathlib import Path
import socket
import stat
import tempfile
import unittest
import sys

from compiled_test_runtime import isolated_runtime

class RuntimeTests(unittest.TestCase):
    def setUp(self):
        # A new owned root per case; no checkout-specific or developer-home writes.
        self.sandbox = tempfile.TemporaryDirectory(prefix='crt-', dir=Path('/tmp').resolve())
        self.addCleanup(self.sandbox.cleanup)
        self.root = Path(self.sandbox.name).resolve()

    @unittest.skipUnless(sys.platform == 'linux', 'Requires Linux atomic no-overwrite cleanup')
    def test_parent_listener_preserved_and_private_sockets_cleaned(self):
        base = self.root / 'rt'
        base.mkdir(mode=0o700, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix='u', dir=base) as temp:
            parent = Path(temp)
            display = parent / 'wayland-test'
            control = parent / 'herald-os/control.sock'
            control.parent.mkdir(mode=0o700)
            with socket.socket(socket.AF_UNIX) as wayland, socket.socket(socket.AF_UNIX) as sentinel:
                wayland.bind(str(display))
                sentinel.bind(str(control))
                sentinel.listen()
                inode = control.stat().st_ino
                inherited = {'XDG_RUNTIME_DIR': str(parent), 'WAYLAND_DISPLAY': 'wayland-test',
                             'SHOULD_NOT_INHERIT': 'fixture', 'DBUS_SESSION_BUS_ADDRESS': 'fixture'}
                with isolated_runtime(self.root, {'HOME': str(parent)}, inherited) as env:
                    runtime = Path(env['XDG_RUNTIME_DIR'])
                    self.assertNotEqual(runtime, parent)
                    self.assertEqual(env['WAYLAND_DISPLAY'], str(display))
                    self.assertEqual(stat.S_IMODE(runtime.stat().st_mode), 0o700)
                    self.assertEqual(runtime.stat().st_uid, os.getuid())
                    self.assertNotIn('SHOULD_NOT_INHERIT', env)
                    self.assertNotIn('DBUS_SESSION_BUS_ADDRESS', env)
                    private = runtime / 'herald-os/control.sock'
                    private.parent.mkdir(mode=0o700)
                    with socket.socket(socket.AF_UNIX) as owned:
                        owned.bind(str(private))
                    self.assertEqual(control.stat().st_ino, inode)
                    with socket.socket(socket.AF_UNIX) as client:
                        client.connect(str(control))
                    accepted, _ = sentinel.accept()
                    accepted.close()
                self.assertFalse(runtime.exists())
                self.assertEqual(control.stat().st_ino, inode)

    @unittest.skipUnless(sys.platform == 'linux', 'Requires Linux atomic no-overwrite cleanup')
    def test_absolute_display_and_exception_cleanup(self):
        base = self.root / 'rt'
        base.mkdir(mode=0o700, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix='u', dir=base) as temp:
            display = Path(temp) / 'wayland-test'
            with socket.socket(socket.AF_UNIX) as wayland:
                wayland.bind(str(display))
                with self.assertRaisesRegex(RuntimeError, 'fixture'):
                    with isolated_runtime(self.root, {'HOME': temp}, {'WAYLAND_DISPLAY': str(display)}) as env:
                        runtime = Path(env['XDG_RUNTIME_DIR'])
                        self.assertEqual(env['WAYLAND_DISPLAY'], str(display))
                        raise RuntimeError('fixture')
                self.assertFalse(runtime.exists())

    def test_invalid_display_fails_before_runtime_allocation(self):
        with self.assertRaises(ValueError):
            with isolated_runtime(self.root, {}, {'WAYLAND_DISPLAY': 'relative'}):
                self.fail('Missing parent runtime accepted')
        with self.assertRaises(ValueError):
            with isolated_runtime(self.root, {}, {'WAYLAND_DISPLAY': str(Path(__file__).resolve())}):
                self.fail('Non-socket display accepted')

    @unittest.skipUnless(sys.platform == 'linux', 'Requires Linux atomic no-overwrite cleanup')
    def test_sticky_temporary_ancestor_supports_an_owned_private_child(self):
        shared = self.root / 'shared'
        shared.mkdir(mode=0o700)
        shared.chmod(0o1777)
        private = shared / 'private'
        private.mkdir(mode=0o700)
        display = self.root / 'display'
        with socket.socket(socket.AF_UNIX) as wayland:
            wayland.bind(str(display))
            with isolated_runtime(private, {}, {'WAYLAND_DISPLAY': str(display)}) as env:
                self.assertEqual(Path(env['XDG_RUNTIME_DIR']).stat().st_mode & 0o777, 0o700)

    def test_symlink_root_is_refused(self):
        base = self.root / 'rt'
        base.mkdir(mode=0o700, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix='u', dir=base) as temp:
            display = Path(temp) / 'wayland-test'
            alias = Path(temp) / 'alias'
            alias.symlink_to(self.root, target_is_directory=True)
            with socket.socket(socket.AF_UNIX) as wayland:
                wayland.bind(str(display))
                with self.assertRaises(ValueError):
                    with isolated_runtime(alias, {}, {'WAYLAND_DISPLAY': str(display)}):
                        self.fail('Symlink project root accepted')


if __name__ == '__main__':
    unittest.main()