# Planner and dispatcher phrasings for the search-ranking test (increment 1, test D2)

These are written by maint, from an agent's planner perspective, not collected from real planners. They are worded as a work-week planner or dispatcher would type them to an Assistant. They contain no tool names, and I did **not** tune them to the search terms in design §5.1. Builders must not edit them; a change goes through maint with a reason.

**How to use them:**
- **The 20 scored phrasings (P1–P20)** feed the gate: at least 18 of 20 must have the expected operation in the top 3.
- **The four ambiguous phrasings (A1–A4)** are reported separately and do not count toward the gate. For each, more than one operation is a reasonable answer, and the acceptable set is given.

Operations, design §5.1:
- `world.simulation-run.planning-facts` (World facts)
- `planning.plan.create`, `planning.plan.edit`, `planning.plan.generate`, `planning.plan.explain`, `planning.plan.read`, `planning.plan.baseline`, `planning.plan.delete`
- `planning.sources.refresh`

## Scored (P1–P20)

| # | Step in the cycle | Phrasing | Expected operation |
|---|---|---|---|
| P1 | start a plan | Set up next week's Train A work week so I can schedule it. | `planning.plan.create` |
| P2 | start a plan | Start a new maintenance plan from scratch for the pump overhauls in week 48. | `planning.plan.create` |
| P3 | find equipment | Find the service water pumps so I can put them in the plan. | `world.simulation-run.planning-facts` |
| P4 | find equipment | Which trucks do we have in the exercise and how much can each carry? | `world.simulation-run.planning-facts` |
| P5 | add a job | Add a 10-hour seal replacement on CCW pump A for the mechanical crew. | `planning.plan.edit` |
| P6 | add a crew | We've got a second electrical crew on days this week, add them. | `planning.plan.edit` |
| P7 | add a link | The seal job can't start until CCW A is tagged out, tie them together. | `planning.plan.edit` |
| P8 | add a rule | Add a rule that at least one of the two service water pumps stays in service the whole time. | `planning.plan.edit` |
| P9 | add a rule | The cooling chain must never be out for more than 72 hours from first tag-out to passed test. | `planning.plan.edit` |
| P10 | change an estimate | The rebuild is more like 26 hours, change the estimate. | `planning.plan.edit` |
| P11 | generate | Work out a schedule for the week. | `planning.plan.generate` |
| P12 | generate | Show me the options with overtime and with contractor nights. | `planning.plan.generate` |
| P13 | ask for something impossible | Can all of this fit inside the window with day shifts only? | `planning.plan.generate` (a "days only" variant; the honest answer is a refusal with its cause) |
| P14 | why a job starts then | Why doesn't the CCW pump test start until Thursday? | `planning.plan.explain` |
| P15 | what sets the finish | What is holding up the end of the cooling chain? | `planning.plan.explain` |
| P16 | why refused | Why was the day-shift-only plan refused? | `planning.plan.explain` |
| P17 | baseline | Lock in the swap option as the plan we issue at the freeze. | `planning.plan.baseline` |
| P18 | refresh World values | The plant has moved on since this morning, pull the latest values into my plan. | `planning.sources.refresh` |
| P19 | read and status | Where are we with the plan? Anything that needs my attention? | `planning.plan.read` |
| P20 | delete | Throw away this draft plan, I don't need it any more. | `planning.plan.delete` |

## Ambiguous (A1–A4): reported, not gated

| # | Phrasing | Acceptable operations | Why it is ambiguous |
|---|---|---|---|
| A1 | Which pumps on the plant are running right now? | `world.simulation-run.planning-facts`; the plant's own signal or observation reads also answer it | This is a World question first, not a planning one. Ranking a plant read first is correct behaviour. |
| A2 | Get Train A back in service by Wednesday noon without touching Train B. | `planning.plan.edit` (a target or window), then `planning.plan.generate` | It is a request for something likely impossible, but generate has no "by" input. The Assistant must set the target, generate, and report the honest refusal. Two steps, so no single right first operation. |
| A3 | Which truck should take the sports hall water tank? | `planning.plan.generate`; Einsatz's own recommendation read is also a fair answer | The dispatcher may want World's immediate suggestion, not a plan. |
| A4 | Is Truck 4 still at the depot? Update the plan with whatever the simulation says now. | `planning.sources.refresh`; `world.simulation-run.planning-facts` | Two requests in one sentence: a World look-up and a refresh. |

**Coverage of the increment-1 cycle:**
- start: P1, P2
- find World items: P3, P4
- add a job, crew or link: P5–P7
- add a rule: P8, P9
- change an estimate: P10
- generate: P11, P12
- something impossible: P13 (and A2)
- why it starts: P14
- what sets the finish: P15
- refusal: P16
- baseline: P17
- refresh: P18
- status: P19
- delete: P20
