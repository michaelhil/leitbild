import { expect, test } from 'bun:test'
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeAtomic } from '../src/core/storage/atomic-write.ts'
import { promoteVectorTiles } from '../scripts/maps/promote-vector-tiles.ts'

test('failed atomic publication cleans only its own temporary file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'atomic-publication-'))
  try {
    await mkdir(join(dir, 'target'))
    await expect(writeAtomic(join(dir, 'target'), 'cannot replace a directory')).rejects.toThrow()
    expect(await readdir(dir)).toEqual(['target'])
    await writeAtomic(join(dir, 'state.json'), '{"saved":true}')
    expect(await readFile(join(dir, 'state.json'), 'utf8')).toBe('{"saved":true}')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('map promotion replaces only a symlink and preserves the current release after validation failure', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'map-publication-'))
  try {
    for (const id of ['one', 'two']) {
      const release = join(dir, 'releases', id)
      await mkdir(release, { recursive: true })
      for (const name of ['norway.pmtiles', 'capabilities.json', 'style.json']) await writeFile(join(release, name), id)
    }
    await promoteVectorTiles(dir, join(dir, 'releases', 'one'))
    await promoteVectorTiles(dir, join(dir, 'releases', 'two'))
    expect(await realpath(join(dir, 'current'))).toBe(await realpath(join(dir, 'releases', 'two')))
    await expect(promoteVectorTiles(dir, join(dir, 'releases', 'missing'))).rejects.toThrow()
    expect(await readFile(join(dir, 'current', 'style.json'), 'utf8')).toBe('two')
    await rm(join(dir, 'current'))
    await mkdir(join(dir, 'current'))
    await expect(promoteVectorTiles(dir, join(dir, 'releases', 'one'))).rejects.toThrow('refusing to replace data')
    expect((await readdir(dir)).some(name => name.endsWith('.next'))).toBe(false)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
