import type { StoreLike } from '../types';
import { Failure, failureOf } from './failure';
import { kubeDelete, LOCAL_CLUSTER } from './k8s';
import { OIDC_SECRET, RANCHER_CA_CONFIGMAP, RECORD_CONFIGMAP, STUDIO_NAMESPACE } from './names';
import { oidcClientPath } from './oidc-client';
import { namespaceIsEmpty, uninstallRelease } from './release';
import type { WaitOptions } from './wait';

/**
 * Removing what the wizard created: on a failed setup (design section 6.4 step 10), and on
 * uninstall. Each removal says what became of the object, and one failure never stops the rest.
 */
export type UndoId = 'release' | 'navLink' | 'record' | 'rancherCA' | 'oidcSecret' | 'oidcClient' | 'namespace';
export type UndoOutcome = 'removed' | 'gone' | 'kept' | 'failed';

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

async function removal(undo: UndoId, remove: () => Promise<boolean>, secret = false): Promise<UndoEvent> {
  try {
    return event(undo, await remove() ? 'removed' : 'gone');
  } catch (err) {
    return event(undo, 'failed', failureOf(err, { secret }));
  }
}

const inStudio = (path: string) => `/api/v1/namespaces/${ STUDIO_NAMESPACE }${ path }`;

export function removeRecord(store: StoreLike, cluster: string): Promise<UndoEvent> {
  return removal('record', () => kubeDelete(store, cluster, inStudio(`/configmaps/${ RECORD_CONFIGMAP }`)));
}

export function removeRancherCA(store: StoreLike, cluster: string): Promise<UndoEvent> {
  return removal('rancherCA', () => kubeDelete(store, cluster, inStudio(`/configmaps/${ RANCHER_CA_CONFIGMAP }`)));
}

export function removeOidcSecret(store: StoreLike, cluster: string): Promise<UndoEvent> {
  return removal('oidcSecret', () => kubeDelete(store, cluster, inStudio(`/secrets/${ OIDC_SECRET }`)), true);
}

export function removeOidcClient(store: StoreLike, name: string): Promise<UndoEvent> {
  return removal('oidcClient', () => kubeDelete(store, LOCAL_CLUSTER, oidcClientPath(name)));
}

export async function removeRelease(store: StoreLike, cluster: string, namespace: string, name: string, options: WaitOptions): Promise<UndoEvent> {
  try {
    return event('release', await uninstallRelease(store, cluster, namespace, name, options));
  } catch (err) {
    return event('release', 'failed', failureOf(err));
  }
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

  if (!await namespaceIsEmpty(store, cluster, STUDIO_NAMESPACE)) {
    return event('namespace', 'kept', { reason: 'notEmpty', args });
  }

  return removal('namespace', () => kubeDelete(store, cluster, `/api/v1/namespaces/${ STUDIO_NAMESPACE }`));
}
