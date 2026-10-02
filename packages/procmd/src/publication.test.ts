import { expect, test } from 'bun:test'
import { validateProcedurePublication } from './publication.ts'

const procedure = (id = 'P', target = 'END', extra = '') => `---\ntype: procedure\nprocedure-md: 0.7\nprocedure-id: ${id}\ntitle: Example\n${extra}---\n## Step 1 [id: first]\nBasis: Engineering owner\nExpected: Achieved response\nRNO: Supported contrary path\nUnknown: Obtain discriminator\n- Achieved [outcome: normal] → ${target}\n- Unresolved [outcome: unknown] → ↻`
test('publication discovers documents, checks local identities and branches, and permits separate source namespaces', () => {
  const docs = [{ path: 'source/P.md', content: procedure('P', '[[Q]]') }, { path: 'source/Q.md', content: procedure('Q') },
    { path: 'other/P.md', content: procedure('P') }, { path: 'source/index.md', content: '# Not a procedure' }]
  expect(() => validateProcedurePublication(docs)).not.toThrow()
  expect(() => validateProcedurePublication([{ path: 'quoted/P.md', content: procedure().replace('type: procedure', 'type: "procedure"') }])).not.toThrow()
  expect(() => validateProcedurePublication(docs.filter(document => document.path !== 'source/Q.md'))).toThrow('Missing or ambiguous procedure target')
  expect(() => validateProcedurePublication([...docs, { path: 'source/duplicate.md', content: procedure('P') }])).toThrow('Duplicate procedure identity')
  expect(() => validateProcedurePublication([{ path: 'source/P.md', content: procedure('P', '#missing') }])).toThrow('Missing step target')
})
test('explicit design guidance requires complete decision blocks without treating reference reconstruction as qualified', () => {
  const doc = { path: 'source/P.md', content: procedure('P', 'END', 'procedure-status: design-guidance\n') }
  expect(() => validateProcedurePublication([doc])).not.toThrow()
  for (const keyword of ['Basis', 'Expected', 'RNO', 'Unknown']) {
    expect(() => validateProcedurePublication([{ ...doc, content: doc.content.replace(new RegExp(`^${keyword}:.*\\n`, 'm'), '') }])).toThrow()
  }
  expect(() => validateProcedurePublication([{ ...doc, content: doc.content.replace('[outcome: unknown]', '') }])).toThrow('unknown route')
  expect(() => validateProcedurePublication([{ ...doc, content: doc.content.replace('→ END', '→ FUTURE') }])).toThrow('unsupported branch target')
  expect(() => validateProcedurePublication([{ ...doc, content: doc.content.slice(0, doc.content.indexOf('## Step')) }])).toThrow()
  expect(() => validateProcedurePublication([{ path: 'reference/P.md', content: procedure().replace('RNO: Supported contrary path\n', '') }])).not.toThrow()
})
