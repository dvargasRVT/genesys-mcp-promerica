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

export function buildRows(users, conv, presence, evals, audits = {}, compact = false) {
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
  const header = ['id', 'email', 'name', 'state', 'lastLogin', 'loggedHrs', 'onQueueHrs', 'handledVoice', 'handledOther', 'outbound', 'handleHrs', 'evaluationsDone', 'wfmChanges14d', 'qualityChanges14d'];
  const keep = compact ? header.map((h, i) => (['id', 'name', 'state'].includes(h) ? -1 : i)).filter((i) => i >= 0) : header.map((_, i) => i);
  const lines = [keep.map((i) => header[i]).join(',')];
  for (const u of users) {
    if (compact && u.state === 'deleted') continue;
    const r = row.get(u.id) || get(u.id);
    lines.push([
      u.id, u.email, u.name, u.state, u.dateLastLogin ? u.dateLastLogin.slice(0, 10) : '',
      hrs(r.loggedMs), hrs(r.onQueueMs), r.handledVoice, r.handledOther, r.outbound, hrs(r.handleMs), r.evaluations, audits.WorkforceManagement?.[u.id] ?? 0, audits.Quality?.[u.id] ?? 0,
    ].map(csvCell).filter((_, i) => keep.includes(i)).join(','));
  }
  return lines.join('\n');
}

export const ACTIVITY_TOOLS = [
  {
    name: 'user_activity_report',
    description: 'READ-ONLY. One CSV row per user for the last N days (default 30, max 31): last login date, hours logged in and on queue, interactions handled (voice / other), outbound attempts, handle hours, and quality evaluations done as evaluator. Use it to see who takes calls, who only logs in, and who uses WEM quality.',
    inputSchema: {
      type: 'object',
      properties: { days: { type: 'number', description: 'Look-back window in days (1-31, default 30)' }, compact: { type: 'boolean', description: 'Drop deleted users and the id/name/state columns' } },
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
      // Realtime audit (max 14 days): who changed WFM / Quality config.
      const audits = {};
      const end = new Date();
      const auditInterval = `${new Date(end.getTime() - 14 * 86400000).toISOString()}/${end.toISOString()}`;
      for (const serviceName of ['WorkforceManagement', 'Quality']) {
        audits[serviceName] = {};
        try {
          for (let pageNumber = 1; pageNumber <= 30; pageNumber++) {
            const r = await gc.post('/api/v2/audits/query/realtime', { interval: auditInterval, serviceName, pageSize: 100, pageNumber });
            for (const e of r?.entities || []) {
              const id = e.user?.id;
              if (id) audits[serviceName][id] = (audits[serviceName][id] ?? 0) + 1;
            }
            if (!r?.pageCount || pageNumber >= r.pageCount) break;
          }
        } catch { /* audit permission missing: leave zeros */ }
      }
      return { interval, users: users.length, truncated, ...(evalError ? { evaluationsError: evalError } : {}), csv: buildRows(users, conv, presence, evals, audits, a.compact === true) };
    },
  },
];
