import { describe, expect, test } from 'bun:test'
import { BRAND_TITLE, openSubjectTitle, pageTitle, withUnreadCount, workspacePageTitle } from './page-title.ts'

describe('tab titles', () => {
  test('end in " · Leitbild.ai"', () => {
    expect(BRAND_TITLE).toBe('Leitbild.ai')
    expect(pageTitle('Grid study')).toBe('Grid study · Leitbild.ai')
    expect(pageTitle('  Halden: loss of offsite power ')).toBe('Halden: loss of offsite power · Leitbild.ai')
  })

  test('show the brand alone while nothing is known', () => {
    expect(pageTitle(null)).toBe('Leitbild.ai')
    expect(pageTitle(undefined)).toBe('Leitbild.ai')
    expect(pageTitle('   ')).toBe('Leitbild.ai')
  })

  test('name the open Run, else the open conversation, else the Workspace', () => {
    expect(workspacePageTitle({ workspace: 'Grid study', run: 'Nordland corridor', room: 'Assistance' })).toBe('Nordland corridor · Leitbild.ai')
    expect(workspacePageTitle({ workspace: 'Grid study', run: null, room: 'Getting started question' })).toBe('Getting started question · Leitbild.ai')
    expect(workspacePageTitle({ workspace: 'Untitled Workspace · b56b1d' })).toBe('Untitled Workspace · b56b1d · Leitbild.ai')
    expect(workspacePageTitle({ workspace: null })).toBe('Leitbild.ai')
  })

  test('beside a Run its plans come first, then the Run; Planning alone is named as before', () => {
    const open = { runSelected: true, run: 'Halden normal operation', planning: true, plan: null }
    expect(openSubjectTitle(open)).toBe('Plans · Halden normal operation')
    expect(openSubjectTitle({ ...open, plan: 'Train A outage' })).toBe('Train A outage · Halden normal operation')
    expect(workspacePageTitle({ workspace: 'Grid study', run: openSubjectTitle({ ...open, plan: 'Train A outage' }) })).toBe('Train A outage · Halden normal operation · Leitbild.ai')
    // The Run not listed yet: its plans alone.
    expect(openSubjectTitle({ ...open, run: null })).toBe('Plans')
    expect(openSubjectTitle({ ...open, planning: false })).toBe('Halden normal operation')
    expect(openSubjectTitle({ runSelected: false, run: null, planning: true, plan: null })).toBe('Planning')
    expect(openSubjectTitle({ runSelected: false, run: null, planning: true, plan: 'Week 47' })).toBe('Week 47')
    expect(openSubjectTitle({ runSelected: false, run: null, planning: false, plan: null })).toBeNull()
  })

  test('never use the old " · Leitbild" suffix', () => {
    for (const title of [pageTitle('Run'), workspacePageTitle({ workspace: 'W' })]) expect(title).not.toMatch(/· Leitbild$/)
  })

  test('lead with the unread direct-message count, and only when there is one', () => {
    expect(withUnreadCount('PWR 4-loop · Leitbild.ai', 3)).toBe('(3) PWR 4-loop · Leitbild.ai')
    expect(withUnreadCount('PWR 4-loop · Leitbild.ai', 0)).toBe('PWR 4-loop · Leitbild.ai')
  })
})
