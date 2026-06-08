import dgram from 'node:dgram'
import { nowIso, type GeoJsonPoint, type IsoTimestamp } from '../../../core/model/index.ts'
import { geoPointFromLonLat } from '../../../core/model/index.ts'
import type { DroneAutopilot, DroneNavigationKind } from '../model.ts'

export const mavCmd = {
  navWaypoint: 16,
  navLoiterUnlim: 17,
  navReturnToLaunch: 20,
  navLand: 21,
  navTakeoff: 22,
  doSetMode: 176,
  doReposition: 192,
  doPauseContinue: 193,
  componentArmDisarm: 400,
  missionStart: 300,
  doGimbalManagerPitchYaw: 1000,
  navFencePolygonVertexInclusion: 5001,
} as const

const mavMsg = {
  heartbeat: 0,
  sysStatus: 1,
  systemTime: 2,
  paramValue: 22,
  paramSet: 23,
  gpsRawInt: 24,
  attitude: 30,
  localPositionNed: 32,
  globalPositionInt: 33,
  missionCurrent: 42,
  missionCount: 44,
  missionClearAll: 45,
  missionItemReached: 46,
  missionAck: 47,
  missionRequest: 40,
  missionRequestInt: 51,
  manualControl: 69,
  missionItemInt: 73,
  commandInt: 75,
  commandLong: 76,
  commandAck: 77,
  setPositionTargetGlobalInt: 86,
  batteryStatus: 147,
  statustext: 253,
} as const

const crcExtra: Readonly<Record<number, number>> = {
  [mavMsg.heartbeat]: 50,
  [mavMsg.sysStatus]: 124,
  [mavMsg.systemTime]: 137,
  [mavMsg.paramValue]: 220,
  [mavMsg.paramSet]: 168,
  [mavMsg.gpsRawInt]: 24,
  [mavMsg.attitude]: 39,
  [mavMsg.localPositionNed]: 185,
  [mavMsg.globalPositionInt]: 104,
  [mavMsg.missionRequest]: 230,
  [mavMsg.missionCurrent]: 28,
  [mavMsg.missionCount]: 221,
  [mavMsg.missionClearAll]: 232,
  [mavMsg.missionItemReached]: 11,
  [mavMsg.missionAck]: 153,
  [mavMsg.missionRequestInt]: 196,
  [mavMsg.manualControl]: 243,
  [mavMsg.missionItemInt]: 38,
  [mavMsg.commandInt]: 158,
  [mavMsg.commandLong]: 152,
  [mavMsg.commandAck]: 143,
  [mavMsg.setPositionTargetGlobalInt]: 5,
  [mavMsg.batteryStatus]: 154,
  [mavMsg.statustext]: 83,
}

const mavAutopilot = {
  ardupilotMega: 3,
  px4: 12,
} as const

const mavModeFlagSafetyArmed = 128
const mavlink1Magic = 0xfe
const mavlink2Magic = 0xfd
const setPositionTargetTypeMask = {
  ignorePositionX: 1 << 0,
  ignorePositionY: 1 << 1,
  ignorePositionZ: 1 << 2,
  ignoreVelocityX: 1 << 3,
  ignoreVelocityY: 1 << 4,
  ignoreVelocityZ: 1 << 5,
  ignoreAccelerationX: 1 << 6,
  ignoreAccelerationY: 1 << 7,
  ignoreAccelerationZ: 1 << 8,
  ignoreYaw: 1 << 10,
  ignoreYawRate: 1 << 11,
} as const

export interface MavlinkDecodedFrame {
  readonly systemId: number
  readonly componentId: number
  readonly messageId: number
  readonly payload: Buffer
}

export interface MavlinkEndpoint {
  readonly host: string
  readonly port: number
  readonly localPort: number
}

export interface MavlinkAttitude {
  readonly rollDeg: number
  readonly pitchDeg: number
  readonly yawDeg: number
  readonly rollRateDegPerSec?: number
  readonly pitchRateDegPerSec?: number
  readonly yawRateDegPerSec?: number
}

export interface MavlinkPose {
  readonly point: GeoJsonPoint
  readonly altitudeM: number
  readonly relativeAltitudeM?: number
  readonly headingDeg: number
  readonly observedAt: IsoTimestamp
}

export interface MavlinkVelocity {
  readonly eastMps: number
  readonly northMps: number
  readonly downMps: number
}

export interface MavlinkBattery {
  readonly remainingPercent?: number
  readonly voltageV?: number
  readonly currentA?: number
  readonly consumedMah?: number
}

export interface MavlinkMissionStatus {
  readonly currentSeq?: number
  readonly total?: number
  readonly updatedAt: IsoTimestamp
}

export interface MavlinkVehicleState {
  readonly systemId: number
  readonly componentId: number
  readonly autopilot?: DroneAutopilot
  readonly baseMode?: number
  readonly customMode?: number
  readonly systemStatus?: number
  readonly armed: boolean
  readonly navigation: {
    readonly kind: DroneNavigationKind
    readonly mode: string
  }
  readonly pose?: MavlinkPose
  readonly velocity?: MavlinkVelocity
  readonly attitude?: MavlinkAttitude
  readonly battery?: MavlinkBattery
  readonly mission?: MavlinkMissionStatus
  readonly lastHeartbeatAt?: IsoTimestamp
  readonly lastMessageAt: IsoTimestamp
  readonly lastStatusText?: string
}

export interface MavlinkCommandAck {
  readonly command: number
  readonly result: number
  readonly accepted: boolean
}

export interface MavlinkMissionItem {
  readonly seq: number
  readonly command: number
  readonly frame: number
  readonly x: number
  readonly y: number
  readonly z: number
  readonly param1: number
  readonly param2: number
  readonly param3: number
  readonly param4: number
  readonly autocontinue: boolean
  readonly missionType: number
}

export interface MavlinkClient {
  readonly open: () => Promise<void>
  readonly close: () => Promise<void>
  readonly vehicles: () => ReadonlyArray<MavlinkVehicleState>
  readonly vehicle: (systemId: number) => MavlinkVehicleState | undefined
  readonly subscribe: (handler: () => void) => () => void
  readonly commandLong: (config: {
    readonly targetSystem: number
    readonly targetComponent?: number
    readonly command: number
    readonly params?: readonly number[]
    readonly timeoutMs?: number
  }) => Promise<MavlinkCommandAck>
  readonly commandInt: (config: {
    readonly targetSystem: number
    readonly targetComponent?: number
    readonly command: number
    readonly frame: number
    readonly x: number
    readonly y: number
    readonly z: number
    readonly params?: readonly number[]
    readonly timeoutMs?: number
  }) => Promise<MavlinkCommandAck>
  readonly manualControl: (config: {
    readonly targetSystem: number
    readonly x: number
    readonly y: number
    readonly z: number
    readonly r: number
    readonly buttons?: number
  }) => Promise<void>
  readonly setGlobalPositionTarget: (config: {
    readonly targetSystem: number
    readonly lat: number
    readonly lon: number
    readonly altitudeM: number
    readonly velocityNorthMps?: number
    readonly velocityEastMps?: number
    readonly velocityDownMps?: number
    readonly yawDeg?: number
  }) => Promise<void>
  readonly uploadMission: (config: {
    readonly targetSystem: number
    readonly targetComponent?: number
    readonly missionType: number
    readonly items: ReadonlyArray<MavlinkMissionItem>
    readonly timeoutMs?: number
  }) => Promise<void>
  readonly clearMission: (config: {
    readonly targetSystem: number
    readonly targetComponent?: number
    readonly missionType: number
    readonly timeoutMs?: number
  }) => Promise<void>
  readonly setParameter: (config: {
    readonly targetSystem: number
    readonly targetComponent?: number
    readonly name: string
    readonly value: number
    readonly paramType: number
  }) => Promise<void>
}

export interface MavlinkClientConfig {
  readonly endpoint: MavlinkEndpoint
  readonly sourceSystemId?: number
  readonly sourceComponentId?: number
  readonly heartbeatTimeoutMs?: number
  readonly commandTimeoutMs?: number
}

export interface SharedMavlinkClientLease {
  readonly client: MavlinkClient
  readonly release: () => Promise<void>
}

const endpointPattern = /^udp:\/\/([^:/]+):(\d+)(?:\?localPort=(\d+))?$/

const isLoopbackHost = (host: string): boolean =>
  host === 'localhost' || host === '127.0.0.1'

export const parseMavlinkEndpoint = (value: string): MavlinkEndpoint => {
  const match = endpointPattern.exec(value)
  if (!match) throw new Error(`invalid MAVLink endpoint "${value}"; expected udp://host:port?localPort=port`)
  const port = Number(match[2])
  const localPort = match[3] === undefined ? port : Number(match[3])
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) throw new Error(`invalid MAVLink remote port: ${match[2]}`)
  if (!Number.isInteger(localPort) || localPort <= 0 || localPort > 65_535) throw new Error(`invalid MAVLink local port: ${match[3] ?? match[2]}`)
  if (isLoopbackHost(match[1]!) && port === localPort) {
    throw new Error(`invalid MAVLink endpoint "${value}"; loopback remote port must differ from localPort`)
  }
  return {
    host: match[1]!,
    port,
    localPort,
  }
}

interface SharedMavlinkClientEntry {
  readonly client: MavlinkClient
  readonly openPromise: Promise<void>
  refCount: number
  closingPromise?: Promise<void>
}

const sharedMavlinkClients = new Map<string, SharedMavlinkClientEntry>()

const sharedMavlinkClientKey = (config: MavlinkClientConfig): string => {
  const endpoint = config.endpoint
  const sourceSystemId = config.sourceSystemId ?? 245
  const sourceComponentId = config.sourceComponentId ?? 190
  return `${endpoint.host}:${endpoint.port}:${endpoint.localPort}:${sourceSystemId}:${sourceComponentId}`
}

const closeSharedMavlinkEntry = async (
  key: string,
  entry: SharedMavlinkClientEntry,
): Promise<void> => {
  if (entry.closingPromise === undefined) entry.closingPromise = entry.client.close()
  try {
    await entry.closingPromise
  } finally {
    if (entry.refCount === 0 && sharedMavlinkClients.get(key) === entry) sharedMavlinkClients.delete(key)
  }
}

export const acquireSharedMavlinkClient = async (
  config: MavlinkClientConfig,
): Promise<SharedMavlinkClientLease> => {
  const key = sharedMavlinkClientKey(config)
  const existing = sharedMavlinkClients.get(key)
  if (existing?.closingPromise !== undefined && existing.refCount === 0) {
    await existing.closingPromise
    if (sharedMavlinkClients.get(key) === existing) sharedMavlinkClients.delete(key)
  }

  let entry = sharedMavlinkClients.get(key)
  if (entry === undefined) {
    const client = createMavlinkClient(config)
    entry = {
      client,
      refCount: 0,
      openPromise: client.open(),
    }
    sharedMavlinkClients.set(key, entry)
  }

  entry.refCount += 1
  let released = false

  try {
    await entry.openPromise
  } catch (err) {
    entry.refCount -= 1
    if (entry.refCount === 0 && sharedMavlinkClients.get(key) === entry) {
      try {
        await closeSharedMavlinkEntry(key, entry)
      } catch (closeErr) {
        console.warn(`MAVLink shared client cleanup failed after open error: ${closeErr instanceof Error ? closeErr.message : String(closeErr)}`)
      }
    }
    throw err
  }

  return {
    client: entry.client,
    release: async (): Promise<void> => {
      if (released) return
      released = true
      entry.refCount -= 1
      if (entry.refCount > 0) return
      await closeSharedMavlinkEntry(key, entry)
    },
  }
}

const crcAccumulate = (data: number, crc: number): number => {
  let tmp = data ^ (crc & 0xff)
  tmp ^= tmp << 4
  tmp &= 0xff
  return ((crc >> 8) ^ (tmp << 8) ^ (tmp << 3) ^ (tmp >> 4)) & 0xffff
}

const mavlinkCrc = (buffer: Buffer, extra: number): number => {
  let crc = 0xffff
  for (const byte of buffer) crc = crcAccumulate(byte, crc)
  return crcAccumulate(extra, crc)
}

const writeString = (buffer: Buffer, offset: number, length: number, value: string): void => {
  const encoded = Buffer.from(value, 'ascii')
  encoded.copy(buffer, offset, 0, Math.min(length, encoded.length))
}

const readString = (buffer: Buffer, offset: number, length: number): string => {
  const slice = buffer.subarray(offset, offset + length)
  const zero = slice.indexOf(0)
  return slice.subarray(0, zero < 0 ? slice.length : zero).toString('utf8').trim()
}

const degrees = (radians: number): number => radians * 180 / Math.PI

const normalizeDeg = (value: number): number => {
  const wrapped = value % 360
  return wrapped < 0 ? wrapped + 360 : wrapped
}

const autopilotFromHeartbeat = (value: number): DroneAutopilot | undefined => {
  if (value === mavAutopilot.px4) return 'px4'
  if (value === mavAutopilot.ardupilotMega) return 'ardupilot'
  return undefined
}

const px4ModeName = (customMode: number): { readonly kind: DroneNavigationKind; readonly mode: string } => {
  const mainMode = (customMode >> 16) & 0xff
  const subMode = (customMode >> 24) & 0xff
  if (mainMode === 1) return { kind: 'manual', mode: 'manual' }
  if (mainMode === 2) return { kind: 'manual', mode: 'altitude control' }
  if (mainMode === 3) return { kind: 'manual', mode: 'position control' }
  if (mainMode === 4 && subMode === 2) return { kind: 'takeoff', mode: 'auto takeoff' }
  if (mainMode === 4 && subMode === 3) return { kind: 'hold', mode: 'auto loiter' }
  if (mainMode === 4 && subMode === 4) return { kind: 'mission', mode: 'auto mission' }
  if (mainMode === 4 && subMode === 5) return { kind: 'return_to_launch', mode: 'auto rtl' }
  if (mainMode === 4 && subMode === 6) return { kind: 'land', mode: 'auto land' }
  if (mainMode === 6) return { kind: 'offboard', mode: 'offboard' }
  return { kind: 'unknown', mode: `px4 custom ${customMode}` }
}

const ardupilotModeName = (customMode: number): { readonly kind: DroneNavigationKind; readonly mode: string } => {
  if (customMode === 0) return { kind: 'manual', mode: 'stabilize' }
  if (customMode === 2) return { kind: 'manual', mode: 'alt hold' }
  if (customMode === 3) return { kind: 'mission', mode: 'auto' }
  if (customMode === 4) return { kind: 'guided', mode: 'guided' }
  if (customMode === 5) return { kind: 'hold', mode: 'loiter' }
  if (customMode === 6) return { kind: 'return_to_launch', mode: 'rtl' }
  if (customMode === 9) return { kind: 'land', mode: 'land' }
  if (customMode === 16) return { kind: 'hold', mode: 'poshold' }
  return { kind: 'unknown', mode: `ardupilot custom ${customMode}` }
}

const navigationFromHeartbeat = (
  autopilot: DroneAutopilot | undefined,
  customMode: number,
): { readonly kind: DroneNavigationKind; readonly mode: string } => {
  if (autopilot === 'px4') return px4ModeName(customMode)
  if (autopilot === 'ardupilot') return ardupilotModeName(customMode)
  return { kind: 'unknown', mode: `custom ${customMode}` }
}

const encodeFrame = (config: {
  readonly seq: number
  readonly systemId: number
  readonly componentId: number
  readonly messageId: number
  readonly payload: Buffer
}): Buffer => {
  const extra = crcExtra[config.messageId]
  if (extra === undefined) throw new Error(`missing MAVLink CRC extra for message ${config.messageId}`)
  const header = Buffer.alloc(9)
  header.writeUInt8(config.payload.length, 0)
  header.writeUInt8(0, 1)
  header.writeUInt8(0, 2)
  header.writeUInt8(config.seq, 3)
  header.writeUInt8(config.systemId, 4)
  header.writeUInt8(config.componentId, 5)
  header.writeUIntLE(config.messageId, 6, 3)
  const crc = mavlinkCrc(Buffer.concat([header, config.payload]), extra)
  const frame = Buffer.alloc(12 + config.payload.length)
  frame.writeUInt8(0xfd, 0)
  header.copy(frame, 1)
  config.payload.copy(frame, 10)
  frame.writeUInt16LE(crc, 10 + config.payload.length)
  return frame
}

export const decodeMavlinkFrames = (buffer: Buffer): ReadonlyArray<MavlinkDecodedFrame> => {
  const frames: MavlinkDecodedFrame[] = []
  let offset = 0
  while (offset < buffer.length) {
    const mavlink1Offset = buffer.indexOf(mavlink1Magic, offset)
    const mavlink2Offset = buffer.indexOf(mavlink2Magic, offset)
    const magicOffset = mavlink1Offset < 0
      ? mavlink2Offset
      : mavlink2Offset < 0
        ? mavlink1Offset
        : Math.min(mavlink1Offset, mavlink2Offset)
    if (magicOffset < 0) return frames
    const magic = buffer.readUInt8(magicOffset)
    if (magic === mavlink1Magic) {
      if (magicOffset + 8 > buffer.length) return frames
      const payloadLength = buffer.readUInt8(magicOffset + 1)
      const frameLength = 8 + payloadLength
      if (magicOffset + frameLength > buffer.length) return frames
      const header = buffer.subarray(magicOffset + 1, magicOffset + 6)
      const payload = buffer.subarray(magicOffset + 6, magicOffset + 6 + payloadLength)
      const messageId = header.readUInt8(4)
      const extra = crcExtra[messageId]
      if (extra !== undefined) {
        const expected = mavlinkCrc(Buffer.concat([header, payload]), extra)
        const actual = buffer.readUInt16LE(magicOffset + 6 + payloadLength)
        if (expected === actual) {
          frames.push({
            systemId: header.readUInt8(2),
            componentId: header.readUInt8(3),
            messageId,
            payload: Buffer.from(payload),
          })
        }
      }
      offset = magicOffset + frameLength
      continue
    }
    if (magicOffset + 12 > buffer.length) return frames
    const payloadLength = buffer.readUInt8(magicOffset + 1)
    const incompatFlags = buffer.readUInt8(magicOffset + 2)
    const signatureLength = (incompatFlags & 0x01) === 0x01 ? 13 : 0
    const frameLength = 12 + payloadLength + signatureLength
    if (magicOffset + frameLength > buffer.length) return frames
    const header = buffer.subarray(magicOffset + 1, magicOffset + 10)
    const payload = buffer.subarray(magicOffset + 10, magicOffset + 10 + payloadLength)
    const messageId = header.readUIntLE(6, 3)
    const extra = crcExtra[messageId]
    if (extra !== undefined) {
      const expected = mavlinkCrc(Buffer.concat([header, payload]), extra)
      const actual = buffer.readUInt16LE(magicOffset + 10 + payloadLength)
      if (expected === actual) {
        frames.push({
          systemId: header.readUInt8(4),
          componentId: header.readUInt8(5),
          messageId,
          payload: Buffer.from(payload),
        })
      }
    }
    offset = magicOffset + frameLength
  }
  return frames
}

const commandResultAccepted = (result: number): boolean => result === 0 || result === 5

const messagePayload = {
  heartbeat: (): Buffer => {
    const payload = Buffer.alloc(9)
    payload.writeUInt32LE(0, 0)
    payload.writeUInt8(6, 4)
    payload.writeUInt8(8, 5)
    payload.writeUInt8(0, 6)
    payload.writeUInt8(4, 7)
    payload.writeUInt8(3, 8)
    return payload
  },
  commandLong: (config: {
    readonly targetSystem: number
    readonly targetComponent: number
    readonly command: number
    readonly params: readonly number[]
  }): Buffer => {
    const payload = Buffer.alloc(33)
    for (let index = 0; index < 7; index += 1) payload.writeFloatLE(config.params[index] ?? 0, index * 4)
    payload.writeUInt16LE(config.command, 28)
    payload.writeUInt8(config.targetSystem, 30)
    payload.writeUInt8(config.targetComponent, 31)
    payload.writeUInt8(0, 32)
    return payload
  },
  commandInt: (config: {
    readonly targetSystem: number
    readonly targetComponent: number
    readonly command: number
    readonly frame: number
    readonly x: number
    readonly y: number
    readonly z: number
    readonly params: readonly number[]
  }): Buffer => {
    const payload = Buffer.alloc(35)
    for (let index = 0; index < 4; index += 1) payload.writeFloatLE(config.params[index] ?? 0, index * 4)
    payload.writeInt32LE(config.x, 16)
    payload.writeInt32LE(config.y, 20)
    payload.writeFloatLE(config.z, 24)
    payload.writeUInt16LE(config.command, 28)
    payload.writeUInt8(config.targetSystem, 30)
    payload.writeUInt8(config.targetComponent, 31)
    payload.writeUInt8(config.frame, 32)
    payload.writeUInt8(0, 33)
    payload.writeUInt8(1, 34)
    return payload
  },
  manualControl: (config: {
    readonly targetSystem: number
    readonly x: number
    readonly y: number
    readonly z: number
    readonly r: number
    readonly buttons: number
  }): Buffer => {
    const payload = Buffer.alloc(11)
    payload.writeInt16LE(config.x, 0)
    payload.writeInt16LE(config.y, 2)
    payload.writeInt16LE(config.z, 4)
    payload.writeInt16LE(config.r, 6)
    payload.writeUInt16LE(config.buttons, 8)
    payload.writeUInt8(config.targetSystem, 10)
    return payload
  },
  setPositionTargetGlobalInt: (config: {
    readonly targetSystem: number
    readonly latInt: number
    readonly lonInt: number
    readonly altitudeM: number
    readonly velocityNorthMps?: number
    readonly velocityEastMps?: number
    readonly velocityDownMps?: number
    readonly yawDeg?: number
  }): Buffer => {
    const payload = Buffer.alloc(53)
    const usesVelocity = config.velocityNorthMps !== undefined && config.velocityEastMps !== undefined && config.velocityDownMps !== undefined
    const mask =
      setPositionTargetTypeMask.ignoreAccelerationX
      | setPositionTargetTypeMask.ignoreAccelerationY
      | setPositionTargetTypeMask.ignoreAccelerationZ
      | setPositionTargetTypeMask.ignoreYawRate
      | (usesVelocity
        ? setPositionTargetTypeMask.ignorePositionX
          | setPositionTargetTypeMask.ignorePositionY
          | setPositionTargetTypeMask.ignorePositionZ
        : setPositionTargetTypeMask.ignoreVelocityX
          | setPositionTargetTypeMask.ignoreVelocityY
          | setPositionTargetTypeMask.ignoreVelocityZ)
      | (config.yawDeg === undefined ? setPositionTargetTypeMask.ignoreYaw : 0)
    payload.writeUInt32LE(0, 0)
    payload.writeInt32LE(config.latInt, 4)
    payload.writeInt32LE(config.lonInt, 8)
    payload.writeFloatLE(config.altitudeM, 12)
    payload.writeFloatLE(config.velocityNorthMps ?? 0, 16)
    payload.writeFloatLE(config.velocityEastMps ?? 0, 20)
    payload.writeFloatLE(config.velocityDownMps ?? 0, 24)
    payload.writeFloatLE(0, 28)
    payload.writeFloatLE(0, 32)
    payload.writeFloatLE(0, 36)
    payload.writeFloatLE(config.yawDeg === undefined ? 0 : config.yawDeg * Math.PI / 180, 40)
    payload.writeFloatLE(0, 44)
    payload.writeUInt16LE(mask, 48)
    payload.writeUInt8(config.targetSystem, 50)
    payload.writeUInt8(1, 51)
    payload.writeUInt8(6, 52)
    return payload
  },
  missionCount: (targetSystem: number, targetComponent: number, count: number, missionType: number): Buffer => {
    const payload = Buffer.alloc(5)
    payload.writeUInt16LE(count, 0)
    payload.writeUInt8(targetSystem, 2)
    payload.writeUInt8(targetComponent, 3)
    payload.writeUInt8(missionType, 4)
    return payload
  },
  missionItemInt: (targetSystem: number, targetComponent: number, item: MavlinkMissionItem): Buffer => {
    const payload = Buffer.alloc(38)
    payload.writeFloatLE(item.param1, 0)
    payload.writeFloatLE(item.param2, 4)
    payload.writeFloatLE(item.param3, 8)
    payload.writeFloatLE(item.param4, 12)
    payload.writeInt32LE(item.x, 16)
    payload.writeInt32LE(item.y, 20)
    payload.writeFloatLE(item.z, 24)
    payload.writeUInt16LE(item.seq, 28)
    payload.writeUInt16LE(item.command, 30)
    payload.writeUInt8(targetSystem, 32)
    payload.writeUInt8(targetComponent, 33)
    payload.writeUInt8(item.frame, 34)
    payload.writeUInt8(item.seq === 0 ? 1 : 0, 35)
    payload.writeUInt8(item.autocontinue ? 1 : 0, 36)
    payload.writeUInt8(item.missionType, 37)
    return payload
  },
  missionClearAll: (targetSystem: number, targetComponent: number, missionType: number): Buffer => {
    const payload = Buffer.alloc(3)
    payload.writeUInt8(targetSystem, 0)
    payload.writeUInt8(targetComponent, 1)
    payload.writeUInt8(missionType, 2)
    return payload
  },
  paramSet: (targetSystem: number, targetComponent: number, name: string, value: number, paramType: number): Buffer => {
    const payload = Buffer.alloc(23)
    payload.writeFloatLE(value, 0)
    payload.writeUInt8(targetSystem, 4)
    payload.writeUInt8(targetComponent, 5)
    writeString(payload, 6, 16, name)
    payload.writeUInt8(paramType, 22)
    return payload
  },
}

export const missionItemForPoint = (config: {
  readonly seq: number
  readonly command: number
  readonly point: GeoJsonPoint
  readonly altitudeM: number
  readonly frame: number
  readonly params?: readonly number[]
  readonly missionType?: number
  readonly autocontinue?: boolean
}): MavlinkMissionItem => ({
  seq: config.seq,
  command: config.command,
  frame: config.frame,
  x: Math.round(config.point.coordinates[1] * 1e7),
  y: Math.round(config.point.coordinates[0] * 1e7),
  z: config.altitudeM,
  param1: config.params?.[0] ?? 0,
  param2: config.params?.[1] ?? 0,
  param3: config.params?.[2] ?? 0,
  param4: config.params?.[3] ?? 0,
  autocontinue: config.autocontinue ?? true,
  missionType: config.missionType ?? 0,
})

export const createMavlinkClient = (config: MavlinkClientConfig): MavlinkClient => {
  const socket = dgram.createSocket('udp4')
  const endpoint = config.endpoint
  const sourceSystemId = config.sourceSystemId ?? 245
  const sourceComponentId = config.sourceComponentId ?? 190
  const heartbeatTimeoutMs = config.heartbeatTimeoutMs ?? 5_000
  const commandTimeoutMs = config.commandTimeoutMs ?? 4_000
  const vehiclesBySystemId = new Map<number, MavlinkVehicleState>()
  const subscribers = new Set<() => void>()
  const pendingCommands = new Map<string, Array<{
    readonly resolve: (ack: MavlinkCommandAck) => void
    readonly reject: (error: Error) => void
    readonly timeout: ReturnType<typeof setTimeout>
  }>>()
  const pendingMissions = new Map<string, {
    readonly items: ReadonlyArray<MavlinkMissionItem>
    readonly targetSystem: number
    readonly targetComponent: number
    readonly missionType: number
    readonly resolve: () => void
    readonly reject: (error: Error) => void
    readonly timeout: ReturnType<typeof setTimeout>
  }>()
  let sequence = 0
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null
  let opened = false
  const endpointLabel = `${endpoint.host}:${endpoint.port} local ${endpoint.localPort}`

  const notify = (): void => {
    for (const subscriber of subscribers) subscriber()
  }

  const sendPayload = async (messageId: number, payload: Buffer): Promise<void> => {
    const frame = encodeFrame({
      seq: sequence,
      systemId: sourceSystemId,
      componentId: sourceComponentId,
      messageId,
      payload,
    })
    sequence = (sequence + 1) & 0xff
    await new Promise<void>((resolve, reject) => {
      socket.send(frame, endpoint.port, endpoint.host, (err) => {
        if (err) reject(err)
        else resolve()
      })
    })
  }

  const vehiclePatch = (
    systemId: number,
    componentId: number,
    patch: Partial<Omit<MavlinkVehicleState, 'systemId' | 'componentId' | 'lastMessageAt' | 'armed' | 'navigation'>> & {
      readonly armed?: boolean
      readonly navigation?: MavlinkVehicleState['navigation']
    },
  ): void => {
    const previous = vehiclesBySystemId.get(systemId)
    const at = nowIso()
    vehiclesBySystemId.set(systemId, {
      systemId,
      componentId,
      armed: patch.armed ?? previous?.armed ?? false,
      navigation: patch.navigation ?? previous?.navigation ?? { kind: 'unknown', mode: 'awaiting heartbeat' },
      lastMessageAt: at,
      ...((patch.autopilot ?? previous?.autopilot) === undefined ? {} : { autopilot: (patch.autopilot ?? previous?.autopilot)! }),
      ...((patch.baseMode ?? previous?.baseMode) === undefined ? {} : { baseMode: (patch.baseMode ?? previous?.baseMode)! }),
      ...((patch.customMode ?? previous?.customMode) === undefined ? {} : { customMode: (patch.customMode ?? previous?.customMode)! }),
      ...((patch.systemStatus ?? previous?.systemStatus) === undefined ? {} : { systemStatus: (patch.systemStatus ?? previous?.systemStatus)! }),
      ...((patch.pose ?? previous?.pose) === undefined ? {} : { pose: (patch.pose ?? previous?.pose)! }),
      ...((patch.velocity ?? previous?.velocity) === undefined ? {} : { velocity: (patch.velocity ?? previous?.velocity)! }),
      ...((patch.attitude ?? previous?.attitude) === undefined ? {} : { attitude: (patch.attitude ?? previous?.attitude)! }),
      ...((patch.battery ?? previous?.battery) === undefined ? {} : { battery: (patch.battery ?? previous?.battery)! }),
      ...((patch.mission ?? previous?.mission) === undefined ? {} : { mission: (patch.mission ?? previous?.mission)! }),
      ...((patch.lastHeartbeatAt ?? previous?.lastHeartbeatAt) === undefined ? {} : { lastHeartbeatAt: (patch.lastHeartbeatAt ?? previous?.lastHeartbeatAt)! }),
      ...((patch.lastStatusText ?? previous?.lastStatusText) === undefined ? {} : { lastStatusText: (patch.lastStatusText ?? previous?.lastStatusText)! }),
    })
    notify()
  }

  const resolveCommandAck = (systemId: number, command: number, result: number): void => {
    const key = `${systemId}:${command}`
    const queue = pendingCommands.get(key)
    const pending = queue?.shift()
    if (!pending) return
    if (queue && queue.length === 0) pendingCommands.delete(key)
    clearTimeout(pending.timeout)
    pending.resolve({
      command,
      result,
      accepted: commandResultAccepted(result),
    })
  }

  const missionKey = (systemId: number, missionType: number): string => `${systemId}:${missionType}`

  const sendMissionItem = (systemId: number, missionType: number, seq: number): void => {
    const mission = pendingMissions.get(missionKey(systemId, missionType))
    const item = mission?.items[seq]
    if (!mission || !item) return
    void sendPayload(mavMsg.missionItemInt, messagePayload.missionItemInt(
      mission.targetSystem,
      mission.targetComponent,
      item,
    ))
  }

  const finishMission = (systemId: number, missionType: number, result: number): void => {
    const key = missionKey(systemId, missionType)
    const mission = pendingMissions.get(key)
    if (!mission) return
    clearTimeout(mission.timeout)
    pendingMissions.delete(key)
    if (result === 0) mission.resolve()
    else mission.reject(new Error(`MAVLink mission transfer rejected with result ${result}`))
  }

  const waitForCommandAck = (systemId: number, command: number, timeoutMs: number): Promise<MavlinkCommandAck> =>
    new Promise((resolve, reject) => {
      const key = `${systemId}:${command}`
      const timeout = setTimeout(() => {
        const queue = pendingCommands.get(key)?.filter(entry => entry.reject !== reject) ?? []
        if (queue.length === 0) pendingCommands.delete(key)
        else pendingCommands.set(key, queue)
        reject(new Error(`timed out waiting for MAVLink COMMAND_ACK ${command} from system ${systemId}`))
      }, timeoutMs)
      const entry = { resolve, reject, timeout }
      pendingCommands.set(key, [...(pendingCommands.get(key) ?? []), entry])
    })

  const parseFrame = (frame: {
    readonly systemId: number
    readonly componentId: number
    readonly messageId: number
    readonly payload: Buffer
  }): void => {
    if (frame.systemId === sourceSystemId) return
    const payload = frame.payload
    if (frame.messageId === mavMsg.heartbeat && payload.length >= 9) {
      const customMode = payload.readUInt32LE(0)
      const autopilot = autopilotFromHeartbeat(payload.readUInt8(5))
      const baseMode = payload.readUInt8(6)
      const systemStatus = payload.readUInt8(7)
      vehiclePatch(frame.systemId, frame.componentId, {
        baseMode,
        customMode,
        systemStatus,
        armed: (baseMode & mavModeFlagSafetyArmed) === mavModeFlagSafetyArmed,
        navigation: navigationFromHeartbeat(autopilot, customMode),
        lastHeartbeatAt: nowIso(),
        ...(autopilot === undefined ? {} : { autopilot }),
      })
      return
    }
    if (frame.messageId === mavMsg.globalPositionInt && payload.length >= 28) {
      const lat = payload.readInt32LE(4) / 1e7
      const lon = payload.readInt32LE(8) / 1e7
      const altitudeM = payload.readInt32LE(12) / 1_000
      const relativeAltitudeM = payload.readInt32LE(16) / 1_000
      const northMps = payload.readInt16LE(20) / 100
      const eastMps = payload.readInt16LE(22) / 100
      const downMps = payload.readInt16LE(24) / 100
      const rawHeading = payload.readUInt16LE(26)
      vehiclePatch(frame.systemId, frame.componentId, {
        pose: {
          point: geoPointFromLonLat(lon, lat),
          altitudeM,
          relativeAltitudeM,
          headingDeg: rawHeading === 65_535 ? 0 : rawHeading / 100,
          observedAt: nowIso(),
        },
        velocity: { eastMps, northMps, downMps },
      })
      return
    }
    if (frame.messageId === mavMsg.gpsRawInt && payload.length >= 30) {
      const lat = payload.readInt32LE(8) / 1e7
      const lon = payload.readInt32LE(12) / 1e7
      const altitudeM = payload.readInt32LE(16) / 1_000
      if (lat !== 0 || lon !== 0) {
        const previous = vehiclesBySystemId.get(frame.systemId)
        vehiclePatch(frame.systemId, frame.componentId, {
          pose: {
            point: geoPointFromLonLat(lon, lat),
            altitudeM,
            headingDeg: previous?.pose?.headingDeg ?? 0,
            observedAt: nowIso(),
            ...(previous?.pose?.relativeAltitudeM === undefined ? {} : { relativeAltitudeM: previous.pose.relativeAltitudeM }),
          },
        })
      }
      return
    }
    if (frame.messageId === mavMsg.attitude && payload.length >= 28) {
      vehiclePatch(frame.systemId, frame.componentId, {
        attitude: {
          rollDeg: degrees(payload.readFloatLE(4)),
          pitchDeg: degrees(payload.readFloatLE(8)),
          yawDeg: normalizeDeg(degrees(payload.readFloatLE(12))),
          rollRateDegPerSec: degrees(payload.readFloatLE(16)),
          pitchRateDegPerSec: degrees(payload.readFloatLE(20)),
          yawRateDegPerSec: degrees(payload.readFloatLE(24)),
        },
      })
      return
    }
    if (frame.messageId === mavMsg.batteryStatus && payload.length >= 36) {
      const voltages: number[] = []
      for (let index = 0; index < 10; index += 1) {
        const voltageMv = payload.readUInt16LE(10 + index * 2)
        if (voltageMv !== 65_535) voltages.push(voltageMv)
      }
      const currentCentiAmp = payload.readInt16LE(30)
      const consumedMah = payload.readInt32LE(32)
      const remaining = payload.length >= 37 ? payload.readInt8(36) : -1
      vehiclePatch(frame.systemId, frame.componentId, {
        battery: {
          ...(remaining >= 0 ? { remainingPercent: remaining } : {}),
          ...(voltages.length > 0 ? { voltageV: voltages.reduce((total, value) => total + value, 0) / 1_000 } : {}),
          ...(currentCentiAmp === -1 ? {} : { currentA: currentCentiAmp / 100 }),
          ...(consumedMah < 0 ? {} : { consumedMah }),
        },
      })
      return
    }
    if (frame.messageId === mavMsg.sysStatus && payload.length >= 31) {
      const voltageBattery = payload.readUInt16LE(14)
      const currentBattery = payload.readInt16LE(16)
      const remaining = payload.readInt8(30)
      vehiclePatch(frame.systemId, frame.componentId, {
        battery: {
          ...(remaining >= 0 ? { remainingPercent: remaining } : {}),
          ...(voltageBattery === 65_535 ? {} : { voltageV: voltageBattery / 1_000 }),
          ...(currentBattery === -1 ? {} : { currentA: currentBattery / 100 }),
        },
      })
      return
    }
    if (frame.messageId === mavMsg.missionCurrent && payload.length >= 2) {
      const currentSeq = payload.readUInt16LE(0)
      const previous = vehiclesBySystemId.get(frame.systemId)
      vehiclePatch(frame.systemId, frame.componentId, {
        mission: {
          currentSeq,
          updatedAt: nowIso(),
          ...(previous?.mission?.total === undefined ? {} : { total: previous.mission.total }),
        },
      })
      return
    }
    if (frame.messageId === mavMsg.commandAck && payload.length >= 3) {
      resolveCommandAck(frame.systemId, payload.readUInt16LE(0), payload.readUInt8(2))
      vehiclePatch(frame.systemId, frame.componentId, {})
      return
    }
    if ((frame.messageId === mavMsg.missionRequest || frame.messageId === mavMsg.missionRequestInt) && payload.length >= 4) {
      const seq = payload.readUInt16LE(0)
      const missionType = payload.length >= 5 ? payload.readUInt8(4) : 0
      sendMissionItem(frame.systemId, missionType, seq)
      vehiclePatch(frame.systemId, frame.componentId, {})
      return
    }
    if (frame.messageId === mavMsg.missionAck && payload.length >= 3) {
      const result = payload.readUInt8(2)
      const missionType = payload.length >= 4 ? payload.readUInt8(3) : 0
      finishMission(frame.systemId, missionType, result)
      vehiclePatch(frame.systemId, frame.componentId, {})
      return
    }
    if (frame.messageId === mavMsg.statustext && payload.length >= 51) {
      vehiclePatch(frame.systemId, frame.componentId, {
        lastStatusText: readString(payload, 1, 50),
      })
    }
  }

  const handleMessage = (message: Buffer): void => {
    for (const frame of decodeMavlinkFrames(message)) parseFrame(frame)
  }

  const handleSocketError = (err: Error): void => {
    console.warn(`MAVLink UDP socket error on ${endpointLabel}: ${err.message}`)
  }

  const open = async (): Promise<void> => {
    if (opened) return
    await new Promise<void>((resolve, reject) => {
      const fail = (err: Error): void => {
        socket.off('listening', success)
        reject(err)
      }
      const success = (): void => {
        socket.off('error', fail)
        resolve()
      }
      socket.once('error', fail)
      socket.once('listening', success)
      socket.bind(endpoint.localPort)
    })
    socket.on('error', handleSocketError)
    socket.on('message', handleMessage)
    heartbeatTimer = setInterval(() => {
      void sendPayload(mavMsg.heartbeat, messagePayload.heartbeat())
    }, 1_000)
    await sendPayload(mavMsg.heartbeat, messagePayload.heartbeat())
    opened = true
    try {
      const startedAt = Date.now()
      while (Date.now() - startedAt < heartbeatTimeoutMs) {
        if (vehiclesBySystemId.size > 0) return
        await Bun.sleep(100)
      }
      throw new Error(`no MAVLink vehicle messages received from ${endpoint.host}:${endpoint.port} within ${heartbeatTimeoutMs} ms`)
    } catch (err) {
      await close()
      throw err
    }
  }

  const close = async (): Promise<void> => {
    if (heartbeatTimer) clearInterval(heartbeatTimer)
    heartbeatTimer = null
    for (const queue of pendingCommands.values()) {
      for (const entry of queue) {
        clearTimeout(entry.timeout)
        entry.reject(new Error('MAVLink connection closed'))
      }
    }
    pendingCommands.clear()
    for (const mission of pendingMissions.values()) {
      clearTimeout(mission.timeout)
      mission.reject(new Error('MAVLink connection closed'))
    }
    pendingMissions.clear()
    if (!opened) return
    socket.off('message', handleMessage)
    socket.off('error', handleSocketError)
    await new Promise<void>((resolve) => socket.close(() => resolve()))
    opened = false
  }

  const commandLong = async (command: {
    readonly targetSystem: number
    readonly targetComponent?: number
    readonly command: number
    readonly params?: readonly number[]
    readonly timeoutMs?: number
  }): Promise<MavlinkCommandAck> => {
    const ack = waitForCommandAck(command.targetSystem, command.command, command.timeoutMs ?? commandTimeoutMs)
    await sendPayload(mavMsg.commandLong, messagePayload.commandLong({
      targetSystem: command.targetSystem,
      targetComponent: command.targetComponent ?? 1,
      command: command.command,
      params: command.params ?? [],
    }))
    const result = await ack
    if (!result.accepted) throw new Error(`MAVLink command ${command.command} rejected with result ${result.result}`)
    return result
  }

  const commandInt = async (command: {
    readonly targetSystem: number
    readonly targetComponent?: number
    readonly command: number
    readonly frame: number
    readonly x: number
    readonly y: number
    readonly z: number
    readonly params?: readonly number[]
    readonly timeoutMs?: number
  }): Promise<MavlinkCommandAck> => {
    const ack = waitForCommandAck(command.targetSystem, command.command, command.timeoutMs ?? commandTimeoutMs)
    await sendPayload(mavMsg.commandInt, messagePayload.commandInt({
      targetSystem: command.targetSystem,
      targetComponent: command.targetComponent ?? 1,
      command: command.command,
      frame: command.frame,
      x: command.x,
      y: command.y,
      z: command.z,
      params: command.params ?? [],
    }))
    const result = await ack
    if (!result.accepted) throw new Error(`MAVLink command ${command.command} rejected with result ${result.result}`)
    return result
  }

  return {
    open,
    close,
    vehicles: () => [...vehiclesBySystemId.values()],
    vehicle: (systemId: number) => vehiclesBySystemId.get(systemId),
    subscribe: (handler: () => void): (() => void) => {
      subscribers.add(handler)
      return () => {
        subscribers.delete(handler)
      }
    },
    commandLong,
    commandInt,
    manualControl: async (manual): Promise<void> => {
      await sendPayload(mavMsg.manualControl, messagePayload.manualControl({
        targetSystem: manual.targetSystem,
        x: manual.x,
        y: manual.y,
        z: manual.z,
        r: manual.r,
        buttons: manual.buttons ?? 0,
      }))
    },
    setGlobalPositionTarget: async (target): Promise<void> => {
      await sendPayload(mavMsg.setPositionTargetGlobalInt, messagePayload.setPositionTargetGlobalInt({
        targetSystem: target.targetSystem,
        latInt: Math.round(target.lat * 1e7),
        lonInt: Math.round(target.lon * 1e7),
        altitudeM: target.altitudeM,
        ...(target.velocityNorthMps === undefined ? {} : { velocityNorthMps: target.velocityNorthMps }),
        ...(target.velocityEastMps === undefined ? {} : { velocityEastMps: target.velocityEastMps }),
        ...(target.velocityDownMps === undefined ? {} : { velocityDownMps: target.velocityDownMps }),
        ...(target.yawDeg === undefined ? {} : { yawDeg: target.yawDeg }),
      }))
    },
    uploadMission: async (mission): Promise<void> => {
      if (mission.items.length === 0) throw new Error('cannot upload an empty MAVLink mission')
      const timeoutMs = mission.timeoutMs ?? 10_000
      const key = missionKey(mission.targetSystem, mission.missionType)
      if (pendingMissions.has(key)) throw new Error(`MAVLink mission transfer already in progress for system ${mission.targetSystem}`)
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          pendingMissions.delete(key)
          reject(new Error(`timed out uploading MAVLink mission to system ${mission.targetSystem}`))
        }, timeoutMs)
        pendingMissions.set(key, {
          items: mission.items,
          targetSystem: mission.targetSystem,
          targetComponent: mission.targetComponent ?? 1,
          missionType: mission.missionType,
          resolve,
          reject,
          timeout,
        })
        const sendCount = async (): Promise<void> => {
          try {
            await sendPayload(mavMsg.missionCount, messagePayload.missionCount(
              mission.targetSystem,
              mission.targetComponent ?? 1,
              mission.items.length,
              mission.missionType,
            ))
          } catch (err) {
            clearTimeout(timeout)
            pendingMissions.delete(key)
            reject(err instanceof Error ? err : new Error(String(err)))
          }
        }
        void sendCount()
      })
    },
    clearMission: async (mission): Promise<void> => {
      const timeoutMs = mission.timeoutMs ?? 2_000
      const key = missionKey(mission.targetSystem, mission.missionType)
      if (pendingMissions.has(key)) throw new Error(`MAVLink mission transfer already in progress for system ${mission.targetSystem}`)
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          pendingMissions.delete(key)
          reject(new Error(`timed out clearing MAVLink mission for system ${mission.targetSystem}`))
        }, timeoutMs)
        pendingMissions.set(key, {
          items: [],
          targetSystem: mission.targetSystem,
          targetComponent: mission.targetComponent ?? 1,
          missionType: mission.missionType,
          resolve,
          reject,
          timeout,
        })
        const sendClear = async (): Promise<void> => {
          try {
            await sendPayload(mavMsg.missionClearAll, messagePayload.missionClearAll(
              mission.targetSystem,
              mission.targetComponent ?? 1,
              mission.missionType,
            ))
          } catch (err) {
            clearTimeout(timeout)
            pendingMissions.delete(key)
            reject(err instanceof Error ? err : new Error(String(err)))
          }
        }
        void sendClear()
      })
    },
    setParameter: async (param): Promise<void> => {
      await sendPayload(mavMsg.paramSet, messagePayload.paramSet(
        param.targetSystem,
        param.targetComponent ?? 1,
        param.name,
        param.value,
        param.paramType,
      ))
    },
  }
}
