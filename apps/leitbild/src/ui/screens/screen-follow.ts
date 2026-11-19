// What a screen window (`screen=<id>`) shows. One pure decision, taken on
// page load before the Workspace page reads its address, and again whenever
// another window of this browser changes the stored target or setup.
//
// The rule it keeps: stored browser state never selects or overrides the
// Workspace of a page. The stored target may name another Workspace, and then
// - on page load the window stays in the Workspace of its path and says where
//   the screens are now, with one link (Standby);
// - on a `storage` event, which is the direct result of the person's press in
//   another window, it asks to navigate to the canonical address there. The
//   caller checks that Workspace exists first.
// Inside the page's own Workspace the target selects the Run and this
// screen's content in the page. With no target at all (a link opened on
// another device) the window shows what its address says.

import { workspaceUrl } from '../launch-destination.ts'
import { contentFor, screenUrl, type ScreenSetup, type ScreenTarget, type Stored } from './screen-setup.ts'

export type FollowTrigger = 'load' | 'storage'

/** What the window's own address selects. */
export interface ScreenAddressSelection {
  readonly world: string | null
  readonly surface: string | null
  readonly planning: string | null
}

export type StandbyReason =
  | { readonly kind: 'unassigned'; readonly definition: string }
  /** The screens show a Run in another Workspace; `problem` says why this window could not go there itself. */
  | { readonly kind: 'elsewhere'; readonly href: string; readonly problem: string | null }
  | { readonly kind: 'unreadable'; readonly what: 'target' | 'setup'; readonly detail: string }
  // The two below are the page's own findings, once it has read the Workspace's Runs.
  | { readonly kind: 'run-gone' }
  | { readonly kind: 'no-run' }

export type ScreenShow =
  /** The address as it is. `following` is false when this browser's storage is unavailable. */
  | { readonly kind: 'address'; readonly following: boolean }
  | { readonly kind: 'select'; readonly runId: string; readonly surface: string | null; readonly definition: string }
  | { readonly kind: 'standby'; readonly reason: StandbyReason }
  | { readonly kind: 'navigate'; readonly workspaceId: string; readonly href: string }

export const screenShows = (input: {
  readonly screenId: string
  /** The Workspace in the page's path. */
  readonly workspaceId: string
  readonly address: ScreenAddressSelection
  readonly target: Stored<ScreenTarget>
  readonly setup: Stored<ScreenSetup>
  readonly trigger: FollowTrigger
}): ScreenShow => {
  const { screenId, workspaceId, address, target, setup, trigger } = input
  if (target.status === 'unavailable') return { kind: 'address', following: false }
  if (target.status === 'absent') return { kind: 'address', following: true }
  if (target.status === 'unreadable') return { kind: 'standby', reason: { kind: 'unreadable', what: 'target', detail: target.reason } }
  if (setup.status === 'unavailable') return { kind: 'address', following: false }
  if (setup.status === 'unreadable') return { kind: 'standby', reason: { kind: 'unreadable', what: 'setup', detail: setup.reason } }

  const { runId, definition } = target.value
  const content = setup.status === 'ok' ? contentFor(setup.value, definition, screenId) : null
  if (target.value.workspaceId !== workspaceId) {
    const href = screenUrl(target.value.workspaceId, screenId, content === null ? null : { runId, content })
    return trigger === 'load'
      ? { kind: 'standby', reason: { kind: 'elsewhere', href, problem: null } }
      : { kind: 'navigate', workspaceId: target.value.workspaceId, href }
  }
  if (content === null) return { kind: 'standby', reason: { kind: 'unassigned', definition } }
  const surface = content.kind === 'surface' ? content.surface : null
  if (address.planning === null && address.world === runId && address.surface === surface) return { kind: 'address', following: true }
  return { kind: 'select', runId, surface, definition }
}

/**
 * The canonical address of what the window now shows, or null when its
 * address stays as it is. A selected Run keeps the conversation beside it; a
 * screen with nothing to show names no Run, so it joins none.
 */
export const screenAddress = (show: ScreenShow, page: { readonly workspaceId: string; readonly screenId: string; readonly agents: string | null }): string | null => {
  if (show.kind === 'select') return workspaceUrl(page.workspaceId, { world: show.runId, surface: show.surface, agents: page.agents, screen: page.screenId })
  if (show.kind === 'standby' && (show.reason.kind === 'unassigned' || show.reason.kind === 'elsewhere')) return workspaceUrl(page.workspaceId, { screen: page.screenId })
  return null
}

export interface StandbyText {
  readonly why: string
  readonly link: { readonly href: string; readonly label: string } | null
}

export const standbyText = (reason: StandbyReason, scenario: (definition: string) => string): StandbyText => {
  switch (reason.kind) {
    case 'unassigned': return { why: `Nothing assigned for ${scenario(reason.definition)}`, link: null }
    case 'run-gone': return { why: 'Its Run no longer exists', link: null }
    case 'no-run': return { why: 'This address names no Run', link: null }
    case 'elsewhere': return {
      why: reason.problem === null
        ? 'The screens now show a Run in another Workspace'
        : `The screens now show a Run in another Workspace. This window could not go there by itself: ${reason.problem}`,
      link: { href: reason.href, label: 'Open it on this screen' },
    }
    case 'unreadable': return {
      why: `This browser's stored ${reason.what === 'target' ? 'record of what the screens show' : 'screen setup'} cannot be read (${reason.detail}). Open Screens… in the main window to reset it.`,
      link: null,
    }
  }
}

export const NOT_FOLLOWING_TEXT = 'This browser offers no storage here, so this screen does not follow the others.'
