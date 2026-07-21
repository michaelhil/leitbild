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
  BoardOperator — state each available indication with trend, unit, timestamp, channel agreement, and quality; label unknowns explicitly
  ProcedureAnalyst — ask only for evidence needed to distinguish the relevant E-0 branches; do not recommend a branch yet
  SafetyReviewer — identify contradictions, common-mode instrument risks, and assumptions hidden inside the fact statements
  ShiftSupervisor — maintain a short shared fact ledger and require read-back of corrections

## Step 2 — Ground the candidate paths
Goal: Compare the supported procedure paths using fetched evidence from the pwr-ops wiki and procedures. Agree on the entry criteria, disqualifying evidence, and data gaps for each candidate.
Roles:
  BoardOperator — map the agreed simulator indications to the evidence requests without interpreting beyond the displays
  ProcedureAnalyst — call procedure_lookup for E-0, E-2, and E-3 and wiki_lookup for relevant system or scenario context; cite the returned identifiers
  SafetyReviewer — test whether the sources actually support each claimed branch and flag any unsupported leap or unavailable datum
  ShiftSupervisor — keep a candidate matrix with supported, contradicted, and unknown columns

## Step 3 — Challenge and decide
Goal: Select the best-supported training response path or explicitly conclude that evidence is insufficient. Record the escalation trigger and one dissenting or residual concern.
Roles:
  BoardOperator — confirm whether the proposed path matches the board evidence and name the next indication that could overturn it
  ProcedureAnalyst — state the procedure basis and the exact unresolved criterion, if any
  SafetyReviewer — make the strongest case against the leading option and verify that uncertainty is not being hidden
  ShiftSupervisor — decide, assign the next verification, and obtain closed-loop read-backs from the crew

## Step 4 — Produce the control-room brief
Goal: Deliver a compact training brief containing situation, evidence, decision, actions-at-a-high-level, owners, trigger for reassessment, and uncertainties.
Roles:
  BoardOperator — provide the final parameter-and-trend summary without adding new facts
  ProcedureAnalyst — provide the cited procedure and wiki basis in two or three lines
  SafetyReviewer — state the residual safety concern and what would invalidate the decision
  ShiftSupervisor — synthesize the final brief and explicitly mark it as simulator training, not operational direction
