# Procmd format reader

One pure parser and one format AST, consumed directly by Agents and by World's
source-identity/wire-validation wrapper. No fetch, persistence, model calls,
unit conversion, runtime signal interpretation, or procedure execution.

The supported subset requires `type: procedure`, `procedure-md: 0.7`,
`procedure-id`, `title`, and explicit stable Step IDs. It reads one-line
frontmatter scalars/inline lists; ordered Step blocks; Decision numbered paths;
branches to local steps, procedures, END, retry and abort; adjacent indented
Because/Against rationale; and a flat Tags appendix. Timing, condition,
concurrency, nested-step inheritance and heading-primitive override semantics
are **not executed**. Unsupported syntax is retained with diagnostics; this
is not a claim of complete procmd or YAML conformance.

`sourceLine` and `sourceEndLine` are one-based positions in the original source,
including frontmatter. `rawMarkdown` preserves the exact input. Blocks and
branches carry source positions for display; `step.branches` remains in source
branch order because its index is used by persisted World transition commands.
Fenced examples are literal text blocks with no operational tag references.

Tests freeze the 39-document PWR corpus and its previous branch-index meanings;
see [fixture provenance](fixtures/README.md). A matching format or plant label
does not establish applicability to a live simulation or certify its readings.
