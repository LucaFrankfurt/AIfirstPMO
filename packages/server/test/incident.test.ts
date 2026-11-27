/**
 * The pure half of incidents: the matrix, the clocks, the report and the review.
 *
 * Each case here is a decision the screens and the assistant both read through
 * `@kolibri/shared`, so a regression in one of them is a disagreement between
 * the start page and `list_incidents` before it is anything else.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  byIncidentUrgency, formatDuration, incidentClocks, incidentNumberOf, incidentReport, isActive, priorityFor,
  reviewMarkdown, type Incident, type ReviewWords,
} from '@kolibri/shared';

const HOUR = 3_600_000;

const incident = (over: Partial<Incident> = {}): Incident => ({
  id: 'i', workspace_id: 'w', number: 1, identifier: 'INC-1', summary: 'Down', description: null,
  status: 'new', priority: 'p3', impact: 'medium', urgency: 'medium', category: 'other', major: 0,
  applications: [], manager_id: null, responders: [], reported_by: null,
  started_at: null, detected_at: null, ended_at: null, resolved_at: null, closed_at: null,
  financial_impact: null, currency: 'EUR', affected_users: null,
  resolution_code: null, resolution: null, root_cause: null, pages: [], tasks: [],
  created_by: null, announced_at: null, created_at: 0, updated_at: 0, deleted_at: null, seq: 0,
  ...over,
});

describe('the priority matrix', () => {
  it('is ServiceNow’s, with planning folded onto P4', () => {
    assert.equal(priorityFor('high', 'high'), 'p1');
    assert.equal(priorityFor('high', 'medium'), 'p2');
    assert.equal(priorityFor('medium', 'high'), 'p2');
    assert.equal(priorityFor('high', 'low'), 'p3');
    assert.equal(priorityFor('medium', 'medium'), 'p3');
    assert.equal(priorityFor('medium', 'low'), 'p4');
    assert.equal(priorityFor('low', 'low'), 'p4');
  });
});

describe('the number, as people paste it', () => {
  it('reads INC-12, inc 12, #12 and 12, and nothing else', () => {
    for (const ref of ['INC-12', 'inc-12', 'inc 12', '#12', '12', ' INC-12 ']) assert.equal(incidentNumberOf(ref), 12, ref);
    for (const ref of ['', 'INC-', 'INC-0', 'WEB-12', '12a', 'a-uuid-like-thing']) assert.equal(incidentNumberOf(ref), null, ref);
  });
});

describe('the clocks', () => {
  const now = 100 * HOUR;

  it('counts the impact to now while it goes on, and stops when it ended', () => {
    const live = incidentClocks(incident({ status: 'investigating', started_at: now - 2 * HOUR }), now);
    assert.equal(live.impactMs, 2 * HOUR);
    assert.equal(live.running, true);
    assert.equal(live.resolveMs, null, 'an active incident has no time to resolve yet');
    const over = incidentClocks(incident({ status: 'resolved', started_at: now - 5 * HOUR, ended_at: now - 3 * HOUR }), now);
    assert.equal(over.impactMs, 2 * HOUR);
    assert.equal(over.running, false);
  });

  it('says nothing rather than guess an end nobody wrote down', () => {
    const clocks = incidentClocks(incident({ status: 'resolved', created_at: now - 9 * HOUR }), now);
    assert.deepEqual([clocks.impactMs, clocks.detectMs, clocks.resolveMs], [null, null, null]);
  });

  it('measures time to resolve to the service being back, not to the paperwork', () => {
    // Written up the next morning: detected 29 h ago, back 26 h ago, resolved now.
    const late = incidentClocks(incident({
      status: 'resolved', started_at: now - 30 * HOUR, detected_at: now - 29 * HOUR,
      ended_at: now - 26 * HOUR, resolved_at: now,
    }), now);
    assert.equal(late.resolveMs, 3 * HOUR);
    // Nobody said when it ended: the stamp is the fallback.
    const live = incidentClocks(incident({ status: 'resolved', detected_at: now - 2 * HOUR, resolved_at: now }), now);
    assert.equal(live.resolveMs, 2 * HOUR);
  });

  it('prints two units at most', () => {
    assert.equal(formatDuration(null), '—');
    assert.equal(formatDuration(45 * 60_000), '45 min');
    assert.equal(formatDuration(3 * HOUR + 20 * 60_000), '3 h 20 min');
    assert.equal(formatDuration(52 * HOUR), '2 d 4 h');
    assert.equal(formatDuration(48 * HOUR), '2 d');
  });
});

describe('what to look at first', () => {
  it('active before over, then priority, then major, then the longest-running', () => {
    const rows = [
      incident({ id: 'done', status: 'resolved', priority: 'p1', resolved_at: 50 }),
      incident({ id: 'p2-old', status: 'investigating', priority: 'p2', started_at: 1 }),
      incident({ id: 'p1', status: 'new', priority: 'p1', started_at: 10 }),
      incident({ id: 'p2-major', status: 'monitoring', priority: 'p2', major: 1, started_at: 5 }),
      incident({ id: 'p2-new', status: 'on_hold', priority: 'p2', started_at: 3 }),
    ];
    assert.deepEqual([...rows].sort(byIncidentUrgency).map((row) => row.id), ['p1', 'p2-major', 'p2-old', 'p2-new', 'done']);
    assert.equal(isActive({ status: 'on_hold' }), true);
    assert.equal(isActive({ status: 'resolved' }), false);
  });
});

describe('the report', () => {
  it('counts an incident nobody costed as unpriced, never as free, and adds per currency', () => {
    const report = incidentReport([
      incident({ status: 'closed', priority: 'p1', financial_impact: 100_00, currency: 'EUR' }),
      incident({ status: 'resolved', priority: 'p2', financial_impact: 50_00, currency: 'EUR' }),
      incident({ status: 'resolved', priority: 'p2', financial_impact: 20_00, currency: 'USD' }),
      incident({ status: 'investigating', priority: 'p3' }),
      incident({ status: 'cancelled', priority: 'p4', financial_impact: 999_00 }),
    ]);
    assert.equal(report.total, 5);
    assert.equal(report.active, 1);
    assert.equal(report.awaitingReview, 2);
    assert.equal(report.unpriced, 1);
    assert.deepEqual(report.cost, [{ currency: 'EUR', amount: 150_00 }, { currency: 'USD', amount: 20_00 }]);
    assert.equal(report.byPriority.p4, 0, 'a false alarm counted as an outage');
  });
});

describe('the review page', () => {
  const words = Object.fromEntries([
    'title', 'summary', 'impact', 'timeline', 'rootCause', 'resolution', 'followUps', 'lessons', 'priority', 'status',
    'manager', 'applications', 'started', 'detected', 'ended', 'duration', 'timeToDetect', 'timeToResolve',
    'financialImpact', 'affectedUsers', 'none', 'toBeWritten',
  ].map((key) => [key, key === 'toBeWritten' ? 'TBD' : key === 'none' ? '—' : key.toUpperCase()])) as unknown as ReviewWords;

  it('fills in what the record knows, and leaves the lessons to a person', () => {
    const page = reviewMarkdown({
      incident: incident({ summary: 'Checkout down', root_cause: 'A missing index', started_at: 0, ended_at: 2 * HOUR, status: 'resolved' }),
      timeline: [{ at: HOUR, text: 'Ada: rolled back\nthe deploy' }],
      managerName: 'Ada',
      applicationNames: ['Shop'],
      followUps: ['PLT-4 Add the index'],
      statusLabel: 'Resolved',
      priorityLabel: 'P1',
      cost: '€1,000.00',
      formatTime: (at) => `t${at / HOUR}`,
    }, words);
    assert.match(page, /^# TITLE: INC-1 Checkout down/);
    assert.match(page, /\| DURATION \| 2 h \|/);
    assert.match(page, /- \*\*t1\*\* — Ada: rolled back the deploy/, 'a line break inside an update broke the list');
    assert.match(page, /## ROOTCAUSE\n\nA missing index/);
    assert.match(page, /- \[ \] PLT-4 Add the index/);
    assert.match(page, /## LESSONS\n\n_TBD_/);
    assert.match(page, /## IMPACT\n\n_TBD_/);
  });
});
