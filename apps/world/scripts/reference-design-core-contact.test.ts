import { expect, test } from 'bun:test';
import { admittedPacket } from './reference-design-core-contact';

test('offline receiver evidence cannot request material beyond its finite donor', () => {
  expect(admittedPacket(100, 150)).toEqual({ deliveredKg: 100, unmetKg: 0 });
  expect(admittedPacket(100, 10)).toEqual({ deliveredKg: 10, unmetKg: 90 });
  expect(admittedPacket(100, 0)).toEqual({ deliveredKg: 0, unmetKg: 100 });
  expect(admittedPacket(0, 10)).toEqual({ deliveredKg: 0, unmetKg: 0 });
  for (const [request, available] of [[-1, 1], [1, -1], [NaN, 1], [1, Infinity]]) {
    expect(() => admittedPacket(request!, available!)).toThrow('Invalid finite material budget');
  }
});
