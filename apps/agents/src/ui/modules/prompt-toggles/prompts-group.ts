// Prompts group — persona, room prompt, system prompt, response format, skills.
// Each row has a magnifier that opens the preview modal (or scrolls the
// persona textarea into view for the persona row).

import { openPreviewModal as openModal } from '../modals/detail-modal.ts'
import {
  mkToggleRow, mkGroup, sectionByKey, PROMPT_KEYS,
  type GroupDeps, type PreviewSection,
} from './shared.ts'

export const buildPromptsGroup = (deps: GroupDeps): HTMLElement => {
  const { preview, agentData, promptTextarea, patchAgent, rerender } = deps
  const get = (k: string): PreviewSection | undefined => sectionByKey(preview, k)
  const includePrompts = (agentData.includePrompts as Record<string, boolean>) ?? {}
  const promptsEnabled = (agentData.promptsEnabled as boolean) ?? true

  const totalTokens = PROMPT_KEYS.reduce((s, p) => s + (get(p.section)?.tokens ?? 0), 0)

  const rows: HTMLElement[] = PROMPT_KEYS.map(p => {
    const sec = get(p.section)
    return mkToggleRow(
      p.label,
      includePrompts[p.code] ?? true,
      sec?.tokens ?? 0,
      async (next) => {
        (agentData as Record<string, unknown>).includePrompts = { ...includePrompts, [p.code]: next }
        await patchAgent({ includePrompts: { [p.code]: next } })
        await rerender()
      },
      p.code === 'persona'
        ? () => {
            promptTextarea.scrollIntoView({ behavior: 'smooth', block: 'center' })
            promptTextarea.classList.add('ring-2', 'ring-blue-400')
            setTimeout(() => promptTextarea.classList.remove('ring-2', 'ring-blue-400'), 1500)
          }
        : () => openModal(`${p.label}${p.code === 'room' ? ` — "${preview.roomName}"` : ''}`, sec?.text ?? '', sec?.tokens ?? 0),
    )
  })

  const registeredSkills = agentData.registeredSkills ?? []
  const selectedSkills = new Set(agentData.skills ?? [])
  if (registeredSkills.length > 0) {
    const fold = document.createElement('details')
    fold.className = 'mt-1'
    fold.setAttribute('data-group-child-label', '')
    const summary = document.createElement('summary')
    summary.className = 'cursor-pointer text-text-subtle hover:text-text list-none select-none'
    summary.textContent = `${selectedSkills.size}/${registeredSkills.length} skills ▾`
    fold.appendChild(summary)
    const list = document.createElement('div')
    list.className = 'mt-1 space-y-0.5 max-h-32 overflow-y-auto pl-2'
    for (const name of registeredSkills) {
      const row = document.createElement('label')
      row.className = 'flex items-center gap-1 w-full'
      row.setAttribute('data-group-child-label', '')
      const checkbox = document.createElement('input')
      checkbox.type = 'checkbox'
      checkbox.className = 'rounded'
      checkbox.checked = selectedSkills.has(name)
      checkbox.setAttribute('data-group-child', '')
      const label = document.createElement('span')
      label.className = 'font-mono'
      label.textContent = name
      checkbox.onchange = async () => {
        const next = checkbox.checked
          ? [...selectedSkills, name]
          : [...selectedSkills].filter(skill => skill !== name)
        agentData.skills = next
        await patchAgent({ skills: next })
        await rerender()
      }
      row.append(checkbox, label)
      list.appendChild(row)
    }
    fold.appendChild(list)
    rows.push(fold)
  }

  return mkGroup({
    label: 'Prompts',
    master: {
      checked: promptsEnabled,
      onChange: async (next) => {
        (agentData as Record<string, unknown>).promptsEnabled = next
        await patchAgent({ promptsEnabled: next })
        await rerender()
      },
    },
    totalTokens,
    children: rows,
  })
}
