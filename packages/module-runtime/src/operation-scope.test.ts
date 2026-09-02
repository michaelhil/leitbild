import { expect, test } from 'bun:test'
import { createOperationScope } from './operation-scope.ts'

test('closing drains concurrent accepted work and rejects late work', async () => {
  const scope = createOperationScope('Workspace')
  const first = scope.acquire(), second = scope.acquire()
  let closed = false
  const closing = scope.close().then(() => { closed = true })
  await expect(scope.run(async () => 1)).rejects.toThrow('closing')
  first(); first()
  await Promise.resolve()
  expect(closed).toBe(false)
  expect(scope.activeCount()).toBe(1)
  second()
  await closing
  expect(closed).toBe(true)
  expect(scope.activeCount()).toBe(0)
})

test('failed operations release their ownership', async () => {
  const scope = createOperationScope('Workspace')
  await expect(scope.run(async () => { throw new Error('failed') })).rejects.toThrow('failed')
  await scope.close()
  expect(scope.activeCount()).toBe(0)
})
