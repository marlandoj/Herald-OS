"""Run against installed Hermes source, never against a real profile.

Usage: <Hermes test python> scripts/test-credentials-integration.py <runtime-source>
This file does not start Hermes, its gateway, or any provider calls.
"""
import multiprocessing
import os
from pathlib import Path
import socket
import stat
import sys
import tempfile
import unittest
from unittest.mock import patch

PROJECT = Path(__file__).resolve().parents[1]
if len(sys.argv) < 2:
    raise ValueError('Hermes source required')
SOURCE = Path(sys.argv.pop(1)).resolve()
if not (SOURCE / 'hermes_cli/config.py').is_file():
    raise ValueError('Hermes source required')
CACHE = PROJECT / 'node_modules/.cache/credential-integration'
CACHE.mkdir(parents=True, exist_ok=True)
SANDBOX = tempfile.TemporaryDirectory(prefix='isolated-', dir=CACHE)
ROOT = Path(SANDBOX.name)
PROFILE = ROOT / 'profile'
PROFILE.mkdir()
# Before importing Hermes: inherited credentials, profile selection, and shared-home
# fallback paths are removed. Bytecode must not modify the installed runtime.
os.environ.clear()
os.environ.update({'HOME': str(ROOT), 'HERMES_HOME': str(PROFILE), 'PATH': '/usr/bin:/bin',
                   'XDG_CONFIG_HOME': str(ROOT / 'config'), 'XDG_DATA_HOME': str(ROOT / 'data'),
                   'DO_NOT_TRACK': '1', 'HERMES_TELEMETRY_ENABLED': 'false'})
sys.dont_write_bytecode = True
sys.path.insert(0, str(SOURCE))

_original_connect = socket.socket.connect

def deny_external_connect(sock, target):
    if sock.family in (socket.AF_INET, socket.AF_INET6):
        raise AssertionError('Network calls are prohibited in credential integration tests')
    return _original_connect(sock, target)

socket.socket.connect = deny_external_connect

from hermes_cli import config
from hermes_cli.credential_lifecycle import save_provider_env_credential, remove_provider_env_credential


def concurrent_writer(index):
    config.save_env_value(f'TEST_WRITER_{index}', f'fixture-{index}')


class CredentialIntegration(unittest.TestCase):
    def setUp(self):
        for file in PROFILE.iterdir():
            if file.is_file():
                file.unlink()
        for name in list(os.environ):
            if name.endswith('_API_KEY') or name.startswith('TEST_WRITER_'):
                os.environ.pop(name)
        os.environ.pop('VOICE_TOOLS_OPENAI_KEY', None)
        config.invalidate_env_cache()

    def test_active_home_new_update_remove_stay_atomic_and_0600(self):
        self.assertEqual(config.get_env_path(), PROFILE / '.env')
        save_provider_env_credential('VOICE_TOOLS_OPENAI_KEY', 'fixture-first')
        file = PROFILE / '.env'
        self.assertEqual(stat.S_IMODE(file.stat().st_mode), 0o600)
        file.write_text(file.read_text() + '# keep this comment\nUNRELATED=left=right\n', encoding='utf8')
        first_inode = file.stat().st_ino
        save_provider_env_credential('VOICE_TOOLS_OPENAI_KEY', 'fixture-next')
        self.assertNotEqual(file.stat().st_ino, first_inode)
        self.assertEqual(stat.S_IMODE(file.stat().st_mode), 0o600)
        self.assertEqual(config.load_env()['UNRELATED'], 'left=right')
        self.assertIn('# keep this comment', file.read_text())
        before_remove = file.stat().st_ino
        remove_provider_env_credential('VOICE_TOOLS_OPENAI_KEY')
        self.assertNotEqual(file.stat().st_ino, before_remove)
        self.assertEqual(stat.S_IMODE(file.stat().st_mode), 0o600)
        self.assertNotIn('VOICE_TOOLS_OPENAI_KEY', config.load_env())
        self.assertEqual(config.load_env()['UNRELATED'], 'left=right')

    def test_replace_failure_preserves_original_and_cleans_staging(self):
        config.save_env_value('VOICE_TOOLS_OPENAI_KEY', 'fixture-original')
        file = PROFILE / '.env'
        original = file.read_bytes()
        with patch('hermes_cli.config.atomic_replace', side_effect=OSError('fixture write failure')):
            with self.assertRaises(OSError):
                config.save_env_value('VOICE_TOOLS_OPENAI_KEY', 'fixture-new')
        self.assertEqual(file.read_bytes(), original)
        self.assertEqual(list(PROFILE.glob('.env_*.tmp')), [])

    def test_cross_process_writes_preserve_unrelated_entries(self):
        config.save_env_value('UNRELATED', 'preserved')
        workers = [multiprocessing.get_context('fork').Process(target=concurrent_writer, args=(i,)) for i in range(8)]
        for worker in workers:
            worker.start()
        for worker in workers:
            worker.join(20)
            self.assertEqual(worker.exitcode, 0)
        config.invalidate_env_cache()
        values = config.load_env()
        self.assertEqual(values['UNRELATED'], 'preserved')
        for i in range(8):
            self.assertEqual(values[f'TEST_WRITER_{i}'], f'fixture-{i}')
        self.assertEqual(stat.S_IMODE((PROFILE / '.env').stat().st_mode), 0o600)

    def test_public_env_http_handlers_save_rotate_remove_and_preserve_unrelated(self):
        from fastapi.testclient import TestClient
        from hermes_cli.web_server import app, _SESSION_TOKEN
        client = TestClient(app)
        headers = {'X-Hermes-Session-Token': _SESSION_TOKEN}
        config.save_env_value('UNRELATED', 'left=right')
        names = ['VOICE_TOOLS_OPENAI_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY',
                 'OPENROUTER_API_KEY', 'GEMINI_API_KEY', 'XAI_API_KEY', 'GROQ_API_KEY']
        for name in names:
            response = client.put('/api/env', json={'key': name, 'value': 'fixture-first'}, headers=headers)
            self.assertEqual(response.status_code, 200)
            self.assertEqual(config.load_env()[name], 'fixture-first')
        listing = client.get('/api/env', headers=headers)
        self.assertEqual(listing.status_code, 200)
        for name in names:
            self.assertIs(listing.json()[name]['is_set'], True)
        response = client.put('/api/env', json={'key': 'VOICE_TOOLS_OPENAI_KEY', 'value': 'fixture-rotated'}, headers=headers)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(config.load_env()['VOICE_TOOLS_OPENAI_KEY'], 'fixture-rotated')
        for name in names:
            response = client.request('DELETE', '/api/env', json={'key': name}, headers=headers)
            self.assertEqual(response.status_code, 200)
            self.assertNotIn(name, config.load_env())
        self.assertEqual(config.load_env()['UNRELATED'], 'left=right')
        self.assertEqual(stat.S_IMODE((PROFILE / '.env').stat().st_mode), 0o600)

    def test_provider_lifecycle_reconciles_synthetic_config_and_pool_mirrors(self):
        import json
        import hermes_yaml as yaml
        from hermes_cli.auth import _load_auth_store
        save_provider_env_credential('OPENAI_API_KEY', 'fixture-old')
        mirror = PROFILE / 'config.yaml'
        mirror.write_text('model:\n  api_key: fixture-old\nauxiliary:\n  vision:\n    api_key: fixture-old\nunrelated: preserved\n', encoding='utf8')
        save_provider_env_credential('OPENAI_API_KEY', 'fixture-new')
        saved = yaml.safe_load(mirror.read_text())
        self.assertEqual(saved['model']['api_key'], 'fixture-new')
        self.assertEqual(saved['auxiliary']['vision']['api_key'], 'fixture-new')
        self.assertEqual(saved['unrelated'], 'preserved')
        pool = _load_auth_store().get('credential_pool', {})
        entries = [entry for group in pool.values() for entry in group if entry.get('source') == 'env:OPENAI_API_KEY']
        self.assertTrue(entries, 'Provider save must materialize the pool')
        self.assertNotIn('fixture-old', json.dumps(entries))
        remove_provider_env_credential('OPENAI_API_KEY')
        saved = yaml.safe_load(mirror.read_text())
        self.assertNotIn('api_key', saved['model'])
        self.assertNotIn('api_key', saved['auxiliary']['vision'])
        pool = _load_auth_store().get('credential_pool', {})
        self.assertFalse(any(entry.get('source') == 'env:OPENAI_API_KEY' for group in pool.values() for entry in group))

    def test_existing_insecure_mode_is_preserved_upstream_limitation(self):
        # This intentionally documents upstream behavior, NOT a security guarantee.
        file = PROFILE / '.env'
        file.write_text('VOICE_TOOLS_OPENAI_KEY=fixture-old\nUNRELATED=preserved\n', encoding='utf8')
        file.chmod(0o644)
        save_provider_env_credential('VOICE_TOOLS_OPENAI_KEY', 'fixture-new')
        self.assertEqual(stat.S_IMODE(file.stat().st_mode), 0o644)
        remove_provider_env_credential('VOICE_TOOLS_OPENAI_KEY')
        self.assertEqual(stat.S_IMODE(file.stat().st_mode), 0o644)


if __name__ == '__main__':
    try:
        unittest.main(verbosity=2)
    finally:
        SANDBOX.cleanup()
