import { expect, test, spyOn } from 'bun:test'
import { createCollector } from './collector.ts'
import { openRecordStore } from './store.ts'
import { situationSourceSchema } from '../model.ts'

const source = (id: string) => situationSourceSchema.parse({ id, name: id, adapter: 'rss', url: `https://${id}.example.org/feed` })
const body = '<rss><channel><item><guid>1</guid><title>Test evidence</title></item></channel></rss>'
test('retry deadlines survive the last lease closing, including empty/error-only collections', async () => {
  const store = openRecordStore(':memory:'); let calls = 0
  const collector = createCollector(store, async () => { calls++; return { status: 429, text: '', headers: { 'retry-after': '3600' } } })
  const first = collector.acquire(source('retry'), () => {})
  await Bun.sleep(20)
  const deadline = first.status().nextAttemptAt
  expect(first.status().state).toBe('error')
  await first.release(); store.cleanup(Date.now(), true)
  const second = collector.acquire(source('retry'), () => {})
  try { await Bun.sleep(1100); expect(calls).toBe(1); expect(second.status().nextAttemptAt).toBe(deadline); expect(second.status().error).toBe('Provider HTTP 429') }
  finally { await second.release(); await collector.close() }
})
test('empty snapshots remain conditional cache hits; unchanged data emits no map invalidation', async () => {
  const store = openRecordStore(':memory:'); let changes = 0, etag: string | undefined
  const collector = createCollector(store, async (_url, options) => { etag = options?.etag; return { status: 304, text: '', headers: {} } })
  const item = source('empty')
  const { collectionKey } = await import('./collector.ts'), key = collectionKey(item)
  store.replace(key, [], 1); store.setMetadata(key, { etag: 'empty-v1', lastSuccessAt: new Date().toISOString() })
  store.cleanup(Date.now(), true)
  const lease = collector.acquire(item, () => { changes++ })
  try { await Bun.sleep(20); expect(etag).toBe('empty-v1'); expect(lease.status().state).toBe('ready'); expect(store.hasSnapshot(key)).toBe(true); expect(changes).toBe(0) }
  finally { await lease.release(); await collector.close() }
})
test('subscriber failures do not break other subscribers or leak collector capacity', async () => {
  const log = spyOn(console, 'error').mockImplementation(() => {})
  const store = openRecordStore(':memory:'); let changes = 0
  const collector = createCollector(store, async () => ({ status: 200, text: body, headers: {} }))
  const first = collector.acquire(source('subscriber'), () => { throw new Error('test subscriber failure') })
  const second = collector.acquire(source('subscriber'), () => { changes++ })
  try { await Bun.sleep(20); expect(changes).toBe(1); expect(log).toHaveBeenCalledTimes(1); expect(first.status().state).toBe('ready') }
  finally { await first.release(); await second.release(); await collector.close(); log.mockRestore() }
})
test('shared media identity does not depend on the first local source name or ID', async () => {
  const store = openRecordStore(':memory:')
  const collector = createCollector(store, async () => { throw new Error('Configured media must not fetch on the server') })
  const item = situationSourceSchema.parse({ id: 'media-a', name: 'A', adapter: 'media', format: 'image', url: 'https://media.example.org/view.jpg' })
  const first = collector.acquire(item, () => {}), second = collector.acquire({ ...item, id: 'media-b', name: 'B' }, () => {})
  try { await Bun.sleep(20); expect(first.key).toBe(second.key); expect(first.status().recordCount).toBe(1); expect(first.status().state).toBe('ready') }
  finally { await first.release(); await second.release(); await collector.close() }
})

test('polling follows the fastest current subscriber and recomputes after the final lease reopens', async () => {
  const store = openRecordStore(':memory:')
  let calls = 0
  const collector = createCollector(store, async () => { calls++; return { status: 200, text: body, headers: {} } })
  const item = { ...source('cadence'), intervalSeconds: 86400 }
  const slow = collector.acquire(item, () => {})
  await Bun.sleep(20)
  const fast = collector.acquire({ ...item, id: 'fast', intervalSeconds: 60 }, () => {})
  const delay = () => Date.parse(fast.status().nextAttemptAt!) - Date.parse(fast.status().lastAttemptAt!)
  expect(delay()).toBe(60000)
  await fast.refresh()
  expect(calls).toBe(1) // A shorter interval is not permission to bypass its minimum.
  await fast.release()
  expect(Date.parse(slow.status().nextAttemptAt!) - Date.parse(slow.status().lastAttemptAt!)).toBe(86400000)
  await slow.release()
  const reopened = collector.acquire({ ...item, intervalSeconds: 60 }, () => {})
  try {
    expect(Date.parse(reopened.status().nextAttemptAt!) - Date.parse(reopened.status().lastAttemptAt!)).toBe(60000)
    expect(calls).toBe(1)
  } finally { await reopened.release(); await collector.close() }
})

test('faster subscriptions and reopen preserve provider cache and retry deadlines', async () => {
  for (const status of [200, 429]) {
    const store = openRecordStore(':memory:')
    const collector = createCollector(store, async () => ({ status, text: status === 200 ? body : '', headers: status === 200 ? { 'cache-control': 'max-age=7200' } : { 'retry-after': '7200' } }))
    const item = { ...source('provider-cadence-' + status), intervalSeconds: 86400 }
    const slow = collector.acquire(item, () => {})
    await Bun.sleep(20)
    const fast = collector.acquire({ ...item, id: 'fast', intervalSeconds: 60 }, () => {})
    const deadline = fast.status().nextAttemptAt
    expect(Date.parse(deadline!) - Date.now()).toBeGreaterThan(7199000)
    expect(Date.parse(deadline!) - Date.now()).toBeLessThanOrEqual(7200000)
    await fast.release(); await slow.release()
    const reopened = collector.acquire({ ...item, intervalSeconds: 60 }, () => {})
    try { expect(reopened.status().nextAttemptAt).toBe(deadline) }
    finally { await reopened.release(); await collector.close() }
  }
})
