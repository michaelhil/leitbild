import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discoverWorldTests } from './test-world.ts'

const withFixture = async (work: (root: string) => Promise<void>) => {
  const root = await mkdtemp(join(tmpdir(), 'world-test-runner-'))
  try { await work(root) } finally { await rm(root, { recursive: true, force: true }) }
}
const launch = (root: string) => Bun.spawn([process.execPath, '-e',
  `import { runWorldTests } from ${JSON.stringify(join(import.meta.dir, 'test-world.ts'))}; process.exit(await runWorldTests(${JSON.stringify(root)}));`,
], { stdout: 'pipe', stderr: 'pipe' })

test('World discovery includes scripts, source and tests with Bun names, excluding dependencies and hidden directories', async () => withFixture(async root => {
  const paths = ['tests/a.test.ts', 'scripts/b_spec.mts', 'src/nested/c_test.tsx']
  for (const path of [...paths, 'src/helper.ts', 'node_modules/foreign.test.ts', '.hidden/x.test.ts']) await Bun.write(join(root, path), '')
  expect(discoverWorldTests(root)).toEqual(paths.sort())
}))

test('complete World runs use distinct OS processes and finish every file', async () => withFixture(async root => {
  for (const name of ['a', 'b']) await Bun.write(join(root, `${name}.test.ts`), `import { test, expect } from 'bun:test'; test('real test', async () => { await Bun.write(${JSON.stringify(join(root, `${name}.pid`))}, String(process.pid)); expect(2 + 2).toBe(4) });`)
  const child = launch(root)
  const [code, output] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  expect(code).toBe(0)
  expect(await Bun.file(join(root, 'a.pid')).text()).not.toBe(await Bun.file(join(root, 'b.pid')).text())
  expect(output).toContain('World test processes completed: 2/2')
}))

test('a failed file stops the full run without retrying or reporting success; empty discovery refuses', async () => withFixture(async root => {
  const empty = launch(root)
  const [emptyCode] = await Promise.all([empty.exited, new Response(empty.stdout).text(), new Response(empty.stderr).text()])
  expect(emptyCode).not.toBe(0)
  await Bun.write(join(root, 'a.test.ts'), `import { test, expect } from 'bun:test'; test('fails', () => expect(1).toBe(2));`)
  await Bun.write(join(root, 'b.test.ts'), `await Bun.write(${JSON.stringify(join(root, 'unreached'))}, 'incorrectly ran');`)
  const child = launch(root)
  const [code, output] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  expect(code).toBe(1)
  expect(output).not.toContain('processes completed')
  expect(await Bun.file(join(root, 'unreached')).exists()).toBe(false)
}))

test('cancelling the runner stops its active child and never starts the next file', async () => withFixture(async root => {
  const marker = join(root, 'child.pid')
  await Bun.write(join(root, 'a.test.ts'), `import { test } from 'bun:test'; process.on('SIGTERM', () => {}); test('waits', async () => { await Bun.write(${JSON.stringify(marker)}, String(process.pid)); await Bun.sleep(60000); }, 120000);`)
  await Bun.write(join(root, 'b.test.ts'), `await Bun.write(${JSON.stringify(join(root, 'unreached'))}, 'incorrectly ran');`)
  const child = launch(root)
  const output = new Response(child.stdout).text(), error = new Response(child.stderr).text()
  const deadline = Date.now() + 10000
  while (!await Bun.file(marker).exists() && Date.now() < deadline) await Bun.sleep(20)
  expect(await Bun.file(marker).exists()).toBe(true)
  const childPid = Number(await Bun.file(marker).text())
  child.kill('SIGTERM')
  const [code, text] = await Promise.all([child.exited, output, error])
  expect(code).toBe(143)
  expect(text).not.toContain('processes completed')
  expect(() => process.kill(childPid, 0)).toThrow()
  expect(await Bun.file(join(root, 'unreached')).exists()).toBe(false)
}), 20000)
