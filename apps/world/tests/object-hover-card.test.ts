import { describe, expect, test } from 'bun:test'
import { objectHoverCardHtml } from '../src/ui/map/object-hover-card.ts'
import { scenarios } from './fixtures/scenarios.ts'

const unit = scenarios.find(scenario => scenario.id === 'test-plant')?.initialObjects.find(object => object.packId === 'process-plant')
if (unit === undefined) throw new Error('the Plant fixture has no Plant')

describe('the map\'s hover card', () => {
  const presentation = { categoryId: 'plants', icon: 'factory', color: '#22845d', summary: '', fields: [{ key: 'model', label: 'Model', value: 'pwr' }] }

  test('an object with a glance shows its glance lines instead of every field; without one, the fields as before', () => {
    const glanced = objectHoverCardHtml({ object: unit, presentation: { ...presentation, glance: ['Normal · Power operation', 'Core thermal power 3400 MW'] }, hasNewInfo: false, targetPreview: null })
    expect(glanced).toBe(`<strong>${unit.label}</strong><div>Normal · Power operation</div><div>Core thermal power 3400 MW</div>`)
    expect(objectHoverCardHtml({ object: unit, presentation, hasNewInfo: false, targetPreview: null })).toBe(`<strong>${unit.label}</strong><div>Model: pwr</div>`)
  })

  test('an order preview still leads the glance', () => {
    const html = objectHoverCardHtml({ object: unit, presentation: { ...presentation, glance: ['Normal'] }, hasNewInfo: false, targetPreview: { text: 'Send D-1 to Halden Unit 1', refused: false } })
    expect(html).toBe(`<strong>${unit.label}</strong><div class="hover-target-preview">Send D-1 to Halden Unit 1</div><div>Normal</div>`)
  })
})
