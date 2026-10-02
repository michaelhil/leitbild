import { parseProcedure, type ProcedureTextBlock } from '@leitbild/procmd'
import type { KnowledgeHeading } from '@leitbild/knowledge/markdown'

/** Read-only presentation of the same procedure data consumed by World and Agents. */
export const renderProcedurePage = (
  content: string,
  headings: ReadonlyArray<KnowledgeHeading>,
  renderMarkdown: (text: string, lineOffset?: number) => string,
  renderInline: (text: string) => string,
  escape: (text: string) => string,
): string => {
  const procedure = parseProcedure(content)
  const lines = content.split(/\r?\n/)
  const headingFor = (line: number) => headings.find(heading => heading.line === line)
  const labels: Partial<Record<ProcedureTextBlock['kind'], string>> = {
    action: 'Action', check: 'Check', expected: 'Expected result',
    rno: 'Response not obtained', unknown: 'Evidence unknown', basis: 'Technical basis',
    caution: 'Caution', note: 'Note', decision: 'Decision', when: 'When', until: 'Until',
    within: 'Within', concurrent: 'Concurrent', 'abort-if': 'Abort if', 'abort-to': 'Abort to',
    because: 'Because', against: 'Against',
  }
  const blockHtml = (block: ProcedureTextBlock) => {
    const label = labels[block.kind]
    const text = block.kind === 'text' ? renderMarkdown(block.text) : renderInline(block.text)
    return `<div class="procedure-instruction procedure-${block.kind}">${label ? `<strong>${label}</strong>` : ''}${block.kind === 'text' ? text : `<p>${text}</p>`}${block.paths?.length ? `<ol>${block.paths.map(path => `<li>${renderInline(path)}</li>`).join('')}</ol>` : ''}</div>`
  }
  const steps = procedure.steps.map((step, stepIndex) => {
    const previousEnd = stepIndex === 0 ? step.sourceLine - 1 : procedure.steps[stepIndex - 1]!.sourceEndLine
    const interstitial = renderMarkdown(lines.slice(previousEnd, step.sourceLine - 1).join('\n'), previousEnd)
    const heading = headingFor(step.sourceLine)
    const main = step.blocks.filter(block => !['rno', 'unknown', 'basis'].includes(block.kind))
    const responses = step.blocks.filter(block => block.kind === 'rno' || block.kind === 'unknown')
    const basis = step.blocks.filter(block => block.kind === 'basis')
    const branches = step.branches.map((branch, index) => {
      let destination: string
      if (branch.targetKind === 'step') {
        const target = procedure.steps.find(candidate => candidate.id === branch.target)
        const anchor = target && headingFor(target.sourceLine)?.anchor
        destination = anchor
          ? `<a href="#${escape(anchor)}">Go to step ${escape(target!.label)}</a>`
          : `Step ${escape(branch.target)}`
      } else if (branch.targetKind === 'procedure') {
        destination = `${branch.execution === 'parallel' ? 'Continue in parallel with' : 'Transfer to'} ${escape(branch.target)}`
      } else destination = branch.targetKind === 'end' ? 'End this procedure' : branch.targetKind === 'retry' ? 'Repeat this step' : branch.targetKind === 'abort' ? 'Stop this procedure' : escape(branch.target)
      const meaning = branch.outcome === 'rno' ? 'RNO' : branch.outcome === 'unknown' ? 'Unknown' : branch.outcome === 'normal' ? 'Normal' : undefined
      return `<li data-branch-index="${index}">${meaning ? `<span class="procedure-outcome">${meaning}</span> ` : ''}${renderInline(branch.label)} — ${destination}${branch.because ? `<p class="procedure-rationale">Because: ${renderInline(branch.because)}</p>` : ''}${branch.against ? `<p class="procedure-rationale">Against: ${renderInline(branch.against)}</p>` : ''}</li>`
    }).join('')
    const title = `Step ${step.label}${step.title === `Step ${step.label}` ? '' : ` — ${step.title}`}`
    const observation = step.observation ? `<details class="procedure-reference"><summary>Read-only observation specification</summary><pre><code>${escape(JSON.stringify(step.observation, null, 2))}</code></pre></details>` : ''
    return `${interstitial}<section class="procedure-step"><h2${heading ? ` id="${escape(heading.anchor)}"` : ''}>${escape(title)}</h2><div class="procedure-columns"><div class="procedure-actions" aria-label="Instructions and expected results">${main.map(blockHtml).join('')}</div>${responses.length ? `<div class="procedure-responses" aria-label="RNO and unknown evidence">${responses.map(blockHtml).join('')}</div>` : ''}</div>${branches ? `<div class="procedure-routes"><h3>Next step</h3><ul>${branches}</ul></div>` : ''}${basis.length ? `<details class="procedure-basis"><summary>Technical basis</summary>${basis.map(blockHtml).join('')}</details>` : ''}${observation}</section>`
  }).join('')
  const status = [procedure.procedureId, procedure.appliesTo, procedure.annotations['procedure-status'], procedure.annotations['runtime-bindings'] ? `Bindings: ${procedure.annotations['runtime-bindings']}` : undefined].filter(Boolean).map(value => escape(value!)).join(' · ')
  const preamble = renderMarkdown(lines.slice(0, procedure.steps[0]!.sourceLine - 1).join('\n'))
  const appendix = lines.slice(procedure.steps.at(-1)!.sourceEndLine).join('\n')
  return `${preamble}<p class="procedure-applicability">${status}</p><p class="procedure-reader-notice">Document view only. Instructions, branches and expected results are not live plant assessments.</p>${steps}${appendix.trim() ? `<details class="procedure-reference"><summary>Reference appendix</summary>${renderMarkdown(appendix, procedure.steps.at(-1)!.sourceEndLine)}</details>` : ''}<details class="procedure-reference"><summary>Original Markdown</summary><pre><code>${escape(content)}</code></pre></details>`
}
