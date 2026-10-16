import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { expect, it } from 'vitest'

it.each([
  { script: 'test-compiled-runtime.py', count: 5 },
  { script: 'test-compiled-fixture-safety.py', count: 15 },
  { script: 'test-compiled-launcher.py', count: 5 },
  { script: 'test-credential-fixture-cjs.py', count: 2 },
  { script: 'test-credential-source-guard.py', count: 2 },
  // Audits both dispatch branches, without claiming a macOS runtime on Linux.
  { script: 'test-fixture-platform-discovery.py', count: 3 }
])('checks fixture safety without launching a backend: $script', ({ script, count }) => {
  const project = fileURLToPath(new URL('../../../', import.meta.url))
  const result = spawnSync('python3', ['-B', path.join(project, 'scripts', script)], {
    env: { PATH: '/usr/bin:/bin', FIXTURE_TEST_NODE: process.execPath, PYTHONDONTWRITEBYTECODE: '1' },
    encoding: 'utf8', timeout: 10000
  })
  expect(result.error).toBeUndefined()
  expect(result.status, result.stderr).toBe(0)
  expect(result.stderr).toContain(`Ran ${count} test`)
  expect(result.stderr).toContain('OK')
})
