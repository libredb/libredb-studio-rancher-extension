import { fakeStore, httpError, reviewAnswer, FakeStoreSetup } from './helpers/fake-store';
import {
  CLUSTER, CNPG_LIST_RULE, INDEX_URL, RANCHER_CA, SSAR_DOWN, SSAR_LOCAL, ownerOnly, readyCluster, reviewOf
} from './helpers/cluster';
import { aggregationCheck, runPreflight, Check, CheckId } from '../services/setup/preflight';

const byId = (checks: Check[]) => Object.fromEntries(checks.map((check) => [check.id, check])) as Record<CheckId, Check>;

const run = (setup: FakeStoreSetup) => runPreflight(fakeStore(setup), CLUSTER);

const withFind = (key: string, value: unknown, setup = readyCluster()): FakeStoreSetup => ({ ...setup, find: { ...setup.find, [key]: value } });

const withFindAll = (key: string, value: unknown, setup = readyCluster()): FakeStoreSetup => ({ ...setup, findAll: { ...setup.findAll, [key]: value } });

const withRequest = (line: string | RegExp, answer: unknown, setup = readyCluster()): FakeStoreSetup => ({ ...setup, requests: [[line, answer], ...(setup.requests || [])] });

const withoutSchema = (key: string, setup = readyCluster()): FakeStoreSetup => ({ ...setup, schemas: { ...setup.schemas, [key]: undefined } });

describe('setup preflight', () => {
  it('passes every check on a ready cluster for a Rancher administrator', async() => {
    const result = await run(readyCluster());

    expect(result.checks.map(({ id, state }) => [id, state])).toStrictEqual([
      ['owner', 'ok'], ['version', 'ok'], ['cnpg', 'ok'], ['aggregation', 'ok'], ['ingressClass', 'ok'], ['storageClass', 'ok'],
      ['namespace', 'ok'], ['installed', 'ok'], ['chart', 'ok'], ['oidcProvider', 'ok'], ['oidcAdmin', 'ok'], ['oidcClient', 'ok'],
    ]);
    expect(result).toMatchObject({
      canInstall:      true,
      canUseSso:       true,
      serverUrl:       'https://rancher.example.com',
      serverVersion:   'v2.15.2',
      scopes:          ['openid', 'profile', 'groups'],
      cacerts:         RANCHER_CA,
      ingressClasses:  ['traefik', 'nginx'],
      clusterIssuers:  ['letsencrypt'],
      namespaces:      ['kube-system', 'team-a', 'team-b'],
      repo:            'rancher-partner-charts',
      chart:           { version: '0.1.110', appVersion: '1.2.0' },
      namespaceExists: false,
    });
    expect(byId(result.checks).chart.args).toStrictEqual({
      repo: 'rancher-partner-charts', version: '0.1.110', appVersion: '1.2.0'
    });
    expect(byId(result.checks).storageClass.args).toStrictEqual({ name: 'local-path' });
  });

  it('asks the owner question first and stops there for anyone who does not own the cluster', async() => {
    const store = fakeStore(withRequest(SSAR_DOWN, reviewAnswer(false)));
    const result = await runPreflight(store, CLUSTER);

    expect(result.checks).toStrictEqual([{
      id: 'owner', state: 'error', reason: 'notOwner'
    }]);
    expect(result.canInstall).toBe(false);
    expect(result.canUseSso).toBe(false);
    expect(reviewOf(store.calls[0])).toStrictEqual({
      verb: '*', group: '*', resource: '*'
    });
    expect(store.calls).toHaveLength(1);
  });

  it('counts a review that cannot be made as not the owner', async() => {
    const result = await run(withRequest(SSAR_DOWN, httpError(500)));

    expect(result.checks).toStrictEqual([{
      id: 'owner', state: 'error', reason: 'notOwner'
    }]);
  });

  describe('Rancher version', () => {
    it.each([
      ['v2.14.3', 'warning', 'old'],
      ['head', 'warning', 'unknown'],
      ['v2.16.0', 'ok', 'ok'],
    ])('%s is %s (%s)', async(version, state, reason) => {
      const { checks } = await run(withFind('management/management.cattle.io.setting/server-version', { value: version }));

      expect(byId(checks).version).toStrictEqual({
        id: 'version', state, reason, args: { version }
      });
    });

    it('asks only for openid and profile below 2.15', async() => {
      const result = await run(withFind('management/management.cattle.io.setting/server-version', { value: 'v2.14.3' }));

      expect(result.scopes).toStrictEqual(['openid', 'profile']);
    });

    it('is unknown when the setting cannot be read', async() => {
      const { checks } = await run(withFind('management/management.cattle.io.setting/server-version', httpError(403)));

      expect(byId(checks).version).toMatchObject({
        state: 'warning', reason: 'unknown', args: { version: '' }
      });
    });

    it('is unknown without the settings schema', async() => {
      const result = await run(withoutSchema('management/management.cattle.io.setting'));

      expect(byId(result.checks).version.reason).toBe('unknown');
      expect(result.serverUrl).toBeUndefined();
      expect(result.cacerts).toBeUndefined();
    });
  });

  it('needs CloudNativePG', async() => {
    const result = await run(withoutSchema('cluster/postgresql.cnpg.io.cluster'));

    expect(byId(result.checks).cnpg).toStrictEqual({
      id: 'cnpg', state: 'error', reason: 'missing'
    });
    expect(result.canInstall).toBe(false);
  });

  describe('role aggregation', () => {
    it('warns, without blocking, that project members cannot list Clusters when the roles are not aggregated', async() => {
      const result = await run(withFind('cluster/rbac.authorization.k8s.io.clusterrole/view', {
        rules: [{
          apiGroups: [''], resources: ['pods'], verbs: ['list']
        }]
      }));

      expect(byId(result.checks).aggregation).toStrictEqual({
        id: 'aggregation', state: 'warning', reason: 'off'
      });
      expect(result.canInstall).toBe(true);
    });

    it('needs list on Clusters in both edit and view', async() => {
      const editWithoutList = withFind('cluster/rbac.authorization.k8s.io.clusterrole/edit', {
        rules: [{
          apiGroups: ['postgresql.cnpg.io'], resources: ['clusters'], verbs: ['get']
        }]
      });

      expect(byId((await run(editWithoutList)).checks).aggregation.reason).toBe('off');
      expect(byId((await run(withFind('cluster/rbac.authorization.k8s.io.clusterrole/edit', {}))).checks).aggregation.reason).toBe('off');
    });

    it('accepts wildcards', async() => {
      const wildcard = {
        rules: [{
          apiGroups: ['*'], resources: ['*'], verbs: ['*']
        }]
      };
      const setup = withFind('cluster/rbac.authorization.k8s.io.clusterrole/view', wildcard, withFind('cluster/rbac.authorization.k8s.io.clusterrole/edit', wildcard));

      expect(byId((await run(setup)).checks).aggregation.state).toBe('ok');
    });

    it('cannot tell when the roles cannot be read', async() => {
      expect(byId((await run(withFind('cluster/rbac.authorization.k8s.io.clusterrole/view', httpError(403)))).checks).aggregation)
        .toStrictEqual({
          id: 'aggregation', state: 'warning', reason: 'unknown'
        });
      expect(await aggregationCheck(fakeStore(withoutSchema('cluster/rbac.authorization.k8s.io.clusterrole'))))
        .toStrictEqual({
          id: 'aggregation', state: 'warning', reason: 'unknown'
        });
    });

    it('is the same check the settings page shows', async() => {
      expect(await aggregationCheck(fakeStore(readyCluster()))).toStrictEqual({
        id: 'aggregation', state: 'ok', reason: 'ok'
      });
      expect(CNPG_LIST_RULE.verbs).toContain('list');
    });
  });

  describe('ingress and storage', () => {
    it('needs an IngressClass, and puts the default one first', async() => {
      const none = await run(withFindAll('cluster/networking.k8s.io.ingressclass', []));
      const noDefault = await run(withFindAll('cluster/networking.k8s.io.ingressclass', [{ metadata: { name: 'b' } }, { metadata: { name: 'a' } }]));

      expect(byId(none.checks).ingressClass).toStrictEqual({
        id: 'ingressClass', state: 'error', reason: 'none'
      });
      expect(none.canInstall).toBe(false);
      expect(noDefault.ingressClasses).toStrictEqual(['a', 'b']);
      expect(byId(noDefault.checks).ingressClass).toStrictEqual({
        id: 'ingressClass', state: 'ok', reason: 'ok', args: { name: 'a' }
      });
    });

    it('cannot list IngressClasses without their schema', async() => {
      const result = await run(withoutSchema('cluster/networking.k8s.io.ingressclass'));

      expect(byId(result.checks).ingressClass.state).toBe('error');
      expect(result.ingressClasses).toStrictEqual([]);
    });

    it('needs a default StorageClass for Studio\'s volume', async() => {
      const result = await run(withFindAll('cluster/storage.k8s.io.storageclass', [{ metadata: { name: 'fast' } }]));

      expect(byId(result.checks).storageClass).toStrictEqual({
        id: 'storageClass', state: 'error', reason: 'none'
      });
      expect(result.canInstall).toBe(false);
    });

    it('takes the beta default-class annotation too', async() => {
      const beta = [{ metadata: { name: 'old', annotations: { 'storageclass.beta.kubernetes.io/is-default-class': 'true' } } }];

      expect(byId((await run(withFindAll('cluster/storage.k8s.io.storageclass', beta))).checks).storageClass.args).toStrictEqual({ name: 'old' });
    });

    it('offers no ClusterIssuer without cert-manager', async() => {
      expect((await run(withoutSchema('cluster/cert-manager.io.clusterissuer'))).clusterIssuers).toStrictEqual([]);
    });

    it('treats a list that fails as empty', async() => {
      const result = await run(withFindAll('cluster/networking.k8s.io.ingressclass', httpError(500)));

      expect(byId(result.checks).ingressClass.reason).toBe('none');
    });
  });

  describe('Studio\'s namespace', () => {
    it('uses a namespace that exists outside every project', async() => {
      const result = await run(withFindAll('cluster/namespace', [{ metadata: { name: 'libredb-studio', annotations: {} } }, { metadata: { name: 'team-a' } }]));

      expect(byId(result.checks).namespace).toStrictEqual({
        id: 'namespace', state: 'ok', reason: 'existing', args: { namespace: 'libredb-studio' }
      });
      expect(result.namespaceExists).toBe(true);
      expect(result.namespaces).toStrictEqual(['team-a']);
    });

    it('refuses a namespace that belongs to a project, whose members could read Studio\'s Secrets', async() => {
      const result = await run(withFindAll('cluster/namespace', [{ metadata: { name: 'libredb-studio', annotations: { 'field.cattle.io/projectId': 'c-m-1:p-1' } } }]));

      expect(byId(result.checks).namespace).toStrictEqual({
        id: 'namespace', state: 'error', reason: 'inProject', args: { namespace: 'libredb-studio' }
      });
      expect(result.canInstall).toBe(false);
    });

    it('creates it when it does not exist', async() => {
      expect(byId((await run(readyCluster())).checks).namespace).toStrictEqual({
        id: 'namespace', state: 'ok', reason: 'new', args: { namespace: 'libredb-studio' }
      });
    });
  });

  describe('an existing Studio', () => {
    it('refuses a second install when the app is there', async() => {
      const result = await run(withFind('cluster/catalog.cattle.io.app/libredb-studio/libredb-studio', { metadata: { name: 'libredb-studio' } }));

      expect(byId(result.checks).installed).toStrictEqual({
        id: 'installed', state: 'error', reason: 'installed', args: { namespace: 'libredb-studio', name: 'libredb-studio' }
      });
      expect(result.canInstall).toBe(false);
    });

    it('refuses a second Studio when the cluster already links to one', async() => {
      const setup = { ...readyCluster(), findLabelSelector: { 'cluster/ui.cattle.io.navlink': [{ metadata: { name: 'tools.studio' }, spec: { toURL: 'https://studio.example.com' } }] } };

      expect(byId((await run(setup)).checks).installed).toStrictEqual({
        id: 'installed', state: 'error', reason: 'linked', args: { namespace: 'tools' }
      });
    });

    it('cannot tell when the app cannot be read', async() => {
      expect(byId((await run(withFind('cluster/catalog.cattle.io.app/libredb-studio/libredb-studio', httpError(500)))).checks).installed)
        .toStrictEqual({
          id: 'installed', state: 'error', reason: 'unknown'
        });
    });

    it('sends a cluster owner to Settings when an earlier setup left its record behind', async() => {
      const leftover = withRequest(`GET /k8s/clusters/${ CLUSTER }/api/v1/namespaces/libredb-studio/configmaps/libredb-studio-setup`, { metadata: { name: 'libredb-studio-setup' } });

      expect(byId((await run(leftover)).checks).installed).toStrictEqual({
        id: 'installed', state: 'error', reason: 'leftover', args: { namespace: 'libredb-studio', name: 'libredb-studio-setup' }
      });
    });

    it('cannot tell when the record cannot be read', async() => {
      const broken = withRequest(`GET /k8s/clusters/${ CLUSTER }/api/v1/namespaces/libredb-studio/configmaps/libredb-studio-setup`, httpError(500));

      expect(byId((await run(broken)).checks).installed.reason).toBe('unknown');
    });
  });

  describe('chart', () => {
    it('needs the repository', async() => {
      const result = await run(withFind('cluster/catalog.cattle.io.clusterrepo/rancher-partner-charts', httpError(404)));

      expect(byId(result.checks).chart).toStrictEqual({
        id: 'chart', state: 'error', reason: 'noRepo', args: { repo: 'rancher-partner-charts' }
      });
      expect(result.canInstall).toBe(false);
      expect(result.chart).toBeUndefined();
    });

    it('needs the chart in the repository', async() => {
      const { checks } = await run(withRequest(`GET ${ INDEX_URL }`, { entries: { other: [] } }));

      expect(byId(checks).chart).toStrictEqual({
        id: 'chart', state: 'error', reason: 'noChart', args: { repo: 'rancher-partner-charts' }
      });
    });

    it('names the newest version and the floor when no version has Rancher mode', async() => {
      const { checks } = await run(withRequest(`GET ${ INDEX_URL }`, { entries: { 'libredb-studio': [{ version: '0.1.104', appVersion: '1.1.0' }] } }));

      expect(byId(checks).chart).toStrictEqual({
        id:     'chart',
        state:  'error',
        reason: 'tooOld',
        args:   {
          repo: 'rancher-partner-charts', newest: '0.1.104', newestApp: '1.1.0', min: '0.1.107', minApp: '1.1.1'
        },
      });
    });

    it('says so when the index cannot be read', async() => {
      const { checks } = await run(withRequest(`GET ${ INDEX_URL }`, httpError(500)));

      expect(byId(checks).chart).toStrictEqual({
        id: 'chart', state: 'error', reason: 'unreadable', args: { repo: 'rancher-partner-charts' }
      });
    });

    it('says so for a repository without an index link', async() => {
      const setup = withFind('cluster/catalog.cattle.io.clusterrepo/rancher-partner-charts', { metadata: { name: 'rancher-partner-charts' }, links: {} });

      expect(byId((await run(setup)).checks).chart.reason).toBe('unreadable');
    });

    it('reads the extension\'s own repository only', async() => {
      const store = fakeStore(readyCluster());

      await runPreflight(store, CLUSTER);

      expect(store.dispatch.mock.calls.filter(([action, payload]: [string, { type?: string }]) => action === 'cluster/find' && payload.type === 'catalog.cattle.io.clusterrepo'))
        .toStrictEqual([['cluster/find', { type: 'catalog.cattle.io.clusterrepo', id: 'rancher-partner-charts' }]]);
    });
  });

  describe('single sign-on', () => {
    it('warns that turning the OIDC provider on restarts Rancher, and installs without single sign-on', async() => {
      const off = { spec: { value: null }, status: { default: false, lockedValue: null } };
      const result = await run(withFind('management/management.cattle.io.feature/oidc-provider', off));

      expect(byId(result.checks).oidcProvider).toStrictEqual({
        id: 'oidcProvider', state: 'warning', reason: 'off', sso: true
      });
      expect(result.canUseSso).toBe(false);
      expect(result.canInstall).toBe(true);
    });

    it('reads the flag as Rancher does: a locked value, then the value, then the default', async() => {
      const feature = (spec: unknown, status: unknown) => withFind('management/management.cattle.io.feature/oidc-provider', { spec, status });

      expect(byId((await run(feature({ value: true }, { default: false, lockedValue: false }))).checks).oidcProvider.reason).toBe('off');
      expect(byId((await run(feature({ value: null }, { default: true, lockedValue: null }))).checks).oidcProvider.reason).toBe('ok');
      expect(byId((await run(feature({ value: false }, { default: true }))).checks).oidcProvider.reason).toBe('off');
      expect(byId((await run(feature(undefined, undefined))).checks).oidcProvider.reason).toBe('off');
      expect(byId((await run(withFind('management/management.cattle.io.feature/oidc-provider', httpError(403)))).checks).oidcProvider.reason).toBe('off');
    });

    it('needs Rancher\'s server URL for the issuer', async() => {
      const result = await run(withFind('management/management.cattle.io.setting/server-url', { value: '' }));

      expect(byId(result.checks).oidcProvider).toStrictEqual({
        id: 'oidcProvider', state: 'warning', reason: 'noServerUrl', sso: true
      });
      expect(result.canUseSso).toBe(false);
    });

    it('needs an administrator, and asks nothing about the OIDC client of anyone else', async() => {
      const store = fakeStore(ownerOnly());
      const result = await runPreflight(store, CLUSTER);
      const local = store.calls.filter((call) => call.url.startsWith('/k8s/clusters/local/')).map(reviewOf);

      expect(byId(result.checks).oidcAdmin).toStrictEqual({
        id: 'oidcAdmin', state: 'warning', reason: 'notAdmin', sso: true
      });
      expect(byId(result.checks).oidcClient).toBeUndefined();
      expect(result.canUseSso).toBe(false);
      expect(result.canInstall).toBe(true);
      expect(local).toStrictEqual([{
        group: 'management.cattle.io', resource: 'oidcclients', verb: 'create'
      }]);
    });

    it('needs both rights: the client and its secret', async() => {
      const store = fakeStore(withRequest(SSAR_LOCAL, (request: Parameters<typeof reviewOf>[0]) => reviewAnswer(reviewOf(request).resource === 'oidcclients')));
      const result = await runPreflight(store, CLUSTER);

      expect(byId(result.checks).oidcAdmin.reason).toBe('notAdmin');
      expect(store.calls.filter((call) => call.url.startsWith('/k8s/clusters/local/')).map(reviewOf)).toContainEqual({
        namespace: 'cattle-oidc-client-secrets', resource: 'secrets', verb: 'get'
      });
    });

    it('refuses single sign-on when the cluster\'s OIDC client already exists', async() => {
      const result = await run(withRequest('GET /k8s/clusters/local/apis/management.cattle.io/v3/oidcclients/libredb-studio-c-m-1', { metadata: { name: 'libredb-studio-c-m-1' } }));

      expect(byId(result.checks).oidcClient).toStrictEqual({
        id: 'oidcClient', state: 'error', reason: 'exists', args: { name: 'libredb-studio-c-m-1' }, sso: true
      });
      expect(result.canUseSso).toBe(false);
      expect(result.canInstall).toBe(true);
    });

    it('refuses single sign-on when it cannot tell whether the client exists', async() => {
      const result = await run(withRequest(/^GET \/k8s\/clusters\/local\/apis\/management.cattle.io\/v3\/oidcclients\//, httpError(500)));

      expect(byId(result.checks).oidcClient).toStrictEqual({
        id: 'oidcClient', state: 'error', reason: 'unknown', args: { name: 'libredb-studio-c-m-1' }, sso: true
      });
    });
  });

  it('keeps an empty cacerts setting out of the result', async() => {
    expect((await run(withFind('management/management.cattle.io.setting/cacerts', { value: '' }))).cacerts).toBeUndefined();
  });

  it('never reads a Secret', async() => {
    const store = fakeStore(readyCluster());

    await runPreflight(store, CLUSTER);

    const reads = store.dispatch.mock.calls.filter(([, payload]: [string, Record<string, unknown>]) => /secret/i.test(String(payload?.type || '')) || (/\/secrets/.test(String(payload?.url || '')) && !/selfsubjectaccessreviews/.test(String(payload?.url))));

    expect(reads).toStrictEqual([]);
  });
});
