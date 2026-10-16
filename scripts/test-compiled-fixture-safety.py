"""Fixture guard behavior only: no backend import or Electron execution."""
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
import sys
from unittest.mock import patch

import fixture_owned
from fixture_owned import owned_home, write_new

class HomeSafetyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='guard-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()

    @unittest.skipUnless(sys.platform == 'linux', 'Requires Linux atomic no-overwrite cleanup')
    def test_unique_homes_ignore_preexisting_launcher_and_preserve_stores(self):
        outside = self.root / 'outside'
        outside.mkdir(mode=0o700)
        target = outside / '.env'
        target.write_text('synthetic sentinel')
        (self.root / 'launcher').symlink_to(outside, target_is_directory=True)
        with owned_home(self.root) as first:
            write_new(first / '.env', 'synthetic fixture', 0o644)
            with owned_home(self.root) as second:
                self.assertNotEqual(first, second)
                self.assertEqual(first.stat().st_mode & 0o777, 0o700)
                self.assertEqual((first / '.env').stat().st_mode & 0o777, 0o644)
            self.assertFalse(second.exists())
        self.assertFalse(first.exists())
        self.assertEqual(target.read_text(), 'synthetic sentinel')
        self.assertTrue((self.root / 'launcher').is_symlink())

    def test_root_and_ancestor_aliases_refused_before_creation(self):
        child = self.root / 'child'
        child.mkdir(mode=0o700)
        alias = self.root / 'alias'
        alias.symlink_to(child, target_is_directory=True)
        for root in (alias, alias / 'nested'):
            with self.subTest(root=root), self.assertRaises((ValueError, OSError)):
                with owned_home(root):
                    self.fail('Alias accepted')
        self.assertEqual(list(child.iterdir()), [])

    @unittest.skipUnless(sys.platform == 'linux', 'Requires Linux atomic no-overwrite cleanup')
    def test_exclusive_publish_does_not_replace_regular_symlink_or_hardlink(self):
        target = self.root / 'target'
        target.write_text('untouched')
        for kind in ('regular', 'symlink', 'hardlink'):
            with self.subTest(kind=kind), owned_home(self.root) as home:
                leaf = home / '.env'
                if kind == 'regular': leaf.write_text('untouched')
                elif kind == 'symlink': leaf.symlink_to(target)
                else: os.link(target, leaf)
                inode = leaf.lstat().st_ino
                with self.assertRaises(FileExistsError):
                    write_new(leaf, 'must not publish')
                self.assertEqual(leaf.lstat().st_ino, inode)
                self.assertEqual(leaf.read_text(), 'untouched')
                self.assertEqual(target.read_text(), 'untouched')

    @unittest.skipUnless(sys.platform == 'linux', 'Requires Linux atomic no-overwrite cleanup')
    def test_unsafe_root_modes_rejected_and_exception_cleanup(self):
        self.root.chmod(0o755)
        with self.assertRaises(ValueError):
            with owned_home(self.root): self.fail('Public root accepted')
        self.root.chmod(0o700)
        with self.assertRaisesRegex(RuntimeError, 'synthetic failure'):
            with owned_home(self.root) as home:
                raise RuntimeError('synthetic failure')
        self.assertFalse(home.exists())

    def test_cleanup_refuses_replaced_home_and_preserves_replacement(self):
        with self.assertRaisesRegex(ValueError, 'ownership changed'):
            with owned_home(self.root) as home:
                moved = home.with_name(home.name + '-moved')
                home.rename(moved)
                home.mkdir(mode=0o700)
                (home / 'sentinel').write_text('untouched')
        self.assertEqual((home / 'sentinel').read_text(), 'untouched')
        self.assertTrue(moved.exists())

    @unittest.skipUnless(sys.platform == 'linux', 'Requires Linux atomic no-overwrite cleanup')
    def test_cleanup_refuses_replacement_after_identity_stat(self):
        """Replace AFTER stat returns the owned inode, before old rmtree opens it."""
        real_stat = os.stat
        events = []
        def late_replace(path, *args, **kwargs):
            info = real_stat(path, *args, **kwargs)
            if path == home.name and kwargs.get('dir_fd') is not None and not events:
                self.assertEqual(info.st_ino, owned_inode)
                home.rename(moved)
                home.mkdir(mode=0o700)
                (home / 'sentinel').write_text('late replacement untouched')
                events.append('replaced-after-owned-stat')
            return info
        error = None
        home = self.root / 'not-created'
        try:
            with owned_home(self.root) as home:
                moved = home.with_name(home.name + '-moved')
                owned_inode = home.stat().st_ino
                # Keep the interceptor active across context-manager exit.
                interceptor = patch.object(fixture_owned.os, 'stat', side_effect=late_replace)
                interceptor.start()
                self.addCleanup(interceptor.stop)
        except ValueError as exc:
            error = exc
        self.assertEqual(events, ['replaced-after-owned-stat'])
        self.assertTrue((home / 'sentinel').exists(), 'late replacement was deleted')
        self.assertEqual((home / 'sentinel').read_text(), 'late replacement untouched')
        self.assertIsNotNone(error, 'Cleanup reported success after a late replacement')
        self.assertRegex(str(error), 'ownership changed')

    @unittest.skipUnless(sys.platform == 'linux', 'Requires Linux atomic no-overwrite cleanup')
    def test_cleanup_rejects_exported_name_recreated_at_final_rmdir(self):
        """Final rmdir must target a private claim, never an empty replacement."""
        for boundary in ('claimed-home', 'cleanup-arena'):
            with self.subTest(boundary=boundary):
                populated = boundary == 'claimed-home'
                real_rmdir = os.rmdir
                events = []
                home = self.root / 'not-created'
                owned_inode = None
                def replace_at_final_remove(path, *args, **kwargs):
                    info = os.stat(path, dir_fd=kwargs.get('dir_fd'), follow_symlinks=False)
                    at_boundary = (info.st_ino == owned_inode if boundary == 'claimed-home'
                                   else str(path).startswith('.cleanup-'))
                    if at_boundary and not events:
                        self.assertNotEqual(path, home.name, 'Mutable home passed to rmdir')
                        home.mkdir(mode=0o700)
                        if populated:
                            (home / 'sentinel').write_text('final replacement untouched')
                        events.append(home.stat().st_ino)
                    return real_rmdir(path, *args, **kwargs)
                error = None
                with patch.object(fixture_owned.os, 'rmdir', side_effect=replace_at_final_remove):
                    try:
                        with owned_home(self.root) as home:
                            owned_inode = home.stat().st_ino
                    except ValueError as exc:
                        error = exc
                self.assertEqual(len(events), 1, 'Final removal boundary not intercepted')
                self.assertEqual(home.stat().st_ino, events[0], 'Empty replacement was removed')
                if populated:
                    self.assertEqual((home / 'sentinel').read_text(), 'final replacement untouched')
                self.assertIsNotNone(error, 'Cleanup reported success with a recreated exported name')
                self.assertRegex(str(error), 'ownership changed')

    @unittest.skipUnless(sys.platform == 'linux', 'Requires Linux atomic no-overwrite cleanup')
    def test_nested_replacement_after_open_is_preserved_without_reopening(self):
        """A held child fd is not permission to delete its replaced public name."""
        real_open = os.open
        moved = self.root / 'moved-child'
        events = []
        error = None
        home_fd = None
        def substitute_after_open(path, flags, *args, **kwargs):
            result = real_open(path, flags, *args, **kwargs)
            if path == 'nested' and flags & os.O_DIRECTORY and not events:
                parent = kwargs['dir_fd']
                os.rename('nested', moved, src_dir_fd=parent)
                os.mkdir('nested', 0o700, dir_fd=parent)
                marker = real_open('nested/sentinel', os.O_WRONLY | os.O_CREAT | os.O_EXCL,
                                   0o600, dir_fd=parent)
                try:
                    os.write(marker, b'nested replacement untouched')
                finally:
                    os.close(marker)
                events.append('replaced-after-child-open')
            return result
        try:
            with patch.object(fixture_owned.os, 'open', side_effect=substitute_after_open):
                try:
                    with owned_home(self.root) as home:
                        nested = home / 'nested'
                        nested.mkdir(mode=0o700)
                        (nested / 'owned').write_text('owned child retained on rejection')
                        home_fd = real_open(home, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
                except ValueError as exc:
                    error = exc
            self.assertEqual(events, ['replaced-after-child-open'])
            self.assertIsNotNone(error, 'Nested replacement incorrectly accepted')
            self.assertRegex(str(error), 'ownership changed')
            self.assertIsNotNone(home_fd)
            marker = real_open('nested/sentinel', os.O_RDONLY | os.O_NOFOLLOW, dir_fd=home_fd)
            try:
                self.assertEqual(os.read(marker, 128), b'nested replacement untouched')
            finally:
                os.close(marker)
            self.assertEqual((moved / 'owned').read_text(), 'owned child retained on rejection')
        finally:
            if home_fd is not None:
                os.close(home_fd)

    @unittest.skipUnless(sys.platform == 'linux', 'Requires Linux atomic no-overwrite cleanup')
    def test_nested_cleanup_and_symlink_controls(self):
        outside = self.root / 'outside-nested'
        outside.mkdir(mode=0o700)
        sentinel = outside / 'sentinel'
        sentinel.write_text('outside untouched')
        with owned_home(self.root) as home:
            child = home / 'child'
            child.mkdir(mode=0o700)
            (child / 'deep').mkdir(mode=0o700)
            (child / 'deep/data').write_text('owned disposable contents')
            (child / 'alias').symlink_to(outside, target_is_directory=True)
            os.link(sentinel, child / 'hardlink')
            (home / 'broken').symlink_to(outside / 'absent')
        self.assertFalse(home.exists())
        self.assertEqual(sentinel.read_text(), 'outside untouched')
        self.assertEqual(sorted(p.name for p in self.root.iterdir()), ['outside-nested'])

    @unittest.skipUnless(sys.platform == 'linux', 'Requires Linux atomic no-overwrite cleanup')
    def test_nested_symlink_substitution_after_stat_never_follows_target(self):
        outside = self.root / 'outside-symlink'
        outside.mkdir(mode=0o700)
        (outside / 'sentinel').write_text('outside sentinel untouched')
        moved = self.root / 'moved-before-open'
        real_stat = os.stat
        events = []
        def substitute_after_stat(path, *args, **kwargs):
            info = real_stat(path, *args, **kwargs)
            if path == 'nested' and kwargs.get('dir_fd') is not None and not events:
                parent = kwargs['dir_fd']
                os.rename('nested', moved, src_dir_fd=parent)
                os.symlink(outside, 'nested', dir_fd=parent, target_is_directory=True)
                events.append('symlink-after-nested-stat')
            return info
        with patch.object(fixture_owned.os, 'stat', side_effect=substitute_after_stat):
            with self.assertRaises((OSError, ValueError)):
                with owned_home(self.root) as home:
                    (home / 'nested').mkdir(mode=0o700)
                    (home / 'nested/owned').write_text('owned retained')
        self.assertEqual(events, ['symlink-after-nested-stat'])
        self.assertEqual((outside / 'sentinel').read_text(), 'outside sentinel untouched')
        self.assertEqual((moved / 'owned').read_text(), 'owned retained')
        aliases = list(self.root.glob('.cleanup-*/c-*/nested'))
        self.assertEqual(len(aliases), 1)
        self.assertTrue(aliases[0].is_symlink())

    def test_collision_guards_without_linux_cleanup(self):
        # Neutral publication controls must not depend on cleanup availability.
        target = self.root / 'outside'
        target.write_text('outside unchanged')
        with tempfile.TemporaryDirectory(dir=self.root) as private:
            home = Path(private)
            for kind in ('regular', 'symlink', 'hardlink'):
                leaf = home / kind
                if kind == 'regular': leaf.write_text('outside unchanged')
                elif kind == 'symlink': leaf.symlink_to(target)
                else: os.link(target, leaf)
                inode = leaf.lstat().st_ino
                with self.assertRaises(FileExistsError):
                    write_new(leaf, 'must not replace')
                self.assertEqual(leaf.lstat().st_ino, inode)
                self.assertEqual(target.read_text(), 'outside unchanged')

    def test_unsafe_root_rejected_before_native_cleanup(self):
        self.root.chmod(0o755)
        with patch.object(fixture_owned.ctypes, 'CDLL', side_effect=AssertionError('Native cleanup reached')) as libc:
            with self.assertRaisesRegex(ValueError, 'owned and private'):
                with owned_home(self.root): self.fail('Public root accepted')
            libc.assert_not_called()
        self.assertEqual(list(self.root.iterdir()), [])

    def test_unsupported_platform_rejects_cleanup_and_preserves_owned_contents(self):
        # Deterministic dispatch test, not a claim of execution on a Mac kernel.
        import sys
        for platform in ('darwin', 'win32'):
            with self.subTest(platform=platform), patch.object(sys, 'platform', platform), \
                    patch.object(fixture_owned.ctypes, 'CDLL', side_effect=AssertionError('Unsupported platform reached libc')) as libc:
                with self.assertRaisesRegex(ValueError, 'Atomic fixture cleanup unavailable'):
                    with owned_home(self.root) as home:
                        (home / 'sentinel').write_text('unsupported cleanup must preserve')
                self.assertEqual((home / 'sentinel').read_text(), 'unsupported cleanup must preserve')
                self.assertTrue((home / '.fixture-owner').is_file())
                libc.assert_not_called()

    def test_atomic_claim_unavailable_fails_closed_without_path_fallback(self):
        home = self.root / 'not-created'
        with patch.object(sys, 'platform', 'linux'), patch.object(fixture_owned.ctypes, 'CDLL', return_value=object()):
            with self.assertRaisesRegex(ValueError, 'Atomic fixture cleanup unavailable'):
                with owned_home(self.root) as home:
                    (home / 'sentinel').write_text('preserved without atomic primitive')
        self.assertEqual((home / 'sentinel').read_text(), 'preserved without atomic primitive')
        self.assertTrue((home / '.fixture-owner').is_file())

    @unittest.skipUnless(sys.platform == 'linux', 'Requires Linux atomic no-overwrite cleanup')
    def test_failed_restore_keeps_both_replacements_instead_of_overwriting(self):
        real_stat = os.stat
        real_rename = fixture_owned._rename_noreplace
        events = []
        home = self.root / 'not-created'
        def replace_after_stat(path, *args, **kwargs):
            info = real_stat(path, *args, **kwargs)
            if path == home.name and kwargs.get('dir_fd') is not None and not events:
                home.rename(home.with_name(home.name + '-moved'))
                home.mkdir(mode=0o700)
                (home / 'first-sentinel').write_text('first replacement untouched')
                events.append('first-replacement')
            return info
        def occupy_restore(source, name, destination, target):
            if target == home.name and events == ['first-replacement']:
                home.mkdir(mode=0o700)
                (home / 'second-sentinel').write_text('second replacement untouched')
                events.append('restore-occupied')
            return real_rename(source, name, destination, target)
        with patch.object(fixture_owned.os, 'stat', side_effect=replace_after_stat), \
                patch.object(fixture_owned, '_rename_noreplace', side_effect=occupy_restore):
            with self.assertRaisesRegex(ValueError, 'replacement retained in cleanup quarantine'):
                with owned_home(self.root) as home:
                    pass
        self.assertEqual(events, ['first-replacement', 'restore-occupied'])
        self.assertEqual((home / 'second-sentinel').read_text(), 'second replacement untouched')
        preserved = list(self.root.glob('.cleanup-*/c-*/first-sentinel'))
        self.assertEqual(len(preserved), 1)
        self.assertEqual(preserved[0].read_text(), 'first replacement untouched')

if __name__ == '__main__':
    unittest.main(verbosity=2)
