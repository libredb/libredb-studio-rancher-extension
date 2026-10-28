import { flushPromises } from '@vue/test-utils';
import { CNPG_CLUSTER_TYPE } from '../config';
import { CNPG_CLUSTER_KIND } from '../contract/kinds';
import { connectionId } from '../contract/connection-id';
import { clearReviews, ensureReview, reviewState } from '../services/access';
import {
  REFRESH_MS, cachedStudioLink, canOpen, loadStudioLink, openAccess, openDatabase, resourceCluster, resourceStore, targetOf, ShellResource
} from '../services/open';

const NAVLINK = { metadata: { name: 'studio.libredb-studio' }, spec: { toURL: 'https://studio.example.com' } };

interface Setup {
  cluster: string;
  navlinks?: unknown[];
  allowed?: boolean | 'error';
}

/** A shell resource over a mocked root store: NavLink reads and access reviews only */
const setup = ({ cluster, navlinks = [NAVLINK], allowed = true }: Setup) => {
  const answers = { navlinks, allowed };
  const dispatch = jest.fn((action: string, _payload?: unknown) => {
    if (action === 'cluster/findLabelSelector') {
      return Promise.resolve(answers.navlinks);
    }
    if (answers.allowed === 'error') {
      return Promise.reject(new Error('network'));
    }

    return Promise.resolve({ status: { allowed: answers.allowed } });
  });
  const rootGetters = { 'cluster/schemaFor': () => ({}), clusterId: cluster };
  const resource = (namespace = 'team-a', name = 'orders'): ShellResource => ({
    type:         CNPG_CLUSTER_TYPE,
    metadata:     { namespace, name },
    $rootGetters: rootGetters,
    $dispatch:    (action: string, payload?: unknown) => dispatch(action, payload),
  });

  clearReviews(cluster);

  return {
    answers, dispatch, resource, store: { getters: rootGetters as never, dispatch }
  };
};

const reviews = (dispatch: jest.Mock) => dispatch.mock.calls.filter(([action]) => action === 'cluster/request');
const navlinkReads = (dispatch: jest.Mock) => dispatch.mock.calls.filter(([action]) => action === 'cluster/findLabelSelector');

describe('open service: the shell resource', () => {
  it('dispatches root actions through the resource and reads the cluster from the root store', () => {
    const $dispatch = jest.fn();
    const resource = {
      type: CNPG_CLUSTER_TYPE, metadata: { namespace: 'n', name: 'd' }, $rootGetters: { clusterId: 'c-x' }, $dispatch
    };

    resourceStore(resource).dispatch('cluster/request', { a: 1 });

    expect($dispatch).toHaveBeenCalledWith('cluster/request', { a: 1 }, { root: true });
    expect(resourceStore(resource).getters).toBe(resource.$rootGetters);
    expect(resourceCluster(resource)).toBe('c-x');
  });

  it('targets only a supported kind', () => {
    const { resource } = setup({ cluster: 'c-target' });

    expect(targetOf(resource())).toMatchObject({ cluster: 'c-target', kind: CNPG_CLUSTER_KIND });
    expect(targetOf({ ...resource(), type: 'apps.deployment' })).toBeUndefined();
  });
});

describe('open service: the NavLink cache', () => {
  it('is empty at first, loads once in the background, then answers synchronously', async() => {
    const { dispatch, store } = setup({ cluster: 'c-link-1' });

    expect(cachedStudioLink(store, 'c-link-1')).toBeUndefined();
    expect(cachedStudioLink(store, 'c-link-1')).toBeUndefined();
    expect(dispatch).not.toHaveBeenCalled();
    await flushPromises();

    expect(cachedStudioLink(store, 'c-link-1')).toMatchObject({ toURL: 'https://studio.example.com', namespace: 'studio' });
    expect(navlinkReads(dispatch)).toHaveLength(1);
  });

  it('reads the NavLink again past the refresh time, keeping the old answer meanwhile', async() => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1000);
    const { answers, dispatch, store } = setup({ cluster: 'c-link-2' });

    cachedStudioLink(store, 'c-link-2');
    await flushPromises();
    answers.navlinks = [];

    now.mockReturnValue(1000 + REFRESH_MS);
    expect(cachedStudioLink(store, 'c-link-2')).toBeDefined();
    await flushPromises();
    expect(navlinkReads(dispatch)).toHaveLength(1);

    now.mockReturnValue(1001 + REFRESH_MS);
    expect(cachedStudioLink(store, 'c-link-2')).toBeDefined();
    await flushPromises();

    expect(navlinkReads(dispatch)).toHaveLength(2);
    expect(cachedStudioLink(store, 'c-link-2')).toBeUndefined();
  });

  it('is refreshed by a direct load', async() => {
    const { store } = setup({ cluster: 'c-link-3', navlinks: [] });

    await expect(loadStudioLink(store, 'c-link-3')).resolves.toBeUndefined();
    expect(cachedStudioLink(store, 'c-link-3')).toBeUndefined();
  });
});

describe('open service: access', () => {
  it('is not set up until a usable NavLink is known, and asks no review before', async() => {
    const { dispatch, resource } = setup({ cluster: 'c-acc-1', navlinks: [] });
    const target = targetOf(resource())!;

    expect(openAccess(target)).toBe('not-set-up');
    await flushPromises();

    expect(openAccess(target)).toBe('not-set-up');
    expect(reviews(dispatch)).toHaveLength(0);
  });

  it('reviews every row read in one tick as one batch, and never returns a Promise', async() => {
    const { dispatch, resource } = setup({ cluster: 'c-acc-2' });
    const rows = [resource('team-a', 'orders'), resource('team-a', 'billing'), resource('team-b', 'analytics')];

    rows.forEach((row) => expect(canOpen(row)).toBe(false));
    await flushPromises();
    expect(reviews(dispatch)).toHaveLength(0);

    rows.forEach((row) => expect(canOpen(row)).toBe(false));
    await flushPromises();

    expect(rows.map((row) => canOpen(row))).toStrictEqual([true, true, true]);
    expect(reviews(dispatch)).toHaveLength(3);
    expect(reviews(dispatch).map(([, payload]) => payload.data.spec.resourceAttributes.name)).toStrictEqual(['orders-app', 'billing-app', 'analytics-app']);
  });

  it('counts a pending, denied or failed review as not allowed', async() => {
    const denied = setup({ cluster: 'c-acc-3', allowed: false });
    const target = targetOf(denied.resource())!;

    expect(openAccess(target)).toBe('not-set-up');
    await flushPromises();
    expect(openAccess(target)).toBe('pending');
    expect(canOpen(denied.resource())).toBe(false);
    await flushPromises();
    expect(openAccess(target)).toBe('denied');
    expect(canOpen(denied.resource())).toBe(false);

    const failed = setup({ cluster: 'c-acc-4', allowed: 'error' });

    canOpen(failed.resource());
    await flushPromises();
    canOpen(failed.resource());
    await flushPromises();
    expect(openAccess(targetOf(failed.resource())!)).toBe('failed');
    expect(canOpen(failed.resource())).toBe(false);
  });

  it('is never allowed for an unsupported kind', () => {
    const { resource } = setup({ cluster: 'c-acc-5' });

    expect(canOpen({ ...resource(), type: 'apps.deployment' })).toBe(false);
  });

  it('reviews again in place past the refresh time, without falling back to pending', async() => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(5000);
    const { answers, dispatch, resource } = setup({ cluster: 'c-acc-6' });

    canOpen(resource());
    await flushPromises();
    canOpen(resource());
    await flushPromises();
    expect(canOpen(resource())).toBe(true);
    answers.allowed = false;

    now.mockReturnValue(5000 + REFRESH_MS);
    expect(canOpen(resource())).toBe(true);
    await flushPromises();
    expect(reviews(dispatch)).toHaveLength(1);

    now.mockReturnValue(5001 + REFRESH_MS);
    expect(canOpen(resource())).toBe(true);
    expect(canOpen(resource())).toBe(true);
    expect(reviewState('c-acc-6', 'team-a', 'orders-app')).toBe('allowed');
    await flushPromises();

    expect(reviews(dispatch)).toHaveLength(2);
    expect(canOpen(resource())).toBe(false);
  });

  it('refreshes once an answer it did not ask for itself, such as the Databases page\'s', async() => {
    const { dispatch, resource, store } = setup({ cluster: 'c-acc-7' });

    cachedStudioLink(store, 'c-acc-7');
    await ensureReview(store, 'c-acc-7', 'team-a', 'orders-app');
    await flushPromises();
    dispatch.mockClear();

    expect(canOpen(resource())).toBe(true);
    expect(canOpen(resource())).toBe(true);
    await flushPromises();

    expect(reviews(dispatch)).toHaveLength(1);
  });
});

describe('open service: opening', () => {
  it('reads the NavLink and reviews again, then opens the Studio link without an opener', async() => {
    const open = jest.spyOn(window, 'open').mockImplementation(() => null);
    const { dispatch, resource } = setup({ cluster: 'c-open-1' });

    await expect(openDatabase(targetOf(resource())!)).resolves.toBe('opened');

    expect(navlinkReads(dispatch)).toHaveLength(1);
    expect(reviews(dispatch)).toHaveLength(1);
    expect(open).toHaveBeenCalledWith(`https://studio.example.com/?connection=seed%3A${ connectionId('cnpg', 'team-a', 'orders') }`, '_blank', 'noopener,noreferrer');
  });

  it('does not open without a usable NavLink, and reviews nothing', async() => {
    const open = jest.spyOn(window, 'open').mockImplementation(() => null);
    const { dispatch, resource } = setup({ cluster: 'c-open-2', navlinks: [{ metadata: { name: 'a.b' }, spec: { toURL: 'http://studio.example.com' } }] });

    await expect(openDatabase(targetOf(resource())!)).resolves.toBe('not-set-up');
    expect(reviews(dispatch)).toHaveLength(0);
    expect(open).not.toHaveBeenCalled();
  });

  it('does not open when the review refuses or fails, and says which', async() => {
    const open = jest.spyOn(window, 'open').mockImplementation(() => null);
    const denied = setup({ cluster: 'c-open-3', allowed: false });
    const failed = setup({ cluster: 'c-open-4', allowed: 'error' });

    await expect(openDatabase(targetOf(denied.resource())!)).resolves.toBe('denied');
    await expect(openDatabase(targetOf(failed.resource())!)).resolves.toBe('failed');
    expect(reviewState('c-open-3', 'team-a', 'orders-app')).toBe('denied');
    expect(open).not.toHaveBeenCalled();
  });

  it('never reads or lists a Secret', async() => {
    jest.spyOn(window, 'open').mockImplementation(() => null);
    const { dispatch, resource } = setup({ cluster: 'c-open-5' });

    canOpen(resource());
    await flushPromises();
    canOpen(resource());
    await flushPromises();
    await openDatabase(targetOf(resource())!);

    const touchesSecrets = dispatch.mock.calls.filter(([, payload]) => {
      const { type, url } = (payload || {}) as { type?: unknown, url?: unknown };

      return /secret/i.test(String(type || '')) || /\/secrets/i.test(String(url || ''));
    });

    expect(dispatch).toHaveBeenCalled();
    expect(touchesSecrets).toStrictEqual([]);
  });
});
