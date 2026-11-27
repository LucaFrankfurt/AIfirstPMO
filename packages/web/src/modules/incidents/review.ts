/**
 * The post-incident review, filed from the screen.
 *
 * The page is `reviewMarkdown` from `@kolibri/shared` — the same function
 * `write_incident_review` calls over MCP — so a review filed by a person and
 * one filed by an assistant have the same headings in the same order, and a
 * workspace's reviews read as one series rather than two dialects. The words
 * come from this side's catalogue, in the reader's language.
 *
 * It is created offline like any page and linked to the incident in the same
 * breath; the link is the incident's `pages` list, so the review is one click
 * from the record and the record one search from the review.
 */
import { formatMoney, reviewMarkdown, type Incident, type IncidentUpdate, type Task } from '@kolibri/shared';
import { exactTime } from '../../kernel/design-system/format';
import { currentLocale, type Translate } from '../../kernel/i18n/i18n';
import { createPage, update } from '../../kernel/sync/mutations';
import { byId } from '../../kernel/sync/store';
import { priorityKey, statusKey } from './incident-parts';

export function fileReview(
  incident: Incident,
  timeline: IncidentUpdate[],
  changeWords: (line: IncidentUpdate) => string,
  t: Translate,
  actorId: string,
): string {
  const apps = (incident.applications ?? []).map((id) => byId('application', id)?.name).filter((name): name is string => !!name);
  const followUps = (incident.tasks ?? [])
    .map((id) => byId('task', id))
    .filter((task): task is Task => !!task && !task.deleted_at)
    .map((task) => `${task.identifier} ${task.title}`);
  const content = reviewMarkdown({
    incident,
    timeline: timeline.map((line) => ({
      at: line.occurred_at,
      text: line.kind === 'change'
        ? changeWords(line)
        : `${line.author_id ? `${byId('user', line.author_id)?.name ?? ''}: ` : ''}${line.body ?? ''}`,
    })),
    managerName: incident.manager_id ? byId('user', incident.manager_id)?.name ?? null : null,
    applicationNames: apps,
    followUps,
    statusLabel: t(statusKey(incident.status)),
    priorityLabel: t(priorityKey(incident.priority)),
    cost: incident.financial_impact === null ? null : formatMoney(incident.financial_impact, incident.currency, currentLocale()),
    formatTime: exactTime,
  }, {
    title: t('incident.review.title'), summary: t('incident.review.summary'), impact: t('incident.review.impact'),
    timeline: t('incident.review.timeline'), rootCause: t('incident.rootCause'), resolution: t('incident.resolutionText'),
    followUps: t('incident.followUps'), lessons: t('incident.review.lessons'), priority: t('incident.priority'),
    status: t('incident.status'), manager: t('incident.manager'), applications: t('incident.applications'),
    started: t('incident.startedAt'), detected: t('incident.detectedAt'), ended: t('incident.endedAt'),
    duration: t('incident.clock.impact'), timeToDetect: t('incident.clock.detect'), timeToResolve: t('incident.clock.resolve'),
    financialImpact: t('incident.financialImpact'), affectedUsers: t('incident.affectedUsers'),
    none: '—', toBeWritten: t('incident.review.toBeWritten'),
  });
  const pageId = createPage({
    title: `${t('incident.review.title')}: ${incident.identifier} ${incident.summary}`,
    icon: '🧯',
    content,
    format: 'markdown',
  }, actorId);
  update('incident', incident.id, { pages: [...new Set([...(incident.pages ?? []), pageId])] });
  return pageId;
}
