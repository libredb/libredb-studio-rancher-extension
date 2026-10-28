import { reactive } from 'vue';
import { ContractKind, ContractResource, kindFor } from '../contract/kinds';
import { databaseLink } from '../contract/connection-id';
import { ensureReview, reviewNow, reviewState, ReviewState } from './access';
import { findStudioLinks, selectStudioLink, StudioLink } from './navlink';
import type { StoreLike } from './types';

/**
 * Opening a database in Studio from a row's menu (F3) or its view page (F4). An action's `enabled`
 * must answer synchronously, so the reads here come from reactive caches that fill themselves in the
 * background; opening always reads the NavLink and reviews access again first.
 */

/** How long a NavLink or a review answer is used before it is read again: Studio's review cache in Rancher mode */
export const REFRESH_MS = 15000;

export type OpenAccess = 'not-set-up' | ReviewState;
export type OpenResult = 'opened' | 'not-set-up' | 'denied' | 'failed';

/** The part of a shell resource (a dashboard-store model) the open path uses */
export interface ShellResource extends ContractResource {
  type: string;
  $rootGetters: Record<string, unknown>;
  $dispatch(action: string, payload?: unknown, options?: { root: boolean }): Promise<unknown>;
}

/** A supported database resource, with the store and the cluster to read it through */
export interface OpenTarget {
  store: StoreLike;
  cluster: string;
  kind: ContractKind;
  resource: ContractResource;
}

interface LinkEntry {
  link?: StudioLink;
  at: number;
}

const links = reactive<Record<string, LinkEntry>>({});
/** NavLink reads under way, per cluster; not reactive, so marking one inside a render tracks nothing */
const loading = new Map<string, Promise<StudioLink | undefined>>();
/** When this module last asked for each review */
const reviewedAt = new Map<string, number>();

const reviewKey = (cluster: string, namespace: string, secret: string) => `${ cluster }/${ namespace }/${ secret }`;

/**
 * Runs a cache fill after the current evaluation, so a read from a computed or a render never
 * writes reactive state while it is being tracked.
 */
const later = (fill: () => unknown) => {
  Promise.resolve().then(fill);
};

/** The root store a shell resource belongs to */
export function resourceStore(resource: ShellResource): StoreLike {
  return {
    getters:  resource.$rootGetters as StoreLike['getters'],
    dispatch: (action, payload) => resource.$dispatch(action, payload, { root: true }),
  };
}

export function resourceCluster(resource: ShellResource): string {
  return resource.$rootGetters.clusterId as string;
}

/** What opening a resource needs, or nothing for a kind the contract does not support */
export function targetOf(resource: ShellResource): OpenTarget | undefined {
  const kind = kindFor(resource.type);

  return kind ? {
    store: resourceStore(resource), cluster: resourceCluster(resource), kind, resource
  } : undefined;
}

/** Reads the cluster's Studio NavLink now, as the signed-in user, and keeps the answer */
export function loadStudioLink(store: StoreLike, cluster: string): Promise<StudioLink | undefined> {
  const read = findStudioLinks(store).then((navlinks) => {
    const { link } = selectStudioLink(navlinks);

    links[cluster] = { link, at: Date.now() };
    loading.delete(cluster);

    return link;
  });

  loading.set(cluster, read);

  return read;
}

/**
 * The cluster's Studio link as last read; undefined until the first read answers. A missing or
 * stale answer starts one read in the background and keeps the old answer until it lands.
 */
export function cachedStudioLink(store: StoreLike, cluster: string): StudioLink | undefined {
  const entry = links[cluster];

  if (!loading.has(cluster) && (!entry || Date.now() - entry.at > REFRESH_MS)) {
    loading.set(cluster, Promise.resolve(undefined));
    later(() => loadStudioLink(store, cluster));
  }

  return entry?.link;
}

/**
 * May the signed-in user open this database, as far as the caches know: not set up without a usable
 * NavLink, otherwise the access review's answer, pending until it comes. Never returns a Promise.
 */
export function openAccess({
  store, cluster, kind, resource
}: OpenTarget): OpenAccess {
  if (!cachedStudioLink(store, cluster)) {
    return 'not-set-up';
  }

  const { namespace } = resource.metadata;
  const secret = kind.credentialSecretName(resource);
  const key = reviewKey(cluster, namespace, secret);
  const state = reviewState(cluster, namespace, secret);
  const askedAt = reviewedAt.get(key);

  if (!state) {
    reviewedAt.set(key, Date.now());
    later(() => ensureReview(store, cluster, namespace, secret));

    return 'pending';
  }

  if (state !== 'pending' && (askedAt === undefined || Date.now() - askedAt > REFRESH_MS)) {
    reviewedAt.set(key, Date.now());
    later(() => reviewNow(store, cluster, namespace, secret));
  }

  return state;
}

/** The row action's `enabled`: a pending, denied or failed review is not allowed */
export function canOpen(resource: ShellResource): boolean {
  const target = targetOf(resource);

  return !!target && openAccess(target) === 'allowed';
}

/**
 * Opens the database in Studio in a new tab, after reading the NavLink and reviewing access again,
 * past the caches. The tab gets no opener and no referrer.
 */
export async function openDatabase({
  store, cluster, kind, resource
}: OpenTarget): Promise<OpenResult> {
  const link = await loadStudioLink(store, cluster);

  if (!link) {
    return 'not-set-up';
  }

  const { namespace } = resource.metadata;
  const secret = kind.credentialSecretName(resource);

  reviewedAt.set(reviewKey(cluster, namespace, secret), Date.now());

  if (!await reviewNow(store, cluster, namespace, secret)) {
    return reviewState(cluster, namespace, secret) === 'failed' ? 'failed' : 'denied';
  }

  window.open(databaseLink(link.toURL, kind, resource), '_blank', 'noopener,noreferrer');

  return 'opened';
}
