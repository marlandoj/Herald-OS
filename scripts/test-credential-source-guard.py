"""Optimization-safe prerequisite check; never import real Hermes modules."""
from pathlib import Path
import runpy
import sys
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).with_name('test-credentials-integration.py')

class SourceGuardTests(unittest.TestCase):
    def test_missing_source_rejected_before_any_write_or_import(self):
        with tempfile.TemporaryDirectory() as root:
            for arguments in ([], [str(Path(root) / 'missing')]):
                with self.subTest(arguments=arguments), patch.object(sys, 'argv', [str(SCRIPT), *arguments]), patch.object(Path, 'mkdir', side_effect=AssertionError('Write before source validation')) as mkdir:
                    with self.assertRaisesRegex(ValueError, '^Hermes source required$'):
                        runpy.run_path(str(SCRIPT), run_name='source_guard_test')
                    mkdir.assert_not_called()

    def test_valid_synthetic_source_reaches_allocation_not_backend_import(self):
        with tempfile.TemporaryDirectory() as root:
            source = Path(root)
            (source / 'hermes_cli').mkdir()
            (source / 'hermes_cli/config.py').write_text('# synthetic source prerequisite only')
            with patch.object(sys, 'argv', [str(SCRIPT), str(source)]), patch.object(Path, 'mkdir', side_effect=RuntimeError('Allocation intercepted')):
                with self.assertRaisesRegex(RuntimeError, 'Allocation intercepted'):
                    runpy.run_path(str(SCRIPT), run_name='source_guard_test')

if __name__ == '__main__':
    unittest.main(verbosity=2)
