import { expect, test } from 'bun:test'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStorageBudget } from './storage-budget.ts'

test('aggregate admission includes sibling workspaces and never removes authored content', async () => {
  const root = await mkdtemp(join(tmpdir(), 'storage-budget-'))
  try {
    const a = join(root, 'a'), b = join(root, 'b')
    await mkdir(a); await mkdir(b)
    await writeFile(join(a, 'authored.json'), 'x'.repeat(60))
    const budget = createStorageBudget({ root, maxBytes: 100, maxWorkspaceBytes: 80, minFreeBytes: 0, cacheMs: 0 })
    await expect(budget.withGrowth(b, 50, async () => {})).rejects.toThrow('budget reached')
    await expect(budget.withGrowth(a, 30, async () => {})).rejects.toThrow('budget reached')
    await budget.withGrowth(b, 10, () => writeFile(join(b, 'small'), 'y'.repeat(10)))
    expect((await budget.inspect(b)).rootBytes).toBe(70)
    expect(await readFile(join(a, 'authored.json'), 'utf8')).toBe('x'.repeat(60))
    await expect(budget.inspect(join(root, '..', 'outside'))).rejects.toThrow('outside')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('concurrent reservations cannot each claim the same capacity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'storage-concurrent-'))
  let release!: () => void
  const gate = new Promise<void>(r => { release = r })
  try {
    const budget = createStorageBudget({ root, maxBytes: 100, maxWorkspaceBytes: 100, minFreeBytes: 0, cacheMs: 0 })
    let entered!: () => void
    const started = new Promise<void>(r => { entered = r })
    const first = budget.withGrowth(root, 60, async () => { entered(); await gate })
    await started
    await expect(budget.withGrowth(root, 60, async () => {})).rejects.toThrow('budget reached')
    release(); await first
    expect((await budget.inspect(root)).allowed).toBe(true)
  } finally { release(); await rm(root, { recursive: true, force: true }) }
})
