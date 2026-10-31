import { expect, test } from 'bun:test'
import { createGridAssetRequestOrder } from './asset-request-order.ts'

const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

test('a Grid revision refresh wins while the selected detail is still loading', async () => {
  const view = { run: 'run-a', grid: 'grid-a', revision: 1, selected: 'hydro-a' }
  const requests = createGridAssetRequestOrder(() => JSON.stringify(view))
  const old = deferred<string>(), fresh = deferred<string>()
  let shown: string | null = null
  const load = async (result: Promise<string>) => {
    const request = requests.begin()
    const value = await result
    if (request.current()) shown = value
  }
  const beforeTrip = load(old.promise)
  expect(shown).toBeNull()
  // An Agent or another person's accepted command arrives through the same Grid revision.
  view.revision++
  const afterTrip = load(fresh.promise)
  fresh.resolve('tripped'); await afterTrip
  old.resolve('online'); await beforeTrip
  expect(shown as string | null).toBe('tripped')
  expect(view.selected).toBe('hydro-a')
})

test('A → B → A and same-asset refreshes reject older successes and errors', () => {
  let selection = 'A'
  const requests = createGridAssetRequestOrder(() => selection)
  const firstA = requests.begin()
  selection = 'B'; const b = requests.begin()
  selection = 'A'; const latestA = requests.begin()
  expect(firstA.current()).toBe(false)
  expect(b.current()).toBe(false)
  expect(latestA.current()).toBe(true)
  const refreshedA = requests.begin()
  expect(latestA.current()).toBe(false)
  expect(refreshedA.current()).toBe(true)
})

test('Run, Grid, filter and page changes retire results before the next request starts', () => {
  for (const field of ['run', 'grid', 'text', 'kind', 'offset'] as const) {
    const view = { run: 'run-a', grid: 'grid-a', text: 'hydro', kind: 'generator', offset: '40' }
    const requests = createGridAssetRequestOrder(() => JSON.stringify(view))
    const old = requests.begin()
    view[field] = 'changed'
    expect(old.current()).toBe(false)
    // A refresh does not reset the caller's search, page or selection.
    const expected = structuredClone(view)
    expect(requests.begin().current()).toBe(true)
    expect(view).toEqual(expected)
  }
})

test('closing an asset browser retires its pending result', () => {
  const requests = createGridAssetRequestOrder(() => 'same asset')
  const pending = requests.begin()
  requests.dispose()
  expect(pending.current()).toBe(false)
})
