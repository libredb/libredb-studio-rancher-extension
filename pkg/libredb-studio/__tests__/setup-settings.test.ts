import { fakeStore, httpError, reviewAnswer, Request } from './helpers/fake-store';
import {
  CLUSTER, RANCHER_CA, SSAR_DOWN, SSAR_LOCAL, readyCluster, reviewOf
} from './helpers/cluster';
import { FakeKube, KUBE_REQUESTS, Reaction, secretDataReads } from './helpers/kube';
import {
  disableSso, enableSso, loadSettings, recordProblem, rotateClientSecret, rotationFailure, saveKinds, saveNamespaces, uninstallStudio, AppInfo, ChangeOptions, ChangeStepId
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
const DEPLOYMENT = `${ K8S }/apis/apps/v1/namespaces/libredb-studio/deployments/libredb-studio`;
const UPGRADE = `${ K8S }/v1/catalog.cattle.io.clusterrepos/rancher-partner-charts?action=upgrade`;
const UNINSTALL = `${ K8S }/v1/catalog.cattle.io.apps/libredb-studio/libredb-studio?action=uninstall`;
const CLIENT = `${ LOCAL }/apis/management.cattle.io/v3/oidcclients/libredb-studio-c-m-1`;
const CLIENT_SECRET = `${ LOCAL }/api/v1/namespaces/cattle-oidc-client-secrets/secrets/client-abc`;
const NAVLINK = `${ K8S }/apis/ui.cattle.io/v1/navlinks/libredb-studio.libredb-studio`;
const SECRET_B64 = btoa('not-a-real-client-secret');
const NEW_SECRET_B64 = btoa('not-a-real-new-client-secret');
const REGENERATE = 'cattle.io/oidc-client-secret-regenerate';
const RESTARTED_AT = 'kubectl.kubernetes.io/restartedAt';
const CRDS = `${ K8S }/apis/apiextensions.k8s.io/v1/customresourcedefinitions`;
const CRD = {
  cnpg: 'clusters.postgresql.cnpg.io', edbpg: 'clusters.postgresql.k8s.enterprisedb.io', pgo: 'postgresclusters.postgres-operator.crunchydata.com', mongo: 'mongodbcommunity.mongodbcommunity.mongodb.com'
};
const MANAGED = { 'app.kubernetes.io/managed-by': 'libredb-studio-rancher-extension', 'app.kubernetes.io/part-of': 'libredb-studio' };

/**
 * What Rancher's OIDC client controller does for the regenerate annotation (v2.15.2,
 * pkg/controllers/management/oidcprovider): a new value under each named key of the client's
 * Secret, then the annotation removed from the client.
 */
const regenerates: Reaction = (client, kube) => {
  const annotations = client.metadata?.annotations || {};
  const source = kube.objects.get(CLIENT_SECRET);

  if (annotations[REGENERATE] && source) {
    kube.objects.set(CLIENT_SECRET, {
      ...source,
      metadata: { ...source.metadata, resourceVersion: `${ source.metadata?.resourceVersion }-regenerated` },
      data:     { 'client-secret-1': NEW_SECRET_B64 },
    });
    delete annotations[REGENERATE];
  }
};

/** The Deployment controller rolling out every replica of a new generation at once */
const rollsOut: Reaction = (deployment) => {
  Object.assign(deployment, {
    status: {
      observedGeneration: deployment.metadata?.generation, replicas: 1, updatedReplicas: 1, availableReplicas: 1, readyReplicas: 1
    }
  });
};

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
/** A record whose owner chose kinds in Settings, which every other change carries forward */
const KINDS_RECORD: SetupRecord = { ...RECORD, kinds: ['cnpg', 'mongo'] };
const APP_INFO: AppInfo = {
  chartVersion: '0.1.111', appVersion: '1.2.1', status: 'deployed', revision: 3, managed: true
};
const CONTEXT: RancherContext = {
  serverUrl: 'https://rancher.example.com', serverVersion: 'v2.15.2', scopes: ['openid', 'profile', 'groups'], cacerts: RANCHER_CA
};
const HOST = 'studio.example.com';
/** What the administrator saw and confirmed before single sign-on */
const CONFIRMED = {
  host: HOST, namespaces: ['team-a'], ownersTrusted: true
};

type Answers = [string | RegExp, unknown][];

/** Answers one after another, then the last one for good */
const sequence = (...answers: unknown[]) => {
  let next = 0;

  return () => answers[Math.min(next++, answers.length - 1)];
};

/** The app at a revision in a Helm state, with the extension's mark */
const managedApp = (version: number, status: string) => ({
  spec: {
    version,
    info:  { status },
    chart: {
      metadata: {
        version: '0.1.111', appVersion: '1.2.1', annotations: MANAGED
      }
    }
  }
});

const CHANGED = {
  ok: false, failure: { reason: 'changedSinceLoad' }, undone: []
};

const IN_PROJECT = {
  ok: false, failure: { reason: 'inProject', args: { namespace: 'libredb-studio' } }, undone: []
};

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
  /** The chart metadata of the release, the deployed chart with `annotations` by default */
  chart?: Record<string, unknown>;
  /** Store reads to answer differently from a ready cluster */
  find?: Record<string, unknown>;
  /** What Rancher does when the OIDC client changes, regenerating its secret for the annotation by default */
  clientUpdate?: Reaction;
}

/**
 * A cluster with Studio installed by the wizard: the wizard's objects live in a fake API server with
 * its labels, beside Studio's Deployment and, with single sign-on, Rancher's OIDC client and the
 * Secret it keeps the client secret in. Each upgrade makes a new revision in the Helm state given,
 * a restart rolls the Deployment out at once, and the uninstall makes the app and the chart's
 * NavLink go away.
 */
function installed({
  record = RECORD, override = [], upgradeStates = ['deployed'], annotations = MANAGED, ingressHost = HOST, chart, find = {}, clientUpdate = regenerates
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
          metadata: chart || {
            version: '0.1.111', appVersion: '1.2.1', annotations
          }
        }
      }
    };
  };
  const labelled = (name: string, more: Record<string, unknown> = {}) => ({ metadata: { name, labels: MANAGED }, ...more });

  holder.kube = new FakeKube({
    [NS]:          labelled('libredb-studio'),
    [RECORD_PATH]: {
      metadata: {
        name: 'libredb-studio-setup', labels: MANAGED, resourceVersion: '7'
      },
      data: { 'setup.json': serializeRecord(record) }
    },
    [INGRESS]:    { metadata: { name: 'libredb-studio' }, spec: { rules: [{ host: ingressHost }] } },
    [DEPLOYMENT]: {
      metadata: { name: 'libredb-studio', generation: 4 },
      spec:     { replicas: 1 },
      status:   {
        observedGeneration: 4, replicas: 1, updatedReplicas: 1, availableReplicas: 1, readyReplicas: 1
      },
    },
    ...(record.sso ? {
      [CA_PATH]:     labelled('libredb-studio-rancher-ca'),
      [SECRET_PATH]: {
        metadata: {
          name: 'libredb-studio-oidc', labels: MANAGED, resourceVersion: 's1'
        },
        type: 'Opaque',
        data: { 'oidc-client-id': btoa('client-abc'), 'oidc-client-secret': SECRET_B64 },
      },
      [CLIENT]: {
        metadata: {
          name: 'libredb-studio-c-m-1', labels: MANAGED, resourceVersion: 'c1'
        },
        spec:   { redirectURIs: ['https://studio.example.com/api/auth/oidc/callback'] },
        // Rancher lists each key its Secret holds for the client
        status: { clientID: 'client-abc', clientSecrets: { 'client-secret-1': { lastFiveCharacters: 'ecret' } } },
      },
      [CLIENT_SECRET]: { metadata: { name: 'client-abc', resourceVersion: 'k1' }, data: { 'client-secret-1': SECRET_B64 } },
    } : {}),
  }, {
    [CLIENT]: (created, kube) => {
      Object.assign(created, { status: { clientID: 'client-abc' } });
      kube.objects.set(CLIENT_SECRET, { metadata: { name: 'client-abc', resourceVersion: 'k1' }, data: { 'client-secret-1': SECRET_B64 } });
    },
  }, {
    [CLIENT]:     clientUpdate,
    [DEPLOYMENT]: rollsOut,
  });
  holder.store = fakeStore({
    ...setup,
    find: {
      ...setup.find, 'cluster/apps.deployment/libredb-studio/libredb-studio': { status: { readyReplicas: 1 } }, ...find
    },
    findLabelSelector: { 'cluster/ui.cattle.io.navlink': [{ metadata: { name: 'libredb-studio.libredb-studio' }, spec: { toURL: 'https://studio.example.com' } }] },
    requests:          [
      ...override,
      ...(setup.requests || []),
      [`GET ${ APP }`, app],
      [`POST ${ UPGRADE }`, { operationName: 'helm-operation-9', operationNamespace: 'cattle-system' }],
      [`POST ${ UNINSTALL }`, { operationName: 'helm-operation-10', operationNamespace: 'cattle-system' }],
      [`GET ${ NAVLINK }`, () => (count(`POST ${ UNINSTALL }`) ? httpError(404) : { metadata: { name: 'libredb-studio.libredb-studio', labels: { 'app.kubernetes.io/name': 'libredb-studio' } } })],
      [/^GET .*\/namespaces\/libredb-studio\/(apps|deployments|replicasets|statefulsets|daemonsets|jobs|cronjobs|pods|persistentvolumeclaims|services|clusters)$/, { items: [] }],
      [KUBE_REQUESTS, (request: Request) => holder.kube.handle(request)],
    ],
  });

  return holder;
}

const lines = (store: ReturnType<typeof fakeStore>) => store.calls.map((call: Request) => `${ call.method } ${ call.url }`);
const bodyOf = (store: ReturnType<typeof fakeStore>, line: string, nth = 0) => store.calls.filter((call: Request) => `${ call.method } ${ call.url }` === line)[nth]?.data as Record<string, unknown>;
const changes = (store: ReturnType<typeof fakeStore>) => lines(store).filter((line) => !line.startsWith('GET') && !line.endsWith('selfsubjectaccessreviews'));
/** How each step ended, in order */
const finished = (run: { events: unknown[] }) => run.events
  .map((event) => event as { step: string, state: string })
  .filter(({ state }) => state !== 'running')
  .map(({ step, state }) => `${ step } ${ state }`);
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const NOT_ADMIN: Answers = [[SSAR_LOCAL, reviewAnswer(false)]];

function options(): ChangeOptions & { events: unknown[], undone: unknown[] } {
  const events: unknown[] = [];
  const undone: unknown[] = [];

  return {
    ...fast(), events, undone, onStep: (event) => events.push(event), onUndo: (event) => undone.push(event)
  };
}

/** The chart 0.1.113 deployed, whose discovery takes every kind */
const CHART_113 = {
  version: '0.1.113', appVersion: '1.2.2', annotations: MANAGED
};

/** The CustomResourceDefinitions of these kinds put on the cluster */
const withCrds = (kube: FakeKube, kinds: (keyof typeof CRD)[]) => kinds.forEach((kind) => kube.objects.set(`${ CRDS }/${ CRD[kind] }`, { metadata: { name: CRD[kind] } }));

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
    expect(recordProblem({ ...RECORD, sso: { ...SSO, scope: 'openid profile groups offline_access' } }, CLUSTER)).toBe('scope');
    expect(recordProblem({ ...RECORD, sso: { ...SSO, scope: 'openid' } }, CLUSTER)).toBe('scope');
    // A client registered on a Rancher line before 2.15 keeps the scopes it was registered with
    expect(recordProblem({ ...RECORD, sso: { ...SSO, scope: 'openid profile' } }, CLUSTER)).toBeUndefined();
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
      ['other scopes', { ...SSO_RECORD, sso: { ...SSO, scope: 'openid profile groups offline_access' } }, 'scope'],
    ];

    it.each(forged)('naming %s steers no action', async(_, record, field) => {
      const { store } = installed({ record });
      const refused = {
        ok: false, failure: { reason: 'untrustedRecord', args: { field } }, undone: []
      };

      await expect(saveNamespaces(store, CLUSTER, record, APP_INFO, ['team-b'], options())).resolves.toStrictEqual(refused);
      await expect(saveKinds(store, CLUSTER, record, APP_INFO, ['cnpg'], options())).resolves.toStrictEqual(refused);
      await expect(enableSso(store, CLUSTER, record, APP_INFO, CONTEXT, CONFIRMED, options())).resolves.toStrictEqual(refused);
      await expect(rotateClientSecret(store, CLUSTER, record, APP_INFO, record.sso?.client as string, options())).resolves.toStrictEqual(refused);
      await expect(disableSso(store, CLUSTER, record, APP_INFO, { name: record.sso?.client as string, namespaces: ['team-a'] }, options())).resolves.toStrictEqual(refused);
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
      inProject:        false,
      sso:              { canUseSso: true, context: CONTEXT },
    });
    expect(settings.recordProblem).toBeUndefined();
    expect(settings.sso?.checks.map((check) => check.id)).toStrictEqual(['oidcProvider', 'oidcAdmin', 'oidcClient']);
  });

  it('tells for each discovery kind whether its CustomResourceDefinition is on the cluster and whether the chart takes it', async() => {
    const { store, kube } = installed();

    withCrds(kube, ['cnpg', 'mongo']);

    const unreadable = `GET ${ CRDS }/${ CRD.pgo }`;
    const settings = await loadSettings(installed({ override: [[unreadable, httpError(403)]] }).store, CLUSTER);

    expect(settings.kinds).toStrictEqual([
      {
        id: 'cnpg', crd: CRD.cnpg, installed: false, chartTakes: true
      },
      {
        id: 'edbpg', crd: CRD.edbpg, installed: false, chartTakes: false
      },
      {
        id: 'pgo', crd: CRD.pgo, installed: undefined, chartTakes: false
      },
      {
        id: 'mongo', crd: CRD.mongo, installed: false, chartTakes: false
      },
    ]);
    expect((await loadSettings(store, CLUSTER)).kinds?.map(({ id, installed }) => `${ id } ${ installed }`)).toStrictEqual(['cnpg true', 'edbpg false', 'pgo false', 'mongo true']);

    const newer = installed({ chart: CHART_113 });

    expect((await loadSettings(newer.store, CLUSTER)).kinds?.every(({ chartTakes }) => chartTakes)).toBe(true);
    // The chart the record names when the app does not say, as an upgrade from Settings would use
    expect((await loadSettings(installed({ chart: { annotations: MANAGED } }).store, CLUSTER)).kinds?.[3].chartTakes).toBe(false);
    expect((await loadSettings(installed({ record: { ...RECORD, cluster: 'c-m-2' } }).store, CLUSTER)).kinds).toBeUndefined();
  });

  it('says when Studio\'s namespace was moved into a project', async() => {
    const { store, kube } = installed();

    kube.objects.set(NS, {
      metadata: {
        name: 'libredb-studio', labels: MANAGED, annotations: { 'field.cattle.io/projectId': 'c-m-1:p-a' }
      }
    });

    expect((await loadSettings(store, CLUSTER)).inProject).toBe(true);
  });

  it('offers nothing about single sign-on once it is on', async() => {
    expect((await loadSettings(installed({ record: SSO_RECORD }).store, CLUSTER)).sso).toBeUndefined();
  });

  it('asks Rancher, once single sign-on is on, whether the user may rotate the client secret and delete the client', async() => {
    const { store } = installed({ record: SSO_RECORD });

    expect((await loadSettings(store, CLUSTER)).ssoAdmin).toBe(true);
    expect(store.calls.filter((call) => call.url.startsWith(LOCAL)).map(reviewOf)).toStrictEqual([
      {
        group: 'management.cattle.io', resource: 'oidcclients', verb: 'patch', name: 'libredb-studio-c-m-1'
      },
      {
        group: 'management.cattle.io', resource: 'oidcclients', verb: 'delete', name: 'libredb-studio-c-m-1'
      },
      {
        namespace: 'cattle-oidc-client-secrets', resource: 'secrets', verb: 'get'
      },
    ]);
    expect((await loadSettings(installed({ record: SSO_RECORD, override: [[SSAR_LOCAL, reviewAnswer(false)]] }).store, CLUSTER)).ssoAdmin).toBe(false);
    expect((await loadSettings(installed().store, CLUSTER)).ssoAdmin).toBeUndefined();
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

  it('tells an app upgraded in Apps, which drops the extension\'s mark from it', async() => {
    const { store } = installed({ annotations: { 'catalog.cattle.io/ui-source-repo-type': 'cluster', 'catalog.cattle.io/ui-source-repo': 'rancher-partner-charts' } });

    expect((await loadSettings(store, CLUSTER)).app?.managed).toBe(false);
  });

  it('says when the record is there but cannot be read', async() => {
    const settings = await loadSettings(installed({ override: [[`GET ${ RECORD_PATH }`, { data: { 'setup.json': '{' } }]] }).store, CLUSTER);

    expect(settings).toMatchObject({ record: undefined, recordUnreadable: true });
  });

  it('reads an app without chart metadata or a Helm state', async() => {
    const settings = await loadSettings(installed({ override: [[`GET ${ APP }`, { spec: {}, status: { summary: { state: 'deployed' } } }]] }).store, CLUSTER);

    expect(settings.app).toStrictEqual({
      chartVersion: undefined, appVersion: undefined, status: 'deployed', revision: 0, managed: false
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
      apiVersion: 'v1',
      kind:       'ConfigMap',
      metadata:   {
        name: 'libredb-studio-setup', labels: MANAGED, resourceVersion: '7'
      },
      data: { 'setup.json': serializeRecord(changed) }
    });
    expect(run.events.filter((event) => (event as { state: string }).state !== 'running')).toStrictEqual([
      { step: 'upgrade', state: 'done' }, { step: 'saveRecord', state: 'done' }
    ]);
  });

  it('puts the extension\'s mark back on an app upgraded in Apps', async() => {
    const { store } = installed({ annotations: { 'catalog.cattle.io/ui-source-repo-type': 'cluster', 'catalog.cattle.io/ui-source-repo': 'rancher-partner-charts' } });
    const result = await saveNamespaces(store, CLUSTER, RECORD, { ...APP_INFO, managed: false }, ['team-b'], options());

    expect(result.ok).toBe(true);
    expect(bodyOf(store, `POST ${ UPGRADE }`)).toMatchObject({ charts: [{ annotations: MANAGED }] });
  });

  it('keeps the host Studio serves, whatever the record says', async() => {
    const record = { ...RECORD, host: 'phish.example.net' };
    const { store } = installed({ record });
    const result = await saveNamespaces(store, CLUSTER, record, APP_INFO, ['team-b'], options());

    expect(result.record?.host).toBe(HOST);
    expect((bodyOf(store, `POST ${ UPGRADE }`) as { charts: { values: { ingress: { hosts: { host: string }[] } } }[] }).charts[0].values.ingress.hosts[0].host).toBe(HOST);
  });

  it('refuses while Studio\'s namespace is in a project, whose members could read what Studio keeps there', async() => {
    const { store, kube } = installed();

    kube.objects.set(NS, {
      metadata: {
        name: 'libredb-studio', labels: MANAGED, annotations: { 'field.cattle.io/projectId': 'c-m-1:p-a' }
      }
    });

    await expect(saveNamespaces(store, CLUSTER, RECORD, APP_INFO, ['team-b'], options())).resolves.toStrictEqual(IN_PROJECT);
    expect(changes(store)).toStrictEqual([]);
  });

  it('refuses without a host it can read from Studio\'s Ingress', async() => {
    const { store } = installed({ override: [[`GET ${ INGRESS }`, httpError(404)]] });

    await expect(saveNamespaces(store, CLUSTER, RECORD, APP_INFO, ['team-b'], options())).resolves.toStrictEqual({
      ok: false, failure: { reason: 'noHost' }, undone: []
    });
    expect(changes(store)).toStrictEqual([]);
  });

  it('points Studio at Rancher\'s own OIDC issuer, never at one the record names', async() => {
    const record = { ...SSO_RECORD, sso: { ...SSO, issuer: 'https://idp.example.net/oidc' } };
    const { store } = installed({ record });
    const result = await saveNamespaces(store, CLUSTER, record, APP_INFO, ['team-b'], options());
    const values = (bodyOf(store, `POST ${ UPGRADE }`) as { charts: { values: { config: Record<string, unknown> } }[] }).charts[0].values;

    expect(values.config.oidcIssuer).toBe('https://rancher.example.com/oidc');
    expect(result.record?.sso).toStrictEqual(SSO);
  });

  it('refuses to save single sign-on\'s values without Rancher\'s server URL', async() => {
    const { store } = installed({ record: SSO_RECORD, find: { 'management/management.cattle.io.setting/server-url': {} } });

    await expect(saveNamespaces(store, CLUSTER, SSO_RECORD, APP_INFO, ['team-b'], options())).resolves.toStrictEqual({
      ok: false, failure: { reason: 'ssoUnavailable' }, undone: []
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

  it('upgrades at the chart version deployed now, or the one the record names when the app does not say', async() => {
    const deployed = installed();

    await saveNamespaces(deployed.store, CLUSTER, RECORD, APP_INFO, ['team-b'], options());
    expect(bodyOf(deployed.store, `POST ${ UPGRADE }`)).toMatchObject({ charts: [{ version: '0.1.111' }] });

    const unsaid = installed({ chart: { annotations: MANAGED } });

    await saveNamespaces(unsaid.store, CLUSTER, RECORD, { revision: 3, managed: true }, ['team-b'], options());
    expect(bodyOf(unsaid.store, `POST ${ UPGRADE }`)).toMatchObject({ charts: [{ version: '0.1.110' }] });
  });

  it('acts on nothing older than the page showed: a record or an app that changed since is refused', async() => {
    // A tab loaded before an administrator turned single sign-on on
    const sso = installed({ record: SSO_RECORD });

    await expect(saveNamespaces(sso.store, CLUSTER, RECORD, APP_INFO, ['team-b'], options())).resolves.toStrictEqual(CHANGED);
    expect(changes(sso.store)).toStrictEqual([]);

    // An upgrade someone made after the page read revision 2
    const upgraded = installed();

    await expect(saveNamespaces(upgraded.store, CLUSTER, RECORD, { ...APP_INFO, revision: 2 }, ['team-b'], options())).resolves.toStrictEqual(CHANGED);
    expect(changes(upgraded.store)).toStrictEqual([]);

    const noRecord = installed({ override: [[`GET ${ RECORD_PATH }`, httpError(404)]] });

    await expect(saveNamespaces(noRecord.store, CLUSTER, RECORD, APP_INFO, ['team-b'], options())).resolves.toStrictEqual(CHANGED);

    const noApp = installed({ override: [[`GET ${ APP }`, httpError(404)]] });

    await expect(saveNamespaces(noApp.store, CLUSTER, RECORD, APP_INFO, ['team-b'], options())).resolves.toStrictEqual(CHANGED);
    expect(changes(noApp.store)).toStrictEqual([]);
  });

  it('waits for the revision its own upgrade makes, never one someone else made just before it', async() => {
    const { store } = installed({ override: [[`GET ${ APP }`, sequence(managedApp(3, 'deployed'), managedApp(4, 'deployed'), managedApp(4, 'deployed'), managedApp(5, 'failed'))]] });
    const result = await saveNamespaces(store, CLUSTER, RECORD, APP_INFO, ['team-b'], options());

    expect(result).toStrictEqual({
      ok: false, failedStep: 'upgrade', failure: { reason: 'helmFailed' }, undone: []
    });
    expect(lines(store)).not.toContain(`PUT ${ RECORD_PATH }`);
  });

  it('refuses the upgrade when the app is gone by the time it starts', async() => {
    const { store } = installed({ override: [[`GET ${ APP }`, sequence(managedApp(3, 'deployed'), httpError(404))]] });

    await expect(saveNamespaces(store, CLUSTER, RECORD, APP_INFO, ['team-b'], options())).resolves.toStrictEqual({
      ok: false, failedStep: 'upgrade', failure: { reason: 'changedSinceLoad' }, undone: []
    });
    expect(lines(store)).not.toContain(`POST ${ UPGRADE }`);
  });

  it('writes the record only over the version it read, so a record written meanwhile stands', async() => {
    const holder: { kube?: FakeKube } = {};
    const meanwhile = {
      metadata: {
        name: 'libredb-studio-setup', labels: MANAGED, resourceVersion: '8'
      },
      data: { 'setup.json': serializeRecord(SSO_RECORD) }
    };
    const target = installed({
      override: [[`POST ${ UPGRADE }`, () => {
        // Someone else writes the record while the upgrade runs
        holder.kube?.objects.set(RECORD_PATH, meanwhile);

        return { operationName: 'helm-operation-9', operationNamespace: 'cattle-system' };
      }]]
    });

    holder.kube = target.kube;

    const result = await saveNamespaces(target.store, CLUSTER, RECORD, APP_INFO, ['team-b'], options());

    expect(bodyOf(target.store, `PUT ${ RECORD_PATH }`)).toMatchObject({ metadata: { resourceVersion: '7' } });
    expect(result).toMatchObject({
      ok: false, failedStep: 'saveRecord', failure: { reason: 'request', args: { detail: 'HTTP 409: the object has been modified' } }
    });
    expect(target.kube.objects.get(RECORD_PATH)).toBe(meanwhile);
  });
});

describe('changing the discovered kinds', () => {
  it('upgrades Studio with the whole set of values and the kinds in the chart\'s order, then updates the record', async() => {
    const { store, kube } = installed({ chart: CHART_113 });

    withCrds(kube, ['cnpg', 'mongo']);

    const run = options();
    const result = await saveKinds(store, CLUSTER, RECORD, APP_INFO, ['mongo', 'cnpg', 'mongo'], run);

    expect(result).toStrictEqual({
      ok: true, undone: [], record: KINDS_RECORD
    });
    expect(bodyOf(store, `POST ${ UPGRADE }`)).toMatchObject({
      charts: [{
        version: '0.1.113', values: chartValues(KINDS_RECORD), resetValues: false
      }]
    });
    expect(kube.objects.get(RECORD_PATH)).toMatchObject({ metadata: { resourceVersion: '7' }, data: { 'setup.json': serializeRecord(KINDS_RECORD) } });
    expect(finished(run)).toStrictEqual(['upgrade done', 'saveRecord done']);
  });

  it('writes CloudNativePG alone on a chart before 0.1.113, whose schema allows nothing else', async() => {
    const { store, kube } = installed();

    withCrds(kube, ['cnpg']);

    const result = await saveKinds(store, CLUSTER, RECORD, APP_INFO, ['cnpg'], options());

    expect(result.record?.kinds).toStrictEqual(['cnpg']);
    expect(bodyOf(store, `POST ${ UPGRADE }`)).toMatchObject({ charts: [{ version: '0.1.111', values: { discovery: { kubernetes: { kinds: ['cnpg'] } } } }] });
  });

  it('refuses an empty choice and a kind Studio does not discover, before it asks anything', async() => {
    const { store } = installed({ chart: CHART_113 });

    await expect(saveKinds(store, CLUSTER, RECORD, APP_INFO, [], options())).resolves.toStrictEqual({
      ok: false, failure: { reason: 'noKinds' }, undone: []
    });
    await expect(saveKinds(store, CLUSTER, RECORD, APP_INFO, ['cnpg', 'mysql'], options())).resolves.toStrictEqual({
      ok: false, failure: { reason: 'unknownKind', args: { kind: 'mysql' } }, undone: []
    });
    expect(store.calls).toStrictEqual([]);
  });

  it('refuses anyone who does not own the cluster', async() => {
    const { store, kube } = installed({ chart: CHART_113, override: [[SSAR_DOWN, reviewAnswer(false)]] });

    withCrds(kube, ['cnpg', 'mongo']);
    await expect(saveKinds(store, CLUSTER, RECORD, APP_INFO, ['cnpg', 'mongo'], options())).resolves.toStrictEqual({
      ok: false, failure: { reason: 'notOwner' }, undone: []
    });
    expect(changes(store)).toStrictEqual([]);
  });

  it('refuses the record\'s namespaces when the user cannot see them now, since the upgrade deploys them again', async() => {
    const record = { ...RECORD, namespaces: ['libredb-studio', 'team-a'] };
    const { store, kube } = installed({ record, chart: CHART_113 });

    withCrds(kube, ['cnpg']);
    await expect(saveKinds(store, CLUSTER, record, APP_INFO, ['cnpg'], options())).resolves.toStrictEqual({
      ok: false, failure: { reason: 'badNamespaces' }, undone: []
    });
    expect(changes(store)).toStrictEqual([]);
  });

  it('refuses a kind whose CustomResourceDefinition is not on the cluster, which would withdraw every discovered database', async() => {
    const { store, kube } = installed({ chart: CHART_113 });

    withCrds(kube, ['cnpg']);
    await expect(saveKinds(store, CLUSTER, RECORD, APP_INFO, ['cnpg', 'pgo'], options())).resolves.toStrictEqual({
      ok: false, failure: { reason: 'crdMissing', args: { crd: CRD.pgo } }, undone: []
    });
    expect(changes(store)).toStrictEqual([]);
  });

  it('refuses a kind other than CloudNativePG on a chart before 0.1.113, the version an upgrade from Settings uses', async() => {
    const deployed = installed();

    withCrds(deployed.kube, ['cnpg', 'edbpg']);
    await expect(saveKinds(deployed.store, CLUSTER, RECORD, APP_INFO, ['cnpg', 'edbpg'], options())).resolves.toStrictEqual({
      ok: false, failure: { reason: 'kindsNeedChart', args: { chartVersion: '0.1.111', min: '0.1.113' } }, undone: []
    });
    expect(changes(deployed.store)).toStrictEqual([]);

    const unsaid = installed({ chart: { annotations: MANAGED } });

    withCrds(unsaid.kube, ['cnpg', 'edbpg']);
    await expect(saveKinds(unsaid.store, CLUSTER, RECORD, { revision: 3, managed: true }, ['edbpg'], options())).resolves.toMatchObject({ failure: { reason: 'kindsNeedChart', args: { chartVersion: '0.1.110' } } });
  });

  it('acts on nothing older than the page showed, nor while Studio\'s namespace is in a project, nor without a host', async() => {
    const upgraded = installed({ chart: CHART_113 });

    await expect(saveKinds(upgraded.store, CLUSTER, RECORD, { ...APP_INFO, revision: 2 }, ['cnpg'], options())).resolves.toStrictEqual(CHANGED);
    await expect(saveKinds(installed({ record: SSO_RECORD }).store, CLUSTER, RECORD, APP_INFO, ['cnpg'], options())).resolves.toStrictEqual(CHANGED);

    const moved = installed({ chart: CHART_113 });

    moved.kube.objects.set(NS, {
      metadata: {
        name: 'libredb-studio', labels: MANAGED, annotations: { 'field.cattle.io/projectId': 'c-m-1:p-a' }
      }
    });
    await expect(saveKinds(moved.store, CLUSTER, RECORD, APP_INFO, ['cnpg'], options())).resolves.toStrictEqual(IN_PROJECT);

    const hostless = installed({ chart: CHART_113, override: [[`GET ${ INGRESS }`, httpError(404)]] });

    withCrds(hostless.kube, ['cnpg']);
    await expect(saveKinds(hostless.store, CLUSTER, RECORD, APP_INFO, ['cnpg'], options())).resolves.toStrictEqual({
      ok: false, failure: { reason: 'noHost' }, undone: []
    });
    [upgraded, moved, hostless].forEach(({ store }) => expect(changes(store)).toStrictEqual([]));
  });

  it('points Studio at Rancher\'s own OIDC issuer, and keeps the record when the upgrade fails', async() => {
    const record = { ...SSO_RECORD, sso: { ...SSO, issuer: 'https://idp.example.net/oidc' } };
    const signedIn = installed({ record, chart: CHART_113 });

    withCrds(signedIn.kube, ['cnpg', 'mongo']);

    const result = await saveKinds(signedIn.store, CLUSTER, record, APP_INFO, ['cnpg', 'mongo'], options());

    expect(result.record?.sso).toStrictEqual(SSO);

    const failing = installed({ chart: CHART_113, upgradeStates: ['failed'] });

    withCrds(failing.kube, ['cnpg']);
    await expect(saveKinds(failing.store, CLUSTER, RECORD, APP_INFO, ['cnpg'], options())).resolves.toStrictEqual({
      ok: false, failedStep: 'upgrade', failure: { reason: 'helmFailed' }, undone: []
    });
    expect(lines(failing.store)).not.toContain(`PUT ${ RECORD_PATH }`);
  });

  it('says so when Studio took the change but the record was written meanwhile', async() => {
    const { store, kube } = installed({ chart: CHART_113, override: [[`PUT ${ RECORD_PATH }`, httpError(409, 'conflict')]] });

    withCrds(kube, ['cnpg']);
    await expect(saveKinds(store, CLUSTER, RECORD, APP_INFO, ['cnpg'], options())).resolves.toMatchObject({
      ok: false, failedStep: 'saveRecord', failure: { reason: 'request', args: { detail: 'HTTP 409: conflict' } }
    });
  });
});

describe('carrying the discovered kinds forward', () => {
  const kindsOf = (store: ReturnType<typeof fakeStore>) => (bodyOf(store, `POST ${ UPGRADE }`) as { charts: { values: { discovery: { kubernetes: { kinds?: string[] } } } }[] })
    .charts[0].values.discovery.kubernetes.kinds;

  it('keeps them when the namespaces change', async() => {
    const { store, kube } = installed({ record: KINDS_RECORD, chart: CHART_113 });

    withCrds(kube, ['cnpg', 'mongo']);

    const result = await saveNamespaces(store, CLUSTER, KINDS_RECORD, APP_INFO, ['team-b'], options());

    expect(result.record?.kinds).toStrictEqual(['cnpg', 'mongo']);
    expect(kindsOf(store)).toStrictEqual(['cnpg', 'mongo']);
  });

  it('keeps them when single sign-on is turned on or off', async() => {
    const on = installed({ record: KINDS_RECORD, chart: CHART_113 });

    withCrds(on.kube, ['cnpg', 'mongo']);

    const enabled = await enableSso(on.store, CLUSTER, KINDS_RECORD, APP_INFO, CONTEXT, CONFIRMED, options());

    expect(enabled.record?.kinds).toStrictEqual(['cnpg', 'mongo']);
    expect(kindsOf(on.store)).toStrictEqual(['cnpg', 'mongo']);

    const record = { ...KINDS_RECORD, sso: SSO };
    const off = installed({ record, chart: CHART_113 });

    withCrds(off.kube, ['cnpg', 'mongo']);

    const disabled = await disableSso(off.store, CLUSTER, record, APP_INFO, { name: SSO.client, namespaces: ['team-a'] }, options());

    expect(disabled.record).toStrictEqual(KINDS_RECORD);
    expect(kindsOf(off.store)).toStrictEqual(['cnpg', 'mongo']);
  });

  it('leaves them in the record when the client secret is rotated, which changes no value', async() => {
    const record = { ...KINDS_RECORD, sso: SSO };
    const { store, kube } = installed({ record, chart: CHART_113 });

    await expect(rotateClientSecret(store, CLUSTER, record, APP_INFO, SSO.client, options())).resolves.toStrictEqual({ ok: true, undone: [] });
    expect(kube.objects.get(RECORD_PATH)).toMatchObject({ data: { 'setup.json': serializeRecord(record) } });
  });

  // Checked before any step, so turning single sign-on on creates no OIDC client that an undo could not take back
  it('changes nothing on a chart before 0.1.113 with kinds it refuses, and says why instead of a failed render', async() => {
    const record = { ...KINDS_RECORD, sso: SSO };
    const refusal = {
      ok: false, failure: { reason: 'kindsNeedChart', args: { chartVersion: '0.1.111', min: '0.1.113' } }, undone: []
    };
    const stores = [installed({ record: KINDS_RECORD }), installed({ record: KINDS_RECORD }), installed({ record })];

    stores.forEach(({ kube }) => withCrds(kube, ['cnpg', 'mongo']));
    await expect(saveNamespaces(stores[0].store, CLUSTER, KINDS_RECORD, APP_INFO, ['team-b'], options())).resolves.toStrictEqual(refusal);
    await expect(enableSso(stores[1].store, CLUSTER, KINDS_RECORD, APP_INFO, CONTEXT, CONFIRMED, options())).resolves.toStrictEqual(refusal);
    await expect(disableSso(stores[2].store, CLUSTER, record, APP_INFO, { name: SSO.client, namespaces: ['team-a'] }, options())).resolves.toStrictEqual(refusal);
    stores.forEach(({ store }) => expect(changes(store)).toStrictEqual([]));
  });

  it('changes nothing while a kind\'s CustomResourceDefinition is gone from the cluster, which would withdraw every discovered database', async() => {
    const record = { ...KINDS_RECORD, sso: SSO };
    const refusal = {
      ok: false, failure: { reason: 'crdMissing', args: { crd: CRD.mongo } }, undone: []
    };
    const stores = [installed({ record: KINDS_RECORD, chart: CHART_113 }), installed({ record: KINDS_RECORD, chart: CHART_113 }), installed({ record, chart: CHART_113 })];

    stores.forEach(({ kube }) => withCrds(kube, ['cnpg']));
    await expect(saveNamespaces(stores[0].store, CLUSTER, KINDS_RECORD, APP_INFO, ['team-b'], options())).resolves.toStrictEqual(refusal);
    await expect(enableSso(stores[1].store, CLUSTER, KINDS_RECORD, APP_INFO, CONTEXT, CONFIRMED, options())).resolves.toStrictEqual(refusal);
    await expect(disableSso(stores[2].store, CLUSTER, record, APP_INFO, { name: SSO.client, namespaces: ['team-a'] }, options())).resolves.toStrictEqual(refusal);
    stores.forEach(({ store }) => expect(changes(store)).toStrictEqual([]));
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

    await expect(enableSso(store, CLUSTER, RECORD, APP_INFO, CONTEXT, {
      host: HOST, namespaces: ['someone-elses'], ownersTrusted: true
    }, options())).resolves.toStrictEqual({
      ok: false, failure: { reason: 'badNamespaces' }, undone: []
    });
    expect(changes(store)).toStrictEqual([]);
  });

  it('acts on nothing older than the page showed', async() => {
    // Another administrator turned single sign-on on after this page loaded
    const sso = installed({ record: SSO_RECORD });

    await expect(enableSso(sso.store, CLUSTER, RECORD, APP_INFO, CONTEXT, CONFIRMED, options())).resolves.toStrictEqual(CHANGED);
    expect(changes(sso.store)).toStrictEqual([]);

    const upgraded = installed();

    await expect(enableSso(upgraded.store, CLUSTER, RECORD, { ...APP_INFO, revision: 2 }, CONTEXT, CONFIRMED, options())).resolves.toStrictEqual(CHANGED);
    expect(changes(upgraded.store)).toStrictEqual([]);
  });

  it('writes no client secret into Studio\'s namespace once it is in a project', async() => {
    const { store, kube } = installed();

    kube.objects.set(NS, {
      metadata: {
        name: 'libredb-studio', labels: MANAGED, annotations: { 'field.cattle.io/projectId': 'c-m-1:p-a' }
      }
    });

    await expect(enableSso(store, CLUSTER, RECORD, APP_INFO, CONTEXT, CONFIRMED, options())).resolves.toStrictEqual(IN_PROJECT);
    expect(changes(store)).toStrictEqual([]);
    expect(kube.objects.has(SECRET_PATH)).toBe(false);
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

  it('creates no OIDC client without the administrator\'s acknowledgement of what this cluster\'s owners can then do', async() => {
    const { store } = installed();

    await expect(enableSso(store, CLUSTER, RECORD, APP_INFO, CONTEXT, { ...CONFIRMED, ownersTrusted: false }, options())).resolves.toStrictEqual({
      ok: false, failure: { reason: 'notAcknowledged' }, undone: []
    });
    expect(store.calls).toStrictEqual([]);
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

describe('rotating the client secret', () => {
  /** The OIDC client's name, typed by hand */
  const TYPED = 'libredb-studio-c-m-1';
  const inProject = (kube: FakeKube) => kube.objects.set(NS, {
    metadata: {
      name: 'libredb-studio', labels: MANAGED, annotations: { 'field.cattle.io/projectId': 'c-m-1:p-a' }
    }
  });
  /**
   * A sign-in to Studio: Rancher notes on the client when its secret was last used (v2.15.2,
   * pkg/oidc/provider/token.go), which gives the client a new version
   */
  const signIn = (kube: FakeKube) => {
    const client = kube.objects.get(CLIENT);

    kube.objects.set(CLIENT, {
      ...client,
      metadata: {
        ...client?.metadata, resourceVersion: `${ client?.metadata?.resourceVersion }-used`, annotations: { 'cattle.io.oidc-client-secret-used-client-secret-1': '1793180000' }
      },
    });
  };
  /** Studio with single sign-on, where a sign-in lands right before each of the client's first `count` patches, with `meanwhile` */
  const racing = (count: number, meanwhile: (kube: FakeKube) => void = () => undefined) => {
    let left = count;
    const holder: { kube?: FakeKube } = {};
    const setup = installed({
      record:   SSO_RECORD,
      override: [[`PATCH ${ CLIENT }`, (request: Request) => {
        const kube = holder.kube as FakeKube;

        if (left > 0) {
          left -= 1;
          signIn(kube);
          meanwhile(kube);
        }

        return kube.handle(request);
      }]],
    });

    holder.kube = setup.kube;

    return setup;
  };
  const patchedVersions = (store: ReturnType<typeof fakeStore>) => store.calls
    .filter((call) => `${ call.method } ${ call.url }` === `PATCH ${ CLIENT }`)
    .map((call) => (call.data as { metadata: { resourceVersion: string } }).metadata.resourceVersion);

  it('has Rancher regenerate the secret, writes the new one over Studio\'s Secret, and restarts Studio', async() => {
    const { store, kube } = installed({ record: SSO_RECORD });
    const run = options();
    const result = await rotateClientSecret(store, CLUSTER, SSO_RECORD, APP_INFO, ` ${ TYPED } `, run);

    expect(result).toStrictEqual({ ok: true, undone: [] });
    expect(finished(run)).toStrictEqual(['regenerate done', 'oidcSecret done', 'restart done']);
    expect(changes(store)).toStrictEqual([`PATCH ${ CLIENT }`, `PUT ${ SECRET_PATH }`, `PATCH ${ DEPLOYMENT }`]);
    // Rancher's annotation, on the version of the client that was checked
    expect(bodyOf(store, `PATCH ${ CLIENT }`)).toStrictEqual({ metadata: { resourceVersion: 'c1', annotations: { [REGENERATE]: 'client-secret-1' } } });
    expect(kube.objects.get(SECRET_PATH)).toStrictEqual({
      apiVersion: 'v1',
      kind:       'Secret',
      metadata:   {
        name: 'libredb-studio-oidc', labels: MANAGED, resourceVersion: 's1'
      },
      type: 'Opaque',
      data: { 'oidc-client-id': btoa('client-abc'), 'oidc-client-secret': NEW_SECRET_B64 },
    });
    // What kubectl rollout restart does: a new pod template, so every pod starts again with the new secret
    expect(bodyOf(store, `PATCH ${ DEPLOYMENT }`)).toStrictEqual({ spec: { template: { metadata: { annotations: { [RESTARTED_AT]: expect.stringMatching(ISO_TIME) } } } } });
    expect(store.calls.find((call) => call.method === 'PATCH')?.headers).toStrictEqual({ 'Content-Type': 'application/merge-patch+json' });
    expect(lines(store)).not.toContain(`PUT ${ RECORD_PATH }`);
    expect(JSON.stringify({ result, events: run.events })).not.toContain(NEW_SECRET_B64);
  });

  it('reads no Secret\'s data but the new client secret it copies', async() => {
    const { store } = installed({ record: SSO_RECORD });

    await rotateClientSecret(store, CLUSTER, SSO_RECORD, APP_INFO, TYPED, options());

    expect(lines(store)).toContain(`GET ${ SECRET_PATH }`);
    expect(secretDataReads(store.calls)).toStrictEqual([CLIENT_SECRET]);
  });

  it('writes Studio\'s Secret afresh when it is gone', async() => {
    const { store, kube } = installed({ record: SSO_RECORD });

    kube.objects.delete(SECRET_PATH);

    await expect(rotateClientSecret(store, CLUSTER, SSO_RECORD, APP_INFO, TYPED, options())).resolves.toStrictEqual({ ok: true, undone: [] });
    expect(bodyOf(store, `POST ${ NS }/secrets`)).toMatchObject({ metadata: { name: 'libredb-studio-oidc', labels: MANAGED } });
    expect(kube.objects.get(SECRET_PATH)).toMatchObject({ data: { 'oidc-client-secret': NEW_SECRET_B64 } });
  });

  it('asks for the OIDC client\'s name typed by hand, since it signs everyone out of Studio once', async() => {
    const { store } = installed({ record: SSO_RECORD });

    await expect(rotateClientSecret(store, CLUSTER, SSO_RECORD, APP_INFO, 'libredb-studio', options())).resolves.toStrictEqual({
      ok: false, failure: { reason: 'notConfirmedClient' }, undone: []
    });
    expect(store.calls).toStrictEqual([]);
  });

  it('refuses when single sign-on is not on', async() => {
    const { store } = installed();

    await expect(rotateClientSecret(store, CLUSTER, RECORD, APP_INFO, TYPED, options())).resolves.toStrictEqual({
      ok: false, failure: { reason: 'ssoNotOn' }, undone: []
    });
    expect(store.calls).toStrictEqual([]);
  });

  it('refuses anyone but a Rancher administrator', async() => {
    const { store } = installed({ record: SSO_RECORD, override: NOT_ADMIN });

    await expect(rotateClientSecret(store, CLUSTER, SSO_RECORD, APP_INFO, TYPED, options())).resolves.toStrictEqual({
      ok: false, failure: { reason: 'ssoNeedsAdmin' }, undone: []
    });
    expect(changes(store)).toStrictEqual([]);
  });

  it('acts on nothing older than the page showed', async() => {
    // Another administrator turned single sign-on off after this page loaded
    const off = installed();

    await expect(rotateClientSecret(off.store, CLUSTER, SSO_RECORD, APP_INFO, TYPED, options())).resolves.toStrictEqual(CHANGED);
    expect(changes(off.store)).toStrictEqual([]);

    const upgraded = installed({ record: SSO_RECORD });

    await expect(rotateClientSecret(upgraded.store, CLUSTER, SSO_RECORD, { ...APP_INFO, revision: 2 }, TYPED, options())).resolves.toStrictEqual(CHANGED);
    expect(changes(upgraded.store)).toStrictEqual([]);
  });

  it('writes no client secret into Studio\'s namespace once it is in a project', async() => {
    const { store, kube } = installed({ record: SSO_RECORD });

    inProject(kube);

    await expect(rotateClientSecret(store, CLUSTER, SSO_RECORD, APP_INFO, TYPED, options())).resolves.toStrictEqual(IN_PROJECT);
    expect(changes(store)).toStrictEqual([]);
  });

  it('changes no OIDC client without the extension\'s labels, and says when the client is gone', async() => {
    const unlabelled = installed({ record: SSO_RECORD });

    unlabelled.kube.objects.set(CLIENT, { metadata: { name: 'libredb-studio-c-m-1', resourceVersion: 'c2' }, status: { clientID: 'client-abc' } });

    await expect(rotateClientSecret(unlabelled.store, CLUSTER, SSO_RECORD, APP_INFO, TYPED, options())).resolves.toStrictEqual({
      ok: false, failure: { reason: 'clientNotManaged', args: { name: 'libredb-studio-c-m-1' } }, undone: []
    });
    expect(changes(unlabelled.store)).toStrictEqual([]);

    const gone = installed({ record: SSO_RECORD });

    gone.kube.objects.delete(CLIENT);

    await expect(rotateClientSecret(gone.store, CLUSTER, SSO_RECORD, APP_INFO, TYPED, options())).resolves.toStrictEqual({
      ok: false, failure: { reason: 'clientMissing', args: { name: 'libredb-studio-c-m-1' } }, undone: []
    });
    expect(changes(gone.store)).toStrictEqual([]);
  });

  it('writes into no Secret without the extension\'s labels, and has nothing regenerated for it', async() => {
    const { store, kube } = installed({ record: SSO_RECORD });

    kube.objects.set(SECRET_PATH, { metadata: { name: 'libredb-studio-oidc', resourceVersion: 's2' } });

    await expect(rotateClientSecret(store, CLUSTER, SSO_RECORD, APP_INFO, TYPED, options())).resolves.toStrictEqual({
      ok: false, failure: { reason: 'objectNotManaged', args: { namespace: 'libredb-studio', name: 'libredb-studio-oidc' } }, undone: []
    });
    expect(changes(store)).toStrictEqual([]);
  });

  it('refuses a client without an id, and stops before the annotation at one without a secret in Rancher', async() => {
    const noId = installed({ record: SSO_RECORD });

    noId.kube.objects.set(CLIENT, {
      metadata: {
        name: 'libredb-studio-c-m-1', labels: MANAGED, resourceVersion: 'c1'
      }
    });

    await expect(rotateClientSecret(noId.store, CLUSTER, SSO_RECORD, APP_INFO, TYPED, options())).resolves.toStrictEqual({
      ok: false, failure: { reason: 'noClientId' }, undone: []
    });
    expect(changes(noId.store)).toStrictEqual([]);

    const noSecret = installed({ record: SSO_RECORD });

    noSecret.kube.objects.delete(CLIENT_SECRET);

    await expect(rotateClientSecret(noSecret.store, CLUSTER, SSO_RECORD, APP_INFO, TYPED, options())).resolves.toStrictEqual({
      ok: false, failedStep: 'regenerate', failure: { reason: 'noClientSecret' }, undone: []
    });
    expect(changes(noSecret.store)).toStrictEqual([]);
  });

  it('refuses a client that no longer holds the secret Studio was given, which Rancher would not regenerate', async() => {
    // Rancher regenerates only the keys a client holds, and a client can be moved to client-secret-2 by hand
    const moved = installed({ record: SSO_RECORD });

    moved.kube.objects.set(CLIENT, { ...moved.kube.objects.get(CLIENT), status: { clientID: 'client-abc', clientSecrets: { 'client-secret-2': { lastFiveCharacters: 'ecret' } } } });

    await expect(rotateClientSecret(moved.store, CLUSTER, SSO_RECORD, APP_INFO, TYPED, options())).resolves.toStrictEqual({
      ok: false, failure: { reason: 'secretKeyMissing', args: { name: 'libredb-studio-c-m-1' } }, undone: []
    });
    expect(changes(moved.store)).toStrictEqual([]);

    // Rancher lists no secrets at all once the client holds none
    const none = installed({ record: SSO_RECORD });

    none.kube.objects.set(CLIENT, { ...none.kube.objects.get(CLIENT), status: { clientID: 'client-abc' } });

    await expect(rotateClientSecret(none.store, CLUSTER, SSO_RECORD, APP_INFO, TYPED, options())).resolves.toStrictEqual({
      ok: false, failure: { reason: 'secretKeyMissing', args: { name: 'libredb-studio-c-m-1' } }, undone: []
    });
    expect(changes(none.store)).toStrictEqual([]);
  });

  it('reads the client again right before the annotation, and tries again on the version a sign-in to Studio gave it meanwhile', async() => {
    const { store, kube } = racing(1);
    const run = options();

    await expect(rotateClientSecret(store, CLUSTER, SSO_RECORD, APP_INFO, TYPED, run)).resolves.toStrictEqual({ ok: true, undone: [] });
    expect(finished(run)).toStrictEqual(['regenerate done', 'oidcSecret done', 'restart done']);
    expect(patchedVersions(store)).toStrictEqual(['c1', 'c1-used']);
    expect(kube.objects.get(SECRET_PATH)).toMatchObject({ data: { 'oidc-client-secret': NEW_SECRET_B64 } });
  });

  it('gives up after three tries that sign-ins overtook, with Rancher\'s secret unchanged', async() => {
    const { store, kube } = racing(3);

    await expect(rotateClientSecret(store, CLUSTER, SSO_RECORD, APP_INFO, TYPED, options())).resolves.toStrictEqual({
      ok: false, failedStep: 'regenerate', failure: { reason: 'request', args: { detail: 'HTTP 409: the object has been modified' } }, undone: []
    });
    expect(patchedVersions(store)).toStrictEqual(['c1', 'c1-used', 'c1-used-used']);
    expect(changes(store)).toStrictEqual([`PATCH ${ CLIENT }`, `PATCH ${ CLIENT }`, `PATCH ${ CLIENT }`]);
    expect(kube.objects.get(CLIENT_SECRET)).toMatchObject({ data: { 'client-secret-1': SECRET_B64 } });
    expect(kube.objects.get(SECRET_PATH)).toMatchObject({ data: { 'oidc-client-secret': SECRET_B64 } });
  });

  it('checks the extension\'s labels on each read, so a client that lost them meanwhile gets no annotation', async() => {
    const { store, kube } = racing(1, (changed) => {
      const client = changed.objects.get(CLIENT);

      changed.objects.set(CLIENT, { ...client, metadata: { ...client?.metadata, labels: {} } });
    });

    await expect(rotateClientSecret(store, CLUSTER, SSO_RECORD, APP_INFO, TYPED, options())).resolves.toStrictEqual({
      ok: false, failedStep: 'regenerate', failure: { reason: 'clientNotManaged', args: { name: 'libredb-studio-c-m-1' } }, undone: []
    });
    // Only the try the sign-in overtook, which Rancher refused
    expect(changes(store)).toStrictEqual([`PATCH ${ CLIENT }`]);
    expect(kube.objects.get(CLIENT)?.metadata?.annotations).not.toHaveProperty([REGENERATE]);
  });

  it('tries no more when Rancher refuses the annotation, which leaves its secret as it was', async() => {
    const { store, kube } = installed({ record: SSO_RECORD, override: [[`PATCH ${ CLIENT }`, httpError(403, 'oidcclients is forbidden')]] });

    await expect(rotateClientSecret(store, CLUSTER, SSO_RECORD, APP_INFO, TYPED, options())).resolves.toStrictEqual({
      ok: false, failedStep: 'regenerate', failure: { reason: 'request', args: { detail: 'HTTP 403: oidcclients is forbidden' } }, undone: []
    });
    expect(changes(store)).toStrictEqual([`PATCH ${ CLIENT }`]);
    expect(kube.objects.get(CLIENT_SECRET)).toMatchObject({ data: { 'client-secret-1': SECRET_B64 } });
  });

  it('cannot tell whether Rancher took the annotation when the patch failed without Rancher refusing it', async() => {
    const { store } = installed({ record: SSO_RECORD, override: [[`PATCH ${ CLIENT }`, httpError(503, 'upstream timed out')]] });

    await expect(rotateClientSecret(store, CLUSTER, SSO_RECORD, APP_INFO, TYPED, options())).resolves.toStrictEqual({
      ok: false, failedStep: 'regenerate', failure: { reason: 'regenerateUnknown', args: { detail: 'HTTP 503: upstream timed out' } }, undone: []
    });
    expect(changes(store)).toStrictEqual([`PATCH ${ CLIENT }`]);
  });

  it('cannot tell whether Rancher regenerated the secret when the client cannot be read while it waits', async() => {
    let reads = 0;
    const holder: { kube?: FakeKube } = {};
    // The check before the steps and the read before the annotation answer; every read after it fails
    const { store, kube } = installed({
      record:   SSO_RECORD,
      override: [[`GET ${ CLIENT }`, (request: Request) => {
        reads += 1;

        return reads <= 2 ? (holder.kube as FakeKube).handle(request) : httpError(500, 'etcd unavailable');
      }]],
    });

    holder.kube = kube;

    await expect(rotateClientSecret(store, CLUSTER, SSO_RECORD, APP_INFO, TYPED, options())).resolves.toStrictEqual({
      ok: false, failedStep: 'regenerate', failure: { reason: 'regenerateUnknown', args: { detail: 'HTTP 500: etcd unavailable' } }, undone: []
    });
    // Rancher did regenerate it here, which is why this never says the secret is unchanged
    expect(kube.objects.get(CLIENT_SECRET)).toMatchObject({ data: { 'client-secret-1': NEW_SECRET_B64 } });
    expect(changes(store)).toStrictEqual([`PATCH ${ CLIENT }`]);
  });

  it('copies nothing when Rancher took the annotation away without a new secret', async() => {
    const { store } = installed({
      record:       SSO_RECORD,
      clientUpdate: (client) => {
        delete client.metadata?.annotations?.[REGENERATE];
      },
    });

    await expect(rotateClientSecret(store, CLUSTER, SSO_RECORD, APP_INFO, TYPED, options())).resolves.toStrictEqual({
      ok: false, failedStep: 'regenerate', failure: { reason: 'notRegenerated' }, undone: []
    });
    expect(changes(store)).toStrictEqual([`PATCH ${ CLIENT }`]);
  });

  it('gives up when Rancher does not regenerate the secret in time', async() => {
    const { store } = installed({ record: SSO_RECORD, clientUpdate: () => undefined });

    await expect(rotateClientSecret(store, CLUSTER, SSO_RECORD, APP_INFO, TYPED, options())).resolves.toStrictEqual({
      ok: false, failedStep: 'regenerate', failure: { reason: 'notRegenerated' }, undone: []
    });
    expect(changes(store)).toStrictEqual([`PATCH ${ CLIENT }`]);
  });

  it('says only the status when the new secret cannot be written, and restarts nothing', async() => {
    const { store } = installed({ record: SSO_RECORD, override: [[`PUT ${ SECRET_PATH }`, httpError(409, 'not-a-real-new-client-secret was refused')]] });

    await expect(rotateClientSecret(store, CLUSTER, SSO_RECORD, APP_INFO, TYPED, options())).resolves.toStrictEqual({
      ok: false, failedStep: 'oidcSecret', failure: { reason: 'request', args: { detail: 'HTTP 409' } }, undone: []
    });
    expect(lines(store)).not.toContain(`PATCH ${ DEPLOYMENT }`);
  });

  it('waits until every replica runs the new pod template', async() => {
    const rolling = (status: Record<string, number>) => ({
      metadata: { generation: 5 }, spec: { replicas: 1 }, status
    });
    const { store } = installed({
      record:   SSO_RECORD,
      override: [[`GET ${ DEPLOYMENT }`, sequence(
        { metadata: { generation: 5 }, spec: { replicas: 1 } },
        rolling({
          observedGeneration: 4, replicas: 1, updatedReplicas: 1, availableReplicas: 1
        }),
        rolling({
          observedGeneration: 5, replicas: 1, updatedReplicas: 0, availableReplicas: 1
        }),
        rolling({
          observedGeneration: 5, replicas: 2, updatedReplicas: 1, availableReplicas: 1
        }),
        rolling({
          observedGeneration: 5, replicas: 1, updatedReplicas: 1, availableReplicas: 0
        }),
        {
          metadata: { generation: 5 },
          status:   {
            observedGeneration: 5, replicas: 1, updatedReplicas: 1, availableReplicas: 1
          }
        },
      )]],
    });

    await expect(rotateClientSecret(store, CLUSTER, SSO_RECORD, APP_INFO, TYPED, options())).resolves.toStrictEqual({ ok: true, undone: [] });
    expect(lines(store).filter((line) => line === `GET ${ DEPLOYMENT }`)).toHaveLength(6);
  });

  it('says so when Studio does not finish restarting in time', async() => {
    const stuck = {
      metadata: { generation: 5 },
      spec:     { replicas: 1 },
      status:   {
        observedGeneration: 5, replicas: 2, updatedReplicas: 1, availableReplicas: 1
      },
    };
    const { store } = installed({ record: SSO_RECORD, override: [[`GET ${ DEPLOYMENT }`, stuck]] });

    await expect(rotateClientSecret(store, CLUSTER, SSO_RECORD, APP_INFO, TYPED, options())).resolves.toStrictEqual({
      ok: false, failedStep: 'restart', failure: { reason: 'notRestarted', args: { namespace: 'libredb-studio' } }, undone: []
    });
  });

  it('waits for nothing it cannot tell apart: a restart answered without a generation fails', async() => {
    const { store } = installed({ record: SSO_RECORD, override: [[`PATCH ${ DEPLOYMENT }`, {}]] });

    await expect(rotateClientSecret(store, CLUSTER, SSO_RECORD, APP_INFO, TYPED, options())).resolves.toStrictEqual({
      ok: false, failedStep: 'restart', failure: { reason: 'notRestarted', args: { namespace: 'libredb-studio' } }, undone: []
    });
    expect(lines(store)).not.toContain(`GET ${ DEPLOYMENT }`);
  });

  it('tells how far a rotation that failed in a step got', () => {
    const failedAt = (failedStep: ChangeStepId, reason: string) => rotationFailure({
      ok: false, failedStep, failure: { reason }, undone: []
    });

    // Before Rancher took the annotation, its secret is as it was
    expect(['request', 'clientMissing', 'clientNotManaged', 'noClientId', 'secretKeyMissing', 'noClientSecret'].map((reason) => failedAt('regenerate', reason)))
      .toStrictEqual(Array(6).fill('rotateUnchanged'));
    // Rancher may have a new secret that Studio does not
    expect([failedAt('regenerate', 'notRegenerated'), failedAt('regenerate', 'regenerateUnknown'), failedAt('oidcSecret', 'request')]).toStrictEqual(['rotate', 'rotate', 'rotate']);
    // Studio has the new secret, but has not restarted with it
    expect([failedAt('restart', 'notRestarted'), failedAt('restart', 'request')]).toStrictEqual(['rotateRestart', 'rotateRestart']);
  });
});

describe('turning single sign-on off', () => {
  /** What the administrator typed and saw: the OIDC client's name and the namespaces to discover */
  const TYPED = { name: 'libredb-studio-c-m-1', namespaces: ['team-a'] };
  const labelsOnly = (labels?: Record<string, string>) => ({ metadata: { name: 'libredb-studio-c-m-1', ...(labels ? { labels } : {}) } });

  it('upgrades Studio to its own sign-in, deletes the OIDC client, the credentials and Rancher\'s CA, then updates the record', async() => {
    const { store, kube } = installed({ record: SSO_RECORD });
    const run = options();
    const result = await disableSso(store, CLUSTER, SSO_RECORD, APP_INFO, { ...TYPED, name: ' libredb-studio-c-m-1 ' }, run);

    expect(result).toStrictEqual({
      ok: true, undone: [], record: RECORD
    });
    expect(finished(run)).toStrictEqual(['upgrade done', 'removeOidcClient done', 'removeOidcSecret done', 'removeRancherCA done', 'saveRecord done']);
    // Studio's own sign-in, without the access review, so discovered databases go to its admin only
    expect(bodyOf(store, `POST ${ UPGRADE }`)).toMatchObject({ charts: [{ values: chartValues(RECORD) }] });
    expect(Object.keys((bodyOf(store, `POST ${ UPGRADE }`) as { charts: { values: Record<string, unknown> }[] }).charts[0].values)).not.toContain('accessReview');
    // Studio stops using the client before it goes
    expect(changes(store)).toStrictEqual([`POST ${ UPGRADE }`, `DELETE ${ CLIENT }`, `DELETE ${ SECRET_PATH }`, `DELETE ${ CA_PATH }`, `PUT ${ RECORD_PATH }`]);
    expect(kube.objects.get(RECORD_PATH)).toMatchObject({ metadata: { resourceVersion: '7' }, data: { 'setup.json': serializeRecord(RECORD) } });
    expect(store.calls.filter((call) => call.url.endsWith('selfsubjectaccessreviews')).map(reviewOf)).toContainEqual({
      group: 'management.cattle.io', resource: 'oidcclients', verb: 'delete', name: 'libredb-studio-c-m-1'
    });
  });

  it('asks for the OIDC client\'s name typed by hand', async() => {
    const { store } = installed({ record: SSO_RECORD });

    await expect(disableSso(store, CLUSTER, SSO_RECORD, APP_INFO, { ...TYPED, name: 'libredb-studio' }, options())).resolves.toStrictEqual({
      ok: false, failure: { reason: 'notConfirmedClient' }, undone: []
    });
    expect(store.calls).toStrictEqual([]);
  });

  it('refuses when single sign-on is not on', async() => {
    const { store } = installed();

    await expect(disableSso(store, CLUSTER, RECORD, APP_INFO, TYPED, options())).resolves.toStrictEqual({
      ok: false, failure: { reason: 'ssoNotOn' }, undone: []
    });
    expect(store.calls).toStrictEqual([]);
  });

  it('refuses anyone but a Rancher administrator', async() => {
    const { store } = installed({ record: SSO_RECORD, override: NOT_ADMIN });

    await expect(disableSso(store, CLUSTER, SSO_RECORD, APP_INFO, TYPED, options())).resolves.toStrictEqual({
      ok: false, failure: { reason: 'ssoNeedsAdmin' }, undone: []
    });
    expect(changes(store)).toStrictEqual([]);
  });

  it('acts on nothing older than the page showed', async() => {
    const off = installed();

    await expect(disableSso(off.store, CLUSTER, SSO_RECORD, APP_INFO, TYPED, options())).resolves.toStrictEqual(CHANGED);
    expect(changes(off.store)).toStrictEqual([]);

    const upgraded = installed({ record: SSO_RECORD });

    await expect(disableSso(upgraded.store, CLUSTER, SSO_RECORD, { ...APP_INFO, revision: 2 }, TYPED, options())).resolves.toStrictEqual(CHANGED);
    expect(changes(upgraded.store)).toStrictEqual([]);
  });

  it('changes nothing while Studio\'s namespace is in a project', async() => {
    const { store, kube } = installed({ record: SSO_RECORD });

    kube.objects.set(NS, {
      metadata: {
        name: 'libredb-studio', labels: MANAGED, annotations: { 'field.cattle.io/projectId': 'c-m-1:p-a' }
      }
    });

    await expect(disableSso(store, CLUSTER, SSO_RECORD, APP_INFO, TYPED, options())).resolves.toStrictEqual(IN_PROJECT);
    expect(changes(store)).toStrictEqual([]);
  });

  it('refuses without a host it can read from Studio\'s Ingress, and keeps the one it serves whatever the record says', async() => {
    const noHost = installed({ record: SSO_RECORD, override: [[`GET ${ INGRESS }`, httpError(404)]] });

    await expect(disableSso(noHost.store, CLUSTER, SSO_RECORD, APP_INFO, TYPED, options())).resolves.toStrictEqual({
      ok: false, failure: { reason: 'noHost' }, undone: []
    });
    expect(changes(noHost.store)).toStrictEqual([]);

    const record = { ...SSO_RECORD, host: 'phish.example.net' };
    const moved = installed({ record });
    const result = await disableSso(moved.store, CLUSTER, record, APP_INFO, TYPED, options());

    expect(result.record?.host).toBe(HOST);
    expect((bodyOf(moved.store, `POST ${ UPGRADE }`) as { charts: { values: { ingress: { hosts: { host: string }[] } } }[] }).charts[0].values.ingress.hosts[0].host).toBe(HOST);
  });

  it('carries forward only the namespaces the administrator confirmed, revalidated', async() => {
    const record = { ...SSO_RECORD, namespaces: ['team-a', 'kube-system'] };
    const { store } = installed({ record });
    const result = await disableSso(store, CLUSTER, record, APP_INFO, TYPED, options());

    expect(result.record?.namespaces).toStrictEqual(['team-a']);
    expect(bodyOf(store, `POST ${ UPGRADE }`)).toMatchObject({ charts: [{ values: { discovery: { kubernetes: { namespaces: ['team-a'] } } } }] });

    const unseen = installed({ record: SSO_RECORD });

    await expect(disableSso(unseen.store, CLUSTER, SSO_RECORD, APP_INFO, { ...TYPED, namespaces: ['someone-elses'] }, options())).resolves.toStrictEqual({
      ok: false, failure: { reason: 'badNamespaces' }, undone: []
    });
    expect(changes(unseen.store)).toStrictEqual([]);
  });

  it.each([
    ['the OIDC client', CLIENT, { reason: 'clientNotManaged', args: { name: 'libredb-studio-c-m-1' } }],
    ['the client credentials', SECRET_PATH, { reason: 'objectNotManaged', args: { namespace: 'libredb-studio', name: 'libredb-studio-oidc' } }],
    ['Rancher\'s CA', CA_PATH, { reason: 'objectNotManaged', args: { namespace: 'libredb-studio', name: 'libredb-studio-rancher-ca' } }],
  ])('changes nothing when %s does not carry the extension\'s labels', async(_, path, failure) => {
    const { store, kube } = installed({ record: SSO_RECORD });

    kube.objects.set(path, labelsOnly({ 'app.kubernetes.io/managed-by': 'someone-else' }));

    await expect(disableSso(store, CLUSTER, SSO_RECORD, APP_INFO, TYPED, options())).resolves.toStrictEqual({
      ok: false, failure, undone: []
    });
    expect(changes(store)).toStrictEqual([]);
  });

  it('keeps an object whose labels went between the check and its deletion, and the record with it', async() => {
    const { store } = installed({ record: SSO_RECORD, override: [[`GET ${ CLIENT }`, sequence(labelsOnly(MANAGED), labelsOnly())]] });

    await expect(disableSso(store, CLUSTER, SSO_RECORD, APP_INFO, TYPED, options())).resolves.toStrictEqual({
      ok: false, failedStep: 'removeOidcClient', failure: { reason: 'notManaged' }, undone: []
    });
    expect(lines(store)).not.toContain(`DELETE ${ CLIENT }`);
    expect(lines(store)).not.toContain(`PUT ${ RECORD_PATH }`);
  });

  it('goes past what is already gone', async() => {
    const { store, kube } = installed({ record: SSO_RECORD });
    const run = options();

    kube.objects.delete(CLIENT);
    kube.objects.delete(CA_PATH);

    await expect(disableSso(store, CLUSTER, SSO_RECORD, APP_INFO, TYPED, run)).resolves.toStrictEqual({
      ok: true, undone: [], record: RECORD
    });
    expect(finished(run)).toStrictEqual(['upgrade done', 'removeOidcClient skipped', 'removeOidcSecret done', 'removeRancherCA skipped', 'saveRecord done']);
  });

  it('deletes nothing and keeps the record when the upgrade fails', async() => {
    const { store } = installed({ record: SSO_RECORD, upgradeStates: ['failed'] });

    await expect(disableSso(store, CLUSTER, SSO_RECORD, APP_INFO, TYPED, options())).resolves.toStrictEqual({
      ok: false, failedStep: 'upgrade', failure: { reason: 'helmFailed' }, undone: []
    });
    expect(changes(store)).toStrictEqual([`POST ${ UPGRADE }`]);
  });

  it('keeps the record when a deletion fails, so that turning it off again finishes the job', async() => {
    const { store } = installed({ record: SSO_RECORD, override: [[`DELETE ${ SECRET_PATH }`, httpError(500, 'not-a-real-client-secret')]] });

    await expect(disableSso(store, CLUSTER, SSO_RECORD, APP_INFO, TYPED, options())).resolves.toStrictEqual({
      ok: false, failedStep: 'removeOidcSecret', failure: { reason: 'request', args: { detail: 'HTTP 500' } }, undone: []
    });
    expect(changes(store)).toStrictEqual([`POST ${ UPGRADE }`, `DELETE ${ CLIENT }`, `DELETE ${ SECRET_PATH }`]);
  });

  it('says so when Studio took its own sign-in but the record could not be updated', async() => {
    const { store } = installed({ record: SSO_RECORD, override: [[`PUT ${ RECORD_PATH }`, httpError(409, 'conflict')]] });

    await expect(disableSso(store, CLUSTER, SSO_RECORD, APP_INFO, TYPED, options())).resolves.toMatchObject({
      ok: false, failedStep: 'saveRecord', failure: { reason: 'request', args: { detail: 'HTTP 409: conflict' } }
    });
  });

  it('reads no Secret\'s data, only the labels of what it deletes', async() => {
    const { store } = installed({ record: SSO_RECORD });

    await disableSso(store, CLUSTER, SSO_RECORD, APP_INFO, TYPED, options());

    expect(lines(store)).toContain(`GET ${ SECRET_PATH }`);
    expect(secretDataReads(store.calls)).toStrictEqual([]);
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

  it('acts on nothing older than the page showed', async() => {
    const { store } = installed({ record: SSO_RECORD });

    await expect(uninstallStudio(store, CLUSTER, RECORD, 'libredb-studio', options())).resolves.toStrictEqual(CHANGED);
    expect(changes(store)).toStrictEqual([]);
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

  it('reports no single sign-on object a Studio never had, and keeps a namespace it did not create', async() => {
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
    expect(lines(store).filter((line) => line.startsWith('DELETE') && line.includes(LOCAL))).toStrictEqual([]);
  });

  it('removes the single sign-on objects it finds, also when the record no longer names them', async() => {
    const { store, kube } = installed({ record: SSO_RECORD });

    // Someone who can edit ConfigMaps in Studio's namespace dropped single sign-on from the record
    kube.objects.set(RECORD_PATH, {
      metadata: {
        name: 'libredb-studio-setup', labels: MANAGED, resourceVersion: '8'
      },
      data: { 'setup.json': serializeRecord(RECORD) }
    });

    const result = await uninstallStudio(store, CLUSTER, RECORD, 'libredb-studio', options());

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
    expect([CLIENT, SECRET_PATH, CA_PATH].filter((path) => kube.objects.has(path))).toStrictEqual([]);
  });

  it('names the OIDC client as possibly left behind for a cluster owner, when the record does not name one', async() => {
    const { store } = installed({ override: [[SSAR_LOCAL, reviewAnswer(false)]] });
    const result = await uninstallStudio(store, CLUSTER, RECORD, 'libredb-studio', options());

    expect(result.ok).toBe(true);
    expect(result.undone).toContainEqual({
      undo: 'oidcClient', outcome: 'unchecked', failure: { reason: 'mayBeLeft', args: { name: 'libredb-studio-c-m-1' } }
    });
    expect(lines(store).filter((line) => line.includes(LOCAL) && !line.endsWith('selfsubjectaccessreviews'))).toStrictEqual([]);
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

  it('keeps the namespace while a CloudNativePG database lives there', async() => {
    const { store } = installed({ override: [[`GET ${ K8S }/apis/postgresql.cnpg.io/v1/namespaces/libredb-studio/clusters`, { items: [{ metadata: { name: 'db' } }] }]] });
    const result = await uninstallStudio(store, CLUSTER, RECORD, 'libredb-studio', options());

    expect(result.undone).toContainEqual({
      undo: 'namespace', outcome: 'kept', failure: { reason: 'notEmpty', args: { namespace: 'libredb-studio' } }
    });
    expect(lines(store)).not.toContain(`DELETE ${ NS }`);
  });

  it('keeps the namespace, naming it, while the TLS Secret the owner created is left there', async() => {
    const { store, kube } = installed();

    kube.objects.set(`${ NS }/secrets/libredb-studio-tls`, { metadata: { name: 'libredb-studio-tls' }, data: { 'tls.key': 'zzzzzzzzzzzzzzzz' } });
    const result = await uninstallStudio(store, CLUSTER, RECORD, 'libredb-studio', options());

    expect(result.undone).toContainEqual({
      undo: 'namespace', outcome: 'kept', failure: { reason: 'unmanagedLeft', args: { namespace: 'libredb-studio', objects: 'Secret libredb-studio-tls' } }
    });
    expect(lines(store)).not.toContain(`DELETE ${ NS }`);
    expect(secretDataReads(store.calls)).toStrictEqual([]);
  });

  it('removes the namespace past the TLS Secret cert-manager issued for a cert-manager install', async() => {
    const record: SetupRecord = { ...RECORD, tls: { source: 'cert-manager', clusterIssuer: 'letsencrypt' } };
    const { store, kube } = installed({ record });

    kube.objects.set(`${ NS }/secrets/libredb-studio-tls`, { metadata: { name: 'libredb-studio-tls', annotations: { 'cert-manager.io/issuer-name': 'letsencrypt', 'cert-manager.io/issuer-kind': 'ClusterIssuer' } } });
    const result = await uninstallStudio(store, CLUSTER, record, 'libredb-studio', options());

    expect(result.undone).toContainEqual({ undo: 'namespace', outcome: 'removed' });
    expect(lines(store)).toContain(`DELETE ${ NS }`);
  });

  it('finishes the job when an earlier uninstall left only the record', async() => {
    const { store } = installed({ override: [[`GET ${ APP }`, httpError(404)], [`GET ${ NAVLINK }`, httpError(404)]] });
    const result = await uninstallStudio(store, CLUSTER, RECORD, 'libredb-studio', options());

    expect(result.undone.slice(0, 2)).toStrictEqual([{ undo: 'release', outcome: 'gone' }, { undo: 'navLink', outcome: 'gone' }]);
    expect(result.ok).toBe(true);
  });
});
