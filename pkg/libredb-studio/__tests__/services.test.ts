import {
  NAVLINK_TYPE, NAVLINK_LABEL_SELECTOR, findStudioLinks, selectStudioLink, usableToURL
} from '../services/navlink';
import {
  clearReviews, ensureReview, reviewNow, reviewState, reviewUrl
} from '../services/access';
import { DEPLOYMENT_TYPE, studioStatus } from '../services/studio-status';
import type { StoreLike } from '../services/types';

const navlink = (name: string, spec: Record<string, unknown>) => ({ metadata: { name }, spec });

const storeWith = (getters: StoreLike['getters'], dispatch = jest.fn()): StoreLike => ({ getters, dispatch });

describe('navlink service', () => {
  it('accepts only an https toURL', () => {
    expect(usableToURL(navlink('a', { toURL: 'https://studio.example.com' }))).toBe('https://studio.example.com');
    expect(usableToURL(navlink('a', { toURL: 'http://studio.example.com' }))).toBeUndefined();
    expect(usableToURL(navlink('a', { toURL: 'javascript:alert(1)' }))).toBeUndefined();
    expect(usableToURL(navlink('a', { toURL: 'not a url' }))).toBeUndefined();
    expect(usableToURL(navlink('a', { toService: { name: 'studio', namespace: 'x' } }))).toBeUndefined();
    expect(usableToURL({ metadata: { name: 'a' } })).toBeUndefined();
  });

  it('refuses a toURL with a query or a fragment, which the Studio link could not extend', () => {
    expect(usableToURL(navlink('a', { toURL: 'https://studio.example.com/?x=1' }))).toBeUndefined();
    expect(usableToURL(navlink('a', { toURL: 'https://studio.example.com/#top' }))).toBeUndefined();
    expect(usableToURL(navlink('a', { toURL: 'https://studio.example.com/base/' }))).toBe('https://studio.example.com/base/');
  });

  it('picks the first usable link by name and counts the usable ones', () => {
    const selected = selectStudioLink([
      navlink('studio-b.libredb-studio', { toURL: 'https://b.example.com' }),
      navlink('plain.libredb-studio', { toURL: 'http://plain.example.com' }),
      navlink('studio-a.libredb-studio', { toURL: 'https://a.example.com' }),
    ]);

    expect(selected).toStrictEqual({
      found: 2,
      link:  {
        name: 'studio-a.libredb-studio', toURL: 'https://a.example.com', namespace: 'studio-a', deploymentName: 'libredb-studio'
      }
    });
  });

  it('keeps every dot after the first in the Deployment name', () => {
    expect(selectStudioLink([navlink('ns.release.with.dots', { toURL: 'https://a.example.com' })]).link).toMatchObject({ namespace: 'ns', deploymentName: 'release.with.dots' });
  });

  it('has no link when none is usable', () => {
    expect(selectStudioLink([navlink('a.b', { toURL: 'http://a' })])).toStrictEqual({ found: 0, link: undefined });
    expect(selectStudioLink([navlink('nodot', { toURL: 'https://a.example.com' })])).toStrictEqual({ found: 0, link: undefined });
  });

  it('finds the links by label through the cluster store, schema first', async() => {
    const links = [navlink('a.b', { toURL: 'https://a.example.com' })];
    const dispatch = jest.fn().mockResolvedValue(links);
    const store = storeWith({ 'cluster/schemaFor': (type: string) => (type === NAVLINK_TYPE ? { id: type } : undefined) }, dispatch);

    await expect(findStudioLinks(store)).resolves.toBe(links);
    expect(dispatch).toHaveBeenCalledWith('cluster/findLabelSelector', {
      type:     NAVLINK_TYPE,
      matching: { labelSelector: NAVLINK_LABEL_SELECTOR },
    });
    expect(NAVLINK_LABEL_SELECTOR).toStrictEqual({ matchLabels: { 'app.kubernetes.io/name': 'libredb-studio' } });
  });

  it('finds no link without the NavLink schema, and makes no request', async() => {
    const dispatch = jest.fn();

    await expect(findStudioLinks(storeWith({ 'cluster/schemaFor': () => undefined }, dispatch))).resolves.toStrictEqual([]);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('finds no link when the read fails', async() => {
    const store = storeWith({ 'cluster/schemaFor': () => ({}) }, jest.fn().mockRejectedValue(new Error('forbidden')));

    await expect(findStudioLinks(store)).resolves.toStrictEqual([]);
  });
});

describe('access review service', () => {
  const allowed = (value: boolean) => ({ status: { allowed: value } });

  beforeEach(() => {
    clearReviews('c-1');
    clearReviews('c-2');
  });

  it('posts the review to Rancher\'s Kubernetes proxy, not to Steve', () => {
    expect(reviewUrl('c-m-1')).toBe('/k8s/clusters/c-m-1/apis/authorization.k8s.io/v1/selfsubjectaccessreviews');
    expect(reviewUrl('a/b')).toBe('/k8s/clusters/a%2Fb/apis/authorization.k8s.io/v1/selfsubjectaccessreviews');
  });

  it('reviews get on the credential Secret, and caches allowed', async() => {
    const dispatch = jest.fn().mockResolvedValue(allowed(true));
    const store = storeWith({}, dispatch);

    expect(reviewState('c-1', 'ns', 'db-app')).toBeUndefined();
    const done = ensureReview(store, 'c-1', 'ns', 'db-app');

    expect(reviewState('c-1', 'ns', 'db-app')).toBe('pending');
    await done;

    expect(reviewState('c-1', 'ns', 'db-app')).toBe('allowed');
    expect(dispatch).toHaveBeenCalledWith('cluster/request', {
      url:                  reviewUrl('c-1'),
      method:               'post',
      redirectUnauthorized: false,
      data:                 {
        apiVersion: 'authorization.k8s.io/v1',
        kind:       'SelfSubjectAccessReview',
        spec:       {
          resourceAttributes: {
            namespace: 'ns', verb: 'get', resource: 'secrets', name: 'db-app'
          }
        }
      }
    });
  });

  it('reviews the keys asked in one tick in one pass, once each', async() => {
    const dispatch = jest.fn().mockResolvedValue(allowed(true));
    const store = storeWith({}, dispatch);

    const first = ensureReview(store, 'c-1', 'ns', 'a');
    const second = ensureReview(store, 'c-1', 'ns', 'b');

    expect(ensureReview(store, 'c-1', 'ns', 'a')).toBe(first);
    expect(dispatch).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(dispatch).toHaveBeenCalledTimes(2);
    await Promise.all([first, second]);

    expect(dispatch).toHaveBeenCalledTimes(2);
    await ensureReview(store, 'c-1', 'ns', 'a');
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it('counts a refusal or an answer without status as denied', async() => {
    const dispatch = jest.fn()
      .mockResolvedValueOnce(allowed(false))
      .mockResolvedValueOnce({});
    const store = storeWith({}, dispatch);

    ensureReview(store, 'c-1', 'ns', 'a');
    await ensureReview(store, 'c-1', 'ns', 'b');

    expect(['a', 'b'].map((s) => reviewState('c-1', 'ns', s))).toStrictEqual(['denied', 'denied']);
  });

  it('records a review that could not be made as failed, not as denied', async() => {
    const dispatch = jest.fn().mockRejectedValueOnce(new Error('network')).mockRejectedValueOnce({ _status: 503 });
    const store = storeWith({}, dispatch);

    await ensureReview(store, 'c-1', 'ns', 'a');
    expect(reviewState('c-1', 'ns', 'a')).toBe('failed');
    await expect(reviewNow(store, 'c-1', 'ns', 'b')).resolves.toBe(false);
    expect(reviewState('c-1', 'ns', 'b')).toBe('failed');
  });

  it('resolves a later ask for a pending key only when that key is answered', async() => {
    let answer: (value: unknown) => void = () => undefined;
    const dispatch = jest.fn(() => new Promise((resolve) => {
      answer = resolve;
    }));
    const store = storeWith({}, dispatch);

    ensureReview(store, 'c-1', 'ns', 'a');
    await Promise.resolve();
    await Promise.resolve();
    expect(dispatch).toHaveBeenCalledTimes(1);

    let done = false;
    const later = ensureReview(store, 'c-1', 'ns', 'a').then(() => {
      done = true;
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(done).toBe(false);
    answer(allowed(true));
    await later;
    expect(done).toBe(true);
    expect(reviewState('c-1', 'ns', 'a')).toBe('allowed');
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('does not write back an answer asked for before the cluster was cleared', async() => {
    let answer: (value: unknown) => void = () => undefined;
    const store = storeWith({}, jest.fn(() => new Promise((resolve) => {
      answer = resolve;
    })));

    const first = ensureReview(store, 'c-1', 'ns', 'a');

    await Promise.resolve();
    await Promise.resolve();
    clearReviews('c-1');
    answer(allowed(false));
    await first;

    expect(reviewState('c-1', 'ns', 'a')).toBeUndefined();
  });

  it('reviews again after a clear, even while the cleared review is still out', async() => {
    const answers: ((value: unknown) => void)[] = [];
    const dispatch = jest.fn(() => new Promise((resolve) => {
      answers.push(resolve);
    }));
    const store = storeWith({}, dispatch);

    const first = ensureReview(store, 'c-1', 'ns', 'a');

    await Promise.resolve();
    await Promise.resolve();
    clearReviews('c-1');

    const second = ensureReview(store, 'c-1', 'ns', 'a');

    expect(second).not.toBe(first);
    await Promise.resolve();
    await Promise.resolve();
    expect(dispatch).toHaveBeenCalledTimes(2);
    answers[1](allowed(true));
    await second;
    answers[0](allowed(false));
    await first;

    expect(reviewState('c-1', 'ns', 'a')).toBe('allowed');
  });

  it('reviews again now, past the cache, and records the answer', async() => {
    const dispatch = jest.fn().mockResolvedValueOnce(allowed(true)).mockResolvedValueOnce(allowed(false));
    const store = storeWith({}, dispatch);

    await ensureReview(store, 'c-1', 'ns', 'a');
    await expect(reviewNow(store, 'c-1', 'ns', 'a')).resolves.toBe(false);
    expect(reviewState('c-1', 'ns', 'a')).toBe('denied');
  });

  it('clears one cluster\'s answers only', async() => {
    const store = storeWith({}, jest.fn().mockResolvedValue(allowed(true)));

    ensureReview(store, 'c-1', 'ns', 'a');
    await ensureReview(store, 'c-2', 'ns', 'a');
    clearReviews('c-1');

    expect(reviewState('c-1', 'ns', 'a')).toBeUndefined();
    expect(reviewState('c-2', 'ns', 'a')).toBe('allowed');
  });
});

describe('studio status service', () => {
  const link = {
    name: 'studio.libredb-studio', toURL: 'https://s.example.com', namespace: 'studio', deploymentName: 'libredb-studio'
  };

  it('is not set up without a link', async() => {
    await expect(studioStatus(storeWith({}), undefined)).resolves.toBe('not-set-up');
  });

  it('is unknown without the Deployment schema', async() => {
    await expect(studioStatus(storeWith({ 'cluster/schemaFor': () => undefined }), link)).resolves.toBe('unknown');
  });

  it('reads the Deployment through the cluster store and reports readiness', async() => {
    const dispatch = jest.fn()
      .mockResolvedValueOnce({ status: { readyReplicas: 1 } })
      .mockResolvedValueOnce({ status: { readyReplicas: 0 } })
      .mockResolvedValueOnce({});
    const store = storeWith({ 'cluster/schemaFor': (type: string) => (type === DEPLOYMENT_TYPE ? {} : undefined) }, dispatch);

    await expect(studioStatus(store, link)).resolves.toBe('ready');
    await expect(studioStatus(store, link)).resolves.toBe('not-ready');
    await expect(studioStatus(store, link)).resolves.toBe('not-ready');
    expect(dispatch).toHaveBeenCalledWith('cluster/find', { type: DEPLOYMENT_TYPE, id: 'studio/libredb-studio' });
  });

  it('is unknown when the user cannot read Studio\'s namespace', async() => {
    const store = storeWith({ 'cluster/schemaFor': () => ({}) }, jest.fn().mockRejectedValue({ _status: 403 }));

    await expect(studioStatus(store, link)).resolves.toBe('unknown');
  });

  it('is not ready when Studio\'s Deployment is missing', async() => {
    const store = storeWith({ 'cluster/schemaFor': () => ({}) }, jest.fn().mockRejectedValue({ _status: 404 }));

    await expect(studioStatus(store, link)).resolves.toBe('not-ready');
  });

  it('reads the status of an error that carries no response body', async() => {
    const store = storeWith({ 'cluster/schemaFor': () => ({}) }, jest.fn().mockRejectedValue({ response: { status: 404 } }));

    await expect(studioStatus(store, link)).resolves.toBe('not-ready');
  });

  it('failed when the read fails for any other reason', async() => {
    const dispatch = jest.fn().mockRejectedValueOnce({ _status: 500 }).mockRejectedValueOnce(new Error('network'));
    const store = storeWith({ 'cluster/schemaFor': () => ({}) }, dispatch);

    await expect(studioStatus(store, link)).resolves.toBe('failed');
    await expect(studioStatus(store, link)).resolves.toBe('failed');
  });
});
