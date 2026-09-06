---
type: procedure
procedure-md: 0.7
procedure-id: TEST-1
title: "Decision and source order"
reference-plant: reference-only
custom-key: author-note
csfs-monitored: [subcriticality, core-cooling]
entry-triggers: [reactor-trip]
---
# TEST-1
Plain source introduction.
CSF: subcriticality

## Step 1 [id: choose]
Caution: First inspect «CAUTION».
Decision: Identify cause using «DECISION».
1. First path «PATH»
2. Second path
- Internal choice → #finish
  Because: evidence «BECAUSE»
  Against: counter-evidence «AGAINST»
Action: This action follows the first branch.
Unclassified prose stays visible.
- External choice → [[FR-S.1]]
Note: After external choice.
Within: 60 s
Until: manually assessed recovery
```md
## Step 9 [id: fake]
Action: fenced «FAKE»
- Do not execute → #fake
```
Check: inline `«CODE»` and [[«WIKI»]] are not tag references; «REAL» is.
Future: unsupported annotation
- Manual choice → call supervisor
- Cross-step unsupported → [[OTHER#step]]

Because: detached rationale «DETACHED»

## Step 2 [id: finish]
Action: Record completion.
- Done → END
- Retry → ↻
- Abort → ↯

## Tags
- id: CAUTION
  sim-path: example.caution
  units: bar
  range: [0, 100]
  custom-tag: note
- id: DECISION
- id: PATH
- id: BECAUSE
- id: AGAINST
- id: REAL
- id: DETACHED

## Appendix
Preserve this explanation after Tags.
