/** The vocabulary products are described in, and the form that adds a word to it. */
import { useMemo, useState } from 'react';
import { capabilitiesOf, capabilityKey, orderKey, type Product, type ProductCapability } from '@kolibri/shared';
import { Empty } from '../../kernel/design-system/ui/empty';
import { Icon } from '../../kernel/design-system/ui/icon';
import { MenuButton } from '../../kernel/design-system/ui/menu-button';
import { Sheet, useConfirm } from '../../kernel/design-system/ui/sheet';
import { Button } from '../../kernel/design-system/ui/button';
import { Chip } from '../../kernel/design-system/ui/chip';
import { Input, Textarea, formField } from '../../kernel/design-system/ui/field';
import { useT } from '../../kernel/i18n/i18n';
import { create, remove } from '../../kernel/sync/mutations';
import { list, useQuery } from '../../kernel/sync/store';
import { useSaveChanges } from '../../kernel/design-system/row-form';
import { useCanWrite } from '../../kernel/identity/session';
import { byOrder } from './parts';
import { DataTable, Td, Th, Tr } from '../../kernel/design-system/ui/data-table';

/**
 * The workspace's vocabulary, and the screen that was missing under it.
 *
 * A capability could be created — one input at the bottom of the product form —
 * and after that nothing could rename it, describe it or take it away. That is
 * the same shape as `budgets.archived`: a column every list filters on and
 * nothing sets. It cost something real within an hour of being written down: a
 * name arrived HTML-escaped through the API, landed beside its unescaped twin,
 * and could then not be removed from anywhere.
 *
 * Its own tab rather than more controls in the product form, because the
 * vocabulary belongs to the workspace and not to whichever product happened to
 * be open. `claimed_by` and `inherited_by` are the two columns that make it
 * readable: a package never claims a capability, it gets it from a part, and a
 * table that showed only claims would say the packages have nothing.
 */
export function Capabilities() {
  const t = useT();
  const canWrite = useCanWrite();
  const { confirm, dialog } = useConfirm();
  const [editing, setEditing] = useState<ProductCapability | null | undefined>(undefined);
  const capabilities = useQuery(() => list('productCapability', (row) => !row.archived), []);
  const products = useQuery(() => list('product', (row) => !row.archived), []);
  const parts = useQuery(() => list('productPart'), []);

  /* The same union the product screens and the tools compute, so this table
     cannot come to disagree with either about who has what. */
  const known = useMemo(() => new Set(capabilities.map((row: ProductCapability) => row.id)), [capabilities]);
  const claims = useMemo(() => {
    const own = new Map<string, string[]>();
    const via = new Map<string, string[]>();
    const byId = new Map(products.map((product: Product) => [String(product.id), product]));
    for (const product of products as Product[]) {
      const mine = (product.capabilities ?? []).filter((id) => known.has(id));
      const all = capabilitiesOf({
        product,
        parts: parts.filter((part: { product_id: string }) => part.product_id === product.id),
        capabilitiesOfPart: (id) => byId.get(String(id))?.capabilities ?? [],
        known,
      });
      for (const id of all) {
        const bucket = mine.includes(id) ? own : via;
        bucket.set(id, [...(bucket.get(id) ?? []), String(product.name)]);
      }
    }
    return { own, via };
  }, [products, parts, known]);

  return (
    <div className="grid gap-3.5">
      <p className="text-label text-muted">{t('product.capabilitiesTabHint')}</p>
      {canWrite && (
        <div>
          <Button variant="primary" size="sm" onClick={() => setEditing(null)}>
            <Icon name="plus" size={14} /> {t('product.addCapability')}
          </Button>
        </div>
      )}
      {!capabilities.length ? (
        <Empty emoji="🏷️" title={t('product.noCapabilities')} hint={t('product.noCapabilitiesHint')} />
      ) : (
        <div className="table-wrap">
          <DataTable>
            <thead>
              <tr>
                <Th>{t('product.name')}</Th>
                <Th optional wraps>{t('product.description')}</Th>
                {/* Both lists are `optional`: they grow with the catalogue rather
                    than with the design — one product name is 24 characters and
                    there is no upper bound on how many — and at 360px they
                    pushed the column you act from off the side of the table.
                    The one thing worth acting on, that nothing claims it, moves
                    up beside the name instead. */}
                <Th optional wraps>{t('product.claimedBy')}</Th>
                <Th optional wraps>{t('product.inheritedBy')}</Th>
                {canWrite && <Th />}
              </tr>
            </thead>
            <tbody>
              {[...capabilities].sort(byOrder).map((capability: ProductCapability) => {
                const own = claims.own.get(capability.id) ?? [];
                return (
                  <Tr key={capability.id}>
                    {/* `lead` rather than a plain cell: a cell is `nowrap`, so
                        a name and a chip sat on one 322px line and pushed the
                        column you act from past the edge of a 360px screen.
                        This is the prop that already answers that. */}
                    <Td lead>
                      {capability.name}
                      {/* Marked rather than left to a column that a phone drops:
                          an entry nothing claims is the one somebody came here
                          to delete. */}
                      {!own.length && <> <Chip>{t('product.nobodyClaims')}</Chip></>}
                    </Td>
                    <Td optional wraps>{capability.description || '—'}</Td>
                    <Td optional wraps>{own.join(', ') || '—'}</Td>
                    <Td optional wraps>{(claims.via.get(capability.id) ?? []).join(', ') || '—'}</Td>
                    {canWrite && (
                      <Td>
                        <MenuButton
                          variant="ghost" size="iconSm"
                          label={t('common.moreActions')}
                          items={[
                            { id: 'edit', label: t('action.edit'), onSelect: () => setEditing(capability) },
                            {
                              id: 'delete',
                              label: t('action.delete'),
                              danger: true,
                              onSelect: async () => {
                                if (await confirm(t('product.removeCapabilityHint'), t('action.remove'))) remove('productCapability', capability.id);
                              },
                            },
                          ]}
                        >
                          <Icon name="dots" size={14} />
                        </MenuButton>
                      </Td>
                    )}
                  </Tr>
                );
              })}
            </tbody>
          </DataTable>
        </div>
      )}
      {editing !== undefined && (
        <CapabilityForm capability={editing} known={capabilities} onClose={() => setEditing(undefined)} />
      )}
      {dialog}
    </div>
  );
}

export function CapabilityForm(
  { capability, known, onClose }:
  { capability: ProductCapability | null; known: readonly ProductCapability[]; onClose: () => void },
) {
  const t = useT();
  const saveChanges = useSaveChanges('productCapability', capability);
  const [form, setForm] = useState({ name: capability?.name ?? '', description: capability?.description ?? '' });

  /* The same comparison `create_capability` refuses on, from the same function
     in `@kolibri/shared`. Two doors deciding separately what "the same name"
     means is how the vocabulary gained a duplicate in the first place. */
  const taken = useMemo(() => {
    const key = capabilityKey(form.name);
    return !!key && known.some((row) => row.id !== capability?.id && capabilityKey(row.name) === key);
  }, [form.name, known, capability]);

  return (
    <Sheet
      title={capability ? t('product.editCapabilityTitle') : t('product.addCapability')}
      onClose={onClose}
      footer={(
        <Button
          variant="primary"
          disabled={!form.name.trim() || taken}
          onClick={() => {
            const patch = { name: form.name.trim(), description: form.description.trim() || null };
            if (capability) saveChanges(patch);
            else create('productCapability', { ...patch, archived: 0, sort_order: orderKey() });
            onClose();
          }}
        >
          {t('action.save')}
        </Button>
      )}
    >
      <div className={formField}>
        <label htmlFor="cap-name">{t('product.name')}</label>
        <Input id="cap-name" value={form.name} autoFocus onChange={(event) => setForm({ ...form, name: event.target.value })} />
        {taken && <span className="text-label text-danger">{t('product.capabilityTaken')}</span>}
      </div>
      <div className={formField}>
        <label htmlFor="cap-desc">{t('product.description')}</label>
        <Textarea id="cap-desc" rows={2} value={form.description}
          onChange={(event) => setForm({ ...form, description: event.target.value })} />
        <span className="text-label text-muted">{t('product.capabilitiesHint')}</span>
      </div>
    </Sheet>
  );
}

/* ------------------------------------------------------------------ index */
