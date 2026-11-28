/**
 * The catalogue screens: what is sold, what it earns, and what would happen if
 * something changed.
 *
 * The index tabs run in the order somebody uses them — the catalogue is what
 * people come back for, the packages are its other half, the campaigns are what
 * is being done to it this quarter, the scenarios are the argument somebody
 * makes about it on a Tuesday, and the capabilities are the vocabulary all of
 * it is written in. Five on a product, in the order a product is filled in:
 * what it is,
 * what it costs to sell, what it costs to make, what is in it, and what happens
 * next.
 *
 * Everything is read from the local mirror and added up on render, so all of
 * this works offline — the simulation included, which is the whole reason
 * `simulate` is a pure function in `@kolibri/shared` rather than an endpoint.
 */
import { useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Header, Trail } from '../../../kernel/design-system/chrome';
import { Health, useCatalogue } from '../product';
import { Empty } from '../../../kernel/design-system/ui/empty';
import { Icon } from '../../../kernel/design-system/ui/icon';
import { Button } from '../../../kernel/design-system/ui/button';
import { useT, type TranslationKey } from '../../../kernel/i18n/i18n';
import { useRow } from '../../../kernel/sync/store';
import { useTabStrip } from '../../../kernel/design-system/tab-strip';
import { TabButton, TabList } from '../../../kernel/design-system/ui/tabs';
import { useCanWrite, useFeature } from '../../../kernel/identity/session';
import { pageBody } from '../../../kernel/design-system/ui/page';
import { Capabilities } from '../capabilities';
import { Catalogue } from '../catalogue';
import { Costs } from '../costs';
import { Overview } from '../overview';
import { Package } from '../package';
import { HORIZON, SwitchedOff } from '../parts';
import { Prices } from '../prices';
import { ProductForm } from '../product-form';
import { Promotions } from '../promotions';
import { Scenarios, SimulationTab } from '../scenarios';

type IndexTab = 'catalogue' | 'packages' | 'promotions' | 'scenarios' | 'capabilities';

const INDEX_TABS: IndexTab[] = ['catalogue', 'packages', 'promotions', 'scenarios', 'capabilities'];

const INDEX_TAB_KEY: Record<IndexTab, TranslationKey> = {
  catalogue: 'product.tabCatalogue',
  packages: 'product.tabPackages',
  promotions: 'product.tabPromotions',
  scenarios: 'product.tabScenarios',
  capabilities: 'product.tabCapabilities',
};

export function ProductIndex() {
  const t = useT();
  const canWrite = useCanWrite();
  const enabled = useFeature('products');
  const [search, setSearch] = useSearchParams();
  const tab = (INDEX_TABS.includes(search.get('tab') as IndexTab) ? search.get('tab') : 'catalogue') as IndexTab;
  const strip = useTabStrip(tab);
  const [creating, setCreating] = useState(false);

  if (!enabled) return <><Header title={t('product.title')} /><SwitchedOff /></>;

  const go = (next: IndexTab) => setSearch({ tab: next }, { replace: true });

  return (
    <>
      <Header title={t('product.title')}>
        {canWrite && (tab === 'catalogue' || tab === 'packages') && (
          <Button variant="primary" size="sm" onClick={() => setCreating(true)}>
            <Icon name="plus" size={14} /> <span className="hide-sm">{t('product.new')}</span>
          </Button>
        )}
      </Header>
      <TabList ref={strip} className="tabs" style={{ padding: '0 12px' }}>
        {INDEX_TABS.map((name) => (
          <TabButton key={name} active={tab === name} onClick={() => go(name)}>
            {t(INDEX_TAB_KEY[name])}
          </TabButton>
        ))}
      </TabList>
      <div className={pageBody}>
        {tab === 'catalogue' && <Catalogue only="single" />}
        {tab === 'packages' && <Catalogue only="bundle" />}
        {tab === 'promotions' && <Promotions />}
        {tab === 'scenarios' && <Scenarios />}
        {tab === 'capabilities' && <Capabilities />}
      </div>
      {creating && <ProductForm onClose={() => setCreating(false)} />}
    </>
  );
}

type Tab = 'overview' | 'prices' | 'costs' | 'package' | 'simulation';

const TABS: Tab[] = ['overview', 'prices', 'costs', 'package', 'simulation'];

const TAB_KEY: Record<Tab, TranslationKey> = {
  overview: 'product.tabOverview',
  prices: 'product.tabPrices',
  costs: 'product.tabCosts',
  package: 'product.tabPackage',
  simulation: 'product.tabSimulation',
};

export function ProductDetail() {
  const t = useT();
  const navigate = useNavigate();
  const enabled = useFeature('products');
  const { id = '' } = useParams();
  const product = useRow('product', id);
  const [search, setSearch] = useSearchParams();
  const tab = (TABS.includes(search.get('tab') as Tab) ? search.get('tab') : 'overview') as Tab;
  const strip = useTabStrip(tab);
  const { entries } = useCatalogue(HORIZON);
  const entry = entries.find((row) => row.product.id === id);

  if (!enabled) return <><Header title={t('product.title')} /><SwitchedOff /></>;
  if (!product || !entry) {
    return (
      <>
        <Header title={t('product.title')} />
        <div className="px-3 pt-4 sm:px-6 sm:pt-5">
          <Trail parts={[{ to: '/products', label: t('product.title'), icon: <Icon name="tag" size={13} /> }]} />
        </div>
        <Empty
          emoji="🏷️" title={t('product.gone')}
          action={<Button onClick={() => navigate('/products')}>{t('nav.backToList')}</Button>}
        />
      </>
    );
  }

  const go = (next: Tab) => setSearch({ tab: next }, { replace: true });

  return (
    <>
      <Header title={product.name}><Health entry={entry} /></Header>
      {/* Above the tabs: the tabs are places inside this product, the trail is
          the way out of it, and mixing the two would read as a sixth tab. */}
      <div className="px-3 pt-3 sm:px-6">
        <Trail parts={[{ to: '/products', label: t('product.title'), icon: <Icon name="tag" size={13} /> }]} />
      </div>
      <TabList ref={strip} className="tabs" style={{ padding: '0 12px' }}>
        {TABS.map((name) => (
          <TabButton key={name} active={tab === name} onClick={() => go(name)}>
            {t(TAB_KEY[name])}
          </TabButton>
        ))}
      </TabList>
      <div className={pageBody}>
        {tab === 'overview' && <Overview product={product} entry={entry} />}
        {tab === 'prices' && <Prices product={product} />}
        {tab === 'costs' && <Costs product={product} />}
        {tab === 'package' && <Package product={product} entry={entry} />}
        {tab === 'simulation' && <SimulationTab product={product} />}
      </div>
    </>
  );
}
