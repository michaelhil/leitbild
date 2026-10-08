import { mount } from 'svelte'
import { parseEmbeddedViewFragment } from '@leitbild/contracts'
import { configureActiveWorkspace } from '../workspace-context.ts'
import EmbeddedView from './EmbeddedView.svelte'
import './embed.css'

const target = document.getElementById('view')
if (!target) throw new Error('missing #view mount point')

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
  mount(EmbeddedView, { target, props: { envelope } })
} catch (error) {
  // The view cannot start; say so in place instead of showing an empty frame.
  target.className = 'embed-failure'
  target.textContent = `This view cannot be shown: ${error instanceof Error ? error.message : String(error)}`
}
