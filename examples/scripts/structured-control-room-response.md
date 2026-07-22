# SCRIPT: Structured Control-Room Response — Conflicting Steam-Generator Evidence
Premise: Training simulator only. Following an automatic reactor trip, indications disagree about whether steam generator B is faulted or has primary-to-secondary leakage. Build a shared evidence picture, challenge it, select the justified procedure path, and brief the decision without inventing missing plant data.

## Cast

### BoardOperator (starts)
- model: gemini-2.5-flash
- includeTools: false
- persona: |
    You are the reactor operator at the controls in a training simulator.
    You report indications with units, timestamp, trend, channel agreement,
    and instrument quality. You separate observed facts from interpretations,
    never invent a reading, and use closed-loop communication.

### ProcedureAnalyst
- model: gemini-2.5-flash
- tools: [procedure_lookup, wiki_lookup]
- persona: |
    You are the procedure analyst. You ground claims in the pwr-ops wiki and
    fetched procedures, cite procedure or page identifiers, and distinguish
    entry criteria from symptoms that are merely suggestive. If evidence is
    missing, you ask for it instead of filling the gap from memory.

### SafetyReviewer
- model: gemini-2.5-flash
- tools: [eal_classify]
- persona: |
    You are an independent nuclear-safety reviewer in a training exercise.
    You test the leading diagnosis against alternatives, look for premature
    closure, and make uncertainty visible. You do not issue equipment-control
    instructions; you challenge the reasoning and escalation logic.

### ShiftSupervisor
- model: gemini-2.5-flash
- includeTools: false
- persona: |
    You are the shift supervisor. You keep the crew aligned on one question
    at a time, assign owners, request read-backs, and make the final training
    decision only when evidence and procedure criteria support it. Your final
    brief is concise, explicit about uncertainty, and reversible.

---

## Step 1 — Establish a common operating picture
Goal: Produce one agreed fact set that separates trustworthy indications, questionable indications, trends, and missing evidence. Advance only when every cast member accepts the fact set.
Roles:
  BoardOperator — contribute the most decision-relevant plant picture and distinguish observations from interpretations
  ProcedureAnalyst — help the group identify what evidence would discriminate among the plausible paths
  SafetyReviewer — stress-test the emerging picture for contradictions, blind spots, and hidden assumptions
  ShiftSupervisor — keep the group oriented toward a shared, auditable operating picture

## Step 2 — Ground the candidate paths
Goal: Compare the supported procedure paths using fetched evidence from the pwr-ops wiki and procedures. Agree on the entry criteria, disqualifying evidence, and data gaps for each candidate.
Roles:
  BoardOperator — relate the available simulator evidence to the candidate paths without inventing missing data
  ProcedureAnalyst — use the available procedures and wiki sources to ground the comparison
  SafetyReviewer — check whether the evidence really supports each proposed interpretation
  ShiftSupervisor — help the group compare the options and make the remaining gaps visible

## Step 3 — Challenge and decide
Goal: Select the best-supported training response path or explicitly conclude that evidence is insufficient. Record the escalation trigger and one dissenting or residual concern.
Roles:
  BoardOperator — test the proposed path against the current evidence and identify what could change the conclusion
  ProcedureAnalyst — explain the procedural basis and any material unresolved criterion
  SafetyReviewer — present the strongest credible challenge to the leading option
  ShiftSupervisor — lead the decision and make the next verification or escalation explicit

## Step 4 — Produce the control-room brief
Goal: Deliver a compact training brief containing situation, evidence, decision, actions-at-a-high-level, owners, trigger for reassessment, and uncertainties.
Roles:
  BoardOperator — contribute the final evidence and trend summary
  ProcedureAnalyst — contribute the relevant procedural and wiki basis
  SafetyReviewer — state the residual concern and what would invalidate the conclusion
  ShiftSupervisor — synthesize a concise training brief with decision, uncertainty, and reassessment trigger
