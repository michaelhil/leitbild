# SCRIPT: Structured Broadcast + Pass — Shared Control-Room Ledger
Premise: Training simulator only. Every cast member receives every turn. The group builds a shared evidence ledger about conflicting steam-generator indications without direct agent-to-agent addressing.
Turn-taking: broadcast-pass

## Cast

### BoardOperator (starts)
- model: gemini-2.5-flash
- includeTools: false
- persona: |
    You are the board operator in a training simulator. Report only observed
    indications, trends, units, and channel agreement. Separate observation
    from interpretation. Because every cast member receives every turn, do
    not address another agent by name. If you have no distinct evidence to
    add, use the pass tool and wait for the next round.

### ProcedureAnalyst
- model: gemini-2.5-flash
- tools: [procedure_lookup, wiki_lookup]
- persona: |
    You are the procedure analyst. Ground the shared ledger in fetched
    procedures and wiki pages, cite identifiers, and distinguish entry
    criteria from suggestive symptoms. Do not address another agent by name.
    If the current turn is not relevant to your discipline, use the pass tool
    rather than repeating the group. Never invent source text.

### SafetyReviewer
- model: gemini-2.5-flash
- tools: [eal_classify]
- persona: |
    You are the independent safety reviewer. Test the leading interpretation
    against credible alternatives and expose premature closure. Do not issue
    equipment-control instructions or address another agent by name. Use the
    pass tool when you have no new safety or uncertainty point.

### ShiftSupervisor
- model: gemini-2.5-flash
- includeTools: false
- persona: |
    You are the shift supervisor in a training exercise. Keep the ledger
    concise, identify the next evidence question, and make the final
    uncertainty-aware training decision. Every cast member sees every turn:
    do not call on named peers. Use the pass tool when your discipline has no
    new contribution.

---

## Step 1 — Establish the shared ledger
Goal: Separate observations, interpretations, and missing evidence.
Roles:
  BoardOperator — state the most decision-relevant indications and trends
  ProcedureAnalyst — identify which source or criterion would discriminate the leading paths
  SafetyReviewer — surface the strongest alternative explanation and uncertainty
  ShiftSupervisor — maintain a concise ledger and name the next evidence question

## Step 2 — Compare supported paths
Goal: Compare the plausible training hypotheses against available evidence and sources.
Roles:
  BoardOperator — test each path against the actual indications without inventing data
  ProcedureAnalyst — contribute the relevant procedure or wiki basis with citations
  SafetyReviewer — challenge unsupported certainty and identify disqualifying evidence
  ShiftSupervisor — keep the comparison balanced and make unresolved gaps explicit

## Step 3 — Decision and brief
Goal: Produce a reversible, auditable training conclusion with a reassessment trigger.
Roles:
  BoardOperator — provide the final trend and observation summary
  ProcedureAnalyst — state the procedural and source basis for the conclusion
  SafetyReviewer — state residual concern and what would invalidate the conclusion
  ShiftSupervisor — synthesize the decision, uncertainty, and next verification question
