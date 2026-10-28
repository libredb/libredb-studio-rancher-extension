import { fakeStore, httpError } from './helpers/fake-store';
import {
  canI, findAllIfVisible, findIfVisible, k8sPath, kube, kubeDelete, kubeGet, LOCAL_CLUSTER
} from '../services/setup/k8s';

describe('kubernetes requests through Rancher', () => {
  it('goes through Rancher\'s proxy for the cluster', () => {
    expect(k8sPath('c-m-1', '/api/v1/namespaces')).toBe('/k8s/clusters/c-m-1/api/v1/namespaces');
    expect(k8sPath('a/b', '/x')).toBe('/k8s/clusters/a%2Fb/x');
  });

  it('asks the local cluster through the management store and a downstream one through the cluster store', async() => {
    const store = fakeStore({ requests: [[/^GET /, { kind: 'Namespace' }]] });

    await kube(store, LOCAL_CLUSTER, 'get', '/api/v1/namespaces/x');
    await kube(store, 'c-m-1', 'get', '/api/v1/namespaces/x');

    expect(store.calls.map(({ store: name, url }) => [name, url])).toStrictEqual([
      ['management', '/k8s/clusters/local/api/v1/namespaces/x'],
      ['cluster', '/k8s/clusters/c-m-1/api/v1/namespaces/x'],
    ]);
    expect(store.dispatch).toHaveBeenCalledWith('cluster/request', expect.objectContaining({ redirectUnauthorized: false }));
  });

  it('reads an object, nothing for a missing one, and throws any other failure', async() => {
    const store = fakeStore({
      requests: [
        ['GET /k8s/clusters/c/api/v1/namespaces/here', { metadata: { name: 'here' } }],
        ['GET /k8s/clusters/c/api/v1/namespaces/broken', httpError(500)],
      ]
    });

    await expect(kubeGet(store, 'c', '/api/v1/namespaces/here')).resolves.toStrictEqual({ metadata: { name: 'here' } });
    await expect(kubeGet(store, 'c', '/api/v1/namespaces/gone')).resolves.toBeUndefined();
    await expect(kubeGet(store, 'c', '/api/v1/namespaces/broken')).rejects.toMatchObject({ _status: 500 });
  });

  it('deletes an object, says whether it was there, and throws any other failure', async() => {
    const store = fakeStore({
      requests: [
        ['DELETE /k8s/clusters/c/api/v1/namespaces/here', {}],
        ['DELETE /k8s/clusters/c/api/v1/namespaces/locked', httpError(403)],
      ]
    });

    await expect(kubeDelete(store, 'c', '/api/v1/namespaces/here')).resolves.toBe(true);
    await expect(kubeDelete(store, 'c', '/api/v1/namespaces/gone')).resolves.toBe(false);
    await expect(kubeDelete(store, 'c', '/api/v1/namespaces/locked')).rejects.toMatchObject({ _status: 403 });
  });

  it('answers whether the user may, and no when the review cannot be made', async() => {
    const url = 'POST /k8s/clusters/c/apis/authorization.k8s.io/v1/selfsubjectaccessreviews';

    await expect(canI(fakeStore({ requests: [[url, { status: { allowed: true } }]] }), 'c', { verb: 'get' })).resolves.toBe(true);
    await expect(canI(fakeStore({ requests: [[url, { status: {} }]] }), 'c', { verb: 'get' })).resolves.toBe(false);
    await expect(canI(fakeStore({ requests: [[url, undefined]] }), 'c', { verb: 'get' })).resolves.toBe(false);
    await expect(canI(fakeStore(), 'c', { verb: 'get' })).resolves.toBe(false);
  });

  it('reads through the stores only where the schema is visible', async() => {
    const store = fakeStore({
      schemas: { 'cluster/thing': {}, 'management/setting': {} },
      find:    { 'cluster/thing/a': { id: 'a' }, 'management/setting/b': httpError(403) },
      findAll: { 'cluster/thing': [{ id: 'a' }], 'cluster/other': [{ id: 'z' }] },
    });

    await expect(findIfVisible(store, 'cluster', 'thing', 'a')).resolves.toStrictEqual({ id: 'a' });
    await expect(findIfVisible(store, 'management', 'setting', 'b')).resolves.toBeUndefined();
    await expect(findIfVisible(store, 'cluster', 'other', 'a')).resolves.toBeUndefined();
    await expect(findAllIfVisible(store, 'thing')).resolves.toStrictEqual([{ id: 'a' }]);
    await expect(findAllIfVisible(store, 'other')).resolves.toStrictEqual([]);
  });
});
