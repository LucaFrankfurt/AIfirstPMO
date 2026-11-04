/** A hook sends workspace events to an address somebody typed, so it is an administrator's to set up. */

import { forbidden } from '../../../kernel/platform/http.ts';
import { isWorkspaceAdmin, type EntityRule } from '../../../kernel/write-path/repo.ts';

export const webhookRules = {
  entities: ['webhook'],

  guards(entity, id, values, existing, opts) {
    if (!isWorkspaceAdmin(String(existing?.workspace_id ?? opts.workspaceId), opts.actorId)) {
      throw forbidden('Webhooks are set up by an administrator of the workspace');
    }
  },
} satisfies EntityRule;
