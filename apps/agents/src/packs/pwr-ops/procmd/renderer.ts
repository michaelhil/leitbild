import type { ParsedProcedure, ProcedureBranch, ProcedureStep } from '@leitbild/procmd'

export interface RenderedProcedure {
  readonly markdown: string
  readonly warnings: ReadonlyArray<string>
}

const escapeLabel = (text: string): string => text.replace(/\r?\n/g, ' ')
  .replace(/[&\\"<>|#]/g, character => ({ '&': '&amp;', '\\': '&#92;', '"': "'", '<': '&lt;', '>': '&gt;', '|': '&#124;', '#': '&#35;' })[character]!)

const renderTarget = (branch: ProcedureBranch, steps: readonly ProcedureStep[], citationUrlFor: (id: string) => string): string => {
  if (branch.targetKind === 'step') {
    const target = steps.find(step => step.id === branch.target)
    return target ? `→ Step ${target.label} (${target.id})` : `→ \`#${branch.target}\` _(unresolved)_`
  }
  return branch.targetKind === 'procedure' ? `→ [${branch.target}](${citationUrlFor(branch.target)})` : `→ ${branch.target}`
}

/** Both focused and full readers use exactly this source-ordered step rendering. */
export const renderStep = (step: ProcedureStep, steps: readonly ProcedureStep[], citationUrlFor: (id: string) => string): string => {
  const items = [
    ...step.blocks.map(block => ({ sourceLine: block.sourceLine, markdown: block.kind === 'text' ? block.text
      : `**${block.kind[0]!.toUpperCase() + block.kind.slice(1)}:** ${block.text}${block.paths?.length ? '\n' + block.paths.map((path, index) => `${index + 1}. ${path}`).join('\n') : ''}` })),
    ...step.branches.map(branch => ({ sourceLine: branch.sourceLine, markdown: `- ${branch.label} ${renderTarget(branch, steps, citationUrlFor)}${branch.because ? `\n  _because:_ ${branch.because}` : ''}${branch.against ? `\n  _against:_ ${branch.against}` : ''}` })),
  ].sort((left, right) => left.sourceLine - right.sourceLine)
  return [`### ${step.label}. ${step.title} \`[${step.id}]\``, ...items.map(item => item.markdown)].join('\n\n')
}

// The diagram is explanatory only. Never infer a fall-through transition that
// was not authored, and never silently drop unresolved source branches.
const diagram = (steps: readonly ProcedureStep[]): string => {
  const ids = new Map(steps.map((step, index) => [step.id, `S_${index}`]))
  const lines = ['flowchart TD']
  steps.forEach((step, index) => {
    const label = escapeLabel(`${step.label}: ${step.title}`)
    const decision = step.blocks.some(block => block.kind === 'decision') && step.branches.length >= 2
    lines.push(`  S_${index}${decision ? `{"${label}"}` : `["${label}"]`}`)
    step.branches.forEach((branch, branchIndex) => {
      const target = branch.targetKind === 'step' ? ids.get(branch.target) : undefined
      const leaf = `L_${index}_${branchIndex}`
      if (!target) lines.push(`  ${leaf}(["${escapeLabel(branch.target)}"])`)
      lines.push(`  S_${index} -->|"${escapeLabel(branch.label)}"| ${target ?? leaf}`)
    })
  })
  return ['```mermaid', ...lines, '```'].join('\n')
}

export const renderProcedure = (parsed: ParsedProcedure, citationUrlFor: (id: string) => string): RenderedProcedure => {
  const metadata = [parsed.profile && `Profile: ${parsed.profile}`, parsed.appliesTo && `Applies to: ${parsed.appliesTo}`,
    parsed.referencePlant && `Reference plant: ${parsed.referencePlant}`, parsed.category && `Category: ${parsed.category}`].filter(Boolean)
  const parts = [`## ${parsed.procedureId} — ${parsed.title}`, metadata.join(' · '), parsed.description]
  if (parsed.csfsMonitored.length) parts.push(`**CSFs monitored:** ${parsed.csfsMonitored.join(', ')}`)
  if (parsed.entryTriggers.length) parts.push(`**Entry triggers:** ${parsed.entryTriggers.join(', ')}`)
  if (Object.keys(parsed.annotations).length) parts.push(`**Source annotations:** ${JSON.stringify(parsed.annotations)}`)
  if (parsed.diagnostics.length) parts.push('**Format limitations (not execution guarantees):**\n' + parsed.diagnostics.map(value => `- ${value}`).join('\n'))
  parts.push(...parsed.steps.map(step => renderStep(step, parsed.steps, citationUrlFor)))
  if (parsed.tags.length) {
    const cell = (value: string | undefined) => (value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
    parts.push('### Tags\n\n| Tag | Description | Sim-path | Units | Equipment |\n|---|---|---|---|---|\n'
      + parsed.tags.map(tag => `| ${[tag.id, tag.description, tag.simPath, tag.units, tag.equipment].map(cell).join(' | ')} |`).join('\n'))
  }
  parts.push(diagram(parsed.steps), `---\nSource: [${parsed.procedureId} — ${parsed.title}](${citationUrlFor(parsed.procedureId)})`)
  return { markdown: parts.filter(Boolean).join('\n\n'), warnings: parsed.diagnostics }
}

export const renderIndex = (ids: readonly string[], wikiName: string, wikiHomepage: string): string =>
  `## ${wikiName} — available procedures\n\n${ids.length ? ids.map(id => `- \`${id}\``).join('\n') : 'No procedures listed yet.'}\n\nCall \`procedure_lookup\` with one id.\n\nWiki home: ${wikiHomepage}`
