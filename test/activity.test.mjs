import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRows, intervalFor } from '../src/activity.js';

test('intervalFor spans the requested days', () => {
  const [a, b] = intervalFor(30, new Date('2026-11-18T00:00:00Z')).split('/');
  assert.equal(a, '2026-10-19T00:00:00.000Z');
  assert.equal(b, '2026-11-18T00:00:00.000Z');
});

test('buildRows joins users with conversation, presence and evaluation aggregates', () => {
  const users = [{ id: 'u1', email: 'a@x', name: 'A, B', state: 'active', dateLastLogin: '2026-11-18T14:00:00Z' }, { id: 'u2', email: 'b@x', name: 'C', state: 'active' }];
  const conv = { results: [
    { group: { userId: 'u1', mediaType: 'voice' }, data: [{ metrics: [{ metric: 'tHandle', stats: { count: 10, sum: 3600000 } }, { metric: 'nOutbound', stats: { count: 4 } }] }] },
    { group: { userId: 'u1', mediaType: 'message' }, data: [{ metrics: [{ metric: 'tHandle', stats: { count: 2, sum: 0 } }] }] },
  ] };
  const presence = { results: [{ group: { userId: 'u1' }, data: [{ metrics: [
    { metric: 'tSystemPresence', qualifier: 'AVAILABLE', stats: { sum: 7200000 } },
    { metric: 'tSystemPresence', qualifier: 'OFFLINE', stats: { sum: 99999999 } },
    { metric: 'tAgentRoutingStatus', qualifier: 'IDLE', stats: { sum: 1800000 } },
    { metric: 'tAgentRoutingStatus', qualifier: 'OFF_QUEUE', stats: { sum: 1800000 } },
  ] }] }] };
  const evals = { results: [{ group: { evaluatorId: 'u2' }, data: [{ metrics: [{ metric: 'nEvaluations', stats: { count: 3 } }] }] }] };
  const lines = buildRows(users, conv, presence, evals).split('\n');
  assert.equal(lines[1], 'u1,a@x,"A, B",active,2026-11-18,2,0.5,10,2,4,1,0,0,0');
  assert.equal(lines[2], 'u2,b@x,C,active,,0,0,0,0,0,0,3,0,0');
});
