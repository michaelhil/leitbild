// The library's release line (design §6.5, D8): it says which release this is and what the next one brings,
// in planner words, with no internal names.
import { describe, expect, test } from 'bun:test'
import type { Component } from 'svelte'
import { createPlanningClient } from './api.ts'
import { readableText, registerSvelte, renderHtml } from './fixtures/svelte-ssr.ts'

registerSvelte()
type Any = Component<Record<string, unknown>>
const { default: Library } = await import('./Library.svelte') as { default: Any }
const offline = createPlanningClient('0b4b9a52-2f7e-4c1a-9d3e-00000000000a', async () => { throw new Error('No Host in a render test') })

describe('the release line', () => {
  test('the library says this is release 2 of 3, what it adds, and what release 3 brings', () => {
    const text = readableText(renderHtml(Library, { client: offline, onOpen: () => {} }))
    expect(text).toContain('Release 2 of 3: compare options, see what overtime buys, ask what-ifs and see why one is recommended. Recording progress and replanning after disruptions come in release 3.')
    expect(text).not.toMatch(/increment|Release A|phase|First release/i)
  })
})
