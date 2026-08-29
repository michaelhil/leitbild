import { describe, test, expect } from 'bun:test'
import { createRoomDirectory } from './directory.ts'

describe('RoomDirectory — room collection', () => {
  test('starts empty', () => {
    const directory = createRoomDirectory()
    expect(directory.listAllRooms()).toEqual([])
  })

  test('creates a room with auto-generated UUID', () => {
    const directory = createRoomDirectory()
    const room = directory.createRoom({
      name: 'General',
      createdBy: 'alice',
    })

    expect(room.profile.name).toBe('General')
    expect(room.profile.createdBy).toBe('alice')
    expect(room.profile.createdAt).toBeGreaterThan(0)
    expect(room.profile.id).toHaveLength(36) // UUID format

    const retrieved = directory.getRoom(room.profile.id)
    expect(retrieved).toBe(room)
  })

  test('getRoom returns undefined for nonexistent room', () => {
    const directory = createRoomDirectory()
    expect(directory.getRoom('nope')).toBeUndefined()
  })

  test('findByName returns room (case-insensitive)', () => {
    const directory = createRoomDirectory()
    const room = directory.createRoom({ name: 'General', createdBy: 'alice' })

    expect(directory.getRoom('General')).toBe(room)
    expect(directory.getRoom('general')).toBe(room)
    expect(directory.getRoom('GENERAL')).toBe(room)
    expect(directory.getRoom('nonexistent')).toBeUndefined()
  })

  test('name uniqueness enforced (case-insensitive)', () => {
    const directory = createRoomDirectory()
    directory.createRoom({ name: 'General', createdBy: 'alice' })

    expect(() => {
      directory.createRoom({ name: 'General', createdBy: 'bob' })
    }).toThrow('Room name "General" is already taken')

    expect(() => {
      directory.createRoom({ name: 'general', createdBy: 'bob' })
    }).toThrow('Room name "general" is already taken')
  })

  test('createRoomSafe auto-renames on collision', () => {
    const directory = createRoomDirectory()
    directory.createRoom({ name: 'Planning', createdBy: 'alice' })

    const result = directory.createRoomSafe({ name: 'Planning', createdBy: 'bob' })

    expect(result.requestedName).toBe('Planning')
    expect(result.assignedName).toBe('Planning-2')
    expect(result.value.profile.name).toBe('Planning-2')
  })

  test('createRoomSafe returns original name when no collision', () => {
    const directory = createRoomDirectory()
    const result = directory.createRoomSafe({ name: 'Unique', createdBy: 'alice' })

    expect(result.requestedName).toBe('Unique')
    expect(result.assignedName).toBe('Unique')
  })

  test('createRoomSafe increments suffix on multiple collisions', () => {
    const directory = createRoomDirectory()
    directory.createRoom({ name: 'Room', createdBy: 'a' })
    directory.createRoomSafe({ name: 'Room', createdBy: 'b' }) // Room-2

    const result = directory.createRoomSafe({ name: 'Room', createdBy: 'c' })
    expect(result.assignedName).toBe('Room-3')
  })

  test('listAllRooms returns all rooms', () => {
    const directory = createRoomDirectory()
    directory.createRoom({ name: 'A', createdBy: 'alice' })
    directory.createRoom({ name: 'B', createdBy: 'alice' })

    expect(directory.listAllRooms()).toHaveLength(2)
  })

  test('removeRoom deletes a room', () => {
    const directory = createRoomDirectory()
    const room = directory.createRoom({ name: 'Temp', createdBy: 'alice' })

    expect(directory.removeRoom(room.profile.id)).toBe(true)
    expect(directory.getRoom(room.profile.id)).toBeUndefined()
    expect(directory.listAllRooms()).toHaveLength(0)
  })

  test('removeRoom returns false for nonexistent room', () => {
    const directory = createRoomDirectory()
    expect(directory.removeRoom('nope')).toBe(false)
  })

  test('any room can be removed (no protected rooms)', () => {
    const directory = createRoomDirectory()
    const intro = directory.createRoom({ name: 'Introductions', createdBy: 'system' })

    expect(directory.removeRoom(intro.profile.id)).toBe(true)
    expect(directory.getRoom(intro.profile.id)).toBeUndefined()
  })

  test('onRoomCreated fires when room is created (not restored)', () => {
    const created: string[] = []
    const directory = createRoomDirectory({ onRoomCreated: (p) => created.push(p.name) })

    directory.createRoom({ name: 'Alpha', createdBy: 'alice' })
    directory.createRoomSafe({ name: 'Beta', createdBy: 'bob' })
    expect(created).toEqual(['Alpha', 'Beta'])
  })

  test('onRoomCreated does NOT fire for restoreRoom', () => {
    const created: string[] = []
    const source = createRoomDirectory()
    const profile = source.createRoom({ name: 'Original', createdBy: 'alice' }).profile
    const directory = createRoomDirectory({ onRoomCreated: (p) => created.push(p.name) })

    directory.restoreRoom(profile)
    expect(created).toHaveLength(0)
  })

  test('restoreRoom rejects duplicate ids and names', () => {
    const directory = createRoomDirectory()
    const room = directory.createRoom({ name: 'Original', createdBy: 'alice' })

    expect(() => directory.restoreRoom(room.profile)).toThrow('Cannot restore duplicate Room')
  })

  test('onRoomDeleted fires when room is removed', () => {
    const deleted: string[] = []
    const directory = createRoomDirectory({ onRoomDeleted: (_id, name) => deleted.push(name) })

    const room = directory.createRoom({ name: 'ToDelete', createdBy: 'alice' })
    directory.removeRoom(room.profile.id)
    expect(deleted).toEqual(['ToDelete'])
  })

  test('preserves roomPrompt', () => {
    const directory = createRoomDirectory()
    const room = directory.createRoom({
      name: 'Focused',
      roomPrompt: 'Stay on topic about data pipelines',
      createdBy: 'alice',
    })

    expect(room.profile.roomPrompt).toBe('Stay on topic about data pipelines')
  })

  test('rooms created by directory are functional (can post and query)', () => {
    const directory = createRoomDirectory()
    const room = directory.createRoom({ name: 'Active', createdBy: 'alice' })

    const message = room.post({ senderId: 'alice', content: 'Hello', type: 'chat' })
    expect(message.content).toBe('Hello')
    expect(message.roomId).toBe(room.profile.id)
    expect(room.getMessageCount()).toBe(1)
    expect(room.getRecent(10)).toHaveLength(1)
    expect(room.getParticipantIds()).toContain('alice')
  })

  test('removed room name can be reused', () => {
    const directory = createRoomDirectory()
    const original = directory.createRoom({ name: 'Reusable', createdBy: 'alice' })
    original.post({ senderId: 'alice', content: 'Old message', type: 'chat' })

    directory.removeRoom(original.profile.id)
    const fresh = directory.createRoom({ name: 'Reusable', createdBy: 'bob' })

    expect(fresh.profile.name).toBe('Reusable')
    expect(fresh.profile.createdBy).toBe('bob')
    expect(fresh.getMessageCount()).toBe(0)
  })

  test('rejects empty name', () => {
    const directory = createRoomDirectory()
    expect(() => {
      directory.createRoom({ name: '', createdBy: 'alice' })
    }).toThrow('Room name cannot be empty')
  })

  test('rejects whitespace-only name', () => {
    const directory = createRoomDirectory()
    expect(() => {
      directory.createRoom({ name: '   ', createdBy: 'alice' })
    }).toThrow('Room name cannot be empty')
  })

  test('rejects name with leading/trailing whitespace', () => {
    const directory = createRoomDirectory()
    expect(() => {
      directory.createRoom({ name: '  General  ', createdBy: 'alice' })
    }).toThrow('Room name cannot have leading or trailing whitespace')
  })

  test('rejects excessively long name', () => {
    const directory = createRoomDirectory()
    expect(() => {
      directory.createRoom({ name: 'A'.repeat(101), createdBy: 'alice' })
    }).toThrow('Room name cannot exceed 100 characters')
  })

  test('room tracks members via addMember/hasMember', () => {
    const directory = createRoomDirectory()
    const room = directory.createRoom({ name: 'Members Test', createdBy: 'alice' })

    expect(room.hasMember('bob')).toBe(false)
    room.addMember('bob')
    expect(room.hasMember('bob')).toBe(true)
    expect(room.getParticipantIds()).toContain('bob')
  })

  test('getRoomsForAgent returns rooms where agent is a member', () => {
    const directory = createRoomDirectory()
    const room1 = directory.createRoom({ name: 'A', createdBy: 'alice' })
    const room2 = directory.createRoom({ name: 'B', createdBy: 'alice' })
    directory.createRoom({ name: 'C', createdBy: 'alice' })

    room1.addMember('agent-1')
    room2.addMember('agent-1')

    const rooms = directory.getRoomsForAgent('agent-1')
    expect(rooms).toHaveLength(2)
    expect(rooms.map(r => r.profile.name).sort()).toEqual(['A', 'B'])
  })

  test('getRoomsForAgent returns empty for unknown agent', () => {
    const directory = createRoomDirectory()
    directory.createRoom({ name: 'A', createdBy: 'alice' })
    expect(directory.getRoomsForAgent('nobody')).toEqual([])
  })

  test('posting adds sender as member implicitly', () => {
    const directory = createRoomDirectory()
    const room = directory.createRoom({ name: 'Implicit', createdBy: 'alice' })

    expect(room.hasMember('alice')).toBe(false)
    room.post({ senderId: 'alice', content: 'Hi', type: 'chat' })
    expect(room.hasMember('alice')).toBe(true)
  })
})
