import { expect, test } from 'bun:test'
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readProductSource, MAX_PRODUCT_SOURCE_BYTES } from './source.ts'

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
