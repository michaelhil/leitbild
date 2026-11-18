import { describe, it, expect } from 'bun:test'
import { normaliseMermaidSource as normaliseDiagram, truncateForDisplay, MAX_MERMAID_SOURCE } from './normalise.ts'

// Exercise repairs as complete flowcharts, as the chat renderer receives them.
const normaliseFlowchart = (fragment: string): string => {
  if (/^\s*(?:flowchart|graph)\b/.test(fragment)) return normaliseDiagram(fragment)
  const header = 'flowchart LR\n'
  return normaliseDiagram(header + fragment).slice(header.length)
}

describe('normaliseMermaidSource — trailing semicolons', () => {
  it('strips trailing ; from each line', () => {
    const src = 'flowchart LR\n    A --> B;\n    B --> C;'
    const out = normaliseFlowchart(src)
    expect(out).toBe('flowchart LR\n    A --> B\n    B --> C')
  })

  it('preserves semicolons not at line end', () => {
    const src = 'flowchart LR\n    A["foo; bar"] --> B'
    expect(normaliseFlowchart(src)).toBe(src)
  })

  it('strips trailing ; even with trailing whitespace', () => {
    expect(normaliseFlowchart('A --> B;   ')).toBe('A --> B')
  })
})

describe('normaliseMermaidSource — bracket label quoting', () => {
  // Policy: always quote bracket-delimited bodies (unless already quoted).
  // Mermaid accepts quoted labels everywhere, so this is the safe uniform
  // rewrite — no character allowlist to maintain.

  it('quotes [body] containing /', () => {
    expect(normaliseFlowchart('D[Divert / Abort]'))
      .toBe('D["Divert / Abort"]')
  })

  it('quotes {body} containing <', () => {
    expect(normaliseFlowchart('C{a < b}'))
      .toBe('C{"a < b"}')
  })

  it('quotes (body) containing #', () => {
    expect(normaliseFlowchart('E(foo#bar)'))
      .toBe('E("foo#bar")')
  })

  it('always quotes — even plain bodies (uniform rewrite policy)', () => {
    expect(normaliseFlowchart('A[Start]')).toBe('A["Start"]')
    expect(normaliseFlowchart('B{Decision}')).toBe('B{"Decision"}')
    expect(normaliseFlowchart('C(Process)')).toBe('C("Process")')
  })

  it('does not double-quote already-quoted bodies', () => {
    expect(normaliseFlowchart('D["Divert / Abort"]'))
      .toBe('D["Divert / Abort"]')
    expect(normaliseFlowchart('A["Already quoted"]'))
      .toBe('A["Already quoted"]')
  })

  it('trims whitespace inside the brackets', () => {
    expect(normaliseFlowchart('X[ foo/bar ]'))
      .toBe('X["foo/bar"]')
  })
})

describe('normaliseMermaidSource — bare quoted references', () => {
  it('converts a bare quoted ref into a synthetic node definition', () => {
    const src = '"Process / Store" --> Output'
    const out = normaliseFlowchart(src)
    expect(out).toBe('n1["Process / Store"] --> Output')
  })

  it('reuses the synthetic id on subsequent mentions', () => {
    const src = 'Input --> "Process / Store"\n"Process / Store" --> Output'
    const out = normaliseFlowchart(src)
    expect(out).toBe('Input --> n1["Process / Store"]\nn1 --> Output')
  })

  it('assigns distinct ids to distinct labels', () => {
    const src = '"A/B" --> "C/D"'
    const out = normaliseFlowchart(src)
    expect(out).toBe('n1["A/B"] --> n2["C/D"]')
  })

  it('leaves bracketed quoted labels alone (produced by step 2)', () => {
    const src = 'D["Divert / Abort"] --> X'
    expect(normaliseFlowchart(src)).toBe('D["Divert / Abort"] --> X')
  })
})

describe('normaliseMermaidSource — edge-label quotes preserved (R3 bug)', () => {
  it('preserves `A -- "label" --> B` — edge label is not a node ref', () => {
    const src = 'A -- "some label" --> B'
    const out = normaliseFlowchart(src)
    expect(out).toBe('A -- "some label" --> B')
  })

  it('preserves edge label with tighter spacing', () => {
    const src = 'A --"label"--> B'
    expect(normaliseFlowchart(src)).toBe('A --"label"--> B')
  })

  it('preserves edge label even when the label contains /', () => {
    const src = 'A -- "if / else" --> B'
    expect(normaliseFlowchart(src)).toBe('A -- "if / else" --> B')
  })
})

describe('normaliseMermaidSource — directives and comments', () => {
  it('leaves classDef declarations untouched', () => {
    const src = 'classDef important fill:#f00,stroke:#000\nA:::important --> B'
    expect(normaliseFlowchart(src)).toBe(src)
  })

  it('leaves style declarations untouched', () => {
    const src = 'style A fill:#fff,stroke:#000'
    expect(normaliseFlowchart(src)).toBe(src)
  })

  it('leaves %% comments untouched', () => {
    const src = '%% this is a comment with [brackets] and /slashes'
    expect(normaliseFlowchart(src)).toBe(src)
  })
})

describe('normaliseMermaidSource — edge cases', () => {
  it('empty string returns empty string', () => {
    expect(normaliseFlowchart('')).toBe('')
  })

  it('whitespace-only returns as-is', () => {
    expect(normaliseFlowchart('\n\n   \n')).toBe('\n\n   \n')
  })

  it('preserves mermaid arrows of different styles', () => {
    expect(normaliseFlowchart('A --> B\nC -.-> D\nE ==> F'))
      .toBe('A --> B\nC -.-> D\nE ==> F')
  })

  it('composable: quoting a bracket with / and then using that node elsewhere', () => {
    const src = 'A[foo/bar] --> B\nB --> A'
    const out = normaliseFlowchart(src)
    expect(out).toBe('A["foo/bar"] --> B\nB --> A')
  })

  it('leaves click directive URLs alone (third edge-context case)', () => {
    const src = `flowchart TD
  A["Step 1"]
  EXT_X["X"]
  A --> EXT_X
  click EXT_X "https://example.com/proc/X" _blank`
    const out = normaliseFlowchart(src)
    // The URL must survive intact, not be replaced by a synthetic n1["..."]
    expect(out).toContain('click EXT_X "https://example.com/proc/X" _blank')
    expect(out).not.toMatch(/n\d+\["https/)
  })

  it('leaves already-quoted pipe edge labels alone', () => {
    const src = 'A --> B\nA -->|"If x: continue"| B'
    const out = normaliseFlowchart(src)
    expect(out).toContain('-->|"If x: continue"|')
    expect(out).not.toMatch(/n\d+\["If x: continue"\]/)
  })

  it('quotes pipe edge labels (SGTR diagram regression — slashes, semicolons, parens, degree signs)', () => {
    // Exact shape the LLM produced for the E-3 / ECA-3.1/3.2/3.3 decision
    // diagram on prod — pipe labels with slashes, semicolons, parens, and
    // a degree sign. Pre-fix, mermaid rejected this and the fallback fired.
    const src = `flowchart TD
  B -->|PORVs PORV-456A / PORV-456B stuck or unresponsive; PT-455 drifting uncontrollably| C[ECA-3.3]
  D -->|SUB-MARGIN >= 30 degC at lowest cold-leg (and core exit)| E[ECA-3.1]`
    const out = normaliseFlowchart(src)
    expect(out).toContain('-->|"PORVs PORV-456A / PORV-456B stuck or unresponsive; PT-455 drifting uncontrollably"|')
    expect(out).toContain('-->|"SUB-MARGIN >= 30 degC at lowest cold-leg (and core exit)"|')
  })

  it('always quotes pipe edge labels — even plain text (uniform rewrite policy)', () => {
    expect(normaliseFlowchart('A -->|simple label| B'))
      .toBe('A -->|"simple label"| B')
  })

  it('does not double-quote already-quoted pipe edge labels', () => {
    const src = 'A -->|"already quoted / with slash"| B'
    const out = normaliseFlowchart(src)
    expect(out).toContain('-->|"already quoted / with slash"|')
    expect(out).not.toContain('""')
  })
})

describe('truncateForDisplay', () => {
  it('returns source unchanged (no artificial cap — fallback card uses overflow-scroll)', () => {
    expect(truncateForDisplay('short')).toBe('short')
    const long = 'x'.repeat(10_000)
    expect(truncateForDisplay(long)).toBe(long)
  })
})

describe('MAX_MERMAID_SOURCE constant', () => {
  it('matches the configured UTF-16 source limit', () => {
    expect(MAX_MERMAID_SOURCE).toBe(50_000)
  })
})

describe('diagram grammar preservation', () => {
  it.each([
    'stateDiagram-v2\n[*] --> Idle\nIdle --> [*]',
    'pie title Browser share\n"Chrome" : 65\n"Firefox" : 35',
    'sequenceDiagram\nAlice->>Bob: "Hello (again)"',
    'classDiagram\nclass Animal {\n+String name\n}',
    'erDiagram\nCUSTOMER ||--o{ ORDER : "places"',
    'gantt\ntitle "Sprint (1)"\ndateFormat YYYY-MM-DD\nsection Backend\nAPI :2026-11-18, 3d',
  ])('preserves non-flowchart syntax: %s', (source) => {
    expect(normaliseDiagram(source)).toBe(source)
  })

  it('preserves frontmatter and multiline init configuration', () => {
    const prefix = '---\nconfig:\n  theme: "neutral"\n---\n%%{init: {\n  "flowchart": { "curve": "linear" }\n}}%%\n%% diagram comment\n'
    expect(normaliseDiagram(prefix + 'flowchart TD\nA[Start] --> B'))
      .toBe(prefix + 'flowchart TD\nA["Start"] --> B')
  })

  it('preserves flowchart class styling and subgraph titles', () => {
    const source = 'flowchart TD\nsubgraph "Review (team)"\nA[Input] --> B\nend\nclassDef accepted fill:#dcfce7,color:#14532d,font-family:"Arial";\nclass A accepted'
    expect(normaliseDiagram(source)).toBe(source.replace('A[Input]', 'A["Input"]'))
  })

  it('preserves modern node metadata and multiline descriptions rather than rewriting their grammar', () => {
    const source = 'flowchart LR\nA@{ shape: rect, label: "Input (raw)" } --> B@{ shape: diam, label: "Ready?" }'
    expect(normaliseDiagram(source)).toBe(source)
    const described = 'flowchart LR\naccDescr {\n  "Input" becomes [output]\n}\nA[Input] --> B[Output]'
    expect(normaliseDiagram(described)).toBe(described)
  })

  it('does not merge a synthesized bare reference into an existing node id', () => {
    const output = normaliseDiagram('flowchart LR\nn1[Existing] --> "New label"\n"New label" --> Output')
    const synthetic = output.match(/--> (n\d+)\["New label"\]/)?.[1]
    expect(synthetic).toBeDefined()
    expect(synthetic).not.toBe('n1')
    expect(output).toContain(`\n${synthetic} --> Output`)
  })
})
