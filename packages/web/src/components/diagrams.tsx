/**
 * The guide's animated diagrams.
 *
 * Each one is a miniature of the real interface rather than an abstract box
 * chart: somebody who has just watched a card cross a board should recognise
 * that card when they open a project a minute later. Everything positional is
 * a function of the step, and CSS transitions do the moving.
 */
import { useT } from '../lib/i18n';
import { Conn, Frame, Key, MiniBox, MiniChip, MiniTask, Row, Stage } from './explain';
import { Icon } from './ui';

/* ------------------------------------------------------------- overview */

/**
 * The high-level one: what contains what, built up a layer at a time. It is
 * deliberately the same shape as the hierarchy explorer further down the page,
 * so the two reinforce each other instead of competing.
 */
export function OverviewDiagram() {
  const t = useT();
  return (
    <Stage
      label="guide.overview.label"
      minHeight={324}
      interval={3400}
      captions={[
        'guide.overview.s0', 'guide.overview.s1', 'guide.overview.s2',
        'guide.overview.s3', 'guide.overview.s4', 'guide.overview.s5',
      ]}
    >
      {(step) => (
        <div className="gx-scene gx-overview">
          <MiniBox
            tone="muted"
            on
            title={<><Icon name="home" size={12} /> {t('guide.overview.workspace')}</>}
            className="gx-ws"
          >
            <MiniBox
              on={step >= 1}
              title={<><span>🌐</span> {t('guide.overview.project')} <MiniChip>WEB</MiniChip></>}
              className="gx-proj"
            >
              <Row className="gx-wrap">
                <MiniChip tone="accent">{t('group.unstarted')}</MiniChip>
                <MiniChip tone="accent">{t('group.started')}</MiniChip>
                <MiniChip tone="accent">{t('group.completed')}</MiniChip>
                <MiniChip>bug</MiniChip>
              </Row>
              <div className="gx-stack" data-on={step >= 2 ? 'true' : 'false'}>
                <MiniTask id="WEB-1" title={t('guide.sample.task1')} />
                <MiniTask id="WEB-2" title={t('guide.sample.task2')} />
              </div>
              <Row className="gx-planbar" data-on={step >= 3 ? 'true' : 'false'}>
                <MiniChip tone="ok"><Icon name="cycle" size={10} /> {t('guide.overview.cycle')}</MiniChip>
                <MiniChip tone="ok"><Icon name="target" size={10} /> {t('guide.overview.module')}</MiniChip>
              </Row>
            </MiniBox>

            <MiniBox
              on={step >= 4}
              title={<><Icon name="page" size={12} /> {t('guide.overview.page')}</>}
              className="gx-page"
            >
              <span className="gx-line" style={{ width: '82%' }} />
              <span className="gx-line" style={{ width: '58%' }} />
            </MiniBox>
          </MiniBox>

          <Row className="gx-feet" data-on={step >= 5 ? 'true' : 'false'}>
            <Frame className="gx-foot"><Icon name="board" size={13} /> {t('guide.overview.device')}</Frame>
            <Frame className="gx-foot"><Icon name="refresh" size={13} /> {t('guide.overview.sync')}</Frame>
            <Frame className="gx-foot"><Icon name="sparkle" size={13} /> {t('guide.overview.assistant')}</Frame>
          </Row>
        </div>
      )}
    </Stage>
  );
}

/* -------------------------------------------------------------- capture */

/** Detailed: getting a thought out of your head and into a project. */
export function CaptureDiagram() {
  const t = useT();
  return (
    <Stage
      label="guide.capture.label"
      minHeight={244}
      captions={['guide.capture.s0', 'guide.capture.s1', 'guide.capture.s2', 'guide.capture.s3']}
    >
      {(step) => (
        <div className="gx-scene gx-capture">
          <Frame className="gx-app">
            <Row className="gx-appbar">
              <span className="gx-strong">{t('nav.myWork')}</span>
              <span className="grow" />
              <Key pressed={step === 0}>C</Key>
            </Row>
            <MiniTask id="WEB-1" title={t('guide.sample.task1')} dim />
            <MiniTask id="WEB-2" title={t('guide.sample.task2')} dim />
            <MiniTask id="WEB-12" title={t('guide.sample.newTask')} accent={step >= 3} dim={step < 3}>
              <MiniChip tone="warn">{t('priority.high')}</MiniChip>
            </MiniTask>
          </Frame>

          <Frame className="gx-sheet" data-on={step >= 1 && step < 3 ? 'true' : 'false'}>
            <Row className="gx-sheet-head">
              <strong>{t('quickAdd.title')}</strong>
              <span className="grow" />
              <Icon name="close" size={13} />
            </Row>
            <div className="gx-field" data-typing={step === 1 ? 'true' : undefined}>
              {step >= 1 ? t('guide.sample.newTask') : t('quickAdd.placeholder')}
            </div>
            <Row className="gx-wrap">
              <MiniChip tone={step >= 2 ? 'accent' : undefined}>🌐 {t('guide.sample.project')}</MiniChip>
              <MiniChip tone={step >= 2 ? 'warn' : undefined}>{t('priority.high')}</MiniChip>
              <MiniChip tone={step >= 2 ? 'accent' : undefined}>@ada</MiniChip>
            </Row>
            <Row className="gx-sheet-foot">
              <span className="gx-btn">{t('quickAdd.saveAndNew')}</span>
              <span className="gx-btn primary">{t('quickAdd.create')}</span>
            </Row>
          </Frame>
        </div>
      )}
    </Stage>
  );
}

/* ---------------------------------------------------------------- views */

/**
 * Layout, grouping and the board. The card that moves is one absolutely
 * positioned element whose column is chosen by the step, so the transition
 * survives — re-parenting it into each column would not animate.
 */
export function ViewsDiagram() {
  const t = useT();
  const columns = [t('group.unstarted'), t('group.started'), t('group.completed')];

  return (
    <Stage
      label="guide.views.label"
      minHeight={248}
      captions={[
        'guide.views.s0', 'guide.views.s1', 'guide.views.s2',
        'guide.views.s3', 'guide.views.s4', 'guide.views.s5',
      ]}
    >
      {(step) => {
        const board = step >= 2;
        const column = step <= 2 ? 0 : step === 3 ? 1 : 2;
        return (
          <div className="gx-scene gx-views">
            <Row className="gx-toolbar">
              <span className={`gx-tool${!board ? ' on' : ''}`}><Icon name="list" size={12} /> {t('view.list')}</span>
              <span className={`gx-tool${board ? ' on' : ''}`}><Icon name="board" size={12} /> {t('view.board')}</span>
              <span className="gx-tool"><Icon name="calendar" size={12} /> {t('view.calendar')}</span>
              <span className="grow" />
              <span className={`gx-tool${step === 1 ? ' on' : ''}`}>
                <Icon name="filter" size={12} /> {step === 1 ? t('view.groupAssignee') : t('view.groupState')}
              </span>
            </Row>

            {!board ? (
              <div className="gx-list">
                <div className="gx-grouphead">{step === 1 ? t('guide.sample.person1') : columns[0]}</div>
                <MiniTask id="WEB-2" title={t('guide.sample.task2')} />
                <MiniTask id="WEB-8" title={t('guide.sample.task3')} />
                <div className="gx-grouphead">{step === 1 ? t('guide.sample.person2') : columns[1]}</div>
                <MiniTask id="WEB-1" title={t('guide.sample.task1')} />
              </div>
            ) : (
              <div className="gx-columns">
                {columns.map((name, index) => (
                  <div className="gx-col" key={name} data-target={index === column ? 'true' : undefined}>
                    <div className="gx-col-head">{name}</div>
                    {index === 0 && <div className="gx-card">{t('guide.sample.task3')}</div>}
                    {index === 2 && <div className="gx-card done">{t('guide.sample.task2')}</div>}
                  </div>
                ))}
                <div
                  className={`gx-card travelling${step >= 5 ? ' done' : ''}`}
                  style={{ insetInlineStart: `calc(${column} * (33.333% + 2px) + 6px)` }}
                >
                  <span className="gx-id">WEB-1</span>
                  {t('guide.sample.task1')}
                </div>
              </div>
            )}
          </div>
        );
      }}
    </Stage>
  );
}

/* ------------------------------------------------------------- planning */

/** Cycles are windows of time; modules are outcomes that span several of them. */
export function PlanningDiagram() {
  const t = useT();
  return (
    <Stage
      label="guide.planning.label"
      minHeight={236}
      captions={['guide.planning.s0', 'guide.planning.s1', 'guide.planning.s2', 'guide.planning.s3']}
    >
      {(step) => (
        <div className="gx-scene gx-planning">
          <div className="gx-timeline">
            {[0, 1, 2].map((index) => (
              <div className="gx-week" key={index} data-on={step >= 1 || index === 0 ? 'true' : 'false'}>
                <span className="gx-week-label">
                  {t('guide.planning.cycleName', { number: index + 1 })}
                </span>
              </div>
            ))}
          </div>

          <div className="gx-module" data-on={step >= 2 ? 'true' : 'false'}>
            <Icon name="target" size={12} /> {t('guide.planning.moduleName')}
          </div>

          <div className="gx-cycle-body">
            <MiniTask id="WEB-1" title={t('guide.sample.task1')} done={step >= 3}>
              <MiniChip>5p</MiniChip>
            </MiniTask>
            <MiniTask id="WEB-2" title={t('guide.sample.task2')} done={step >= 3}>
              <MiniChip>3p</MiniChip>
            </MiniTask>
            <MiniTask id="WEB-8" title={t('guide.sample.task3')}>
              <MiniChip>2p</MiniChip>
            </MiniTask>
          </div>

          <Row className="gx-burn">
            <span className="gx-progress">
              <i style={{ width: step >= 3 ? '80%' : step >= 2 ? '30%' : '0%' }} />
            </span>
            <span className="gx-muted">
              {t('cycle.pointProgress', { done: step >= 3 ? 8 : step >= 2 ? 3 : 0, total: 10 })}
            </span>
          </Row>
        </div>
      )}
    </Stage>
  );
}

/* ----------------------------------------------------------------- sync */

/**
 * The one worth watching twice: two people editing the same task while one of
 * them is on a train. It shows the outbox filling, the reconnect, and — the
 * part people do not expect — that the merge happens per field, so neither
 * edit is thrown away.
 */
export function SyncDiagram() {
  const t = useT();
  return (
    <Stage
      label="guide.sync.label"
      minHeight={268}
      interval={3600}
      captions={[
        'guide.sync.s0', 'guide.sync.s1', 'guide.sync.s2',
        'guide.sync.s3', 'guide.sync.s4', 'guide.sync.s5',
      ]}
    >
      {(step) => {
        const offline = step >= 1 && step <= 2;
        const queued = step === 1 || step === 2;
        // Once merged, both sides show the same row: A's title, B's priority.
        const merged = step >= 4;
        return (
          <div className="gx-scene gx-sync">
            <div className="gx-sync-devices">
              {/* Ada goes offline and keeps working */}
              <Frame className="gx-device">
                <Row className="gx-device-head">
                  <strong>{t('guide.sample.person1')}</strong>
                  <span className="grow" />
                  <span className={`gx-pill${offline ? ' offline' : ''}`}>
                    <i /> {offline ? t('sync.offline') : t('sync.synced')}
                  </span>
                </Row>
                <div className="gx-field small">
                  {step >= 1 ? t('guide.sync.titleNew') : t('guide.sync.titleOld')}
                </div>
                <Row className="gx-wrap">
                  <MiniChip tone={merged ? 'warn' : undefined}>
                    {merged ? t('priority.high') : t('priority.medium')}
                  </MiniChip>
                  <span className="grow" />
                  <MiniChip tone={queued ? 'accent' : undefined}>
                    {t('guide.sync.outbox', { count: queued ? 1 : 0 })}
                  </MiniChip>
                </Row>
              </Frame>

              {/* Lin stays online throughout */}
              <Frame className="gx-device">
                <Row className="gx-device-head">
                  <strong>{t('guide.sample.person2')}</strong>
                  <span className="grow" />
                  <span className="gx-pill"><i /> {t('sync.synced')}</span>
                </Row>
                <div className="gx-field small">
                  {merged ? t('guide.sync.titleNew') : t('guide.sync.titleOld')}
                </div>
                <Row className="gx-wrap">
                  <MiniChip tone={step >= 2 ? 'warn' : undefined}>
                    {step >= 2 ? t('priority.high') : t('priority.medium')}
                  </MiniChip>
                </Row>
              </Frame>
            </div>

            <div className="gx-sync-wires">
              <Conn on={step === 3 || merged} dir={merged ? 'up' : 'down'} tone={merged ? 'ok' : 'accent'} />
              <Conn on={step === 2 || merged} dir={merged ? 'up' : 'down'} tone={merged ? 'ok' : 'accent'} />
            </div>

            {/* The server keeps one row with a clock stamp per field */}
            <Frame className="gx-server">
              <div className="gx-server-title">{t('guide.sync.server')}</div>
              <div className="gx-stamps">
                <div className="gx-stamp" data-on={merged ? 'true' : 'false'}>
                  <span className="gx-stamp-key">{t('guide.sync.fieldTitle')}</span>
                  <span className="gx-stamp-owner">{t('guide.sample.person1')}</span>
                </div>
                <div className="gx-stamp" data-on={step >= 2 ? 'true' : 'false'}>
                  <span className="gx-stamp-key">{t('guide.sync.fieldPriority')}</span>
                  <span className="gx-stamp-owner">{t('guide.sample.person2')}</span>
                </div>
              </div>
            </Frame>
          </div>
        );
      }}
    </Stage>
  );
}

/* ---------------------------------------------------------------- pages */

export function PagesDiagram() {
  const t = useT();
  return (
    <Stage
      label="guide.pages.label"
      minHeight={236}
      captions={['guide.pages.s0', 'guide.pages.s1', 'guide.pages.s2', 'guide.pages.s3']}
    >
      {(step) => (
        <div className="gx-scene gx-pages">
          <Frame className="gx-tree">
            <div className="gx-tree-item on">📄 {t('guide.sample.page1')}</div>
            <div className="gx-tree-item" data-on={step >= 1 ? 'true' : 'false'} style={{ paddingInlineStart: 20 }}>
              📄 {t('guide.sample.page2')}
            </div>
            <div className="gx-tree-item" data-on={step >= 1 ? 'true' : 'false'} style={{ paddingInlineStart: 20 }}>
              📄 {t('guide.sample.page3')}
            </div>
          </Frame>

          <Frame className="gx-doc">
            <div className="gx-doc-title">{t('guide.sample.page1')}</div>
            <span className="gx-line" style={{ width: '90%' }} />
            <span className="gx-line" style={{ width: '72%' }} />
            <div className="gx-image" data-on={step >= 2 ? 'true' : 'false'}>
              <Icon name="image" size={16} />
            </div>
            <span className="gx-line" style={{ width: '64%' }} />
            <Row className="gx-versions" data-on={step >= 3 ? 'true' : 'false'}>
              <Icon name="refresh" size={12} />
              <span className="gx-muted">{t('guide.pages.versions')}</span>
              <span className="grow" />
              <span className="gx-btn">{t('action.restore')}</span>
            </Row>
          </Frame>
        </div>
      )}
    </Stage>
  );
}

/* -------------------------------------------------------- collaboration */

/** A comment turns into a notification, and notifications turn into one email. */
export function CollaborationDiagram() {
  const t = useT();
  return (
    <Stage
      label="guide.collab.label"
      minHeight={252}
      captions={['guide.collab.s0', 'guide.collab.s1', 'guide.collab.s2', 'guide.collab.s3']}
    >
      {(step) => (
        <div className="gx-scene gx-collab">
          <Frame className="gx-comment-box">
            <Row className="gx-device-head">
              <span className="gx-avatar">AL</span>
              <strong>{t('guide.sample.person1')}</strong>
            </Row>
            <div className="gx-field small">
              {t('guide.collab.commentBody')} <span className="gx-mention">@lin</span>
            </div>
            <Row className="gx-sheet-foot">
              <span className="gx-btn primary">{t('task.comment')}</span>
            </Row>
          </Frame>

          <Conn on={step >= 1} dir="right" />

          <div className="gx-collab-right">
            <Frame className="gx-inbox" data-on={step >= 1 ? 'true' : 'false'}>
              <Row className="gx-device-head">
                <Icon name="inbox" size={13} />
                <strong>{t('inbox.title')}</strong>
                <span className="grow" />
                <span className="gx-badge">1</span>
              </Row>
              <div className="gx-notif">
                <span className="gx-avatar sm">AL</span>
                <span>{t('guide.collab.notification')}</span>
              </div>
              <div className="gx-muted gx-tiny">{t('guide.collab.inRecipientLanguage')}</div>
            </Frame>

            <Conn on={step >= 2} dir="down" tone="ok" />

            <Frame className="gx-mail" data-on={step >= 2 ? 'true' : 'false'}>
              <Row>
                <Icon name="send" size={12} />
                <strong className="grow">{t('guide.collab.oneMail')}</strong>
                <MiniChip tone={step >= 3 ? 'accent' : undefined}>{t('guide.collab.preference')}</MiniChip>
              </Row>
            </Frame>
          </div>
        </div>
      )}
    </Stage>
  );
}

/* ----------------------------------------------------------------- chat */

/**
 * Why a direct conversation is one conversation.
 *
 * The thing worth drawing here is not the messages — it is the moment two
 * people open the same conversation while neither is online, and the tunnel
 * ending without a second room appearing.
 */
export function ChatDiagram() {
  const t = useT();
  return (
    <Stage
      label="guide.chat.label"
      minHeight={252}
      captions={['guide.chat.s0', 'guide.chat.s1', 'guide.chat.s2', 'guide.chat.s3']}
    >
      {(step) => (
        <div className="gx-scene gx-collab">
          <Frame className="gx-comment-box">
            <Row className="gx-device-head">
              <span className="gx-avatar">AL</span>
              <strong>{t('guide.sample.person1')}</strong>
              <span className="grow" />
              <MiniChip tone={step === 0 ? 'accent' : undefined}>{t('guide.chat.offline')}</MiniChip>
            </Row>
            <div className="gx-field small">{t('guide.chat.said1')}</div>
            <div className="gx-muted gx-tiny mono">{t('guide.chat.derivedId')}</div>
          </Frame>

          <Conn on={step >= 2} dir="right" tone="ok" />

          <div className="gx-collab-right">
            <Frame className="gx-inbox">
              <Row className="gx-device-head">
                <span className="gx-avatar sm">LN</span>
                <strong>{t('guide.sample.person2')}</strong>
                <span className="grow" />
                <MiniChip tone={step === 0 ? 'accent' : undefined}>{t('guide.chat.offline')}</MiniChip>
              </Row>
              <div className="gx-field small">{t('guide.chat.said2')}</div>
              <div className="gx-muted gx-tiny mono">{t('guide.chat.derivedId')}</div>
            </Frame>

            <Conn on={step >= 3} dir="down" tone="ok" />

            <Frame className="gx-mail" data-on={step >= 3 ? 'true' : 'false'}>
              <Row>
                <Icon name="chat" size={12} />
                <strong className="grow">{t('guide.chat.oneRoom')}</strong>
                <MiniChip tone={step >= 3 ? 'accent' : undefined}>{t('guide.chat.bothLines')}</MiniChip>
              </Row>
            </Frame>
          </div>
        </div>
      )}
    </Stage>
  );
}

/* ----------------------------------------------------------- automation */

/** A template, a rule, and the task that comes out the other end. */
export function AutomationDiagram() {
  const t = useT();
  return (
    <Stage
      label="guide.automation.label"
      minHeight={276}
      interval={3400}
      captions={[
        'guide.automation.s0', 'guide.automation.s1', 'guide.automation.s2',
        'guide.automation.s3', 'guide.automation.s4',
      ]}
    >
      {(step) => (
        <div className="gx-scene gx-auto">
          <Frame className="gx-tpl">
            <Row className="gx-device-head">
              <span>🔍</span>
              <strong>{t('guide.autoScene.template')}</strong>
            </Row>
            <div className="gx-field small">{t('guide.autoScene.templateTitle')}</div>
            <div className="gx-checks">
              {[0, 1, 2].map((index) => (
                <span className="gx-check" key={index}><i /> <span className="gx-line" style={{ width: `${68 - index * 12}%` }} /></span>
              ))}
            </div>
          </Frame>

          <div className="gx-auto-middle">
            <Frame className="gx-rule" data-on={step >= 1 ? 'true' : 'false'}>
              <Row className="gx-wrap">
                <MiniChip tone="accent">{t('guide.autoScene.when')}</MiniChip>
                <MiniChip>{t('guide.autoScene.review')}</MiniChip>
              </Row>
              <Row className="gx-wrap">
                <MiniChip tone={step >= 3 ? 'ok' : undefined}>{t('auto.recipientLead')}</MiniChip>
                <MiniChip tone={step >= 3 ? 'ok' : undefined}>{t('auto.recipientAssignees')}</MiniChip>
              </Row>
            </Frame>
            <Conn on={step >= 2} dir="right" tone={step >= 4 ? 'ok' : 'accent'} />
          </div>

          <div className="gx-auto-out">
            <MiniTask id="WEB-1" title={t('guide.sample.task1')} dim>
              <MiniChip tone={step >= 1 ? 'accent' : undefined}>{t('guide.autoScene.review')}</MiniChip>
            </MiniTask>
            <Frame className="gx-made" data-on={step >= 2 ? 'true' : 'false'}>
              <MiniTask id="WEB-7" title={t('guide.autoScene.made')} accent />
              <Row className="gx-wrap">
                <MiniChip tone="ok">@lin</MiniChip>
                {step >= 4 && <MiniChip tone="ok">@ada</MiniChip>}
                <span className="grow" />
                <MiniChip>{t('relation.relates_to')}</MiniChip>
              </Row>
            </Frame>
            <Row className="gx-runlog" data-on={step >= 4 ? 'true' : 'false'}>
              <span className="gx-run-dot" />
              <span className="gx-muted">{t('guide.autoScene.logged')}</span>
            </Row>
          </div>
        </div>
      )}
    </Stage>
  );
}

/* ------------------------------------------------------------ assistant */

/** MCP: what a token can do is exactly what its scope says. */
export function AssistantDiagram() {
  const t = useT();
  return (
    <Stage
      label="guide.assistant.label"
      minHeight={244}
      captions={['guide.assistant.s0', 'guide.assistant.s1', 'guide.assistant.s2', 'guide.assistant.s3']}
    >
      {(step) => {
        const writable = step >= 3;
        return (
          <div className="gx-scene gx-assistant">
            <Frame className="gx-agent">
              <Row className="gx-device-head">
                <Icon name="sparkle" size={13} />
                <strong>{t('guide.assistant.agent')}</strong>
              </Row>
              <div className="gx-token">
                <span className="gx-mono">kol_7f3a…</span>
                <MiniChip tone={writable ? 'accent' : 'ok'}>
                  {writable ? t('guide.assistant.scopeWrite') : t('guide.assistant.scopeRead')}
                </MiniChip>
              </div>
              <div className="gx-call" data-on={step >= 1 ? 'true' : 'false'}>list_tasks</div>
              <div className={`gx-call${writable ? ' ok' : ' denied'}`} data-on={step >= 2 ? 'true' : 'false'}>
                create_task {writable ? '✓' : '✕'}
              </div>
            </Frame>

            <div className="gx-assistant-wires">
              <Conn on={step >= 1} dir="right" />
              <Conn on={step >= 2} dir="left" tone={writable ? 'ok' : 'accent'} />
            </div>

            <Frame className="gx-instance">
              <div className="gx-server-title">{t('app.name')}</div>
              <MiniTask id="WEB-1" title={t('guide.sample.task1')} dim />
              <MiniTask id="WEB-2" title={t('guide.sample.task2')} dim />
              <MiniTask id="WEB-13" title={t('guide.assistant.createdTask')} accent={writable} dim={!writable} />
            </Frame>
          </div>
        );
      }}
    </Stage>
  );
}
