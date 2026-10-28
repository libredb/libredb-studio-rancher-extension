import { StudioLink } from './navlink';
import type { StoreLike } from './types';

export const DEPLOYMENT_TYPE = 'apps.deployment';

export type StudioStatus = 'not-set-up' | 'ready' | 'not-ready' | 'unknown' | 'failed';

/** The HTTP status of a failed store request, whether or not the response had a body */
function statusOf(err: unknown): number | undefined {
  const failed = err as { _status?: number, response?: { status?: number } } | undefined;

  return failed?._status || failed?.response?.status;
}

/**
 * Studio's state in this cluster: not set up without a usable NavLink, otherwise the readiness of
 * its Deployment, read as the signed-in user. A missing Deployment is not ready; unknown when the
 * user cannot read Studio's namespace; failed when the read fails for another reason.
 */
export async function studioStatus(store: StoreLike, link: StudioLink | undefined): Promise<StudioStatus> {
  if (!link) {
    return 'not-set-up';
  }

  if (!store.getters['cluster/schemaFor'](DEPLOYMENT_TYPE)) {
    return 'unknown';
  }

  try {
    const deployment = await store.dispatch('cluster/find', { type: DEPLOYMENT_TYPE, id: `${ link.namespace }/${ link.deploymentName }` }) as { status?: { readyReplicas?: number } } | undefined;

    return (deployment?.status?.readyReplicas || 0) >= 1 ? 'ready' : 'not-ready';
  } catch (err) {
    switch (statusOf(err)) {
    case 403:
      return 'unknown';
    case 404:
      return 'not-ready';
    default:
      return 'failed';
    }
  }
}
