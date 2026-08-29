#!/usr/bin/env bun

// Production deploys must not depend on third-party network availability.
// Keep the ordinary full suite unchanged for developer/CI coverage, but run
// every local test except the explicitly external-network integration files.

const EXTERNAL_NETWORK_TESTS = new Set([
  'tools/research.test.ts',
  'tools/web.test.ts',
])

export const selectDeployTestFiles = (paths: ReadonlyArray<string>): string[] =>
  paths
    .filter(path => path.endsWith('.test.ts'))
    .filter(path => !EXTERNAL_NETWORK_TESTS.has(path))
    .sort()

const captureTrackedAndUntrackedTests = async (): Promise<string[]> => {
  const child = Bun.spawn([
    'git', 'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '*.test.ts', '**/*.test.ts',
  ], { stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (code !== 0) throw new Error(`git ls-files failed (${code}): ${stderr.trim()}`)
  return selectDeployTestFiles(stdout.split('\0').filter(Boolean))
}

const main = async (): Promise<void> => {
  const files = await captureTrackedAndUntrackedTests()
  if (files.length === 0) throw new Error('No deploy-safe test files found')
  console.log(`Deploy-safe suite: ${files.length} files; external-network integrations excluded`)
  const child = Bun.spawn(['bun', 'test', ...files, '-t', '^(?!.*Ollama)'], {
    stdout: 'inherit',
    stderr: 'inherit',
  })
  const code = await child.exited
  if (code !== 0) process.exit(code)
}

if (import.meta.main) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
