import { fakeStore, httpError, reviewAnswer, Request } from './helpers/fake-store';
import {
  CLUSTER, RANCHER_CA, SSAR_DOWN, SSAR_LOCAL, readyCluster, reviewOf
} from './helpers/cluster';
import { FakeKube, KUBE_REQUESTS, secretDataReads } from './helpers/kube';
import {
  enableSso, loadSettings, recordProblem, saveNamespaces, uninstallStudio, AppInfo, ChangeOptions
} from '../services/setup/settings';
import { chartValues, serializeRecord, SetupRecord } from '../services/setup/values';
import type { RancherContext } from '../services/setup/preflight';

const K8S = `/k8s/clusters/${ CLUSTER }`;
const LOCAL = '/k8s/clusters/local';
const NS = `${ K8S }/api/v1/namespaces/libredb-studio`;
const RECORD_PATH = `${ NS }/configmaps/libredb-studio-setup`;
const CA_PATH = `${ NS }/configmaps/libredb-studio-rancher-ca`;
const SECRET_PATH = `${ NS }/secrets/libredb-studio-oidc`;
const INGRESS = `${ K8S }/apis/networking.k8s.io/v1/namespaces/libredb-studio/ingresses/libredb-studio`;
const APP = `${ K8S }/apis/catalog.cattle.io/v1/namespaces/libredb-studio/apps/libredb-studio`;
const UPGRADE = `${ K8S }/v1/catalog.cattle.io.clusterrepos/rancher-partner-charts?action=upgrade`;
const UNINSTALL = `${ K8S }/v1/catalog.cattle.io.apps/libredb-studio/libredb-studio?action=uninstall`;
const CLIENT = `${ LOCAL }/apis/management.cattle.io/v3/oidcclients/libredb-studio-c-m-1`;
const CLIENT_SECRET = `${ LOCAL }/api/v1/namespaces/cattle-oidc-client-secrets/secrets/client-abc`;
const NAVLINK = `${ K8S }/apis/ui.cattle.io/v1/navlinks/libredb-studio.libredb-studio`;
const SECRET_B64 = btoa('not-a-real-client-secret');
const MANAGED = { 'app.kubernetes.io/managed-by': 'libredb-studio-rancher-extension', 'app.kubernetes.io/part-of': 'libredb-studio' };

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
const HOST = 'studio.example.com';
/** What the administrator saw and confirmed before single sign-on */
const CONFIRMED = { host: HOST, namespaces: ['team-a'] };

type Answers = [string | RegExp, unknown][];

const fast = () => {
  let clock = 0;

  return { sleep: () => Promise.resolve(), now: () => (clock += 1000) };
};

interface Installed {
  record?: SetupRecord;
  override?: Answers;
  /** The Helm state of each upgrade in turn */
  upgradeStates?: string[];
  /** The chart annotations of the release, the extension's mark by default */
  annotations?: Record<string, string>;
  ingressHost?: string;
}

/**
 * A cluster with Studio installed by the wizard: the wizard's objects live in a fake API server with
 * its labels, each upgrade makes a new revision in the Helm state given, and the uninstall makes
 * the app and the chart's NavLink go away.
 */
function installed({
  record = RECORD, override = [], upgradeStates = ['deployed'], annotations = MANAGED, ingressHost = HOST
}: Installed = {}) {
  const setup = readyCluster();
  const holder = {} as { store: ReturnType<typeof fakeStore>, kube: FakeKube };
  const count = (line: string) => holder.store.calls.filter((call) => `${ call.method } ${ call.url }` === line).length;
  const app = () => {
    if (count(`POST ${ UNINSTALL }`)) {
      return httpError(404);
    }

    const upgrades = count(`POST ${ UPGRADE }`);
    const status = upgrades ? upgradeStates[Math.min(upgrades, upgradeStates.length) - 1] : 'deployed';

    return {
      spec: {
        version: 3 + upgrades,
        info:    { status },
        chart:   {
          metadata: {
            version: '0.1.111', appVersion: '1.2.1', annotations
          }
        }
      }
    };
  };
  const labelled = (name: string, more: Record<string, unknown> = {}) => ({ metadata: { name, labels: MANAGED }, ...more });

  holder.kube = new FakeKube({
    [NS]:          labelled('libredb-studio'),
    [RECORD_PATH]: labelled('libredb-studio-setup', { data: { 'setup.json': serializeRecord(record) } }),
    [INGRESS]:     { metadata: { name: 'libredb-studio' }, spec: { rules: [{ host: ingressHost }] } },
    ...(record.sso ? {
      [CA_PATH]: labelled('libredb-studio-rancher-ca'), [SECRET_PATH]: labelled('libredb-studio-oidc'), [CLIENT]: labelled('libredb-studio-c-m-1', { status: { clientID: 'client-abc' } })
    } : {}),
  }, {
    [CLIENT]: (created, kube) => {
      Object.assign(created, { status: { clientID: 'client-abc' } });
      kube.objects.set(CLIENT_SECRET, { metadata: { name: 'client-abc' }, data: { 'client-secret-1': SECRET_B64 } });
    },
  });
  holder.store = fakeStore({
    ...setup,
    find:              { ...setup.find, 'cluster/apps.deployment/libredb-studio/libredb-studio': { status: { readyReplicas: 1 } } },
    findLabelSelector: { 'cluster/ui.cattle.io.navlink': [{ metadata: { name: 'libredb-studio.libredb-studio' }, spec: { toURL: 'https://studio.example.com' } }] },
    requests:          [
      ...override,
      ...(setup.requests || []),
      [`GET ${ APP }`, app],
      [`POST ${ UPGRADE }`, { operationName: 'helm-operation-9', operationNamespace: 'cattle-system' }],
      [`POST ${ UNINSTALL }`, { operationName: 'helm-operation-10', operationNamespace: 'cattle-system' }],
      [`GET ${ NAVLINK }`, () => (count(`POST ${ UNINSTALL }`) ? httpError(404) : { metadata: { name: 'libredb-studio.libredb-studio', labels: { 'app.kubernetes.io/name': 'libredb-studio' } } })],
      [/^GET .*\/namespaces\/libredb-studio\/(apps|deployments|statefulsets|daemonsets|jobs|cronjobs)$/, { items: [] }],
      [KUBE_REQUESTS, (request: Request) => holder.kube.handle(request)],
    ],
  });

  return holder;
}

const lines = (store: ReturnType<typeof fakeStore>) => store.calls.map((call: Request) => `${ call.method } ${ call.url }`);
const bodyOf = (store: ReturnType<typeof fakeStore>, line: string, nth = 0) => store.calls.filter((call: Request) => `${ call.method } ${ call.url }` === line)[nth]?.data as Record<string, unknown>;
const changes = (store: ReturnType<typeof fakeStore>) => lines(store).filter((line) => !line.startsWith('GET') && !line.endsWith('selfsubjectaccessreviews'));

function options(): ChangeOptions & { events: unknown[], undone: unknown[] } {
  const events: unknown[] = [];
  const undone: unknown[] = [];

  return {
    ...fast(), events, undone, onStep: (event) => events.push(event), onUndo: (event) => undone.push(event)
  };
}

describe('the setup record', () => {
  it('is trusted only for this cluster, the extension\'s own release and the OIDC client it names', () => {
    expect(recordProblem(RECORD, CLUSTER)).toBeUndefined();
    expect(recordProblem(SSO_RECORD, CLUSTER)).toBeUndefined();
    expect(recordProblem({ ...RECORD, cluster: 'c-m-2' }, CLUSTER)).toBe('cluster');
    expect(recordProblem({ ...RECORD, release: { ...RECORD.release, namespace: 'kube-system' } }, CLUSTER)).toBe('release');
    expect(recordProblem({ ...RECORD, release: { ...RECORD.release, name: 'other' } }, CLUSTER)).toBe('release');
    expect(recordProblem({ ...RECORD, release: { ...RECORD.release, chart: 'other' } }, CLUSTER)).toBe('release');
    expect(recordProblem({ ...RECORD, sso: { ...SSO, client: 'rancher-ai' } }, CLUSTER)).toBe('client');
    expect(recordProblem({ ...RECORD, release: { ...RECORD.release, repo: 'someone-elses-charts' } }, CLUSTER)).toBe('repo');
  });

  describe('a record someone changed', () => {
    const forged: [string, SetupRecord, string][] = [
      ['another cluster', { ...SSO_RECORD, cluster: 'c-m-2' }, 'cluster'],
      ['another release', {
        ...SSO_RECORD,
        release: {
          ...RECORD.release, namespace: 'kube-system', name: 'rancher-webhook'
        }
      }, 'release'],
      ['another OIDC client', { ...SSO_RECORD, sso: { ...SSO, client: 'some-other-client' } }, 'client'],
      ['another chart repository', { ...SSO_RECORD, release: { ...RECORD.release, repo: 'someone-elses-charts' } }, 'repo'],
    ];

    it.each(forged)('naming %s steers no action', async(_, record, field) => {
      const { store } = installed({ record });
      const refused = {
        ok: false, failure: { reason: 'untrustedRecord', args: { field } }, undone: []
      };

      await expect(saveNamespaces(store, CLUSTER, record, APP_INFO, ['team-b'], options())).resolves.toStrictEqual(refused);
      await expect(enableSso(store, CLUSTER, record, APP_INFO, CONTEXT, CONFIRMED, options())).resolves.toStrictEqual(refused);
      await expect(uninstallStudio(store, CLUSTER, record, record.release.name, options())).resolves.toStrictEqual(refused);
      expect(store.calls).toStrictEqual([]);
    });

    it('is shown as such, with nothing offered on it', async() => {
      const { store } = installed({ record: { ...RECORD, cluster: 'c-m-2' } });
      const settings = await loadSettings(store, CLUSTER);

      expect(settings.recordProblem).toBe('cluster');
      expect(settings.sso).toBeUndefined();
    });
  });
});

describe('loading Studio\'s settings', () => {
  it('reads what the wizard set up, the app, the host it serves, the link, the state, and whether single sign-on can be turned on', async() => {
    const settings = await loadSettings(installed().store, CLUSTER);

    expect(settings).toMatchObject({
      canChange:        true,
      record:           RECORD,
      recordUnreadable: false,
      app:              APP_INFO,
      host:             HOST,
      link:             { name: 'libredb-studio.libredb-studio', namespace: 'libredb-studio' },
      status:           'ready',
      aggregation:      { id: 'aggregation', state: 'ok' },
      namespaces:       ['kube-system', 'team-a', 'team-b'],
      sso:              { canUseSso: true, context: CONTEXT },
    });
    expect(settings.recordProblem).toBeUndefined();
    expect(settings.sso?.checks.map((check) => check.id)).toStrictEqual(['oidcProvider', 'oidcAdmin', 'oidcClient']);
  });

  it('offers nothing about single sign-on once it is on', async() => {
    expect((await loadSettings(installed({ record: SSO_RECORD }).store, CLUSTER)).sso).toBeUndefined();
  });

  it('reads nothing more for someone who does not own the cluster', async() => {
    const { store } = installed({ override: [[SSAR_DOWN, reviewAnswer(false)]] });
    const settings = await loadSettings(store, CLUSTER);

    expect(settings).toStrictEqual({
      canChange: false, recordUnreadable: false, namespaces: []
    });
    expect(lines(store)).toStrictEqual([`POST ${ K8S }/apis/authorization.k8s.io/v1/selfsubjectaccessreviews`]);
  });

  it('tells a Studio set up another way from none at all', async() => {
    const other = await loadSettings(installed({ override: [[`GET ${ RECORD_PATH }`, httpError(404)]] }).store, CLUSTER);

    expect(other.record).toBeUndefined();
    expect(other.recordUnreadable).toBe(false);
    expect(other.app).toMatchObject({ chartVersion: '0.1.111' });

    const none = await loadSettings(installed({ override: [[`GET ${ RECORD_PATH }`, httpError(404)], [`GET ${ APP }`, httpError(404)]] }).store, CLUSTER);

    expect(none.app).toBeUndefined();
  });

  it('says when the record is there but cannot be read', async() => {
    const settings = await loadSettings(installed({ override: [[`GET ${ RECORD_PATH }`, { data: { 'setup.json': '{' } }]] }).store, CLUSTER);

    expect(settings).toMatchObject({ record: undefined, recordUnreadable: true });
  });

  it('reads an app without chart metadata or a Helm state', async() => {
    const settings = await loadSettings(installed({ override: [[`GET ${ APP }`, { spec: {}, status: { summary: { state: 'deployed' } } }]] }).store, CLUSTER);

    expect(settings.app).toStrictEqual({
      chartVersion: undefined, appVersion: undefined, status: 'deployed', revision: 0
    });
  });

  it.each([
    ['no Ingress', httpError(404)],
    ['an Ingress without rules', { spec: {} }],
    ['a wildcard host', { spec: { rules: [{ host: '*.example.com' }] } }],
    ['a host with a path', { spec: { rules: [{ host: 'studio.example.com/x' }] } }],
  ])('knows no host with %s', async(_, ingress) => {
    expect((await loadSettings(installed({ override: [[`GET ${ INGRESS }`, ingress]] }).store, CLUSTER)).host).toBeUndefined();
  });

  it('knows no host when the Ingress cannot be read', async() => {
    expect((await loadSettings(installed({ override: [[`GET ${ INGRESS }`, httpError(403)]] }).store, CLUSTER)).host).toBeUndefined();
  });
});

describe('changing the discovered namespaces', () => {
  it('upgrades Studio with the whole set of values and the new list, then updates the record', async() => {
    const { store, kube } = installed();
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
    expect(kube.objects.get(RECORD_PATH)).toStrictEqual({
      apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'libredb-studio-setup', labels: MANAGED }, data: { 'setup.json': serializeRecord(changed) }
    });
    expect(run.events.filter((event) => (event as { state: string }).state !== 'running')).toStrictEqual([
      { step: 'upgrade', state: 'done' }, { step: 'saveRecord', state: 'done' }
    ]);
  });

  it('keeps the host Studio serves, whatever the record says', async() => {
    const record = { ...RECORD, host: 'phish.example.net' };
    const { store } = installed({ record });
    const result = await saveNamespaces(store, CLUSTER, record, APP_INFO, ['team-b'], options());

    expect(result.record?.host).toBe(HOST);
    expect((bodyOf(store, `POST ${ UPGRADE }`) as { charts: { values: { ingress: { hosts: { host: string }[] } } }[] }).charts[0].values.ingress.hosts[0].host).toBe(HOST);
  });

  it('refuses without a host it can read from Studio\'s Ingress', async() => {
    const { store } = installed({ override: [[`GET ${ INGRESS }`, httpError(404)]] });

    await expect(saveNamespaces(store, CLUSTER, RECORD, APP_INFO, ['team-b'], options())).resolves.toStrictEqual({
      ok: false, failure: { reason: 'noHost' }, undone: []
    });
    expect(changes(store)).toStrictEqual([]);
  });

  it('refuses a namespace the user cannot see now', async() => {
    const { store } = installed();

    await expect(saveNamespaces(store, CLUSTER, RECORD, APP_INFO, ['team-a', 'someone-elses'], options())).resolves.toStrictEqual({
      ok: false, failure: { reason: 'badNamespaces' }, undone: []
    });
    expect(changes(store)).toStrictEqual([]);
  });

  it('keeps the record as it was when the upgrade fails', async() => {
    const { store } = installed({ upgradeStates: ['failed'] });
    const result = await saveNamespaces(store, CLUSTER, RECORD, APP_INFO, ['team-b'], options());

    expect(result).toStrictEqual({
      ok: false, failedStep: 'upgrade', failure: { reason: 'helmFailed' }, undone: []
    });
    expect(lines(store)).not.toContain(`PUT ${ RECORD_PATH }`);
  });

  it('says so when Studio took the change but the record could not be updated', async() => {
    const result = await saveNamespaces(installed({ override: [[`PUT ${ RECORD_PATH }`, httpError(409, 'conflict')]] }).store, CLUSTER, RECORD, APP_INFO, ['team-b'], options());

    expect(result).toMatchObject({
      ok: false, failedStep: 'saveRecord', failure: { reason: 'request', args: { detail: 'HTTP 409: conflict' } }
    });
  });

  it('upgrades at the version the record names when the app does not say', async() => {
    const { store } = installed();

    await saveNamespaces(store, CLUSTER, RECORD, { revision: 3 }, ['team-b'], options());

    expect(bodyOf(store, `POST ${ UPGRADE }`)).toMatchObject({ charts: [{ version: '0.1.110' }] });
  });
});

describe('turning single sign-on on', () => {
  it('registers Studio with Rancher, copies the credentials and the CA, upgrades Studio, then updates the record', async() => {
    const { store, kube } = installed();
    const run = options();
    const result = await enableSso(store, CLUSTER, RECORD, APP_INFO, CONTEXT, CONFIRMED, run);

    expect(result).toStrictEqual({
      ok: true, undone: [], record: SSO_RECORD
    });
    expect(run.events.filter((event) => (event as { state: string }).state !== 'running').map((event) => (event as { step: string }).step))
      .toStrictEqual(['oidcClient', 'oidcSecret', 'rancherCA', 'upgrade', 'saveRecord']);
    expect(bodyOf(store, `POST ${ LOCAL }/apis/management.cattle.io/v3/oidcclients`)).toMatchObject({ metadata: { name: 'libredb-studio-c-m-1', labels: MANAGED }, spec: { redirectURIs: ['https://studio.example.com/api/auth/oidc/callback'], scopes: ['openid', 'profile', 'groups'] } });
    expect(kube.objects.get(SECRET_PATH)).toMatchObject({ data: { 'oidc-client-secret': SECRET_B64 } });
    expect(kube.objects.get(CA_PATH)).toMatchObject({ data: { 'ca.crt': RANCHER_CA } });
    expect(bodyOf(store, `POST ${ UPGRADE }`)).toMatchObject({ charts: [{ values: chartValues(SSO_RECORD) }] });
    expect(JSON.stringify({ result, events: run.events })).not.toContain(SECRET_B64);
  });

  it('sends Rancher\'s users back to the host Studio serves, never to the one the record names', async() => {
    const record = { ...RECORD, host: 'phish.example.net' };
    const { store } = installed({ record });
    const result = await enableSso(store, CLUSTER, record, APP_INFO, CONTEXT, CONFIRMED, options());

    expect(result.ok).toBe(true);
    expect(bodyOf(store, `POST ${ LOCAL }/apis/management.cattle.io/v3/oidcclients`)).toMatchObject({ spec: { redirectURIs: ['https://studio.example.com/api/auth/oidc/callback'] } });
    expect(result.record?.host).toBe(HOST);
  });

  it('carries forward only the namespaces the administrator confirmed, not the ones the record names', async() => {
    const record = { ...RECORD, namespaces: ['team-a', 'kube-system'] };
    const { store } = installed({ record });
    const result = await enableSso(store, CLUSTER, record, APP_INFO, CONTEXT, CONFIRMED, options());

    expect(result.record?.namespaces).toStrictEqual(['team-a']);
    expect(bodyOf(store, `POST ${ UPGRADE }`)).toMatchObject({ charts: [{ values: { discovery: { kubernetes: { namespaces: ['team-a'] } } } }] });
  });

  it('refuses confirmed namespaces the administrator cannot see now', async() => {
    const { store } = installed();

    await expect(enableSso(store, CLUSTER, RECORD, APP_INFO, CONTEXT, { host: HOST, namespaces: ['someone-elses'] }, options())).resolves.toStrictEqual({
      ok: false, failure: { reason: 'badNamespaces' }, undone: []
    });
    expect(changes(store)).toStrictEqual([]);
  });

  it('acts only on the redirect the administrator confirmed', async() => {
    const { store } = installed({ ingressHost: 'moved.example.com' });

    await expect(enableSso(store, CLUSTER, RECORD, APP_INFO, CONTEXT, CONFIRMED, options())).resolves.toStrictEqual({
      ok: false, failure: { reason: 'hostChanged', args: { host: 'moved.example.com' } }, undone: []
    });
    expect(changes(store)).toStrictEqual([]);
  });

  it('refuses without a host it can read from Studio\'s Ingress', async() => {
    const { store } = installed({ override: [[`GET ${ INGRESS }`, { spec: { rules: [{ host: 'evil@example.com' }] } }]] });

    await expect(enableSso(store, CLUSTER, RECORD, APP_INFO, CONTEXT, CONFIRMED, options())).resolves.toStrictEqual({
      ok: false, failure: { reason: 'noHost' }, undone: []
    });
    expect(changes(store)).toStrictEqual([]);
  });

  it('copies no CA when Rancher has none of its own', async() => {
    const { store } = installed();
    const result = await enableSso(store, CLUSTER, RECORD, APP_INFO, { ...CONTEXT, cacerts: undefined }, CONFIRMED, options());

    expect(result.record?.sso?.rancherCA).toBe(false);
    expect(lines(store)).not.toContain(`POST ${ NS }/configmaps`);
  });

  it('refuses without Rancher\'s server URL', async() => {
    const { store } = installed();

    await expect(enableSso(store, CLUSTER, RECORD, APP_INFO, { ...CONTEXT, serverUrl: undefined }, CONFIRMED, options())).resolves.toStrictEqual({
      ok: false, failure: { reason: 'ssoUnavailable' }, undone: []
    });
    expect(store.calls).toStrictEqual([]);
  });

  it('puts the previous values back and removes what it created when the upgrade fails', async() => {
    const { store } = installed({ upgradeStates: ['failed', 'deployed'] });
    const run = options();
    const result = await enableSso(store, CLUSTER, RECORD, APP_INFO, CONTEXT, CONFIRMED, run);

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
    const result = await enableSso(installed({ upgradeStates: ['failed', 'failed'] }).store, CLUSTER, RECORD, APP_INFO, CONTEXT, CONFIRMED, options());

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

  it('reads no Secret\'s data but the client secret it copies, also when it takes everything back', async() => {
    const { store } = installed({ upgradeStates: ['failed', 'deployed'] });

    await enableSso(store, CLUSTER, RECORD, APP_INFO, CONTEXT, CONFIRMED, options());

    expect(lines(store)).toContain(`DELETE ${ SECRET_PATH }`);
    expect(secretDataReads(store.calls)).toStrictEqual([CLIENT_SECRET]);
  });

  it('removes the OIDC client when the credentials cannot be copied, and upgrades nothing', async() => {
    const { store } = installed({ override: [[`POST ${ NS }/secrets`, httpError(403)]] });
    const result = await enableSso(store, CLUSTER, RECORD, APP_INFO, CONTEXT, CONFIRMED, options());

    expect(result).toMatchObject({
      ok: false, failedStep: 'oidcSecret', undone: [{ undo: 'oidcClient', outcome: 'removed' }]
    });
    expect(lines(store)).not.toContain(`POST ${ UPGRADE }`);
  });

  it('removes nothing when Studio is upgraded but the record cannot be updated', async() => {
    const result = await enableSso(installed({ override: [[`PUT ${ RECORD_PATH }`, httpError(500)]] }).store, CLUSTER, RECORD, APP_INFO, CONTEXT, CONFIRMED, options());

    expect(result).toMatchObject({
      ok: false, failedStep: 'saveRecord', undone: []
    });
  });
});

describe('uninstalling Studio', () => {
  it('refuses unless the release name was typed by hand', async() => {
    const { store } = installed();

    await expect(uninstallStudio(store, CLUSTER, RECORD, 'libredb', options())).resolves.toStrictEqual({
      ok: false, failure: { reason: 'notConfirmed' }, undone: []
    });
    expect(store.calls).toStrictEqual([]);
  });

  it('removes everything the wizard created, the OIDC client too, for a Rancher administrator', async() => {
    const { store } = installed({ record: SSO_RECORD });
    const run = options();
    const result = await uninstallStudio(store, CLUSTER, SSO_RECORD, ' libredb-studio ', run);

    expect(result).toStrictEqual({
      ok:     true,
      undone: [
        { undo: 'release', outcome: 'removed' },
        { undo: 'navLink', outcome: 'gone' },
        { undo: 'rancherCA', outcome: 'removed' },
        { undo: 'oidcSecret', outcome: 'removed' },
        { undo: 'oidcClient', outcome: 'removed' },
        { undo: 'record', outcome: 'removed' },
        { undo: 'namespace', outcome: 'removed' },
      ],
    });
    expect(run.undone).toStrictEqual(result.undone);
    expect(lines(store).filter((line) => line.startsWith('DELETE'))).toStrictEqual([
      `DELETE ${ CA_PATH }`,
      `DELETE ${ SECRET_PATH }`,
      `DELETE ${ CLIENT }`,
      `DELETE ${ RECORD_PATH }`,
      `DELETE ${ NS }`,
    ]);
    expect(store.calls.filter((call) => call.url.endsWith('selfsubjectaccessreviews')).map(reviewOf)).toContainEqual({
      group: 'management.cattle.io', resource: 'oidcclients', verb: 'delete', name: 'libredb-studio-c-m-1'
    });
  });

  it('leaves the OIDC client to an administrator, and names it, for a cluster owner', async() => {
    const { store } = installed({ record: SSO_RECORD, override: [[SSAR_LOCAL, reviewAnswer(false)]] });
    const result = await uninstallStudio(store, CLUSTER, SSO_RECORD, 'libredb-studio', options());

    expect(result.ok).toBe(true);
    expect(result.undone).toContainEqual({
      undo: 'oidcClient', outcome: 'kept', failure: { reason: 'notAllowed', args: { name: 'libredb-studio-c-m-1' } }
    });
    expect(lines(store)).not.toContain(`DELETE ${ CLIENT }`);
    expect(result.undone).toContainEqual({ undo: 'record', outcome: 'removed' });
  });

  it('deletes no object that does not carry the extension\'s labels', async() => {
    const { store, kube } = installed({ record: SSO_RECORD });

    kube.objects.set(CLIENT, { metadata: { name: 'libredb-studio-c-m-1', labels: {} } });
    kube.objects.set(SECRET_PATH, { metadata: { name: 'libredb-studio-oidc' } });

    const result = await uninstallStudio(store, CLUSTER, SSO_RECORD, 'libredb-studio', options());

    expect(result.undone).toContainEqual({
      undo: 'oidcClient', outcome: 'kept', failure: { reason: 'notManaged' }
    });
    expect(result.undone).toContainEqual({
      undo: 'oidcSecret', outcome: 'kept', failure: { reason: 'notManaged' }
    });
    expect(lines(store)).not.toContain(`DELETE ${ CLIENT }`);
    expect(lines(store)).not.toContain(`DELETE ${ SECRET_PATH }`);
  });

  it('leaves a NavLink Helm left behind, which is the chart\'s and not the extension\'s', async() => {
    const { store } = installed({ override: [[`GET ${ NAVLINK }`, { metadata: { name: 'libredb-studio.libredb-studio', labels: { 'app.kubernetes.io/name': 'libredb-studio' } } }]] });
    const result = await uninstallStudio(store, CLUSTER, RECORD, 'libredb-studio', options());

    expect(result.undone[1]).toStrictEqual({
      undo: 'navLink', outcome: 'kept', failure: { reason: 'notManaged' }
    });
    expect(lines(store)).not.toContain(`DELETE ${ NAVLINK }`);
  });

  it('touches no OIDC object of a Studio that never had single sign-on, and keeps a namespace it did not create', async() => {
    const record = { ...RECORD, createdNamespace: false };
    const { store } = installed({ record });
    const result = await uninstallStudio(store, CLUSTER, record, 'libredb-studio', options());

    expect(result.undone).toStrictEqual([
      { undo: 'release', outcome: 'removed' },
      { undo: 'navLink', outcome: 'gone' },
      { undo: 'record', outcome: 'removed' },
      {
        undo: 'namespace', outcome: 'kept', failure: { reason: 'notOurs', args: { namespace: 'libredb-studio' } }
      },
    ]);
    expect(lines(store).filter((line) => line.includes(LOCAL))).toStrictEqual([]);
  });

  it('reads no Secret\'s data, only the labels of what it deletes', async() => {
    const { store } = installed({ record: SSO_RECORD });

    await uninstallStudio(store, CLUSTER, SSO_RECORD, 'libredb-studio', options());

    expect(lines(store)).toContain(`GET ${ SECRET_PATH }`);
    expect(lines(store)).toContain(`DELETE ${ SECRET_PATH }`);
    expect(secretDataReads(store.calls)).toStrictEqual([]);
  });

  it('removes nothing else when the app cannot be uninstalled', async() => {
    const { store } = installed({ record: SSO_RECORD, override: [[`POST ${ UNINSTALL }`, httpError(500, 'helm is busy')]] });
    const result = await uninstallStudio(store, CLUSTER, SSO_RECORD, 'libredb-studio', options());

    expect(result).toStrictEqual({
      ok:     false,
      undone: [{
        undo: 'release', outcome: 'failed', failure: { reason: 'request', args: { detail: 'HTTP 500: helm is busy' } }
      }]
    });
    expect(lines(store).filter((line) => line.startsWith('DELETE'))).toStrictEqual([]);
  });

  it('removes nothing when the app does not carry the extension\'s mark', async() => {
    const { store } = installed({ record: SSO_RECORD, annotations: { 'catalog.cattle.io/ui-source-repo': 'rancher-partner-charts' } });
    const result = await uninstallStudio(store, CLUSTER, SSO_RECORD, 'libredb-studio', options());

    expect(result).toStrictEqual({
      ok:     false,
      undone: [{
        undo: 'release', outcome: 'kept', failure: { reason: 'notManaged' }
      }]
    });
    expect(lines(store)).not.toContain(`POST ${ UNINSTALL }`);
    expect(lines(store).filter((line) => line.startsWith('DELETE'))).toStrictEqual([]);
  });

  it('keeps the record and the namespace for a later try when a removal fails', async() => {
    const { store } = installed({ record: SSO_RECORD, override: [[`DELETE ${ SECRET_PATH }`, httpError(500)]] });
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
    const { store } = installed({ override: [[`GET ${ APP }`, httpError(404)], [`GET ${ NAVLINK }`, httpError(404)]] });
    const result = await uninstallStudio(store, CLUSTER, RECORD, 'libredb-studio', options());

    expect(result.undone.slice(0, 2)).toStrictEqual([{ undo: 'release', outcome: 'gone' }, { undo: 'navLink', outcome: 'gone' }]);
    expect(result.ok).toBe(true);
  });
});
