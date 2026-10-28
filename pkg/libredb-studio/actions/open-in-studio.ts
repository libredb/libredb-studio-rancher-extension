import type { Action, ActionOpts } from '@shell/core/types';
import {
  canOpen, openDatabase, targetOf, OpenResult, ShellResource
} from '../services/open';

type Translate = (key: string, args?: Record<string, unknown>) => string;

/** How long the warning after a refused open stays up */
const REFUSED_TIMEOUT_MS = 10000;

/**
 * Opens the database in Studio after a fresh check; when that check refuses, says why, because a
 * row menu has no disabled state to carry the reason.
 */
async function openFromMenu(resource: ShellResource): Promise<boolean> {
  const target = targetOf(resource);

  if (!target) {
    return false;
  }

  // A rejection, such as the link chunk failing to load after an upgrade, is a failed open the user is told about
  const result = await openDatabase(target).catch((): OpenResult => 'failed');

  if (result !== 'opened') {
    const t = resource.$rootGetters['i18n/t'] as Translate;
    const args = { secret: target.kind.credentialSecretName(resource), namespace: resource.metadata.namespace };

    await target.store.dispatch('growl/warning', {
      title:   t('libredbStudio.open.refused'),
      message: t(`libredbStudio.databases.reason.${ result }`, args),
      timeout: REFUSED_TIMEOUT_MS,
    });
  }

  return result === 'opened';
}

/**
 * F3, "Open in LibreDB Studio" in a supported database's row menu. Shown only when the cluster has
 * a usable Studio NavLink and the user may get the database's credential Secret; `enabled` reads
 * the caches synchronously and never returns a Promise.
 */
const openInStudioAction: Action = {
  labelKey: 'libredbStudio.databases.open',
  icon:     'icon icon-external-link',
  enabled:  (resource: ShellResource) => canOpen(resource),
  invoke:   (_opts: ActionOpts, resources: ShellResource[]) => openFromMenu(resources[0]),
};

export default openInStudioAction;
