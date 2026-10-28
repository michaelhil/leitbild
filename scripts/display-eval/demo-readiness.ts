import type { EvalScenario } from './scenarios.ts'

const base = { scenario: 'halden-normal-operation', setup: [] } as const
const cases: ReadonlyArray<Omit<EvalScenario, 'set' | 'flaky' | 'evidence'>> = [
  { id: 'direct-trip-unit3', run: base, expect: 'either', prompt: 'Trip the reactor on Unit 3. Execute the operation and verify its response; leave the other units alone.' },
  { id: 'direct-grid-disconnect', run: base, expect: 'either', prompt: 'Disconnect all power connections to Germany, the UK and Denmark in this grid. Leave other international connections alone, and verify which connections were opened.' },
  { id: 'procedure-paused', run: base, expect: 'either', prompt: 'Run E-0 on Unit 2. Work through the procedure and report the result of every step in chat. Continue autonomously where the readings and controls allow it, and clearly tell me if you need my input.' },
  { id: 'procedure-running', run: { ...base, setup: [
    { operationId: 'world.process-plant.action.invoke', input: { plantId: 'plant:halden-2', actionId: 'loss-offsite-power', parameters: {} } },
    { operationId: 'world.simulation-run.execution.advance', input: { minutes: 1, onComplete: 'pause' } },
    { operationId: 'world.simulation-run.execution.set', input: { playback: 'playing', pace: 'realtime' } },
  ] }, expect: 'either', prompt: 'Run E-0 on Unit 2. Work through the procedure and report the result of every step in chat. Continue autonomously where the readings and controls allow it, and clearly tell me if you need my input.' },
  { id: 'many-owner-situation', run: { scenario: 'fixture:demo-discovery-coverage', setup: [] }, expect: 'display', prompt: 'Give me a current situation report for this whole Run, including all plant units, the electrical grid and the weather. Prioritise anything needing attention. Do not change anything.' },
  { id: 'whole-situation', run: base, expect: 'either', prompt: 'Give me a concise current situation report for the whole Run. Cover all four units and the electrical grid, prioritise exceptions, and say where evidence is missing. Do not change anything.' },
  { id: 'mixed-unit-grid', run: base, expect: 'display', prompt: 'Show a live comparison of electrical output from all four Halden units and the electrical grid frequency. Label each unit clearly and explain any important differences. Do not change anything.' },
  { id: 'unit2-situation', run: { ...base, setup: [{ operationId: 'world.process-plant.action.invoke', input: { plantId: 'plant:halden-2', actionId: 'loss-offsite-power', parameters: {} } }], advanceMinutes: 1 }, expect: 'display', prompt: 'Give me a current situation report for Unit 2. What needs attention, what is providing cooling and electrical support, and what should I watch next? Show the decisive evidence. Do not change anything.' },
  { id: 'unit3-component', run: base, expect: 'none', prompt: 'Is main feedwater pump A on Unit 3 running? Answer from its current feedback. Do not change anything.' },
  { id: 'cross-unit-aspect', run: base, expect: 'display', prompt: 'Assess the current heat-removal situation across all four Halden units, including their electrical support from the grid. Show a clear comparison with the decisive readings. Do not change anything.' },
  { id: 'mixed-process-views', run: base, expect: 'display', prompt: 'Show one live display with process information for Unit 1 and Unit 2 together with the electrical grid. Include the two units\' process drawings and the grid frequency, and make it clear which readings belong to which unit. Do not change anything.' },
]

// Real-provider manual regression prompts; setup runs only on disposable local copies.
// Empty holdout evidence means semantic coverage/action receipts require review, not an automatic answer-quality score.
export const demoCases = cases.map(entry => ({ ...entry, holdout: { evidence: [] } }))
