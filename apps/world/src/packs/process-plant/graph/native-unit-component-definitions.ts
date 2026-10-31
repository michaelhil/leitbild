import { z } from 'zod'
import type { ComponentDefinition, ComponentKind, ComponentVariableDescriptor } from './model.ts'
import { localVariablePathSchema, processQuantitySchema, processUnitSchema, variableDisciplineSchema } from './model.ts'
import { defineComponent, variable } from './component-definition-helpers.ts'
import { aspect, fixedSemantics, ratioMeasurandSchema } from './semantics.ts'

// Equipment of a Plant whose physics runs in a native unit (the LD-01 `ld01-unit` child), not in this
// Pack's TS solver. No other kind fits such equipment: every TS kind declares the variables its own
// behaviour solves, which a native unit's channels do not deliver, and a variable no channel answers would
// need a stand-in value. These kinds declare only what their Plant's channels deliver: each instance lists its
// readings and its commands (scripts/reference-design-operating-graph.ts compiles them from the packets, with
// the tag map that binds every one to a channel or a kernel command). Their semantics say what the equipment
// is and does, so the generated displays draw it like any other Plant.

const readingSchema = z.object({
  path: localVariablePathSchema,
  label: z.string().min(1),
  kind: z.enum(['state', 'derived', 'discrete', 'alarm']),
  discipline: variableDisciplineSchema,
  quantity: processQuantitySchema,
  unit: processUnitSchema,
  measurand: ratioMeasurandSchema.optional(),
}).strict()

const commandSchema = z.object({
  path: localVariablePathSchema,
  label: z.string().min(1),
  actuation: z.enum(['command', 'faultInjection']),
}).strict()

const observedSchema = z.object({
  readings: z.array(readingSchema),
  commands: z.array(commandSchema).default([]),
  /** The readings an operator reads first, most important first. */
  keyValues: z.array(localVariablePathSchema).default([]),
}).strict()
type Observed = z.infer<typeof observedSchema>

const observedVariables = ({ parameters }: { readonly parameters: unknown }): ReadonlyArray<ComponentVariableDescriptor> => {
  const observed = parameters as Observed
  return [
    ...observed.readings.map(reading => variable({ ...reading, writable: false, publish: 'telemetry' })),
    ...observed.commands.map(command => variable({
      path: command.path, label: command.label, kind: 'control', discipline: 'control', writable: true, publish: 'telemetry',
      actuation: command.actuation, quantity: 'boolean', unit: 'boolean',
    })),
  ]
}

const coolant = { kind: 'hydraulicThermal', circuit: 'coolant' } as const

export const nativeUnitComponentDefinitions: ReadonlyArray<ComponentDefinition> = [
  defineComponent({
    // A coolant region of the unit's hydraulic network: a plenum, a leg, a downcomer.
    kind: 'nativeCoolantVolume' as ComponentKind,
    label: 'Coolant volume',
    ports: { inlet: { ...coolant, direction: 'in' }, outlet: { ...coolant, direction: 'out' } },
    parametersSchema: observedSchema.extend({ volumeM3: z.number().finite().positive(), elevationM: z.number().finite() }).strict(),
    semantics: parameters => fixedSemantics({ keyValues: (parameters as Observed).keyValues })(parameters),
    variables: [],
    resolveAdditionalVariables: observedVariables,
  }),
  defineComponent({
    // The core: the regions the fission source heats, read by its released power.
    kind: 'nativeReactorCore' as ComponentKind,
    label: 'Reactor core',
    ports: { inlet: { ...coolant, direction: 'in' }, outlet: { ...coolant, direction: 'out' } },
    parametersSchema: observedSchema.extend({ volumeM3: z.number().finite().positive(), powerReading: localVariablePathSchema }).strict(),
    semantics: parameters => {
      const core = parameters as Observed & { readonly powerReading: string }
      return fixedSemantics({ keyValues: core.keyValues, energy: [{ role: 'source', circuit: 'coolant', rate: core.powerReading }] })(parameters)
    },
    variables: [],
    resolveAdditionalVariables: observedVariables,
  }),
  defineComponent({
    // A steam generator: its primary region gives the loop's heat to its lumped secondary, whose steam leaves to the turbine.
    kind: 'nativeSteamGenerator' as ComponentKind,
    label: 'Steam generator',
    ports: {
      primaryInlet: { kind: 'hydraulicThermal', direction: 'in', circuit: 'primary' },
      primaryOutlet: { kind: 'hydraulicThermal', direction: 'out', circuit: 'primary' },
      steamOutlet: { kind: 'steam', direction: 'out', circuit: 'secondary' },
    },
    parametersSchema: observedSchema.extend({ primaryVolumeM3: z.number().finite().positive(), secondaryVolumeM3: z.number().finite().positive() }).strict(),
    semantics: parameters => fixedSemantics({ keyValues: (parameters as Observed).keyValues, energy: [{ role: 'transfer', from: 'primary', to: 'secondary' }] })(parameters),
    variables: [],
    resolveAdditionalVariables: observedVariables,
  }),
  defineComponent({
    // A reactor coolant pump, running while its shaft turns.
    kind: 'nativeCoolantPump' as ComponentKind,
    label: 'Reactor coolant pump',
    ports: { suction: { ...coolant, direction: 'in' }, discharge: { ...coolant, direction: 'out' } },
    parametersSchema: observedSchema.extend({ speedReading: localVariablePathSchema }).strict(),
    semantics: parameters => {
      const pump = parameters as Observed & { readonly speedReading: string }
      return fixedSemantics({ keyValues: pump.keyValues, aspects: [aspect('running', { variable: pump.speedReading, reading: 'aboveZero' })] })(parameters)
    },
    variables: [],
    resolveAdditionalVariables: observedVariables,
  }),
  defineComponent({
    // The pressurizer: its surge line joins a hot leg both ways, its spray enters from a cold leg.
    kind: 'nativePressurizer' as ComponentKind,
    label: 'Pressurizer',
    ports: { surgeLine: { ...coolant, direction: 'bidirectional' }, sprayInlet: { ...coolant, direction: 'in' } },
    parametersSchema: observedSchema.extend({ volumeM3: z.number().finite().positive(), bottomM: z.number().finite(), topM: z.number().finite() }).strict()
      .refine(pressurizer => pressurizer.topM > pressurizer.bottomM, 'a pressurizer top above its bottom'),
    semantics: parameters => fixedSemantics({ keyValues: (parameters as Observed).keyValues })(parameters),
    variables: [],
    resolveAdditionalVariables: observedVariables,
  }),
  defineComponent({
    // The turbine-generator: it takes work out of the steam and exports it, running while its shaft turns.
    kind: 'nativeTurbineGenerator' as ComponentKind,
    label: 'Turbine-generator',
    ports: { steamInlet: { kind: 'steam', direction: 'in', circuit: 'steam' } },
    parametersSchema: observedSchema.extend({ powerReading: localVariablePathSchema, speedReading: localVariablePathSchema }).strict(),
    semantics: parameters => {
      const generator = parameters as Observed & { readonly powerReading: string; readonly speedReading: string }
      return fixedSemantics({
        keyValues: generator.keyValues,
        energy: [{ role: 'sink', circuit: 'steam', rate: generator.powerReading }],
        aspects: [aspect('running', { variable: generator.speedReading, reading: 'aboveZero' })],
      })(parameters)
    },
    variables: [],
    resolveAdditionalVariables: observedVariables,
  }),
  defineComponent({
    // The unit's protection: its divisions, latches, permissive contacts and requests, and its manual inputs.
    kind: 'nativeProtectionSystem' as ComponentKind,
    label: 'Protection system',
    ports: {},
    parametersSchema: observedSchema,
    semantics: parameters => fixedSemantics({ keyValues: (parameters as Observed).keyValues })(parameters),
    variables: [],
    resolveAdditionalVariables: observedVariables,
  }),
]
