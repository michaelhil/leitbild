import { describe, expect, test } from 'bun:test'
import { createMapDiagnostics } from '../src/ui/map-runtime/map-diagnostics.ts'

describe('MapDiagnostics', () => {
  test('keeps runtime and reference phases in the canonical snapshot', () => {
    let nowMs = 100
    const diagnostics = createMapDiagnostics(() => nowMs)

    diagnostics.start('reference', 'Registering reference layers', [
      { label: 'Datasets', value: '1' },
    ])
    nowMs = 125
    diagnostics.ready('reference', 'Reference layers registered', [
      { label: 'Layers', value: '12' },
    ])
    nowMs = 140
    diagnostics.fail('runtime', {
      phase: 'runtime',
      message: 'WebGL context did not recover',
      recoverable: false,
    })

    const snapshot = diagnostics.snapshot()
    const reference = snapshot.phases.find(phase => phase.phase === 'reference')
    const runtime = snapshot.phases.find(phase => phase.phase === 'runtime')

    expect(reference?.status).toBe('ready')
    expect(reference?.message).toBe('Reference layers registered')
    expect(reference?.details).toEqual([{ label: 'Layers', value: '12' }])
    expect(runtime?.status).toBe('failed')
    expect(snapshot.latestError?.message).toBe('WebGL context did not recover')
  })
})
