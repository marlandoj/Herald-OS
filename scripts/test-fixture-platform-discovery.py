"""Audit discovery under Linux/macOS dispatch; no foreign-kernel execution claim."""
import io
from pathlib import Path
import runpy
import sys
import unittest
from unittest.mock import patch

# These tests exercise cleanup success/races backed by Linux renameat2. All other
# guards must remain runnable; adding a test requires an explicit classification.
LINUX_ONLY = {
    'test-compiled-runtime.py': {
        'test_parent_listener_preserved_and_private_sockets_cleaned',
        'test_absolute_display_and_exception_cleanup',
        'test_sticky_temporary_ancestor_supports_an_owned_private_child',
    },
    'test-compiled-fixture-safety.py': {
        'test_unique_homes_ignore_preexisting_launcher_and_preserve_stores',
        'test_exclusive_publish_does_not_replace_regular_symlink_or_hardlink',
        'test_unsafe_root_modes_rejected_and_exception_cleanup',
        'test_cleanup_refuses_replacement_after_identity_stat',
        'test_cleanup_rejects_exported_name_recreated_at_final_rmdir',
        'test_nested_replacement_after_open_is_preserved_without_reopening',
        'test_nested_cleanup_and_symlink_controls',
        'test_nested_symlink_substitution_after_stat_never_follows_target',
        'test_failed_restore_keeps_both_replacements_instead_of_overwriting',
    },
    'test-compiled-launcher.py': {
        'test_positive_plan_pins_runtime_and_namespaced_home_without_inherited_env',
        'test_cleanup_failure_never_emits_a_success_summary',
        'test_home_cleanup_after_intercepted_timeout',
    },
    'test-credential-fixture-cjs.py': {'test_portable_explicit_owned_project_and_home_are_accepted'},
    'test-credential-source-guard.py': set(),
}

def cases(suite):
    for item in suite:
        if isinstance(item, unittest.TestSuite):
            yield from cases(item)
        else:
            yield item

def load(script, platform):
    with patch.object(sys, 'platform', platform):
        namespace = runpy.run_path(str(Path(__file__).with_name(script)), run_name='discovery_audit')
    suite = unittest.TestSuite()
    for value in namespace.values():
        if isinstance(value, type) and issubclass(value, unittest.TestCase):
            suite.addTests(unittest.defaultTestLoader.loadTestsFromTestCase(value))
    return list(cases(suite))

class PlatformDiscoveryTests(unittest.TestCase):
    def test_linux_retains_all_existing_positive_race_and_neutral_tests(self):
        for script in LINUX_ONLY:
            with self.subTest(script=script):
                discovered = load(script, 'linux')
                self.assertTrue(discovered)
                self.assertFalse(any(getattr(getattr(test, test._testMethodName), '__unittest_skip__', False) for test in discovered))

    def test_macos_skips_only_linux_positive_cleanup_and_keeps_neutral_guards(self):
        for script, expected in LINUX_ONLY.items():
            with self.subTest(script=script):
                discovered = load(script, 'darwin')
                skipped = {test._testMethodName for test in discovered if getattr(getattr(test, test._testMethodName), '__unittest_skip__', False)}
                self.assertEqual(skipped, expected)
                self.assertEqual({test._testMethodName for test in discovered}, {test._testMethodName for test in load(script, 'linux')})
                self.assertTrue(set(test._testMethodName for test in discovered) - skipped)

    def test_selected_macos_guards_execute_without_any_native_cleanup(self):
        for script in LINUX_ONLY:
            selected = [test for test in load(script, 'darwin') if not getattr(getattr(test, test._testMethodName), '__unittest_skip__', False)]
            # This patches only the dispatch seam; it does not emulate macOS.
            with self.subTest(script=script), patch.object(sys, 'platform', 'darwin'):
                result = unittest.TextTestRunner(stream=io.StringIO()).run(unittest.TestSuite(selected))
                self.assertEqual(result.errors, [])
                self.assertEqual(result.failures, [])
                self.assertEqual(result.testsRun, len(selected))

if __name__ == '__main__':
    unittest.main(verbosity=2)
