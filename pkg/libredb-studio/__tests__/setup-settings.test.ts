import { fakeStore, httpError, reviewAnswer } from './helpers/fake-store';
import {
  CLUSTER, RANCHER_CA, SSAR_DOWN, SSAR_LOCAL, readyCluster, reviewOf
} from './helpers/cluster';
import {
  enableSso, loadSettings, saveNamespaces, uninstallStudio, AppInfo, ChangeOptions
} from '../services/setup/settings';
import { chartValues, serializeRecord, SetupRecord } from '../services/setup/values';
import type { RancherContext } from '../services/setup/preflight';
import type { Request } from './helpers/fake-store';

const K8S = `/k8s/clusters/${ CLUSTER }`;
const LOCAL = '/k8s/clusters/local';
const NS = `${ K8S }/api/v1/namespaces/libredb-studio`;
const RECORD_PATH = `${ NS }/configmaps/libredb-studio-setup`;
const APP = `${ K8S }/apis/catalog.cattle.io/v1/namespaces/libredb-studio/apps/libredb-studio`;
const UPGRADE = `${ K8S }/v1/catalog.cattle.io.clusterrepos/rancher-partner-charts?action=upgrade`;
const UNINSTALL = `${ K8S }/v1/catalog.cattle.io.apps/libredb-studio/libredb-studio?action=uninstall`;
const CLIENT = `${ LOCAL }/apis/management.cattle.io/v3/oidcclients/libredb-studio-c-m-1`;
const CLIENT_SECRET = `${ LOCAL }/api/v1/namespaces/cattle-oidc-client-secrets/secrets/client-abc`;
const NAVLINK = `${ K8S }/apis/ui.cattle.io/v1/navlinks/libredb-studio.libredb-studio`;
const SECRET_B64 = btoa('not-a-real-client-secret');

const RECORD: SetupRecord = {
  version: 1,
  cluster: CLUSTER,
  release: {
    namespace: 'libredb-studio', name: 'libredb-studio', repo: 'rancher-partner-charts', chart: 'libredb-studio', chartVersion: '0.1.110'
  },
  host:             'studio.example.com',
  ingressClassName: 'traefik',
  tls:              { source: 'secret', secretName: 'studio-tls' },
  namespaces:       ['team-a'],
  createdNamespace: true,
};
const SSO = {
  client: 'libredb-studio-c-m-1', issuer: 'https://rancher.example.com/oidc', scope: 'openid profile groups', rancherCA: true
};
const SSO_RECORD: SetupRecord = { ...RECORD, sso: SSO };
const APP_INFO: AppInfo = {
  chartVersion: '0.1.111', appVersion: '1.2.1', status: 'deployed', revision: 3
};
const CONTEXT: RancherContext = {
  serverUrl: 'https://rancher.example.com', serverVersion: 'v2.15.2', scopes: ['openid', 'profile', 'groups'], cacerts: RANCHER_CA
};

type Answers = [string | RegExp, unknown][];

const fast = () => {
  let clock = 0;

  return { sleep: () => Promise.resolve(), now: () => (clock += 1000) };
};

/**
 * A cluster with Studio installed by the wizard: each upgrade asked for makes a new revision in the
 * Helm state given (the next one each time), and the uninstall makes the app go away.
 */
function installed(record: SetupRecord = RECORD, override: Answers = [], upgradeStates: string[] = ['deployed']) {
  const setup = readyCluster();
  const holder = {} as { store: ReturnType<typeof fakeStore> };
  const count = (line: string) => holder.store.calls.filter((call) => `${ call.method } ${ call.url }` === line).length;
  const app = () => {
    if (count(`POST ${ UNINSTALL }`)) {
      return httpError(404);
    }

    const upgrades = count(`POST ${ UPGRADE }`);
    const status = upgrades ? upgradeStates[Math.min(upgrades, upgradeStates.length) - 1] : 'deployed';

    return {
      spec: {
        version: 3 + upgrades, chart: { metadata: { version: '0.1.111', appVersion: '1.2.1' } }, info: { status }
      }
    };
  };

  holder.store = fakeStore({
    ...setup,
    find:              { ...setup.find, 'cluster/apps.deployment/libredb-studio/libredb-studio': { status: { readyReplicas: 1 } } },
    findLabelSelector: { 'cluster/ui.cattle.io.navlink': [{ metadata: { name: 'libredb-studio.libredb-studio' }, spec: { toURL: 'https://studio.example.com' } }] },
    requests:          [
      ...override,
      [`GET ${ RECORD_PATH }`, { data: { 'setup.json': serializeRecord(record) } }],
      [`GET ${ APP }`, app],
      [`POST ${ UPGRADE }`, { operationName: 'helm-operation-9', operationNamespace: 'cattle-system' }],
      [`PUT ${ RECORD_PATH }`, {}],
      [`POST ${ LOCAL }/apis/management.cattle.io/v3/oidcclients`, {}],
      [`GET ${ CLIENT }`, () => (count(`POST ${ LOCAL }/apis/management.cattle.io/v3/oidcclients`) ? { status: { clientID: 'client-abc' } } : httpError(404))],
      [`GET ${ CLIENT_SECRET }`, { data: { 'client-secret-1': SECRET_B64 } }],
      [`POST ${ NS }/secrets`, {}],
      [`POST ${ NS }/configmaps`, {}],
      [`POST ${ UNINSTALL }`, { operationName: 'helm-operation-10', operationNamespace: 'cattle-system' }],
      [/^GET .*\/namespaces\/libredb-studio\/(apps|deployments|statefulsets|daemonsets|jobs|cronjobs)$/, { items: [] }],
      [/^DELETE /, {}],
      ...(setup.requests || []),
    ],
  });

  return holder.store;
}

const lines = (store: ReturnType<typeof fakeStore>) => store.calls.map((call: Request) => `${ call.method } ${ call.url }`);
const bodyOf = (store: ReturnType<typeof fakeStore>, line: string, nth = 0) => store.calls.filter((call: Request) => `${ call.method } ${ call.url }` === line)[nth]?.data as Record<string, unknown>;

function options(): ChangeOptions & { events: unknown[], undone: unknown[] } {
  const events: unknown[] = [];
  const undone: unknown[] = [];

  return {
    ...fast(), events, undone, onStep: (event) => events.push(event), onUndo: (event) => undone.push(event)
  };
}

describe('loading Studio\'s settings', () => {
  it('reads what the wizard set up, the app, the link, the state, and whether single sign-on can be turned on', async() => {
    const settings = await loadSettings(installed(), CLUSTER);

    expect(settings).toMatchObject({
      canChange:        true,
      record:           RECORD,
      recordUnreadable: false,
      app:              APP_INFO,
      link:             { name: 'libredb-studio.libredb-studio', namespace: 'libredb-studio' },
      status:           'ready',
      aggregation:      { id: 'aggregation', state: 'ok' },
      namespaces:       ['kube-system', 'team-a', 'team-b'],
      sso:              { canUseSso: true, context: CONTEXT },
    });
    expect(settings.sso?.checks.map((check) => check.id)).toStrictEqual(['oidcProvider', 'oidcAdmin', 'oidcClient']);
  });

  it('offers nothing about single sign-on once it is on', async() => {
    expect((await loadSettings(installed(SSO_RECORD), CLUSTER)).sso).toBeUndefined();
  });

  it('reads nothing more for someone who does not own the cluster', async() => {
    const store = installed(RECORD, [[SSAR_DOWN, reviewAnswer(false)]]);
    const settings = await loadSettings(store, CLUSTER);

    expect(settings).toStrictEqual({
      canChange: false, recordUnreadable: false, namespaces: []
    });
    expect(lines(store)).toStrictEqual([`POST ${ K8S }/apis/authorization.k8s.io/v1/selfsubjectaccessreviews`]);
  });

  it('tells a Studio set up another way from none at all', async() => {
    const other = await loadSettings(installed(RECORD, [[`GET ${ RECORD_PATH }`, httpError(404)]]), CLUSTER);

    expect(other.record).toBeUndefined();
    expect(other.recordUnreadable).toBe(false);
    expect(other.app).toMatchObject({ chartVersion: '0.1.111' });

    const none = await loadSettings(installed(RECORD, [[`GET ${ RECORD_PATH }`, httpError(404)], [`GET ${ APP }`, httpError(404)]]), CLUSTER);

    expect(none.app).toBeUndefined();
  });

  it('says when the record is there but cannot be read', async() => {
    const settings = await loadSettings(installed(RECORD, [[`GET ${ RECORD_PATH }`, { data: { 'setup.json': '{' } }]]), CLUSTER);

    expect(settings).toMatchObject({ record: undefined, recordUnreadable: true });
  });

  it('reads an app without chart metadata or a Helm state', async() => {
    const settings = await loadSettings(installed(RECORD, [[`GET ${ APP }`, { spec: {}, status: { summary: { state: 'deployed' } } }]]), CLUSTER);

    expect(settings.app).toStrictEqual({
      chartVersion: undefined, appVersion: undefined, status: 'deployed', revision: 0
    });
  });
});

describe('changing the discovered namespaces', () => {
  it('upgrades Studio with the whole set of values and the new list, then updates the record', async() => {
    const store = installed();
    const run = options();
    const result = await saveNamespaces(store, CLUSTER, RECORD, APP_INFO, ['team-b', 'team-a', 'team-b'], run);
    const changed = { ...RECORD, namespaces: ['team-a', 'team-b'] };

    expect(result).toStrictEqual({
      ok: true, undone: [], record: changed
    });
    expect(bodyOf(store, `POST ${ UPGRADE }`)).toMatchObject({
      charts: [{
        version: '0.1.111', values: chartValues(changed), resetValues: false
      }]
    });
    expect(bodyOf(store, `PUT ${ RECORD_PATH }`)).toStrictEqual({
      apiVersion: 'v1',
      kind:       'ConfigMap',
      metadata:   { name: 'libredb-studio-setup', labels: { 'app.kubernetes.io/managed-by': 'libredb-studio-rancher-extension', 'app.kubernetes.io/part-of': 'libredb-studio' } },
      data:       { 'setup.json': serializeRecord(changed) },
    });
    expect(run.events.filter((event) => (event as { state: string }).state !== 'running')).toStrictEqual([
      { step: 'upgrade', state: 'done' }, { step: 'saveRecord', state: 'done' }
    ]);
  });

  it('keeps the record as it was when the upgrade fails', async() => {
    const store = installed(RECORD, [], ['failed']);
    const result = await saveNamespaces(store, CLUSTER, RECORD, APP_INFO, ['team-b'], options());

    expect(result).toStrictEqual({
      ok: false, failedStep: 'upgrade', failure: { reason: 'helmFailed' }, undone: []
    });
    expect(lines(store)).not.toContain(`PUT ${ RECORD_PATH }`);
  });

  it('says so when Studio took the change but the record could not be updated', async() => {
    const result = await saveNamespaces(installed(RECORD, [[`PUT ${ RECORD_PATH }`, httpError(409, 'conflict')]]), CLUSTER, RECORD, APP_INFO, ['team-b'], options());

    expect(result).toMatchObject({
      ok: false, failedStep: 'saveRecord', failure: { reason: 'request', args: { detail: 'HTTP 409: conflict' } }
    });
  });

  it('upgrades at the version the record names when the app does not say', async() => {
    const store = installed();

    await saveNamespaces(store, CLUSTER, RECORD, { revision: 3 }, ['team-b'], options());

    expect(bodyOf(store, `POST ${ UPGRADE }`)).toMatchObject({ charts: [{ version: '0.1.110' }] });
  });
});

describe('turning single sign-on on', () => {
  it('registers Studio with Rancher, copies the credentials and the CA, upgrades Studio, then updates the record', async() => {
    const store = installed();
    const run = options();
    const result = await enableSso(store, CLUSTER, RECORD, APP_INFO, CONTEXT, run);

    expect(result).toStrictEqual({
      ok: true, undone: [], record: SSO_RECORD
    });
    expect(run.events.filter((event) => (event as { state: string }).state !== 'running').map((event) => (event as { step: string }).step))
      .toStrictEqual(['oidcClient', 'oidcSecret', 'rancherCA', 'upgrade', 'saveRecord']);
    expect(bodyOf(store, `POST ${ LOCAL }/apis/management.cattle.io/v3/oidcclients`)).toMatchObject({ metadata: { name: 'libredb-studio-c-m-1' }, spec: { redirectURIs: ['https://studio.example.com/api/auth/oidc/callback'], scopes: ['openid', 'profile', 'groups'] } });
    expect(bodyOf(store, `POST ${ NS }/secrets`)).toMatchObject({ data: { 'oidc-client-secret': SECRET_B64 } });
    expect(bodyOf(store, `POST ${ NS }/configmaps`)).toMatchObject({ metadata: { name: 'libredb-studio-rancher-ca' }, data: { 'ca.crt': RANCHER_CA } });
    expect(bodyOf(store, `POST ${ UPGRADE }`)).toMatchObject({ charts: [{ values: chartValues(SSO_RECORD) }] });
    expect(JSON.stringify({ result, events: run.events })).not.toContain(SECRET_B64);
  });

  it('copies no CA when Rancher has none of its own', async() => {
    const store = installed();
    const result = await enableSso(store, CLUSTER, RECORD, APP_INFO, { ...CONTEXT, cacerts: undefined }, options());

    expect(result.record?.sso?.rancherCA).toBe(false);
    expect(lines(store)).not.toContain(`POST ${ NS }/configmaps`);
  });

  it('refuses without Rancher\'s server URL', async() => {
    const store = installed();

    await expect(enableSso(store, CLUSTER, RECORD, APP_INFO, { ...CONTEXT, serverUrl: undefined }, options())).resolves.toStrictEqual({
      ok: false, failure: { reason: 'ssoUnavailable' }, undone: []
    });
    expect(store.calls).toStrictEqual([]);
  });

  it('puts the previous values back and removes what it created when the upgrade fails', async() => {
    const store = installed(RECORD, [], ['failed', 'deployed']);
    const run = options();
    const result = await enableSso(store, CLUSTER, RECORD, APP_INFO, CONTEXT, run);

    expect(result).toMatchObject({
      ok: false, failedStep: 'upgrade', failure: { reason: 'helmFailed' }
    });
    expect(result.undone).toStrictEqual([
      { undo: 'upgrade', outcome: 'restored' },
      { undo: 'rancherCA', outcome: 'removed' },
      { undo: 'oidcSecret', outcome: 'removed' },
      { undo: 'oidcClient', outcome: 'removed' },
    ]);
    expect(run.undone).toStrictEqual(result.undone);
    expect(bodyOf(store, `POST ${ UPGRADE }`, 1)).toMatchObject({ charts: [{ values: chartValues(RECORD) }] });
    expect(lines(store)).not.toContain(`PUT ${ RECORD_PATH }`);
  });

  it('keeps the credentials while Studio may still use them, when the previous values cannot be put back', async() => {
    const result = await enableSso(installed(RECORD, [], ['failed', 'failed']), CLUSTER, RECORD, APP_INFO, CONTEXT, options());

    expect(result.undone).toStrictEqual([
      {
        undo: 'upgrade', outcome: 'failed', failure: { reason: 'helmFailed' }
      },
      {
        undo: 'rancherCA', outcome: 'kept', failure: { reason: 'upgradeLeft' }
      },
      {
        undo: 'oidcSecret', outcome: 'kept', failure: { reason: 'upgradeLeft' }
      },
      {
        undo: 'oidcClient', outcome: 'kept', failure: { reason: 'upgradeLeft' }
      },
    ]);
  });

  it('removes the OIDC client when the credentials cannot be copied, and upgrades nothing', async() => {
    const store = installed(RECORD, [[`POST ${ NS }/secrets`, httpError(403)]]);
    const result = await enableSso(store, CLUSTER, RECORD, APP_INFO, CONTEXT, options());

    expect(result).toMatchObject({
      ok: false, failedStep: 'oidcSecret', undone: [{ undo: 'oidcClient', outcome: 'removed' }]
    });
    expect(lines(store)).not.toContain(`POST ${ UPGRADE }`);
  });

  it('removes nothing when Studio is upgraded but the record cannot be updated', async() => {
    const result = await enableSso(installed(RECORD, [[`PUT ${ RECORD_PATH }`, httpError(500)]]), CLUSTER, RECORD, APP_INFO, CONTEXT, options());

    expect(result).toMatchObject({
      ok: false, failedStep: 'saveRecord', undone: []
    });
  });
});

describe('uninstalling Studio', () => {
  it('refuses unless the release name was typed by hand', async() => {
    const store = installed();

    await expect(uninstallStudio(store, CLUSTER, RECORD, 'libredb', options())).resolves.toStrictEqual({
      ok: false, failure: { reason: 'notConfirmed' }, undone: []
    });
    expect(store.calls).toStrictEqual([]);
  });

  it('removes everything the wizard created, the OIDC client too, for a Rancher administrator', async() => {
    const store = installed(SSO_RECORD);
    const run = options();
    const result = await uninstallStudio(store, CLUSTER, SSO_RECORD, ' libredb-studio ', run);

    expect(result).toStrictEqual({
      ok:     true,
      undone: [
        { undo: 'release', outcome: 'removed' },
        { undo: 'navLink', outcome: 'removed' },
        { undo: 'rancherCA', outcome: 'removed' },
        { undo: 'oidcSecret', outcome: 'removed' },
        { undo: 'oidcClient', outcome: 'removed' },
        { undo: 'record', outcome: 'removed' },
        { undo: 'namespace', outcome: 'removed' },
      ],
    });
    expect(run.undone).toStrictEqual(result.undone);
    expect(lines(store).filter((line) => line.startsWith('DELETE'))).toStrictEqual([
      `DELETE ${ NAVLINK }`,
      `DELETE ${ NS }/configmaps/libredb-studio-rancher-ca`,
      `DELETE ${ NS }/secrets/libredb-studio-oidc`,
      `DELETE ${ CLIENT }`,
      `DELETE ${ RECORD_PATH }`,
      `DELETE ${ NS }`,
    ]);
    expect(store.calls.filter((call) => call.url.endsWith('selfsubjectaccessreviews')).map(reviewOf)).toContainEqual({
      group: 'management.cattle.io', resource: 'oidcclients', verb: 'delete', name: 'libredb-studio-c-m-1'
    });
  });

  it('leaves the OIDC client to an administrator, and names it, for a cluster owner', async() => {
    const store = installed(SSO_RECORD, [[SSAR_LOCAL, reviewAnswer(false)]]);
    const result = await uninstallStudio(store, CLUSTER, SSO_RECORD, 'libredb-studio', options());

    expect(result.ok).toBe(true);
    expect(result.undone).toContainEqual({
      undo: 'oidcClient', outcome: 'kept', failure: { reason: 'notAllowed', args: { name: 'libredb-studio-c-m-1' } }
    });
    expect(lines(store)).not.toContain(`DELETE ${ CLIENT }`);
    expect(result.undone).toContainEqual({ undo: 'record', outcome: 'removed' });
  });

  it('touches no OIDC object of a Studio that never had single sign-on, and keeps a namespace it did not create', async() => {
    const record = { ...RECORD, createdNamespace: false };
    const store = installed(record);
    const result = await uninstallStudio(store, CLUSTER, record, 'libredb-studio', options());

    expect(result.undone).toStrictEqual([
      { undo: 'release', outcome: 'removed' },
      { undo: 'navLink', outcome: 'removed' },
      { undo: 'record', outcome: 'removed' },
      {
        undo: 'namespace', outcome: 'kept', failure: { reason: 'notOurs', args: { namespace: 'libredb-studio' } }
      },
    ]);
    expect(lines(store).filter((line) => line.includes(LOCAL))).toStrictEqual([]);
  });

  it('removes nothing else when the app cannot be uninstalled', async() => {
    const store = installed(SSO_RECORD, [[`POST ${ UNINSTALL }`, httpError(500, 'helm is busy')]]);
    const result = await uninstallStudio(store, CLUSTER, SSO_RECORD, 'libredb-studio', options());

    expect(result).toStrictEqual({
      ok:     false,
      undone: [{
        undo: 'release', outcome: 'failed', failure: { reason: 'request', args: { detail: 'HTTP 500: helm is busy' } }
      }]
    });
    expect(lines(store).filter((line) => line.startsWith('DELETE'))).toStrictEqual([]);
  });

  it('keeps the record and the namespace for a later try when a removal fails', async() => {
    const store = installed(SSO_RECORD, [[`DELETE ${ NS }/secrets/libredb-studio-oidc`, httpError(500)]]);
    const result = await uninstallStudio(store, CLUSTER, SSO_RECORD, 'libredb-studio', options());

    expect(result.ok).toBe(false);
    expect(result.undone.slice(-2)).toStrictEqual([
      {
        undo: 'record', outcome: 'kept', failure: { reason: 'retryLater' }
      },
      {
        undo: 'namespace', outcome: 'kept', failure: { reason: 'retryLater' }
      },
    ]);
    expect(lines(store)).not.toContain(`DELETE ${ RECORD_PATH }`);
  });

  it('finishes the job when an earlier uninstall left only the record', async() => {
    const store = installed(RECORD, [[`GET ${ APP }`, httpError(404)], [/^DELETE .*navlinks/, httpError(404)]]);
    const result = await uninstallStudio(store, CLUSTER, RECORD, 'libredb-studio', options());

    expect(result.undone.slice(0, 2)).toStrictEqual([{ undo: 'release', outcome: 'gone' }, { undo: 'navLink', outcome: 'gone' }]);
    expect(result.ok).toBe(true);
  });
});
