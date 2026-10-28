import { statusOf } from '../studio-status';
import type { StoreLike } from '../types';

/** Rancher's own cluster, where OIDC clients and their secrets live */
export const LOCAL_CLUSTER = 'local';

/**
 * A path on a cluster's Kubernetes API through Rancher's proxy. Every call runs as the signed-in
 * user, so Kubernetes RBAC and Rancher's audit log apply, and nothing it answers lands in a store.
 */
export function k8sPath(cluster: string, path: string): string {
  return `/k8s/clusters/${ encodeURIComponent(cluster) }${ path }`;
}

export function kube<T = unknown>(store: StoreLike, cluster: string, method: string, path: string, data?: unknown): Promise<T> {
  return store.dispatch(`${ cluster === LOCAL_CLUSTER ? 'management' : 'cluster' }/request`, {
    url: k8sPath(cluster, path), method, data, redirectUnauthorized: false
  }) as Promise<T>;
}

/** The object at the path, or nothing when it does not exist; any other failure throws */
export async function kubeGet<T = unknown>(store: StoreLike, cluster: string, path: string): Promise<T | undefined> {
  try {
    return await kube<T>(store, cluster, 'get', path);
  } catch (err) {
    if (statusOf(err) === 404) {
      return undefined;
    }
    throw err;
  }
}

/** Deletes the object at the path: true when it was there, false when it was already gone */
export async function kubeDelete(store: StoreLike, cluster: string, path: string): Promise<boolean> {
  try {
    await kube(store, cluster, 'delete', path);

    return true;
  } catch (err) {
    if (statusOf(err) === 404) {
      return false;
    }
    throw err;
  }
}

/**
 * Whether the signed-in user may do something, as a SelfSubjectAccessReview answers it. A review
 * that cannot be made counts as not allowed.
 */
export async function canI(store: StoreLike, cluster: string, resourceAttributes: Record<string, string>): Promise<boolean> {
  try {
    const answer = await kube<{ status?: { allowed?: boolean } }>(store, cluster, 'post', '/apis/authorization.k8s.io/v1/selfsubjectaccessreviews', {
      apiVersion: 'authorization.k8s.io/v1',
      kind:       'SelfSubjectAccessReview',
      spec:       { resourceAttributes },
    });

    return answer?.status?.allowed === true;
  } catch {
    return false;
  }
}

/** A store read with the schema checked first: nothing when the user cannot see the type or the object */
export async function findIfVisible<T = unknown>(store: StoreLike, storeName: 'cluster' | 'management', type: string, id: string): Promise<T | undefined> {
  if (!store.getters[`${ storeName }/schemaFor`](type)) {
    return undefined;
  }

  try {
    return await store.dispatch(`${ storeName }/find`, { type, id }) as T;
  } catch {
    return undefined;
  }
}

/** A list read with the schema checked first: empty when the user cannot see the type or the list fails */
export async function findAllIfVisible<T = unknown>(store: StoreLike, type: string): Promise<T[]> {
  if (!store.getters['cluster/schemaFor'](type)) {
    return [];
  }

  try {
    return await store.dispatch('cluster/findAll', { type }) as T[];
  } catch {
    return [];
  }
}
