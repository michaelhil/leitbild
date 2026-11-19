// The library's cards: a plan that planning.plan.create starts on its own has a Start button; a guided plan,
// which create refuses without its World demo run, links to that demo instead.
import { describe, expect, test } from 'bun:test'
import type { Component } from 'svelte'
import { workspaceIdSchema, type ModuleDefinitionDescriptor } from '@leitbild/contracts'
import { bundledPlanDefinitions, createPlanDefinitions, definitionDescriptors, guidedPlanDefinitionIds } from '../definitions/index.ts'
import { createPlanningClient } from './api.ts'
import { readableText, registerSvelte, renderHtml } from './fixtures/svelte-ssr.ts'

registerSvelte()
type Any = Component<Record<string, unknown>>
const { default: Library } = await import('./Library.svelte') as { default: Any }

const workspace = workspaceIdSchema.parse('0b4b9a52-2f7e-4c1a-9d3e-00000000000a')
const offline = createPlanningClient(workspace, async () => { throw new Error('No Host in a render test') })
// The descriptors Planning publishes for its bundled Definitions.
const published = definitionDescriptors(workspace, createPlanDefinitions(), ['planning.plan.create'])

const cardsOf = (definitions: readonly ModuleDefinitionDescriptor[]): readonly string[] =>
  [...renderHtml(Library, { client: offline, onOpen: () => {}, initialDefinitions: definitions }).matchAll(/<article class="demo-card[^"]*">([\s\S]*?)<\/article>/g)].map(match => match[1]!)
const cardOf = (cards: readonly string[], definition: ModuleDefinitionDescriptor): string => {
  const found = cards.filter(card => readableText(card).includes(definition.title))
  expect(found).toHaveLength(1)
  return found[0]!
}
const buttons = (card: string): readonly string[] => [...card.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map(match => readableText(match[1]!).trim())
const links = (card: string): readonly { href: string; text: string }[] =>
  [...card.matchAll(/<a [^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g)].map(match => ({ href: match[1]!, text: readableText(match[2]!).trim() }))

describe('the library cards', () => {
  test('a guided plan has no Start button: its card links to its World demo', () => {
    const cards = cardsOf(published)
    const guided = published.filter(definition => guidedPlanDefinitionIds.has(definition.ref.id))
    expect(guided.map(definition => String(definition.ref.id))).toEqual(['nuclear-maintenance-planning', 'halden-delivery-planning'])
    for (const definition of guided) {
      const card = cardOf(cards, definition)
      expect(buttons(card)).toEqual([])
      expect(links(card)).toEqual([{ href: `/workspaces?demos=world%3A${definition.ref.id}`, text: 'Open World demo' }])
    }
  })

  test('a plan that starts on its own keeps its Start button, and the blank plan its New plan button', () => {
    const cards = cardsOf(published)
    expect(cards).toHaveLength(published.length)
    const startable = published.filter(definition => definition.ref.id !== 'blank' && !guidedPlanDefinitionIds.has(definition.ref.id))
    expect(startable.map(definition => String(definition.ref.id))).toEqual(['train-a-work-week', 'supply-run'])
    for (const definition of startable) {
      const card = cardOf(cards, definition)
      expect(buttons(card)).toEqual(['Start this plan'])
      expect(links(card)).toEqual([])
    }
    const blank = cardOf(cards, published.find(definition => definition.ref.id === 'blank')!)
    expect(buttons(blank)).toEqual(['New plan'])
    expect(links(blank)).toEqual([])
  })

  test('the card follows the published primary action, not a Definition id', () => {
    const trainA = published.find(definition => definition.ref.id === 'train-a-work-week')!
    const { primaryCapabilityId, ...withoutPrimary } = trainA
    expect(String(primaryCapabilityId)).toBe('planning.plan.create')
    expect(buttons(cardOf(cardsOf([withoutPrimary]), withoutPrimary))).toEqual([])
    const maintenance = published.find(definition => definition.ref.id === 'nuclear-maintenance-planning')!
    expect(maintenance.primaryCapabilityId).toBeUndefined()
    const withPrimary = { ...maintenance, primaryCapabilityId: primaryCapabilityId! }
    expect(buttons(cardOf(cardsOf([withPrimary]), withPrimary))).toEqual(['Start this plan'])
  })

  test('each guided plan names a World Scenario with its own id, which the card\'s demo link relies on', () => {
    for (const definition of bundledPlanDefinitions.filter(entry => guidedPlanDefinitionIds.has(entry.id))) {
      expect(definition.inputs.settings.scenario?.id).toBe(definition.id)
    }
  })
})
