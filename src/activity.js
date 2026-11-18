// Read-only activity report: one compact row per user, joined server-side so a
// whole org fits in one tool response. Uses analytics aggregate queries
// (read-only POSTs) and the users list. Nothing is created or changed.

const ON_QUEUE = new Set(['IDLE', 'INTERACTING', 'NOT_RESPONDING', 'COMMUNICATING']);
const hrs = (ms) => Math.round((ms / 3600000) * 10) / 10;

export function intervalFor(days, now = new Date()) {
  const end = new Date(now);
  const start = new Date(end.getTime() - days * 86400000);
  return `${start.toISOString()}/${end.toISOString()}`;
}

// Walk {results:[{group, data:[{metrics:[{metric, qualifier, stats}]}]}]}.
export function eachMetric(res, fn) {
  for (const r of res?.results || []) {
    for (const d of r.data || []) {
      for (const m of d.metrics || []) fn(r.group || {}, m);
    }
  }
}

const csvCell = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function buildRows(users, conv, presence, evals) {
  const row = new Map();
  const get = (id) => {
    if (!row.has(id)) row.set(id, { loggedMs: 0, onQueueMs: 0, handledVoice: 0, handledOther: 0, outbound: 0, handleMs: 0, evaluations: 0 });
    return row.get(id);
  };
  eachMetric(conv, (g, m) => {
    if (!g.userId) return;
    const r = get(g.userId);
    const count = m.stats?.count ?? 0;
    if (m.metric === 'tHandle') {
      if (g.mediaType === 'voice') r.handledVoice += count; else r.handledOther += count;
      r.handleMs += m.stats?.sum ?? 0;
    }
    if (m.metric === 'nOutbound') r.outbound += count;
  });
  eachMetric(presence, (g, m) => {
    if (!g.userId) return;
    const r = get(g.userId);
    const sum = m.stats?.sum ?? 0;
    if (m.metric === 'tSystemPresence' && m.qualifier && m.qualifier.toUpperCase() !== 'OFFLINE') r.loggedMs += sum;
    if (m.metric === 'tAgentRoutingStatus' && ON_QUEUE.has(String(m.qualifier).toUpperCase())) r.onQueueMs += sum;
  });
  eachMetric(evals, (g, m) => {
    if (!g.evaluatorId || m.metric !== 'nEvaluations') return;
    get(g.evaluatorId).evaluations += m.stats?.count ?? 0;
  });
  const header = ['id', 'email', 'name', 'state', 'lastLogin', 'loggedHrs', 'onQueueHrs', 'handledVoice', 'handledOther', 'outbound', 'handleHrs', 'evaluationsDone'];
  const lines = [header.join(',')];
  for (const u of users) {
    const r = row.get(u.id) || get(u.id);
    lines.push([
      u.id, u.email, u.name, u.state, u.dateLastLogin ? u.dateLastLogin.slice(0, 10) : '',
      hrs(r.loggedMs), hrs(r.onQueueMs), r.handledVoice, r.handledOther, r.outbound, hrs(r.handleMs), r.evaluations,
    ].map(csvCell).join(','));
  }
  return lines.join('\n');
}

export const ACTIVITY_TOOLS = [
  {
    name: 'user_activity_report',
    description: 'READ-ONLY. One CSV row per user for the last N days (default 30, max 31): last login date, hours logged in and on queue, interactions handled (voice / other), outbound attempts, handle hours, and quality evaluations done as evaluator. Use it to see who takes calls, who only logs in, and who uses WEM quality.',
    inputSchema: {
      type: 'object',
      properties: { days: { type: 'number', description: 'Look-back window in days (1-31, default 30)' } },
      additionalProperties: false,
    },
    handler: async (gc, a) => {
      const days = Math.min(31, Math.max(1, Math.floor(a.days ?? 30)));
      const interval = intervalFor(days);
      const { entities: users, truncated } = await gc.listAll('/api/v2/users', { state: 'any', expand: 'dateLastLogin' }, { max: 5000 });
      const conv = await gc.post('/api/v2/analytics/conversations/aggregates/query', {
        interval, groupBy: ['userId', 'mediaType'], metrics: ['tHandle', 'nOutbound'],
      });
      // The users aggregate endpoint requires a filter: query in batches of 100 ids.
      const presence = { results: [] };
      for (let i = 0; i < users.length; i += 100) {
        const ids = users.slice(i, i + 100).map((u) => u.id);
        const r = await gc.post('/api/v2/analytics/users/aggregates/query', {
          interval, groupBy: ['userId'], metrics: ['tSystemPresence', 'tAgentRoutingStatus'],
          filter: { type: 'or', predicates: ids.map((id) => ({ dimension: 'userId', value: id })) },
        });
        presence.results.push(...(r?.results || []));
      }
      let evals = null;
      let evalError;
      try {
        evals = await gc.post('/api/v2/analytics/evaluations/aggregates/query', {
          interval, groupBy: ['evaluatorId'], metrics: ['nEvaluations'],
        });
      } catch (e) { evalError = e.message; }
      return { interval, users: users.length, truncated, ...(evalError ? { evaluationsError: evalError } : {}), csv: buildRows(users, conv, presence, evals) };
    },
  },
];
