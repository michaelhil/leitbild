import { assumptionBindings, object, type CalculationReceipt, type SourceStatus } from './model.ts'

const element = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag)
  if (text !== undefined) node.textContent = text
  return node
}
const formatted = (value: unknown): string => typeof value === 'number'
  ? value.toLocaleString(undefined, { maximumSignificantDigits: 8 }) : value === null ? 'Not supplied' : String(value)
const label = (name: string): string => name.replaceAll('_', ' ').replace(/([a-z])([A-Z])/g, '$1 $2')
const table = (headings: ReadonlyArray<string>, rows: ReadonlyArray<ReadonlyArray<unknown>>): HTMLElement => {
  const scroll = element('div'); scroll.className = 'table-scroll'
  const node = element('table'); const head = element('thead'); const tr = element('tr')
  for (const heading of headings) { const cell = element('th', heading); cell.scope = 'col'; tr.append(cell) }
  head.append(tr); node.append(head); const body = element('tbody')
  for (const row of rows) { const line = element('tr'); for (const value of row) line.append(element('td', formatted(value))); body.append(line) }
  node.append(body); scroll.append(node); return scroll
}
const disclosure = (title: string, content: HTMLElement): HTMLElement => {
  const details = element('details'); details.append(element('summary', title), content); return details
}

/** Guest output is data, never a chart specification, markup, URL or script.
 * Uniform object arrays get readable tables; other JSON retains its shape. */
export const renderEngineeringData = (value: unknown, depth = 0): HTMLElement => {
  if (Array.isArray(value)) {
    if (value.length === 0) return element('p', 'No entries were returned.')
    const records = value.map(object)
    if (records.every(item => item !== null) && records.length <= 500) {
      const keys = [...new Set(records.flatMap(item => Object.keys(item!)))]
      if (keys.length <= 16 && records.every(item => Object.values(item!).every(item => item === null || ['number', 'string', 'boolean'].includes(typeof item)))) {
        return table(keys.map(label), records.map(item => keys.map(key => Object.hasOwn(item!, key) ? item![key] : 'Not supplied')))
      }
    }
    return element('pre', JSON.stringify(value, null, 2))
  }
  const record = object(value)
  if (record === null) return element('p', formatted(value))
  if (depth > 3) return element('pre', JSON.stringify(value, null, 2))
  const section = element('div'); section.className = 'data-group'
  for (const [key, item] of Object.entries(record)) {
    if (item !== null && typeof item === 'object') {
      const content = renderEngineeringData(item, depth + 1)
      if (depth === 0) { const child = element('section'); child.append(element('h3', label(key)), content); section.append(child) }
      else section.append(disclosure(label(key), content))
    } else { const line = element('p'); line.append(element('strong', `${label(key)}: `), document.createTextNode(formatted(item))); section.append(line) }
  }
  return section
}

export const renderCalculation = (host: HTMLElement, receipt: CalculationReceipt, statuses: ReadonlyArray<SourceStatus>, handlers: {
  readonly run: (edits: ReadonlyMap<string, string>, refresh: boolean) => void
  readonly original?: () => void
}): void => {
  host.replaceChildren()
  const header = element('header')
  const eyebrow = element('p', `${receipt.mode === 'exploratory-script' ? 'Exploratory program' : 'Reviewed arithmetic method'} · research only`); eyebrow.className = 'eyebrow'
  header.append(eyebrow, element('h1', receipt.title), element('p', `Calculated ${receipt.createdAt}`)); host.append(header)
  const outcome = object(receipt.outcome)
  const failed = outcome?.status === 'failed' || outcome?.status === 'cancelled' || outcome?.success === false
  if (failed) { const failure = element('p', `This attempt ${String(outcome.status ?? 'failed')}. No completed result is established.`); failure.setAttribute('role', 'alert'); failure.className = 'failure'; host.append(failure) }
  const result = element('section'); result.append(element('h2', receipt.mode === 'exploratory-script' ? 'Program-reported output' : 'Arithmetic result'))
  if (receipt.mode === 'exploratory-script') {
    result.append(element('p', `Program execution: ${String(outcome?.status ?? 'Unknown')}${typeof outcome?.elapsedMs === 'number' ? ` · ${formatted(outcome.elapsedMs)} ms` : ''}`))
    result.append(element('p', 'Execution status checks the program ran within its limits. Its model, claimed horizon and conclusions require independent checking.'))
    result.append(outcome !== null && Object.hasOwn(outcome, 'output') ? renderEngineeringData(outcome.output) : element('p', 'No program output was retained.'))
    if (outcome?.error !== undefined) result.append(renderEngineeringData(outcome.error))
  } else result.append(renderEngineeringData(receipt.outcome))
  host.append(result)
  const inputs = element('section'); inputs.append(element('h2', 'Inputs used'))
  inputs.append(table(['Input', 'Value', 'Unit', 'Origin', 'Quality', 'Simulation time'], receipt.inputs.map(input => [input.name, input.value, input.unit, input.origin === 'observation' ? 'Owner observation' : 'Assumption', input.quality, input.simulationAt ?? 'Not time-stamped'])))
  host.append(inputs)
  const sources = element('section'); sources.append(element('h2', 'Source and current applicability'))
  if (receipt.sources.length === 0) sources.append(element('p', 'This calculation uses explicit assumptions. It has no captured owner observations.'))
  receipt.sources.forEach((source, index) => {
    const status = statuses[index]
    const section = element('div'); section.className = 'source'
    section.append(element('h3', `${source.subjectId} · ${source.profile}`), element('p', `Simulation time ${source.frame.simulationAt}`), element('p', `Observed ${source.frame.observedAt}`))
    const qualification = element('p', status?.allowed ? 'Source still qualifies for reuse. This is a retained observation, not a live reading.' : `Source cannot be reused: ${status?.code ?? 'qualification_unavailable'} — ${status?.reason ?? 'Current qualification was not returned.'}`)
    if (!status?.allowed) qualification.setAttribute('role', 'alert')
    section.append(qualification); sources.append(section)
  })
  host.append(sources)
  const form = element('form'); form.append(element('h2', 'Try changed assumptions'))
  const fields = new Map<string, HTMLInputElement>()
  for (const assumption of assumptionBindings(receipt)) {
    const field = element('label'); field.className = 'assumption'
    field.append(element('span', `${assumption.name} (${assumption.unit})`))
    const input = element('input'); input.type = 'number'; input.step = 'any'; input.value = String(assumption.value); input.required = true
    const note = element('small', assumption.note)
    field.append(input, note); fields.set(assumption.name, input); form.append(field)
  }
  form.append(element('p', 'Editing an assumption creates a new recorded calculation. Rerun retains the captured inputs. Refresh acquires new owner observations.'))
  const actions = element('div'); actions.className = 'actions'
  const rerun = element('button', 'Rerun these inputs'); rerun.type = 'submit'; rerun.disabled = statuses.some(status => !status.allowed)
  if (rerun.disabled) form.append(element('p', 'Rerun is unavailable because a source no longer qualifies. The original result remains historical evidence.'))
  const edits = () => new Map([...fields].map(([name, input]) => [name, input.value]))
  actions.append(rerun)
  if (receipt.sources.length > 0) {
    const refresh = element('button', 'Refresh from current Run'); refresh.type = 'button'
    refresh.addEventListener('click', () => { if (form.reportValidity()) handlers.run(edits(), true) }); actions.append(refresh)
  }
  if (handlers.original !== undefined) { const original = element('button', 'Return to original result'); original.type = 'button'; original.addEventListener('click', handlers.original); actions.append(original) }
  form.append(actions); form.addEventListener('submit', event => { event.preventDefault(); if (form.reportValidity()) handlers.run(edits(), false) }); host.append(form)
  if (receipt.programSource !== undefined) host.append(disclosure('Program source (retained, not executed when opened)', element('pre', receipt.programSource)))
  host.append(disclosure('Full calculation receipt and execution limits', element('pre', JSON.stringify(receipt, null, 2))))
}
