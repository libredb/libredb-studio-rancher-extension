import type { StoreLike } from '../types';
import { Failure, failureOf } from './failure';
import { kubeDelete, kubeGet, LOCAL_CLUSTER } from './k8s';
import {
  OIDC_SECRET, RANCHER_CA_CONFIGMAP, RECORD_CONFIGMAP, STUDIO_NAMESPACE, isManaged
} from './names';
import { oidcClientPath } from './oidc-client';
import { namespaceIsEmpty, uninstallRelease } from './release';
import type { SetupRecord, SsoRecord } from './values';
import type { WaitOptions } from './wait';

/**
 * Removing what the wizard created: on a failed setup (design section 6.4 step 10), and on
 * uninstall. Each removal says what became of the object, and one failure never stops the rest.
 */
export type UndoId = 'release' | 'upgrade' | 'navLink' | 'record' | 'rancherCA' | 'oidcSecret' | 'oidcClient' | 'namespace';
/** restored: an upgrade taken back to the values Studio had */
export type UndoOutcome = 'removed' | 'gone' | 'kept' | 'restored' | 'failed';

export interface UndoEvent {
  undo: UndoId;
  outcome: UndoOutcome;
  failure?: Failure;
}

function event(undo: UndoId, outcome: UndoOutcome, failure?: Failure): UndoEvent {
  return failure ? {
    undo, outcome, failure
  } : { undo, outcome };
}

/** notEmpty: a namespace something else still lives in */
type Removal = 'removed' | 'gone' | 'notManaged' | 'notEmpty';

const KEPT: Record<string, Failure> = {
  notManaged: { reason: 'notManaged' },
  notEmpty:   { reason: 'notEmpty', args: { namespace: STUDIO_NAMESPACE } },
};

async function removal(undo: UndoId, remove: () => Promise<Removal>, secret = false): Promise<UndoEvent> {
  try {
    const result = await remove();

    return KEPT[result] ? event(undo, 'kept', KEPT[result]) : event(undo, result as UndoOutcome);
  } catch (err) {
    return event(undo, 'failed', failureOf(err, { secret }));
  }
}

/**
 * Deletes an object only when it carries the extension's labels, so a record someone edited can
 * never steer the extension into deleting what it did not create.
 */
async function deleteManaged(store: StoreLike, cluster: string, path: string): Promise<Removal> {
  const found = await kubeGet<{ metadata?: { labels?: Record<string, string> } }>(store, cluster, path);

  if (!found) {
    return 'gone';
  }

  if (!isManaged(found.metadata?.labels)) {
    return 'notManaged';
  }

  return await kubeDelete(store, cluster, path) ? 'removed' : 'gone';
}

const inStudio = (path: string) => `/api/v1/namespaces/${ STUDIO_NAMESPACE }${ path }`;

export function removeRecord(store: StoreLike, cluster: string): Promise<UndoEvent> {
  return removal('record', () => deleteManaged(store, cluster, inStudio(`/configmaps/${ RECORD_CONFIGMAP }`)));
}

export function removeRancherCA(store: StoreLike, cluster: string): Promise<UndoEvent> {
  return removal('rancherCA', () => deleteManaged(store, cluster, inStudio(`/configmaps/${ RANCHER_CA_CONFIGMAP }`)));
}

export function removeOidcSecret(store: StoreLike, cluster: string): Promise<UndoEvent> {
  return removal('oidcSecret', () => deleteManaged(store, cluster, inStudio(`/secrets/${ OIDC_SECRET }`)), true);
}

/** Helm removes the chart's NavLink with the app; one left behind goes too */
export function removeNavLink(store: StoreLike, cluster: string, name: string): Promise<UndoEvent> {
  return removal('navLink', () => deleteManaged(store, cluster, `/apis/ui.cattle.io/v1/navlinks/${ encodeURIComponent(name) }`));
}

export function removeOidcClient(store: StoreLike, name: string): Promise<UndoEvent> {
  return removal('oidcClient', () => deleteManaged(store, LOCAL_CLUSTER, oidcClientPath(name)));
}

export function removeRelease(store: StoreLike, cluster: string, namespace: string, name: string, options: WaitOptions): Promise<UndoEvent> {
  return removal('release', () => uninstallRelease(store, cluster, namespace, name, options));
}

/**
 * Removes Studio's namespace, which only a namespace the wizard created may be: kept while a release
 * that could not be uninstalled may still be there, or while anything else lives in it.
 */
export async function removeNamespace(store: StoreLike, cluster: string, releaseLeft: boolean): Promise<UndoEvent> {
  const args = { namespace: STUDIO_NAMESPACE };

  if (releaseLeft) {
    return event('namespace', 'kept', { reason: 'releaseLeft', args });
  }

  return removal('namespace', async() => {
    const path = `/api/v1/namespaces/${ STUDIO_NAMESPACE }`;
    const found = await kubeGet<{ metadata?: { labels?: Record<string, string> } }>(store, cluster, path);

    if (!found || !isManaged(found.metadata?.labels)) {
      return found ? 'notManaged' : 'gone';
    }

    if (!await namespaceIsEmpty(store, cluster, STUDIO_NAMESPACE)) {
      return 'notEmpty';
    }

    return await kubeDelete(store, cluster, path) ? 'removed' : 'gone';
  });
}

/** Removes, newest first, what a run created, each reported as it goes */
export async function undoCreated(store: StoreLike, cluster: string, record: SetupRecord, created: UndoId[], options: WaitOptions & { onUndo?: (event: UndoEvent) => void }): Promise<UndoEvent[]> {
  const undone: UndoEvent[] = [];
  const undo: Partial<Record<UndoId, () => Promise<UndoEvent>>> = {
    release:    () => removeRelease(store, cluster, record.release.namespace, record.release.name, options),
    record:     () => removeRecord(store, cluster),
    rancherCA:  () => removeRancherCA(store, cluster),
    oidcSecret: () => removeOidcSecret(store, cluster),
    oidcClient: () => removeOidcClient(store, (record.sso as SsoRecord).client),
    namespace:  () => removeNamespace(store, cluster, undone.some((item) => item.undo === 'release' && (item.outcome === 'failed' || item.outcome === 'kept'))),
  };

  for (const id of [...created].reverse()) {
    const result = await (undo[id] as () => Promise<UndoEvent>)();

    undone.push(result);
    options.onUndo?.(result);
  }

  return undone;
}
