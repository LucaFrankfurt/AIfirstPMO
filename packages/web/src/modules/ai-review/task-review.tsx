import { useEffect, useState } from 'react';
import type { ReviewFinding, Task, TaskReview } from '@kolibri/shared';
import { api, ApiError } from '../../kernel/sync/api';
import { comment, update } from '../../kernel/sync/mutations';
import { useT } from '../../kernel/i18n/i18n';
import { useCanWrite, useFeature, useMe } from '../../kernel/identity/session';
import { Button } from '../../kernel/design-system/ui/button';
import { Icon, useToast } from '../../kernel/design-system/ui';
import { Markdown } from '../pages/Markdown';

/**
 * A second pair of eyes on a task, before anybody else has to read it.
 *
 * Three rules hold this together, and all three are about restraint.
 *
 * **Nothing is written without a click.** The panel proposes; `update()` runs
 * only from a button. What lands is an ordinary edit — it syncs, it merges, it
 * shows up in the activity tab under the name of whoever accepted it, because
 * that is who decided.
 *
 * **Nothing is stored.** A review lives as long as this panel does. It could
 * have been an entity with a table and a sync rule, to persist advice whose
 * whole lifespan is the thirty seconds before somebody accepts or rejects it.
 * The durable thing is the task.
 *
 * **A suggestion arrives finished.** A finding with no replacement text is
 * shown without a button rather than with one that opens an editor: "this
 * could be clearer" is something the person already knew, and the only version
 * of this feature worth having is one where agreeing takes a click.
 *
 * The questions are the other half. A model that cannot tell which export is
 * meant must ask rather than guess, and a question nobody can act on is a dead
 * end — so they are offered as a comment, which puts the ambiguity in front of
 * the person who can settle it and notifies them the way anything else would.
 */

/**
 * Whether this server can reach a model at all.
 *
 * Asked once per page load and remembered: the answer is a property of the
 * instance, not of the task, and one fetch per task sheet would be a request
 * per click. A failure — offline, most likely — reads as "no", which is the
 * right direction: there is no reviewing anything without a network.
 */
let asked: Promise<{ provider: string } | null> | null = null;

function useAiProvider(): string | null {
  const [provider, setProvider] = useState<string | null>(null);
  useEffect(() => {
    asked ??= api.config().then((config) => config.ai).catch(() => null);
    let live = true;
    asked.then((ai) => { if (live) setProvider(ai?.provider ?? null); });
    return () => { live = false; };
  }, []);
  return provider;
}

/** So a test and a person can both be sure the panel is talking about now. */
const isStale = (review: TaskReview, task: Task): boolean => review.reviewed_at !== task.updated_at;

function Finding({ finding, task }: { finding: ReviewFinding; task: Task }) {
  const t = useT();
  const toast = useToast();
  const [applied, setApplied] = useState(false);
  const [open, setOpen] = useState(false);

  const apply = () => {
    if (!finding.field || !finding.replacement) return;
    update('task', task.id, { [finding.field]: finding.replacement });
    setApplied(true);
    toast(t('review.applied'));
  };

  return (
    <li className="review-finding">
      <p className="review-problem">{finding.problem}</p>
      {finding.field && finding.replacement && (
        <>
          {/* The proposal itself, not a promise of one. A title is one line and
              is shown outright; a description can be pages, so it opens. */}
          {finding.field === 'title' ? (
            <p className="review-replacement">{finding.replacement}</p>
          ) : (
            <>
              <button type="button" className="review-toggle" onClick={() => setOpen(!open)}>
                <Icon name={open ? 'chevronDown' : 'chevronRight'} size={12} />
                {t(open ? 'review.hideProposal' : 'review.showProposal')}
              </button>
              {open && <div className="review-replacement"><Markdown source={finding.replacement} /></div>}
            </>
          )}
          <div className="flex items-center gap-1.5 mt-1.5">
            <Button size="sm" variant="primary" disabled={applied} onClick={apply}>
              {applied ? t('review.appliedShort') : t('review.apply')}
            </Button>
          </div>
        </>
      )}
    </li>
  );
}

export function TaskReviewPanel({ task }: { task: Task }) {
  const t = useT();
  const me = useMe();
  const toast = useToast();
  const provider = useAiProvider();
  const switchedOn = useFeature('ai');
  const canWrite = useCanWrite();

  const [review, setReview] = useState<TaskReview | null>(null);
  const [working, setWorking] = useState(false);
  const [asking, setAsking] = useState(false);

  // A review belongs to the task it read. Opening another one through the
  // sub-task list keeps the sheet mounted, and a panel that carried the last
  // task's findings across would be offering to rewrite the wrong title.
  useEffect(() => { setReview(null); }, [task.id]);

  // Off leaves no trace. Not a disabled button with an explanation — an
  // instance with no key configured should look like an app without the
  // feature, and the place to learn about it is the workspace settings.
  if (!provider || !switchedOn || !canWrite) return null;

  const run = async () => {
    setWorking(true);
    try {
      setReview(await api.review(task.id));
    } catch (problem) {
      toast(problem instanceof ApiError && problem.message ? problem.message : t('review.failed'));
    } finally {
      setWorking(false);
    }
  };

  const ask = () => {
    if (!review?.questions.length) return;
    comment(
      { task_id: task.id },
      `${t('review.questionsIntro')}\n\n${review.questions.map((question) => `- ${question}`).join('\n')}`,
      me,
    );
    setAsking(true);
    toast(t('review.asked'));
  };

  return (
    <section className="mb-[18px]">
      <div className="flex items-center gap-2 mb-1.5">
        <strong className="text-[13.5px]">{t('review.title')}</strong>
        <span className="flex-1 min-w-0" />
        <Button size="sm" disabled={working} onClick={run}>
          <Icon name="bolt" size={13} />
          {working ? t('action.working') : review ? t('review.again') : t('review.ask')}
        </Button>
      </div>

      {!review && (
        // Said before the first click rather than after it: this is the one
        // button in the app that sends the workspace's own words elsewhere,
        // and who receives them is not a detail to discover afterwards.
        <p className="text-muted text-[12px] m-0">{t('review.sends', { provider })}</p>
      )}

      {review && (
        <div className="review">
          <p className="review-summary">
            <Icon name={review.verdict === 'clear' ? 'check' : 'bolt'} size={13} />
            {review.summary}
          </p>

          {isStale(review, task) && (
            <p className="review-stale">{t('review.stale')}</p>
          )}

          {!!review.findings.length && (
            <ul className="review-list">
              {review.findings.map((finding, at) => (
                <Finding key={`${finding.kind}-${at}`} finding={finding} task={task} />
              ))}
            </ul>
          )}

          {!!review.questions.length && (
            <div className="review-questions">
              <strong className="text-[12.5px]">{t('review.questions')}</strong>
              <ul>
                {review.questions.map((question) => <li key={question}>{question}</li>)}
              </ul>
              {/* The one thing to do with a question: put it where the person
                  who knows the answer will see it. */}
              <Button size="sm" disabled={asking} onClick={ask}>
                {asking ? t('review.askedShort') : t('review.askThem')}
              </Button>
            </div>
          )}

          <p className="review-by">{t('review.by', { model: review.model })}</p>
        </div>
      )}
    </section>
  );
}
