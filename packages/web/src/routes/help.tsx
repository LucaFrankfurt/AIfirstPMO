/**
 * The guide.
 *
 * A manual that lives inside the product, because a README somebody has to
 * find on GitHub is a manual nobody reads. Four sections: what the thing is,
 * how the pieces nest, what each feature does with an animation showing it,
 * and the keyboard shortcuts.
 *
 * Every feature card ends in a link into the real screen — the point of the
 * guide is to be left, not to be read twice.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Header } from '../components/AppShell';
import {
  AssistantDiagram, AutomationDiagram, CaptureDiagram, ChatDiagram,
  CollaborationDiagram,
  OverviewDiagram, PagesDiagram, PlanningDiagram, SyncDiagram, ViewsDiagram,
} from '../components/diagrams';
import { HierarchyExplorer } from '../components/hierarchy';
import { Icon } from '../components/ui';
import { cardId, sectionFor, type GuideSection } from '../lib/guide';
import { useT, type TranslationKey } from '../lib/i18n';
import { SHOW_CHECKLIST, START_TOUR } from '../components/tour';

type Section = GuideSection;

const SECTION_KEY: Record<Section, TranslationKey> = {
  overview: 'guide.tabOverview',
  hierarchy: 'guide.tabHierarchy',
  features: 'guide.tabFeatures',
  shortcuts: 'guide.tabShortcuts',
};

/* ------------------------------------------------------------- building blocks */

function Feature({
  id, icon, title, lead, steps, to, linkLabel, children,
}: {
  /** Also the guide target other screens link to: `/guide?to=<id>`. */
  id: string;
  icon: string;
  title: TranslationKey;
  lead: TranslationKey;
  /** The how-to, in order. Kept short: the animation carries the detail. */
  steps: TranslationKey[];
  to: string;
  linkLabel: TranslationKey;
  children: ReactNode;
}) {
  const t = useT();
  return (
    <section className="guide-feature" id={cardId(id)}>
      <div className="guide-feature-head">
        <span className="guide-icon"><Icon name={icon} size={16} /></span>
        <h3>{t(title)}</h3>
      </div>
      <p className="soft">{t(lead)}</p>

      {children}

      <ol className="guide-steps">
        {steps.map((step) => <li key={step}>{t(step)}</li>)}
      </ol>

      <Link className="btn sm" to={to}>
        {t(linkLabel)} <Icon name="chevronRight" size={13} />
      </Link>
    </section>
  );
}

const Principle = ({ icon, title, body }: { icon: string; title: TranslationKey; body: TranslationKey }) => {
  const t = useT();
  return (
    <div className="card guide-principle">
      <span className="guide-icon"><Icon name={icon} size={16} /></span>
      <strong>{t(title)}</strong>
      <span className="soft">{t(body)}</span>
    </div>
  );
};

/* ------------------------------------------------------------------ sections */

function Overview() {
  const t = useT();
  return (
    <>
      <p className="guide-lead">{t('guide.intro')}</p>

      <div className="grid three" style={{ marginBottom: 22 }}>
        <Principle icon="refresh" title="guide.principleOfflineTitle" body="guide.principleOfflineBody" />
        <Principle icon="home" title="guide.principleHostTitle" body="guide.principleHostBody" />
        <Principle icon="sparkle" title="guide.principleAssistantTitle" body="guide.principleAssistantBody" />
      </div>

      <h2 className="guide-h2">{t('guide.bigPicture')}</h2>
      <p className="soft">{t('guide.bigPictureLead')}</p>
      <OverviewDiagram />

      <h2 className="guide-h2">{t('guide.firstFiveTitle')}</h2>
      <ol className="guide-steps big">
        <li>{t('guide.firstFive1')}</li>
        <li>{t('guide.firstFive2')}</li>
        <li>{t('guide.firstFive3')}</li>
        <li>{t('guide.firstFive4')}</li>
        <li>{t('guide.firstFive5')}</li>
      </ol>
      <div className="row wrap" style={{ gap: 8 }}>
        <Link className="btn primary sm" to="/projects/new">
          {t('guide.startHere')} <Icon name="chevronRight" size={13} />
        </Link>
        <button className="btn sm" onClick={() => window.dispatchEvent(new CustomEvent(START_TOUR))}>
          <Icon name="play" size={13} /> {t('guide.restartTour')}
        </button>
        <button className="btn sm" onClick={() => window.dispatchEvent(new CustomEvent(SHOW_CHECKLIST))}>
          <Icon name="check" size={13} /> {t('guide.showChecklist')}
        </button>
      </div>
      <p className="soft" style={{ marginTop: 12, fontSize: 12.5 }}>{t('guide.helpFromHere')}</p>
    </>
  );
}

function Hierarchy() {
  const t = useT();
  return (
    <>
      <p className="guide-lead">{t('guide.hierarchyIntro')}</p>
      <HierarchyExplorer />

      <h2 className="guide-h2">{t('guide.rulesTitle')}</h2>
      <p className="soft">{t('guide.rulesLead')}</p>
      <ul className="guide-rules">
        <li>{t('guide.rule1')}</li>
        <li>{t('guide.rule2')}</li>
        <li>{t('guide.rule3')}</li>
        <li>{t('guide.rule4')}</li>
        <li>{t('guide.rule5')}</li>
        <li>{t('guide.rule6')}</li>
        <li>{t('guide.rule7')}</li>
      </ul>
    </>
  );
}

function Features() {
  const t = useT();
  return (
    <>
      <p className="guide-lead">{t('guide.featuresIntro')}</p>

      <Feature
        id="capture"
        icon="plus"
        title="guide.capture.title"
        lead="guide.capture.lead"
        to="/"
        linkLabel="guide.capture.cta"
        steps={['guide.capture.h1', 'guide.capture.h2', 'guide.capture.h3', 'guide.capture.h4', 'guide.capture.h5']}
      >
        <CaptureDiagram />
      </Feature>

      <Feature
        id="views"
        icon="board"
        title="guide.views.title"
        lead="guide.views.lead"
        to="/projects"
        linkLabel="guide.views.cta"
        steps={['guide.views.h1', 'guide.views.h2', 'guide.views.h3', 'guide.views.h4', 'guide.views.h5', 'guide.views.h6', 'guide.views.h7', 'guide.views.h8']}
      >
        <ViewsDiagram />
      </Feature>

      <Feature
        id="planning"
        icon="cycle"
        title="guide.planning.title"
        lead="guide.planning.lead"
        to="/projects"
        linkLabel="guide.planning.cta"
        steps={['guide.planning.h1', 'guide.planning.h2', 'guide.planning.h3', 'guide.planning.h4', 'guide.planning.h5', 'guide.planning.h6']}
      >
        <PlanningDiagram />
      </Feature>

      <Feature
        id="sync"
        icon="refresh"
        title="guide.sync.title"
        lead="guide.sync.lead"
        to="/settings"
        linkLabel="guide.sync.cta"
        steps={['guide.sync.h1', 'guide.sync.h2', 'guide.sync.h3', 'guide.sync.h4', 'guide.sync.h5']}
      >
        <SyncDiagram />
      </Feature>

      <Feature
        id="pages"
        icon="page"
        title="guide.pages.title"
        lead="guide.pages.lead"
        to="/pages"
        linkLabel="guide.pages.cta"
        steps={['guide.pages.h1', 'guide.pages.h2', 'guide.pages.h3', 'guide.pages.h4', 'guide.pages.h5', 'guide.pages.h6']}
      >
        <PagesDiagram />
      </Feature>

      <Feature
        id="collab"
        icon="inbox"
        title="guide.collab.title"
        lead="guide.collab.lead"
        to="/inbox"
        linkLabel="guide.collab.cta"
        steps={['guide.collab.h1', 'guide.collab.h6', 'guide.collab.h2', 'guide.collab.h5', 'guide.collab.h3', 'guide.collab.h4']}
      >
        <CollaborationDiagram />
      </Feature>

      <Feature
        id="chat"
        icon="chat"
        title="guide.chat.title"
        lead="guide.chat.lead"
        to="/chat"
        linkLabel="guide.chat.cta"
        steps={['guide.chat.h1', 'guide.chat.h2', 'guide.chat.h3', 'guide.chat.h4']}
      >
        <ChatDiagram />
      </Feature>

      <Feature
        id="teams"
        icon="users"
        title="guide.teams.title"
        lead="guide.teams.lead"
        to="/teams"
        linkLabel="guide.teams.cta"
        steps={['guide.teams.h1', 'guide.teams.h2', 'guide.teams.h3', 'guide.teams.h4']}
      >
        <div className="guide-roles">
          {(['owner', 'admin', 'member', 'guest'] as const).map((role) => (
            <div className="card guide-role" key={role}>
              <strong>{t(`members.role${role[0].toUpperCase()}${role.slice(1)}` as TranslationKey)}</strong>
              <span className="soft">{t(`guide.role.${role}` as TranslationKey)}</span>
            </div>
          ))}
        </div>
      </Feature>

      <Feature
        id="automation"
        icon="refresh"
        title="guide.automation.title"
        lead="guide.automation.lead"
        to="/settings?tab=automation"
        linkLabel="guide.automation.cta"
        steps={['guide.automation.h1', 'guide.automation.h2', 'guide.automation.h3', 'guide.automation.h4']}
      >
        <AutomationDiagram />
        <p className="soft" style={{ fontSize: 12.5, marginTop: 10 }}>{t('guide.automation.newProject')}</p>
      </Feature>

      <Feature
        id="assistant"
        icon="sparkle"
        title="guide.assistant.title"
        lead="guide.assistant.lead"
        to="/settings"
        linkLabel="guide.assistant.cta"
        steps={['guide.assistant.h1', 'guide.assistant.h2', 'guide.assistant.h3', 'guide.assistant.h4']}
      >
        <AssistantDiagram />
      </Feature>
    </>
  );
}

const SHORTCUTS: { keys: string[]; what: TranslationKey }[] = [
  { keys: ['⌘', 'K'], what: 'guide.key.palette' },
  { keys: ['C'], what: 'guide.key.newTask' },
  { keys: ['?'], what: 'guide.key.guide' },
  { keys: ['Esc'], what: 'guide.key.close' },
  { keys: ['⌘', '↵'], what: 'guide.key.submit' },
  { keys: ['↑', '↓'], what: 'guide.key.navigate' },
  { keys: ['Tab'], what: 'guide.key.indent' },
];

function Shortcuts() {
  const t = useT();
  return (
    <>
      <p className="guide-lead">{t('guide.shortcutsIntro')}</p>
      <div className="guide-keys">
        {SHORTCUTS.map((shortcut) => (
          <div className="guide-key-row" key={shortcut.what}>
            <span className="guide-key-caps">
              {shortcut.keys.map((cap) => <kbd className="gx-key" key={cap}>{cap}</kbd>)}
            </span>
            <span className="soft">{t(shortcut.what)}</span>
          </div>
        ))}
      </div>
      <p className="soft" style={{ marginTop: 14 }}>{t('guide.shortcutsMac')}</p>
    </>
  );
}

/* -------------------------------------------------------------------- route */

export function Help() {
  const t = useT();
  const [params, setParams] = useSearchParams();
  const target = params.get('to');
  const [section, setSection] = useState<Section>(() => (target ? sectionFor(target) : 'overview'));
  const highlighted = useRef<string | null>(null);

  // Arriving from an empty screen should land on the card that explains it,
  // not at the top of a manual the reader then has to search.
  useEffect(() => {
    if (!target) return;
    setSection(sectionFor(target));
    const id = cardId(target);
    highlighted.current = id;
    // One frame for the section to render, then scroll and mark it briefly.
    const handle = setTimeout(() => {
      const card = document.getElementById(id);
      if (!card) return;
      card.scrollIntoView({ block: 'start', behavior: 'smooth' });
      card.classList.add('flash');
      setTimeout(() => card.classList.remove('flash'), 1600);
    }, 60);
    return () => clearTimeout(handle);
  }, [target]);

  const choose = (next: Section) => {
    setSection(next);
    if (target) setParams({}, { replace: true });   // stop re-scrolling on a manual switch
  };

  return (
    <>
      <Header title={t('guide.title')} />
      <div className="tabs" style={{ padding: '0 12px' }}>
        {(Object.keys(SECTION_KEY) as Section[]).map((name) => (
          <button key={name} className={section === name ? 'active' : ''} onClick={() => choose(name)}>
            {t(SECTION_KEY[name])}
          </button>
        ))}
      </div>
      <div className="page guide">
        {section === 'overview' && <Overview />}
        {section === 'hierarchy' && <Hierarchy />}
        {section === 'features' && <Features />}
        {section === 'shortcuts' && <Shortcuts />}
      </div>
    </>
  );
}
