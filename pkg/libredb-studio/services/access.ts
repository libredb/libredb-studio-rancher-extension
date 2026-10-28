import { reactive } from 'vue';
import type { StoreLike } from './types';

/**
 * A reactive cache of SelfSubjectAccessReviews: may the signed-in user get a database's credential
 * Secret? The extension never reads the Secret; this only asks Kubernetes whether the user could.
 * Reads are synchronous, so an action's `enabled` can use them; a pending review counts as not
 * allowed wherever a decision is needed.
 */
export type ReviewState = 'pending' | 'allowed' | 'denied';

interface QueuedReview {
  store: StoreLike;
  cluster: string;
  namespace: string;
  secret: string;
}

const reviews = reactive<Record<string, ReviewState>>({});
let queue: Map<string, QueuedReview> = new Map();
let flushing: Promise<void> | undefined;

const keyOf = (cluster: string, namespace: string, secret: string) => `${ cluster }/${ namespace }/${ secret }`;

/**
 * Steve's own route for SelfSubjectAccessReviews refuses the create (it adds a generateName, which a
 * review must not carry), so the review goes through Rancher's Kubernetes proxy for the cluster.
 */
export function reviewUrl(cluster: string): string {
  return `/k8s/clusters/${ encodeURIComponent(cluster) }/apis/authorization.k8s.io/v1/selfsubjectaccessreviews`;
}

async function review({
  store, cluster, namespace, secret
}: QueuedReview): Promise<boolean> {
  try {
    const res = await store.dispatch('cluster/request', {
      url:                  reviewUrl(cluster),
      method:               'post',
      redirectUnauthorized: false,
      data:                 {
        apiVersion: 'authorization.k8s.io/v1',
        kind:       'SelfSubjectAccessReview',
        spec:       {
          resourceAttributes: {
            namespace, verb: 'get', resource: 'secrets', name: secret
          }
        }
      }
    }) as { status?: { allowed?: boolean } } | undefined;

    return res?.status?.allowed === true;
  } catch {
    return false;
  }
}

async function flush(): Promise<void> {
  const batch = queue;

  queue = new Map();
  flushing = undefined;

  await Promise.all([...batch.entries()].map(async([key, item]) => {
    reviews[key] = (await review(item)) ? 'allowed' : 'denied';
  }));
}

export function reviewState(cluster: string, namespace: string, secret: string): ReviewState | undefined {
  return reviews[keyOf(cluster, namespace, secret)];
}

/**
 * Asks for a review unless one is cached or under way; the reviews asked for in the same tick go
 * out together. Resolves when that pass is done.
 */
export function ensureReview(store: StoreLike, cluster: string, namespace: string, secret: string): Promise<void> {
  const key = keyOf(cluster, namespace, secret);

  if (!reviews[key]) {
    reviews[key] = 'pending';
    queue.set(key, {
      store, cluster, namespace, secret
    });
    flushing = flushing || Promise.resolve().then(flush);
  }

  return flushing || Promise.resolve();
}

/** Reviews again past the cache, for the moment before a database is opened */
export async function reviewNow(store: StoreLike, cluster: string, namespace: string, secret: string): Promise<boolean> {
  const allowed = await review({
    store, cluster, namespace, secret
  });

  reviews[keyOf(cluster, namespace, secret)] = allowed ? 'allowed' : 'denied';

  return allowed;
}

/** Forgets one cluster's answers, so the next read reviews again */
export function clearReviews(cluster: string): void {
  const prefix = `${ cluster }/`;

  Object.keys(reviews).filter((key) => key.startsWith(prefix)).forEach((key) => {
    delete reviews[key];
  });
}
