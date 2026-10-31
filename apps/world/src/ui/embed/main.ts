import { mount } from 'svelte'
import { parseEmbeddedViewFragment } from '@leitbild/contracts'
import { configureActiveRoleSet, initialRoleSet, roleSetStorageKey } from '../roles/role-session.ts'
import { configureActiveWorkspace } from '../workspace-context.ts'
import EmbeddedView from './EmbeddedView.svelte'
import './embed.css'

const target = document.getElementById('view')
if (!target) throw new Error('missing #view mount point')

// The embedding page stores the reader's theme choice; follow it live.
// OpenBridge "night" is a dark-adaptation palette; dusk suits a dark screen.
window.addEventListener('storage', event => {
  if (event.key !== 'leitbild.theme') return
  const dark = event.newValue === 'dark' || (event.newValue === null && matchMedia('(prefers-color-scheme: dark)').matches)
  document.documentElement.classList.toggle('dark', dark)
  document.documentElement.dataset.obcTheme = dark ? 'dusk' : 'day'
})

const workspaceFromPath = (): string => {
  const match = location.pathname.match(/^\/workspaces\/([^/]+)\/world\/embed\//)
  if (!match) throw new Error(`Embedded view route is malformed: ${location.pathname}`)
  return decodeURIComponent(match[1]!)
}

try {
  const envelope = parseEmbeddedViewFragment(location.hash)
  const workspaceId = workspaceFromPath()
  if (envelope.subject.workspaceId !== workspaceId) throw new Error('Embedded view subject belongs to another Workspace')
  configureActiveWorkspace(envelope.subject.workspaceId)
  // A Run that declares roles answers only a screen that plays one: a view of it plays this tab's role set, as the
  // World frame that chose it does (role-session.ts: the frame's query, else the tab's stored set).
  if (envelope.subject.type === 'world.simulation-run') configureActiveRoleSet(initialRoleSet({ search: location.search, storage: sessionStorage, key: roleSetStorageKey(workspaceId, envelope.subject.id) }))
  mount(EmbeddedView, { target, props: { envelope } })
} catch (error) {
  // The view cannot start; say so in place instead of showing an empty frame.
  target.className = 'embed-failure'
  target.textContent = `This view cannot be shown: ${error instanceof Error ? error.message : String(error)}`
}
