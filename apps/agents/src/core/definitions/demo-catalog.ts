// ============================================================================
// Server-owned demo definitions. The UI renders these declarations, while
// the application service applies their Room Definition and Prompt Deck.
//
// Adding a new demo: add an entry below. The strip/modal/header-icon all
// derive from this array — no other edits needed.
// ============================================================================

import type { DeliveryMode } from '../types/messaging.ts'

export interface PromptDeckEntry {
  readonly id: string
  readonly label: string
  readonly description: string
  readonly action: PromptDeckAction
}

export interface AgentDefinition {
  readonly name: string
  readonly persona: string
  readonly tools?: ReadonlyArray<string>
  readonly temperature?: number
}

export type PromptDeckAction =
  | {
      readonly kind: 'post-message'
      readonly content: string
      readonly pauseAfterMs?: number
    }
  | {
      readonly kind: 'start-script'
      readonly scriptName: string
    }

export interface RoomDefinition {
  readonly id: string
  readonly name: string
  readonly prompt?: string
  readonly deliveryMode: DeliveryMode
  readonly packs: ReadonlyArray<string>
  readonly agents: ReadonlyArray<AgentDefinition>
}

export interface PromptDeck {
  readonly id: string
  readonly entries: ReadonlyArray<PromptDeckEntry>
}

export interface DemoDefinition {
  readonly id: string
  readonly title: string
  readonly category?: string
  readonly blurb: string
  readonly requiredTools: ReadonlyArray<string>
  readonly room: RoomDefinition
  readonly deck: PromptDeck
}

export const DEMO_CATALOG: ReadonlyArray<DemoDefinition> = [
  {
    id: 'control-room-chaos',
    title: 'Control Room: Unstructured',
    category: 'Turn-Taking Demos',
    blurb:
      'See why “put several smart agents in one room” is not an orchestration strategy. This training-only demo creates four opinionated control-room personas in broadcast mode, gives them one ambiguous question, and pauses delivery automatically after 25 seconds. Leitbild opens it in a dedicated room. Re-open it from the 🪄 icon.',
    requiredTools: [],
    room: {
      id: 'control-room-chaos',
      name: 'Demo: Control Room Unstructured',
      deliveryMode: 'broadcast',
      packs: [],
      agents: [
        {
          name: 'ChaosBoardOperator',
          temperature: 0.8,
          persona:
            'You are a reactor board operator in a training simulator. You privilege live indications and trend recognition, distrust abstract debate, and push the group to act on what is visible. Be concise and assertive. Challenge one peer when their interpretation outruns the board evidence. Make no more than two contributions, then wait for a human.',
        },
        {
          name: 'ChaosShiftSupervisor',
          temperature: 0.8,
          persona:
            'You are the shift supervisor in a training simulator. You feel responsible for reaching a decision quickly and tend to close debate before every uncertainty is resolved. Be decisive, question delay, and challenge one peer. Make no more than two contributions, then wait for a human.',
        },
        {
          name: 'ChaosSafetyEngineer',
          temperature: 0.8,
          persona:
            'You are an independent nuclear-safety engineer in a training exercise. You focus on worst credible cases, common-mode failures, and premature closure. Interrupt overconfident claims with missing evidence. Do not give equipment-control instructions. Make no more than two contributions, then wait for a human.',
        },
        {
          name: 'ChaosProcedureSpecialist',
          temperature: 0.8,
          persona:
            'You are a procedure specialist in a training exercise, but you have not been given a shared evidence worksheet or a formal turn. You insist on procedural discipline, correct imprecise terminology, and challenge one peer whose framing does not match your recollection. Do not invent exact step text. Make no more than two contributions, then wait for a human.',
        },
      ],
    },
    deck: {
      id: 'control-room-chaos',
      entries: [
      {
        id: 'start',
        label: 'Create the crew and start the discussion',
        description: 'Four agents react concurrently with no chair, turn order, shared evidence template, or decision gate.',
        action: {
          kind: 'post-message',
          content: 'TRAINING SIMULATOR DISCUSSION — not operational direction. At 02:40, twenty minutes after an automatic reactor trip, steam-generator B level is rising on one channel while wide-range level is flat, its radiation monitor is slightly elevated but below alarm, pressurizer pressure is drifting down, and no shared evidence board exists. Discuss: which hypothesis should frame the crew response, what evidence is missing, and what should be communicated in the next five minutes? There is deliberately no moderator, speaking order, shared template, or decision rule. Respond to the human question, challenge at least one peer once, keep each message under 120 words, and stop after at most two contributions.',
          pauseAfterMs: 25_000,
        },
      },
      ],
    },
  },
  {
    id: 'control-room-script',
    title: 'Control Room: Scripted',
    category: 'Turn-Taking Demos',
    blurb:
      'Run the same kind of ambiguous training problem as a living multi-agent script. Four personas take controlled turns through a shared fact ledger, source grounding, adversarial challenge, decision gate, and final brief. The script creates and removes its own cast. Re-open it from the 🪄 icon.',
    requiredTools: ['procedure_lookup', 'wiki_lookup', 'eal_classify'],
    room: { id: 'control-room-script', name: 'Demo: Control Room Scripted', deliveryMode: 'manual', packs: ['pwr-ops'], agents: [] },
    deck: {
      id: 'control-room-script',
      entries: [
      {
        id: 'start',
        label: 'Start the structured discussion',
        description: 'Launch the four-person script and watch its living document in the right rail.',
        action: { kind: 'start-script', scriptName: 'structured-control-room-response' },
      },
      ],
    },
  },
  {
    id: 'control-room-broadcast-pass',
    title: 'Control Room: Broadcast + Pass',
    category: 'Turn-Taking Demos',
    blurb:
      'Run a structured discussion where every agent sees every turn. Each discipline contributes once per round or uses the pass tool when it has nothing new to add. No agent-to-agent addressing; the shared ledger and step gates keep the conversation coherent. Re-open it from the 🪄 icon.',
    requiredTools: ['procedure_lookup', 'wiki_lookup', 'eal_classify'],
    room: { id: 'control-room-broadcast-pass', name: 'Demo: Control Room Broadcast Pass', deliveryMode: 'manual', packs: ['pwr-ops'], agents: [] },
    deck: {
      id: 'control-room-broadcast-pass',
      entries: [
      {
        id: 'start',
        label: 'Start the broadcast-and-pass discussion',
        description: 'Watch every agent receive each turn, contribute by discipline, or pass cleanly before the next round.',
        action: { kind: 'start-script', scriptName: 'structured-broadcast-pass' },
      },
      ],
    },
  },
  {
    id: 'procedures',
    title: 'Procedure Demo',
    blurb:
      'Pull real nuclear-plant emergency operating procedures from the wiki, search across them by keyword, and classify scenarios against NEI 99-01 emergency action levels. Click any prompt below to try it. You can re-open this list any time from the 🪄 icon in the room header.',
    requiredTools: ['procedure_lookup', 'procedure_search', 'wiki_lookup', 'eal_classify'],
    room: {
      id: 'procedures',
      name: 'Demo: Procedures',
      deliveryMode: 'manual',
      packs: ['pwr-ops'],
      agents: [{
        name: 'Procedure Guide',
        persona: 'You facilitate this procedure demonstration. Use the available tools when relevant, cite tool evidence clearly, and treat nuclear-domain material as training and reference information rather than real-time operational authority.',
        tools: ['procedure_lookup', 'procedure_search', 'wiki_lookup', 'eal_classify'],
      }],
    },
    deck: {
      id: 'procedures',
      entries: [
      {
        id: 'e0-to-e3',
        label: 'E-0 → E-3 transition criteria',
        description: 'Decision points and criteria for the transfer from E-0 (reactor trip) to E-3 (SGTR), as a diagram.',
        action: { kind: 'post-message', content: 'Use procedure_lookup to fetch E-0 then E-3. Explain the decision points and decision criteria for the transfer from E-0 to E-3 — which step in E-0 triggers the branch, what symptoms qualify, what disqualifies it (faulted SG vs. ruptured SG), and what E-3 does first. Show the relevant steps as a mermaid flowchart.' },
      },
      {
        id: 'sgtr-recovery',
        label: 'SGTR recovery: pick ECA-3.1 vs 3.2 vs 3.3',
        description: 'Cross-procedure: how the operator chooses between the three SGTR recovery paths.',
        action: { kind: 'post-message', content: 'Use procedure_lookup with mode=summary to fetch E-3, then ECA-3.1, then ECA-3.2, then ECA-3.3 (four calls). Then produce a mermaid flowchart showing how an operator decides between the three recovery procedures once an SGTR is confirmed in E-3. Label each branch with the actual entry criterion (subcooling margin state, pressurizer pressure control, etc.) drawn from the procedures.' },
      },
      {
        id: 'diagnose-e1-e2-e3',
        label: 'Diagnose E-1 vs E-2 vs E-3 from E-0',
        description: 'How E-0 distinguishes a LOCA, a faulted SG, and a ruptured SG.',
        action: { kind: 'post-message', content: 'Use procedure_lookup to fetch E-0, E-1, E-2, and E-3 (mode=summary is fine). Then explain how an operator in E-0 distinguishes between transitioning to E-1 (LOCA), E-2 (faulted SG), and E-3 (SGTR) — which symptoms point to which procedure, and what the disambiguation order is. Render the decision tree as a mermaid flowchart.' },
      },
      {
        id: 'station-blackout',
        label: 'Station-blackout vs E-0',
        description: 'What in E-0 becomes unavailable under ECA-0.0, and how the procedure copes.',
        action: { kind: 'post-message', content: 'Use procedure_lookup to fetch E-0 and ECA-0.0. Identify the E-0 verification steps that cannot be performed once both AC trains are de-energized (e.g. ECCS, Phase-A isolation, charging pumps), and explain what ECA-0.0 substitutes (TDAFW, natural circulation, DC load shedding, RCP seal-LOCA risk). Summarise as a side-by-side table plus a short mermaid diagram of the SBO coping timeline.' },
      },
      {
        id: 'csf-red-path',
        label: 'CSF red-path priority',
        description: 'Compare the five red-path Function Restoration procedures.',
        action: { kind: 'post-message', content: 'Use procedure_lookup to fetch FR-S.1, FR-C.1, FR-H.1, FR-P.1, and FR-Z.1 (mode=summary). Build a comparison table with columns: CSF, entry trigger, first immediate action, and the EOP it would override. Then explain in 2-3 sentences why CSF status trees take priority over the active EOP, and render a mermaid diagram showing how a red-path CSF interrupts the running E-procedure.' },
      },
      {
        id: 'eal-classify-sgtr',
        label: 'EAL classify SGTR scenario',
        description: 'Classify a steam-generator-tube-rupture scenario against NEI 99-01 EALs.',
        action: { kind: 'post-message', content: 'Use the eal_classify tool to classify a scenario where a steam generator tube rupture is detected with primary-to-secondary leakage of 50 gpm and rising secondary-side radiation on SG-B. What EAL class does this map to, and why?' },
      },
      {
        id: 'tag-catalogue',
        label: 'Reference: Tag catalogue index',
        description: 'Fetch a wiki reference page (not a procedure) — the tag-catalogue index.',
        action: { kind: 'post-message', content: 'Use the wiki_lookup tool with type "tag-catalogue" and id "index" to fetch the tag-catalogue index, then summarise what systems are covered and what each entry represents.' },
      },
      ],
    },
  },
  {
    id: 'biometrics',
    title: 'Biometrics Demo',
    blurb:
      'Webcam-based attention tracking. The agent observes your face for a moment, narrates what it sees, then releases the camera. You\'ll be asked to consent to webcam access the first time. Re-open this list any time from the 🪄 icon in the room header.',
    requiredTools: ['biometrics_start', 'biometrics_read', 'biometrics_stop'],
    room: {
      id: 'biometrics',
      name: 'Demo: Biometrics',
      deliveryMode: 'manual',
      packs: ['biometrics'],
      agents: [{
        name: 'Biometrics Guide',
        persona: 'You facilitate this biometrics demonstration. Follow the selected request, use the available biometrics tools in the requested lifecycle order, report only what the tool evidence supports, and release the camera promptly.',
        tools: ['biometrics_start', 'biometrics_read', 'biometrics_stop'],
      }],
    },
    deck: {
      id: 'biometrics',
      entries: [
      {
        id: 'watch-me',
        label: 'Watch me',
        description: 'Agent starts the camera, reads one frame, narrates, and stops.',
        action: { kind: 'post-message', content: 'Watch me for a moment using the biometrics tools, then tell me what you see — attention level, dominant expression, anything notable. Use biometrics_start, then biometrics_read with the captureId you got, then biometrics_stop with the same captureId.' },
      },
      {
        id: 'coach-focus',
        label: 'Coach my focus',
        description: 'Agent observes and offers one piece of concrete focus advice.',
        action: { kind: 'post-message', content: 'Use the biometrics tools to observe me for a moment, then give me one concrete piece of advice for staying focused based on what you see. One reading, one observation, one tip.' },
      },
      {
        id: 'quick-check',
        label: 'Quick check',
        description: 'Just a quick glance — am I still here?',
        action: { kind: 'post-message', content: 'Use biometrics_start, biometrics_read, then biometrics_stop to quickly check whether I\'m still at my desk and looking attentive. One sentence reply.' },
      },
      ],
    },
  },
  {
    id: 'aviation',
    title: 'Aviation Demo',
    blurb:
      'Live VATSIM network data — real human pilots flying simulators right now — plus offshore platform geodata, rendered on an inline map. Re-open this list any time from the 🪄 icon in the room header.',
    requiredTools: ['vatsim_arrivals', 'norway_platforms'],
    room: {
      id: 'aviation',
      name: 'Demo: Aviation',
      deliveryMode: 'manual',
      packs: ['demos'],
      agents: [{
        name: 'Aviation Guide',
        persona: 'You facilitate this live-data demonstration. Use the requested tools, distinguish live observations from interpretation, and present geospatial results clearly.',
        tools: ['vatsim_arrivals', 'norway_platforms'],
      }],
    },
    deck: {
      id: 'aviation',
      entries: [
      {
        id: 'heathrow-arrivals',
        label: 'Arrivals into Heathrow',
        description: 'Live VATSIM arrivals to EGLL on a map.',
        action: { kind: 'post-message', content: 'Use the vatsim_arrivals tool with ICAO EGLL and show me live arrivals to London Heathrow on a map.' },
      },
      {
        id: 'jfk-arrivals',
        label: 'Arrivals into JFK',
        description: 'Live VATSIM arrivals to KJFK on a map.',
        action: { kind: 'post-message', content: 'Use the vatsim_arrivals tool with ICAO KJFK and show me live arrivals to New York JFK on a map.' },
      },
      {
        id: 'norway-platforms',
        label: 'Norwegian oil platforms',
        description: 'Every major NCS platform plotted on a map.',
        action: { kind: 'post-message', content: 'Use the norway_platforms tool and show me all major Norwegian Continental Shelf oil & gas platforms on a map.' },
      },
      {
        id: 'oslo-arrivals',
        label: 'Arrivals into Oslo',
        description: 'Live VATSIM arrivals to ENGM on a map.',
        action: { kind: 'post-message', content: 'Use the vatsim_arrivals tool with ICAO ENGM and show me live arrivals to Oslo Gardermoen on a map.' },
      },
      ],
    },
  },
]

export const getDemo = (id: string): DemoDefinition | undefined =>
  DEMO_CATALOG.find(demo => demo.id === id)
