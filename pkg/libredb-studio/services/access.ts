import { reactive } from 'vue';
import type { StoreLike } from './types';

/**
 * A reactive cache of SelfSubjectAccessReviews: may the signed-in user get a database's credential
 * Secret? The extension never reads the Secret; this only asks Kubernetes whether the user could.
 * Reads are synchronous, so an action's `enabled` can use them; a pending or failed review counts as
 * not allowed wherever a decision is needed. Failed means the review could not be made at all.
 */
export type ReviewState = 'pending' | 'allowed' | 'denied' | 'failed';

interface QueuedReview {
  store: StoreLike;
  cluster: string;
  namespace: string;
  secret: string;
}

interface QueuedItem extends QueuedReview {
  generation: number;
  resolve: () => void;
}

const reviews = reactive<Record<string, ReviewState>>({});
/** The promise of each review still out, so a later ask for the same key waits for its answer */
const inFlight = new Map<string, Promise<void>>();
/** Per cluster, raised by a clear, so an answer asked for before the clear is not written back */
const generations = new Map<string, number>();
let queue: Map<string, QueuedItem> = new Map();
let scheduled = false;

const generationOf = (cluster: string) => generations.get(cluster) || 0;

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
}: QueuedReview): Promise<ReviewState> {
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

    return res?.status?.allowed === true ? 'allowed' : 'denied';
  } catch {
    return 'failed';
  }
}

function flush(): void {
  const batch = queue;

  queue = new Map();
  scheduled = false;

  batch.forEach((item, key) => {
    review(item).then((answer) => {
      if (generationOf(item.cluster) === item.generation) {
        reviews[key] = answer;
        inFlight.delete(key);
      }
      item.resolve();
    });
  });
}

export function reviewState(cluster: string, namespace: string, secret: string): ReviewState | undefined {
  return reviews[keyOf(cluster, namespace, secret)];
}

/**
 * Asks for a review unless one is cached or under way; the reviews asked for in the same tick go
 * out together. Resolves when this key's review has answered.
 */
export function ensureReview(store: StoreLike, cluster: string, namespace: string, secret: string): Promise<void> {
  const key = keyOf(cluster, namespace, secret);
  const pending = inFlight.get(key);

  if (pending) {
    return pending;
  }

  if (reviews[key]) {
    return Promise.resolve();
  }

  reviews[key] = 'pending';

  const promise = new Promise<void>((resolve) => {
    queue.set(key, {
      store, cluster, namespace, secret, generation: generationOf(cluster), resolve
    });
  });

  inFlight.set(key, promise);

  if (!scheduled) {
    scheduled = true;
    Promise.resolve().then(flush);
  }

  return promise;
}

/** Reviews again past the cache, for the moment before a database is opened */
export async function reviewNow(store: StoreLike, cluster: string, namespace: string, secret: string): Promise<boolean> {
  const answer = await review({
    store, cluster, namespace, secret
  });

  reviews[keyOf(cluster, namespace, secret)] = answer;

  return answer === 'allowed';
}

/** Forgets one cluster's answers and the reviews still out for it, so the next read reviews again */
export function clearReviews(cluster: string): void {
  const prefix = `${ cluster }/`;

  generations.set(cluster, generationOf(cluster) + 1);
  Object.keys(reviews).filter((key) => key.startsWith(prefix)).forEach((key) => {
    delete reviews[key];
  });
  [...inFlight.keys()].filter((key) => key.startsWith(prefix)).forEach((key) => inFlight.delete(key));
}
