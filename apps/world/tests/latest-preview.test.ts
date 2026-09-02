import { expect, test } from 'bun:test'
import { createLatestPreview } from '../src/ui/latest-preview.ts'

test('preview runs only one request and retains only the latest pending input', async () => {
  const pending: Array<(value: number) => void> = []
  const started: number[] = []
  const shown: number[] = []
  const queue = createLatestPreview({ delayMs: 0,
    run: (input: number) => { started.push(input); return new Promise<number>(resolve => pending.push(resolve)) },
    success: value => shown.push(value), failure: () => { throw new Error('unexpected failure') },
  })
  queue.schedule(1)
  await Bun.sleep(5)
  queue.schedule(2)
  queue.schedule(3)
  await Bun.sleep(5)
  expect(started).toEqual([1])
  pending[0]!(1)
  await Bun.sleep(5)
  expect(started).toEqual([1, 3])
  expect(shown).toEqual([])
  pending[1]!(3)
  await Bun.sleep(5)
  expect(shown).toEqual([3])
  queue.dispose()
})

test('cancel and disposal suppress responses from already running requests', async () => {
  let complete!: (value: number) => void
  const shown: number[] = []
  const queue = createLatestPreview({ delayMs: 0, run: () => new Promise<number>(resolve => { complete = resolve }), success: value => shown.push(value), failure: () => {} })
  queue.schedule(undefined)
  await Bun.sleep(5)
  queue.cancel()
  complete(1)
  await Bun.sleep(5)
  expect(shown).toEqual([])
  queue.dispose()
})
