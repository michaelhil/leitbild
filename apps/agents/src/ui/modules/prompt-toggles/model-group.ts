// Model group — temperature, history limit, thinking toggle. No master
// checkbox — model settings always apply.

import { createInlineNumberEditor } from '../inline-number.ts'
import { showToast } from '../toast.ts'
import { mkGroup, type GroupDeps } from './shared.ts'
import { REASONING_EFFORTS, type ReasoningEffort } from '../../../core/types/llm.ts'
import type { ModelInfo } from '../../../core/types/model-info.ts'

/** Only provider-advertised choices; no model-name inference or default mutation. */
export const reasoningEffortChoices = (info?: ModelInfo): ReadonlyArray<ReasoningEffort> => {
  const supported = info?.reasoning?.supportedEfforts
  if (supported === undefined) return []
  const choices = supported === null ? REASONING_EFFORTS : supported
  return choices.filter((effort): effort is ReasoningEffort =>
    REASONING_EFFORTS.some(known => known === effort) && !(info?.reasoning?.mandatory && effort === 'none'))
}

export const buildModelGroup = (deps: Pick<GroupDeps, 'agentData' | 'patchAgent'>): HTMLElement => {
  const { agentData, patchAgent } = deps
  const temperature = agentData.temperature as number | undefined
  const historyLimit = agentData.historyLimit as number | undefined
  const thinking = (agentData.thinking as boolean) ?? false

  const modelRows: HTMLElement[] = []

  const tempRow = createInlineNumberEditor({
    label: 'temp',
    value: String(temperature ?? 'default'),
    tooltip: 'Temperature — controls randomness',
    step: '0.1',
    onSave: async (v) => {
      const patch = v === '' ? { temperature: undefined } : { temperature: Number(v) }
      await patchAgent(patch)
      ;(agentData as Record<string, unknown>).temperature = v === '' ? undefined : Number(v)
    },
  })
  modelRows.push(tempRow)

  const histRow = createInlineNumberEditor({
    label: 'history',
    value: String(historyLimit ?? 'default'),
    tooltip: 'History limit — max messages',
    step: '1',
    onSave: async (v) => {
      const patch = v === '' ? { historyLimit: undefined } : { historyLimit: Number(v) }
      await patchAgent(patch)
      ;(agentData as Record<string, unknown>).historyLimit = v === '' ? undefined : Number(v)
    },
  })
  modelRows.push(histRow)

  const replayRow = document.createElement('label')
  replayRow.className = 'flex flex-col gap-1 text-xs text-text-subtle'
  replayRow.textContent = 'History replay target (tokens)'
  replayRow.title = 'Prior-history working target only. Default 64,000; not a hard model capacity or current-turn tool-evidence cap. Clear to restore the default.'
  const replayInput = document.createElement('input')
  replayInput.type = 'number'
  replayInput.min = '1'
  replayInput.step = '1'
  replayInput.placeholder = 'Default (64,000)'
  replayInput.className = 'border rounded px-1 py-0.5 text-text bg-surface'
  replayInput.value = agentData.historyTokenBudget === undefined ? '' : String(agentData.historyTokenBudget)
  replayInput.onchange = async () => {
    const previous = agentData.historyTokenBudget
    const value = replayInput.value.trim() === '' ? null : Number(replayInput.value)
    try {
      if (value !== null && (!Number.isSafeInteger(value) || value <= 0)) throw new Error('History replay target must be a positive integer')
      await patchAgent({ historyTokenBudget: value })
      agentData.historyTokenBudget = value ?? undefined
    } catch (error) {
      replayInput.value = previous === undefined ? '' : String(previous)
      showToast(document.body, error instanceof Error ? error.message : 'History replay target was not saved', { type: 'error', position: 'fixed' })
    }
  }
  replayRow.appendChild(replayInput)
  modelRows.push(replayRow)

  const effortRow = document.createElement('label')
  effortRow.className = 'flex flex-col gap-1 text-xs text-text-subtle'
  const info = agentData.modelInfo
  effortRow.textContent = `Reasoning effort${info ? ` — ${info.provider}` : ''}`
  effortRow.title = 'Requested effort, validated by the actual provider route. Provider default sends no override. Independent of Ollama thinking.'
  const effortSelect = document.createElement('select')
  effortSelect.className = 'border rounded px-1 py-0.5 text-text bg-surface'
  const addChoice = (value: string, label: string, disabled = false): void => {
    const option = document.createElement('option')
    option.value = value
    option.textContent = label
    option.disabled = disabled
    effortSelect.appendChild(option)
  }
  addChoice('', `Provider default${info?.reasoning?.defaultEffort ? ` (${info.reasoning.defaultEffort})` : ''}`)
  const choices = reasoningEffortChoices(info)
  for (const effort of choices) addChoice(effort, effort)
  const savedEffort = typeof agentData.reasoningEffort === 'string' ? agentData.reasoningEffort : ''
  if (savedEffort && !choices.some(effort => effort === savedEffort)) addChoice(savedEffort, `${savedEffort} (saved; support not advertised)`, true)
  effortSelect.value = savedEffort
  effortSelect.onchange = async () => {
    const previous = typeof agentData.reasoningEffort === 'string' ? agentData.reasoningEffort : ''
    try {
      const value = effortSelect.value || null
      await patchAgent({ reasoningEffort: value })
      agentData.reasoningEffort = value ?? undefined
    } catch (error) {
      effortSelect.value = previous
      showToast(document.body, error instanceof Error ? error.message : 'Reasoning effort was not saved', { type: 'error', position: 'fixed' })
    }
  }
  effortRow.appendChild(effortSelect)
  if (choices.length === 0 || agentData.modelInfoError) {
    const note = document.createElement('span')
    note.textContent = agentData.modelInfoError ?? 'No effort choices advertised for this route. A saved override can still be cleared.'
    effortRow.appendChild(note)
  }
  modelRows.push(effortRow)

  const thinkRow = document.createElement('label')
  thinkRow.className = 'inline-flex items-center gap-1 cursor-pointer text-xs text-text-subtle'
  const thinkCb = document.createElement('input')
  thinkCb.type = 'checkbox'
  thinkCb.className = 'rounded'
  thinkCb.checked = thinking
  thinkCb.onchange = async () => {
    try {
      await patchAgent({ thinking: thinkCb.checked })
      agentData.thinking = thinkCb.checked
      showToast(document.body, `Ollama thinking ${thinkCb.checked ? 'on' : 'off'}`, { position: 'fixed' })
    } catch (error) {
      thinkCb.checked = (agentData.thinking as boolean) ?? false
      showToast(document.body, error instanceof Error ? error.message : 'Thinking setting was not saved', { type: 'error', position: 'fixed' })
    }
  }
  const thinkText = document.createElement('span')
  thinkText.textContent = 'Ollama thinking'
  thinkRow.appendChild(thinkCb)
  thinkRow.appendChild(thinkText)
  modelRows.push(thinkRow)

  return mkGroup({
    label: 'Model',
    children: modelRows,
  })
}
