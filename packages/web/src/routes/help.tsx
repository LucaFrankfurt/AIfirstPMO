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
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Header } from '../components/AppShell';
import {
  AssistantDiagram, CaptureDiagram, CollaborationDiagram, OverviewDiagram,
  PagesDiagram, PlanningDiagram, SyncDiagram, ViewsDiagram,
} from '../components/diagrams';
import { HierarchyExplorer } from '../components/hierarchy';
import { Icon } from '../components/ui';
import { useT, type TranslationKey } from '../lib/i18n';

type Section = 'overview' | 'hierarchy' | 'features' | 'shortcuts';

const SECTION_KEY: Record<Section, TranslationKey> = {
  overview: 'guide.tabOverview',
  hierarchy: 'guide.tabHierarchy',
  features: 'guide.tabFeatures',
  shortcuts: 'guide.tabShortcuts',
};

/* ------------------------------------------------------------- building blocks */

function Feature({
  icon, title, lead, steps, to, linkLabel, children,
}: {
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
    <section className="guide-feature">
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
      <Link className="btn primary sm" to="/projects/new">
        {t('guide.startHere')} <Icon name="chevronRight" size={13} />
      </Link>
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
        icon="plus"
        title="guide.capture.title"
        lead="guide.capture.lead"
        to="/"
        linkLabel="guide.capture.cta"
        steps={['guide.capture.h1', 'guide.capture.h2', 'guide.capture.h3', 'guide.capture.h4']}
      >
        <CaptureDiagram />
      </Feature>

      <Feature
        icon="board"
        title="guide.views.title"
        lead="guide.views.lead"
        to="/projects"
        linkLabel="guide.views.cta"
        steps={['guide.views.h1', 'guide.views.h2', 'guide.views.h3', 'guide.views.h4']}
      >
        <ViewsDiagram />
      </Feature>

      <Feature
        icon="cycle"
        title="guide.planning.title"
        lead="guide.planning.lead"
        to="/projects"
        linkLabel="guide.planning.cta"
        steps={['guide.planning.h1', 'guide.planning.h2', 'guide.planning.h3', 'guide.planning.h4']}
      >
        <PlanningDiagram />
      </Feature>

      <Feature
        icon="refresh"
        title="guide.sync.title"
        lead="guide.sync.lead"
        to="/settings"
        linkLabel="guide.sync.cta"
        steps={['guide.sync.h1', 'guide.sync.h2', 'guide.sync.h3', 'guide.sync.h4']}
      >
        <SyncDiagram />
      </Feature>

      <Feature
        icon="page"
        title="guide.pages.title"
        lead="guide.pages.lead"
        to="/pages"
        linkLabel="guide.pages.cta"
        steps={['guide.pages.h1', 'guide.pages.h2', 'guide.pages.h3', 'guide.pages.h4']}
      >
        <PagesDiagram />
      </Feature>

      <Feature
        icon="inbox"
        title="guide.collab.title"
        lead="guide.collab.lead"
        to="/inbox"
        linkLabel="guide.collab.cta"
        steps={['guide.collab.h1', 'guide.collab.h2', 'guide.collab.h3', 'guide.collab.h4']}
      >
        <CollaborationDiagram />
      </Feature>

      <Feature
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
  const [section, setSection] = useState<Section>('overview');

  return (
    <>
      <Header title={t('guide.title')} />
      <div className="tabs" style={{ padding: '0 12px' }}>
        {(Object.keys(SECTION_KEY) as Section[]).map((name) => (
          <button key={name} className={section === name ? 'active' : ''} onClick={() => setSection(name)}>
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
