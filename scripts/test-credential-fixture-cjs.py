"""Execute only the CJS fixture's startup guard, with Electron intercepted."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
import sys
from fixture_owned import owned_home

class CjsGuardTests(unittest.TestCase):
    def test_missing_explicit_project_rejected_before_electron_import(self):
        # Neutral negative boundary: no owned_home success or native cleanup.
        project = Path(__file__).resolve().parents[1]
        code = '''const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const fixture=path.join(process.argv[1],'scripts/credential-electron-fixture.cjs');
const local=require('node:module').createRequire(fixture);
const source=fs.readFileSync(fixture,'utf8').split('const pause')[0];
try {
 vm.runInNewContext(source,{require:name=>{if(name==='electron')throw new Error('Electron import reached');return local(name)},
  __dirname:path.dirname(fixture),process,console});
 throw new Error('Missing project accepted');
} catch(error) {
 if(error.message!=='Explicit portable fixture project required') throw error;
 console.log('PASS project rejected before Electron import');
}'''
        with tempfile.TemporaryDirectory(prefix='cjs-neutral-') as root:
            env = {'PATH': '/usr/bin:/bin', 'HOME': root, 'HERMES_HOME': root}
            result = subprocess.run([os.environ.get('FIXTURE_TEST_NODE', 'node'), '-e', code, str(project)], env=env, capture_output=True, text=True, timeout=5)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn('PASS project rejected', result.stdout)
            self.assertEqual(list(Path(root).iterdir()), [])

    @unittest.skipUnless(sys.platform == 'linux', 'Requires Linux atomic no-overwrite cleanup')
    def test_portable_explicit_owned_project_and_home_are_accepted(self):
        with tempfile.TemporaryDirectory(prefix='cjs-') as root:
            shared = Path(root).resolve() / 'shared'
            shared.mkdir(mode=0o700)
            shared.chmod(0o1777)
            private = shared / 'private'
            private.mkdir(mode=0o700)
            self.check_guard(Path(root).resolve(), private)

    def check_guard(self, root, private):
        with owned_home(private) as home:
            project = Path(__file__).resolve().parents[1]
            code = '''const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const project=process.argv[1];
const fixture=path.join(project,'scripts/credential-electron-fixture.cjs');
const local=require('node:module').createRequire(fixture);
const source=fs.readFileSync(fixture,'utf8').split('const pause')[0];
vm.runInNewContext(source,{require: name => name==='electron' ? {app:{setPath(){},on(){}}} : local(name),
 __dirname:path.dirname(fixture),process,console});
console.log('PASS portable CJS startup guard; Electron intercepted');'''
            env = {'PATH': '/opt/node/bin:/usr/bin:/bin', 'HOME': str(home), 'HERMES_HOME': str(home),
                   'CREDENTIAL_FIXTURE_PROJECT': str(project),
                   'CREDENTIAL_FIXTURE_TOKEN': (home / '.fixture-owner').read_text(),
                   'HERALD_OS_HERMES_ROOT': str(Path(root).resolve() / 'runtime')}
            runtime = Path(env['HERALD_OS_HERMES_ROOT'])
            runtime.mkdir(mode=0o700)
            result = subprocess.run([os.environ.get('FIXTURE_TEST_NODE', 'node'), '-e', code, str(project)], env=env, capture_output=True, text=True, timeout=5)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn('PASS portable', result.stdout)
            alias = root / 'home-alias'
            alias.symlink_to(home, target_is_directory=True)
            for override, reason in (
                ({'HOME': str(root)}, 'Fixture home mismatch'),
                ({'CREDENTIAL_FIXTURE_TOKEN': 'wrong'}, 'Fixture ownership marker required'),
                ({'CREDENTIAL_FIXTURE_PROJECT': str(project / 'alias')}, 'Explicit portable fixture project required'),
                ({'HOME': str(alias), 'HERMES_HOME': str(alias)}, 'Canonical fixture directory required')
            ):
                result = subprocess.run([os.environ.get('FIXTURE_TEST_NODE', 'node'), '-e', code, str(project)], env=env | override, capture_output=True, text=True, timeout=5)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(reason, result.stderr)

if __name__ == '__main__':
    unittest.main(verbosity=2)
