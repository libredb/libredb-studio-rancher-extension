import { StudioLink } from './navlink';
import type { StoreLike } from './types';

export const DEPLOYMENT_TYPE = 'apps.deployment';

export type StudioStatus = 'not-set-up' | 'ready' | 'not-ready' | 'unknown';

/**
 * Studio's state in this cluster: not set up without a usable NavLink, otherwise the readiness of
 * its Deployment, read as the signed-in user; unknown when the user cannot read Studio's namespace.
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
  } catch {
    return 'unknown';
  }
}
