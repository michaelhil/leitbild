import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { z } from 'zod'

const packageJsonPath = resolve(import.meta.dir, '../../../package.json')
const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { readonly version?: unknown }
const implementationVersion = typeof packageJson.version === 'string' ? packageJson.version : 'unknown'

const hrefSchema = z.object({
  href: z.string().url(),
})

const hrefTemplateSchema = z.object({
  hrefTemplate: z.string().min(1),
})

export const discoveryManifestSchema = z.object({
  manifestSchemaVersion: z.literal('1.0.0'),
  generatedAt: z.string().datetime(),
  identity: z.object({
    implementation: z.literal('leitbild'),
    implementationVersion: z.string().min(1),
    title: z.literal('Leitbild'),
    operator: z.string().min(1),
    deploymentId: z.string().min(1),
  }),
  auth: z.object({
    posture: z.literal('unauthenticated'),
    modes: z.array(z.literal('none')),
    notes: z.string().min(1),
  }),
  cors: z.object({
    posture: z.literal('not-configured'),
    browserDirectAccess: z.literal(false),
    notes: z.string().min(1),
  }),
  links: z.object({
    self: hrefSchema,
    scenarios: hrefSchema,
    controlInstances: hrefSchema,
    controlInstance: hrefTemplateSchema,
    controlInstanceSnapshot: hrefTemplateSchema,
    controlInstanceEvents: hrefTemplateSchema,
    controlInstancePackQueries: hrefTemplateSchema,
    controlInstanceCommands: hrefTemplateSchema,
    controlInstanceSignals: hrefTemplateSchema,
    controlInstanceReset: hrefTemplateSchema,
    controlInstanceClock: hrefTemplateSchema,
    realtime: hrefSchema.merge(hrefTemplateSchema),
    mapCapabilities: hrefSchema,
    mapStyle: hrefSchema,
    docs: hrefSchema,
  }),
  actions: z.object({
    controlInstanceCreate: z.object({
      status: z.literal('implemented'),
      linkRel: z.literal('controlInstances'),
      method: z.literal('POST'),
      description: z.string().min(1),
    }),
    controlInstanceEnsure: z.object({
      status: z.literal('implemented'),
      linkRel: z.literal('controlInstance'),
      method: z.literal('POST'),
      description: z.string().min(1),
    }),
    controlInstanceDelete: z.object({
      status: z.literal('implemented'),
      linkRel: z.literal('controlInstance'),
      method: z.literal('DELETE'),
      description: z.string().min(1),
    }),
    controlInstanceReset: z.object({
      status: z.literal('implemented'),
      linkRel: z.literal('controlInstanceReset'),
      method: z.literal('POST'),
      description: z.string().min(1),
    }),
    controlInstanceClockUpdate: z.object({
      status: z.literal('implemented'),
      linkRel: z.literal('controlInstanceClock'),
      method: z.literal('POST'),
      description: z.string().min(1),
    }),
  }),
  protocols: z.object({
    http: z.object({
      status: z.literal('implemented'),
      baseUrl: z.string().url(),
      apiBasePath: z.literal('/api'),
      version: z.literal('v1'),
      contentType: z.literal('application/json'),
    }),
    webSocket: z.object({
      status: z.literal('implemented'),
      messageEncoding: z.literal('json'),
      linkRel: z.literal('realtime'),
    }),
  }),
  realtime: z.object({
    status: z.literal('implemented'),
    model: z.literal('one-mixed-stream-per-control-instance'),
    transportLinkRel: z.literal('realtime'),
    serverMessages: z.array(z.object({
      type: z.enum(['realtime.ready', 'events']),
      description: z.string().min(1),
    })),
    durableCatchup: z.object({
      linkRel: z.literal('controlInstanceEvents'),
      description: z.string().min(1),
    }),
  }),
  clientIdentification: z.object({
    status: z.literal('planned'),
    headers: z.object({
      'User-Agent': z.string().min(1),
      'Leitbild-Client': z.string().min(1),
    }),
    notes: z.string().min(1),
  }),
  capabilities: z.object({
    status: z.literal('implemented'),
    deploymentLevel: z.object({
      scenarioCatalog: z.literal(true),
      controlInstanceRegistry: z.literal(true),
      controlInstanceLifecycle: z.literal(true),
      clockControl: z.literal(true),
      mapCapabilityManifest: z.literal(true),
      durableEventCatchup: z.literal(true),
      liveChangeFeed: z.literal(true),
      packQueries: z.literal(true),
      commands: z.literal(true),
      interactionSignals: z.literal(true),
    }),
  }),
  wikiRefs: z.object({
    status: z.literal('planned'),
    scope: z.literal('per-control-instance-pack'),
    notes: z.string().min(1),
  }),
  limits: z.object({
    status: z.literal('not-published'),
    notes: z.string().min(1),
  }),
  planned: z.object({
    controlInstanceCapabilities: z.object({
      hrefTemplate: z.string().min(1),
      expectedContents: z.array(z.string().min(1)),
    }),
    authModes: z.array(z.literal('bearer')),
    cors: z.object({
      allowedOrigins: z.array(z.literal('deployment-configured')),
      allowedMethods: z.array(z.enum(['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'])),
      exposedHeaders: z.array(z.literal('ETag')),
    }),
    clientIdentificationEnforcement: z.literal(true),
    realtimeChannelFiltering: z.object({
      plannedNames: z.array(z.enum(['journal', 'alarms', 'signals', 'telemetry'])),
    }),
    sourceTelemetryThrottling: z.literal(true),
  }),
})

export type DiscoveryManifest = z.infer<typeof discoveryManifestSchema>

const normalizeBaseUrl = (baseUrl: string): string => {
  const url = new URL(baseUrl)
  url.pathname = url.pathname.replace(/\/+$/, '')
  url.search = ''
  url.hash = ''
  return url.toString().replace(/\/$/, '')
}

const joinUrl = (baseUrl: string, path: string): string =>
  `${baseUrl}${path.startsWith('/') ? path : `/${path}`}`

const websocketBaseUrl = (baseUrl: string): string => {
  const url = new URL(baseUrl)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url.toString().replace(/\/$/, '')
}

export const buildManifest = (baseUrl: string): DiscoveryManifest => {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl)
  const wsBaseUrl = websocketBaseUrl(normalizedBaseUrl)
  const controlInstanceBase = joinUrl(normalizedBaseUrl, '/api/control-instances/{id}')
  const manifest = {
    manifestSchemaVersion: '1.0.0',
    generatedAt: new Date().toISOString(),
    identity: {
      implementation: 'leitbild',
      implementationVersion,
      title: 'Leitbild',
      operator: process.env.LEITBILD_OPERATOR ?? 'unknown',
      deploymentId: process.env.LEITBILD_DEPLOYMENT_ID ?? 'unknown',
    },
    auth: {
      posture: 'unauthenticated',
      modes: ['none'],
      notes: 'V1 publishes discovery without authentication. API write paths are still validated at the request boundary.',
    },
    cors: {
      posture: 'not-configured',
      browserDirectAccess: false,
      notes: 'V1 does not publish a cross-origin browser access contract.',
    },
    links: {
      self: { href: joinUrl(normalizedBaseUrl, '/.well-known/leitbild') },
      scenarios: { href: joinUrl(normalizedBaseUrl, '/api/scenarios') },
      controlInstances: { href: joinUrl(normalizedBaseUrl, '/api/control-instances') },
      controlInstance: { hrefTemplate: controlInstanceBase },
      controlInstanceSnapshot: { hrefTemplate: `${controlInstanceBase}/snapshot` },
      controlInstanceEvents: { hrefTemplate: `${controlInstanceBase}/events{?afterSeq}` },
      controlInstancePackQueries: { hrefTemplate: `${controlInstanceBase}/queries` },
      controlInstanceCommands: { hrefTemplate: `${controlInstanceBase}/commands` },
      controlInstanceSignals: { hrefTemplate: `${controlInstanceBase}/signals` },
      controlInstanceReset: { hrefTemplate: `${controlInstanceBase}/reset` },
      controlInstanceClock: { hrefTemplate: `${controlInstanceBase}/clock` },
      realtime: {
        href: joinUrl(wsBaseUrl, '/ws'),
        hrefTemplate: `${joinUrl(wsBaseUrl, '/ws')}?controlInstance={id}`,
      },
      mapCapabilities: { href: joinUrl(normalizedBaseUrl, '/map/capabilities.json') },
      mapStyle: { href: joinUrl(normalizedBaseUrl, '/map/style.json') },
      docs: { href: 'https://github.com/michaelhil/leitbild/blob/main/docs/discovery.md' },
    },
    actions: {
      controlInstanceCreate: {
        status: 'implemented',
        linkRel: 'controlInstances',
        method: 'POST',
        description: 'Create a Control Instance from an optional scenario id.',
      },
      controlInstanceEnsure: {
        status: 'implemented',
        linkRel: 'controlInstance',
        method: 'POST',
        description: 'Ensure a named Control Instance exists, optionally with a scenario id.',
      },
      controlInstanceDelete: {
        status: 'implemented',
        linkRel: 'controlInstance',
        method: 'DELETE',
        description: 'Delete an idle Control Instance. The server rejects deletion while clients are connected.',
      },
      controlInstanceReset: {
        status: 'implemented',
        linkRel: 'controlInstanceReset',
        method: 'POST',
        description: 'Reset a Control Instance to a scenario baseline.',
      },
      controlInstanceClockUpdate: {
        status: 'implemented',
        linkRel: 'controlInstanceClock',
        method: 'POST',
        description: 'Update pause state, speed, or current time for a Control Instance.',
      },
    },
    protocols: {
      http: {
        status: 'implemented',
        baseUrl: normalizedBaseUrl,
        apiBasePath: '/api',
        version: 'v1',
        contentType: 'application/json',
      },
      webSocket: {
        status: 'implemented',
        messageEncoding: 'json',
        linkRel: 'realtime',
      },
    },
    realtime: {
      status: 'implemented',
      model: 'one-mixed-stream-per-control-instance',
      transportLinkRel: 'realtime',
      serverMessages: [
        {
          type: 'realtime.ready',
          description: 'Sent when a client joins an existing Control Instance stream.',
        },
        {
          type: 'events',
          description: 'Batch of Control Instance Domain Events from the live feed.',
        },
      ],
      durableCatchup: {
        linkRel: 'controlInstanceEvents',
        description: 'Returns durable journal events after a sequence number.',
      },
    },
    clientIdentification: {
      status: 'planned',
      headers: {
        'User-Agent': 'Standard HTTP user agent.',
        'Leitbild-Client': 'Structured client identity, for example: samsinn; version="0.1.0".',
      },
      notes: 'Clients may send these headers now, but Leitbild does not yet enforce, persist, authorize, or rate-limit by them.',
    },
    capabilities: {
      status: 'implemented',
      deploymentLevel: {
        scenarioCatalog: true,
        controlInstanceRegistry: true,
        controlInstanceLifecycle: true,
        clockControl: true,
        mapCapabilityManifest: true,
        durableEventCatchup: true,
        liveChangeFeed: true,
        packQueries: true,
        commands: true,
        interactionSignals: true,
      },
    },
    wikiRefs: {
      status: 'planned',
      scope: 'per-control-instance-pack',
      notes: 'Authoritative wiki recommendations should live on the planned per-Control-Instance capability manifest because active packs and scenarios vary by Control Instance.',
    },
    limits: {
      status: 'not-published',
      notes: 'V1 does not publish rate, size, or retention limits.',
    },
    planned: {
      controlInstanceCapabilities: {
        hrefTemplate: `${controlInstanceBase}/capabilities`,
        expectedContents: [
          'active packs',
          'scenario id',
          'accepted command kinds',
          'pack query kinds',
          'realtime channel support',
          'recommended wiki refs',
        ],
      },
      authModes: ['bearer'],
      cors: {
        allowedOrigins: ['deployment-configured'],
        allowedMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
        exposedHeaders: ['ETag'],
      },
      clientIdentificationEnforcement: true,
      realtimeChannelFiltering: {
        plannedNames: ['journal', 'alarms', 'signals', 'telemetry'],
      },
      sourceTelemetryThrottling: true,
    },
  } satisfies DiscoveryManifest
  return discoveryManifestSchema.parse(manifest)
}
