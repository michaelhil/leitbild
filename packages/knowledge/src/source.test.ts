import { expect, test } from 'bun:test'
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readProductSource, MAX_PRODUCT_SOURCE_BYTES } from './source.ts'
import { findProductSourceReferences, parseProductSourceReference } from './source-reference.ts'

test('native kernel sources remain inspectable but compiled/private paths do not', () => {
  expect(parseProductSourceReference('apps/world/native/process-plant/src/lib.rs:1-5')).not.toBeNull()
  expect(parseProductSourceReference('apps/world/native/process-plant/src/if97-bridge.cpp')).not.toBeNull()
  expect(parseProductSourceReference('apps/world/native/process-plant/target/release/build.rs')).toBeNull()
  expect(parseProductSourceReference('apps/world/native/../private.rs')).toBeNull()
  expect(parseProductSourceReference('apps/world/native/.env/secrets.rs')).toBeNull()
})

test('authored dependency diffs use the same read-only source inspection boundary', async () => {
  const root = await mkdtemp(join(tmpdir(), 'knowledge-diff-'))
  const path = 'apps/example/scripts/numerical-method.patch'
  const content = '--- a/source.c\n+++ b/source.c\n@@ -1 +1 @@\n-old\n+new\n'
  try {
    await mkdir(join(root, 'apps/example/scripts'), { recursive: true })
    await writeFile(join(root, path), content)
    expect(parseProductSourceReference(`${path}:1-5`)?.path).toBe(path)
    expect(findProductSourceReferences(`Inspect ${path}:1-5 for the change.`)[0]?.path).toBe(path)
    const document = await readProductSource(path, root)
    expect(document.content).toBe(content)
    expect(document.kind).toBe('source')
    expect(parseProductSourceReference('apps/example/scripts/method.dylib')).toBeNull()
    expect(parseProductSourceReference('apps/example/.env/method.patch')).toBeNull()
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('explicit product root rejects parent symlinks escaping corpus and oversized sources', async () => {
  const fixture=await mkdtemp(join(tmpdir(),'knowledge-source-'))
  const root=join(fixture,'product')
  try {
    await mkdir(join(root,'apps/example'),{recursive:true})
    await mkdir(join(fixture,'outside'))
    await writeFile(join(fixture,'outside/private.ts'),'outside source')
    await symlink(join(fixture,'outside'),join(root,'apps/example/src'))
    await expect(readProductSource('apps/example/src/private.ts',root)).rejects.toThrow('outside')
    await writeFile(join(root,'README.md'),'x'.repeat(MAX_PRODUCT_SOURCE_BYTES+1))
    await expect(readProductSource('README.md',root)).rejects.toThrow('inline inspection')
  } finally {await rm(fixture,{recursive:true,force:true})}
})
