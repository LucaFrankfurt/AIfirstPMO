/**
 * The timesheet: a week of logged time, and what it cost.
 *
 * Two tabs because they are two jobs. The week grid is something somebody
 * *checks* — did I write Thursday down — and the cost report is something
 * somebody *reports*, over months. Putting them on one screen with one date
 * range would make both of them awkward.
 *
 * The cost half only exists for owners and admins, because their device is the
 * only one that has any rates on it. See `filterFor` in the server's `sync.ts`.
 */
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Header } from '../components/AppShell';
import { CostReport, Timesheet } from '../components/rates';
import { Empty } from '../components/ui';
import { useT, type TranslationKey } from '../lib/i18n';
import { useTabStrip } from '../lib/tab-strip';
import { useFeature, useSeesMoney } from '../session';

const TABS = ['week', 'cost'] as const;
type Tab = (typeof TABS)[number];
const TAB_KEY: Record<Tab, TranslationKey> = {
  week: 'timesheet.tabWeek',
  cost: 'timesheet.tabCost',
};

export function TimesheetPage() {
  const t = useT();
  const time = useFeature('time');
  const seesMoney = useSeesMoney();
  const [params, setParams] = useSearchParams();
  const asked = params.get('tab');
  const [tab, setTab] = useState<Tab>(TABS.includes(asked as Tab) ? asked as Tab : 'week');
  const strip = useTabStrip(tab);

  if (!time) {
    return (
      <>
        <Header title={t('timesheet.title')} />
        <Empty emoji="🔕" title={t('timesheet.offTitle')} hint={t('timesheet.offHint')} />
      </>
    );
  }

  // One tab is not a tab strip. A member sees the week and nothing about it
  // says there is a second screen they cannot have.
  const tabs = seesMoney ? TABS : (['week'] as const);

  return (
    <>
      <Header title={t('timesheet.title')} />
      {tabs.length > 1 && (
        <div ref={strip} className="tabs" style={{ padding: '0 12px' }}>
          {tabs.map((name) => (
            <button
              key={name}
              className={tab === name ? 'active' : ''}
              onClick={() => {
                setTab(name);
                setParams(name === 'week' ? {} : { tab: name }, { replace: true });
              }}
            >
              {t(TAB_KEY[name])}
            </button>
          ))}
        </div>
      )}
      {tab === 'cost' && seesMoney ? <CostReport /> : <Timesheet />}
    </>
  );
}
