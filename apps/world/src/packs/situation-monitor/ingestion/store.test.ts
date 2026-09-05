import { expect, test } from 'bun:test'
import { openRecordStore } from './store.ts'
import { externalRecordSchema, recordSearchSchema } from '../model.ts'
const now = '2026-09-03T12:00:00Z'
const record = externalRecordSchema.parse({ id: 'camera', sourceId: 'camera', kind: 'media', title: 'Camera', url: 'https://example.org/', attribution: 'Provider', retrievedAt: now, geometry: { type: 'Point', coordinates: [10,60] } })
test('forecast reduction precedes map limits and keeps independent subjects', () => {
  const store = openRecordStore(':memory:')
  try {
    const forecasts = Array.from({ length: 150 }, (_, index) => ({ ...record, id: String(index), sourceId: 'forecast', kind: 'forecast' as const, subject: { id: 'oslo', label: 'Oslo' }, validAt: new Date(Date.parse(now) + index * 3600000).toISOString() }))
    store.replace('f', forecasts, 1); store.replace('c', [record], 1)
    const result = store.search([{ id: 'forecast', key: 'f' }, { id: 'camera', key: 'c' }], { ...recordSearchSchema.parse({}), limit: 2 }, [], Date.parse(now))
    expect(result.total).toBe(2); expect(result.hasMore).toBe(false); expect(result.records.map(item => item.id).sort()).toEqual(['0','camera'])
    store.replace('f', [...forecasts, { ...forecasts[0]!, id: 'bergen', subject: { id: 'bergen', label: 'Bergen' } }], 1)
    expect(store.search([{ id: 'forecast', key: 'f' }], recordSearchSchema.parse({ subjectId: 'bergen' }), []).total).toBe(1)
    expect(store.search([{ id: 'forecast', key: 'f' }], recordSearchSchema.parse({}), [], Date.parse(now)).total).toBe(2)
  } finally { store.close() }
})
test('expiry hides inspection and search together without deleting retry metadata', () => {
  const store = openRecordStore(':memory:')
  try {
    store.replace('source', [record], 1); store.setMetadata('source', { nextAttemptAt: '2099-01-01T00:00:00Z', error: 'Provider retry' })
    store.cleanup(Date.now() + 3600001, true)
    expect(store.inspect('source', record.id)).toBeNull(); expect(store.count('source')).toBe(0); expect(store.metadata('source').error).toBe('Provider retry')
  } finally { store.close() }
})

test('search matches literal terms across record text without requiring one exact phrase', () => {
  const store = openRecordStore(':memory:')
  try {
    store.replace('source', [{ ...record, title: 'Norway traffic camera', summary: 'E6 road conditions' }], 1)
    expect(store.search(
      [{ id: 'camera', key: 'source' }],
      recordSearchSchema.parse({ text: 'road camera' }),
      [],
    ).records).toHaveLength(1)
  } finally { store.close() }
})
