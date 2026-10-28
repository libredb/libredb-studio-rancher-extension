import { fakeStore, httpError, FakeStoreSetup, Request } from './helpers/fake-store';
import { FakeKube, KUBE_REQUESTS } from './helpers/kube';
import { CLUSTER, RANCHER_CA } from './helpers/cluster';
import {
  installStudio, plannedSteps, SetupPlan, StepEvent, UndoEvent
} from '../services/setup/install';
import { upgradeRelease } from '../services/setup/release';
import { chartValues, serializeRecord, SetupRecord } from '../services/setup/values';
import { waitFor } from '../services/setup/wait';

const K8S = `/k8s/clusters/${ CLUSTER }`;
const LOCAL = '/k8s/clusters/local';
const NS = `${ K8S }/api/v1/namespaces/libredb-studio`;
const APP = `${ K8S }/apis/catalog.cattle.io/v1/namespaces/libredb-studio/apps/libredb-studio`;
const OPERATION = `${ K8S }/apis/catalog.cattle.io/v1/namespaces/cattle-system/operations/helm-operation-1`;
const POD = `${ K8S }/api/v1/namespaces/cattle-system/pods/helm-operation-1-pod`;
const CLIENT = `${ LOCAL }/apis/management.cattle.io/v3/oidcclients/libredb-studio-c-m-1`;
const CLIENT_SECRET = `${ LOCAL }/api/v1/namespaces/cattle-oidc-client-secrets/secrets/client-abc`;
const NAVLINK = `${ K8S }/apis/ui.cattle.io/v1/navlinks/libredb-studio.libredb-studio`;
const DEPLOYMENT = `${ K8S }/apis/apps/v1/namespaces/libredb-studio/deployments/libredb-studio`;
const INSTALL = `${ K8S }/v1/catalog.cattle.io.clusterrepos/rancher-partner-charts?action=install`;
const UNINSTALL = `${ K8S }/v1/catalog.cattle.io.apps/libredb-studio/libredb-studio?action=uninstall`;

/** base64 of not-a-real-client-secret: what Rancher would hold, never decoded by the wizard */
const SECRET_B64 = btoa('not-a-real-client-secret');
const SECRET_TEXT = 'not-a-real-client-secret';

const RECORD: SetupRecord = {
  version: 1,
  cluster: CLUSTER,
  release: {
    namespace: 'libredb-studio', name: 'libredb-studio', repo: 'rancher-partner-charts', chart: 'libredb-studio', chartVersion: '0.1.110'
  },
  host:             'studio.example.com',
  ingressClassName: 'traefik',
  tls:              { source: 'secret', secretName: 'studio-tls' },
  namespaces:       ['team-a', 'team-b'],
  sso:              {
    client: 'libredb-studio-c-m-1', issuer: 'https://rancher.example.com/oidc', scope: 'openid profile groups', rancherCA: true
  },
  createdNamespace: false,
};

const LOCAL_RECORD: SetupRecord = { ...RECORD };

delete LOCAL_RECORD.sso;

const ssoPlan = (record: SetupRecord = RECORD): SetupPlan => ({
  cluster: CLUSTER, record, cacerts: RANCHER_CA
});
const localPlan = (): SetupPlan => ({ cluster: CLUSTER, record: LOCAL_RECORD });

/** Answers one after another, then the last one for good */
const sequence = (...answers: unknown[]) => {
  let next = 0;

  return () => answers[Math.min(next++, answers.length - 1)];
};

interface Cluster {
  setup: FakeStoreSetup;
  store: ReturnType<typeof fakeStore>;
  kube: FakeKube;
}

type Answers = [string | RegExp, unknown][];

const MANAGED = { 'app.kubernetes.io/managed-by': 'libredb-studio-rancher-extension', 'app.kubernetes.io/part-of': 'libredb-studio' };
const SOURCE = { 'catalog.cattle.io/ui-source-repo-type': 'cluster', 'catalog.cattle.io/ui-source-repo': 'rancher-partner-charts' };

/**
 * A cluster where every step answers as Rancher does on a good day; `override` answers go first.
 * Objects live in a fake API server: Rancher gives a new OIDC client its id and writes its secret,
 * and Helm's app, NavLink and Deployment appear once the install is asked for and leave once the
 * uninstall is. The app carries the chart annotations the install sent, `annotations` by default.
 */
function cluster(override: Answers = [], appStatus = 'deployed', annotations: Record<string, string> = { ...SOURCE, ...MANAGED }): Cluster {
  const holder = {} as Cluster;
  const asked = (line: string) => holder.store.calls.some((call) => `${ call.method } ${ call.url }` === line);
  const installed = () => asked(`POST ${ INSTALL }`) && !asked(`POST ${ UNINSTALL }`);
  const app = () => (installed() ? {
    spec: {
      version: 1, info: { status: appStatus }, chart: { metadata: { name: 'libredb-studio', annotations } }
    },
    status: { summary: { state: appStatus } },
  } : httpError(404));

  holder.kube = new FakeKube({}, {
    [CLIENT]: (created, kube) => {
      Object.assign(created, { status: { clientID: 'client-abc' } });
      kube.objects.set(CLIENT_SECRET, { metadata: { name: 'client-abc' }, data: { 'client-secret-1': SECRET_B64 } });
    },
  });
  holder.setup = {
    requests: [
      ...override,
      [`POST ${ INSTALL }`, { operationName: 'helm-operation-1', operationNamespace: 'cattle-system' }],
      [`GET ${ APP }`, app],
      [`GET ${ OPERATION }`, { status: { podName: 'helm-operation-1-pod', podNamespace: 'cattle-system' } }],
      [`GET ${ POD }`, { status: { phase: 'Running' } }],
      [`GET ${ NAVLINK }`, () => (installed() ? { metadata: { name: 'libredb-studio.libredb-studio' }, spec: { toURL: 'https://studio.example.com' } } : httpError(404))],
      [`GET ${ DEPLOYMENT }`, () => (installed() ? { status: { readyReplicas: 1 } } : httpError(404))],
      [`POST ${ UNINSTALL }`, { operationName: 'helm-operation-2', operationNamespace: 'cattle-system' }],
      [/^GET .*\/namespaces\/libredb-studio\/(apps|deployments|statefulsets|daemonsets|jobs|cronjobs)$/, { items: [] }],
      [KUBE_REQUESTS, (request: Request) => holder.kube.handle(request)],
    ],
  };
  holder.store = fakeStore(holder.setup);

  return holder;
}

const fast = () => {
  let clock = 0;

  return { sleep: () => Promise.resolve(), now: () => (clock += 1000) };
};

interface Run {
  events: StepEvent[];
  undone: UndoEvent[];
}

async function install(plan: SetupPlan, { store }: Cluster) {
  const run: Run = { events: [], undone: [] };
  const result = await installStudio(store, plan, {
    ...fast(), onStep: (event) => run.events.push(event), onUndo: (event) => run.undone.push(event)
  });

  return { result, run };
}

const lines = (store: Cluster['store']) => store.calls.map((call) => `${ call.method } ${ call.url }`);
const bodyOf = (store: Cluster['store'], line: string) => store.calls.find((call) => `${ call.method } ${ call.url }` === line)?.data;
const bodiesOf = (store: Cluster['store'], line: string) => store.calls.filter((call) => `${ call.method } ${ call.url }` === line).map((call) => call.data);
const states = (run: Run) => run.events.filter((event) => event.state !== 'running').map(({ step, state }) => `${ step }:${ state }`);

describe('installing Studio', () => {
  it('plans the single sign-on steps only with single sign-on, and the CA only when Rancher has one', () => {
    expect(plannedSteps(ssoPlan())).toStrictEqual(['namespace', 'oidcClient', 'oidcSecret', 'rancherCA', 'record', 'install', 'ready']);
    expect(plannedSteps(ssoPlan({ ...RECORD, sso: { ...RECORD.sso!, rancherCA: false } }))).toStrictEqual(['namespace', 'oidcClient', 'oidcSecret', 'record', 'install', 'ready']);
    expect(plannedSteps(localPlan())).toStrictEqual(['namespace', 'record', 'install', 'ready']);
  });

  describe('with single sign-on', () => {
    it('runs every step in order and links to Studio', async() => {
      const target = cluster();
      const { result, run } = await install(ssoPlan(), target);

      expect(states(run)).toStrictEqual(['namespace:done', 'oidcClient:done', 'oidcSecret:done', 'rancherCA:done', 'record:done', 'install:done', 'ready:done']);
      expect(result).toStrictEqual({
        ok:     true,
        undone: [],
        link:   {
          name: 'libredb-studio.libredb-studio', toURL: 'https://studio.example.com', namespace: 'libredb-studio', deploymentName: 'libredb-studio'
        },
      });
    });

    it('creates Studio\'s namespace outside every project, labelled as the wizard\'s', async() => {
      const target = cluster();

      await install(ssoPlan(), target);

      expect(bodyOf(target.store, `POST ${ K8S }/api/v1/namespaces`)).toStrictEqual({
        apiVersion: 'v1', kind: 'Namespace', metadata: { name: 'libredb-studio', labels: MANAGED }
      });
    });

    it('registers Studio with Rancher on the local cluster, with the callback, short lifetimes and the scopes of the line', async() => {
      const target = cluster();

      await install(ssoPlan(), target);

      expect(bodyOf(target.store, `POST ${ LOCAL }/apis/management.cattle.io/v3/oidcclients`)).toStrictEqual({
        apiVersion: 'management.cattle.io/v3',
        kind:       'OIDCClient',
        metadata:   { name: 'libredb-studio-c-m-1', labels: MANAGED },
        spec:       {
          description:                   'LibreDB Studio in cluster c-m-1',
          redirectURIs:                  ['https://studio.example.com/api/auth/oidc/callback'],
          tokenExpirationSeconds:        300,
          refreshTokenExpirationSeconds: 300,
          scopes:                        ['openid', 'profile', 'groups'],
        },
      });
    });

    it('copies the client id and secret into Studio\'s Secret without decoding the secret', async() => {
      const target = cluster();

      await install(ssoPlan(), target);

      expect(lines(target.store).filter((line) => line === `GET ${ CLIENT_SECRET }`)).toHaveLength(1);
      expect(bodiesOf(target.store, `POST ${ NS }/secrets`)).toStrictEqual([{
        apiVersion: 'v1',
        kind:       'Secret',
        metadata:   { name: 'libredb-studio-oidc', labels: MANAGED },
        type:       'Opaque',
        data:       { 'oidc-client-id': btoa('client-abc'), 'oidc-client-secret': SECRET_B64 },
      }]);
    });

    it('never puts the client secret in a step, a result or an error', async() => {
      const target = cluster();
      const { result, run } = await install(ssoPlan(), target);
      const shown = JSON.stringify({ result, run });

      expect(shown).not.toContain(SECRET_B64);
      expect(shown).not.toContain(SECRET_TEXT);
    });

    it('copies Rancher\'s CA and records the setup, the namespace marked as created', async() => {
      const target = cluster();

      await install(ssoPlan(), target);

      expect(bodiesOf(target.store, `POST ${ NS }/configmaps`)).toStrictEqual([
        {
          apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'libredb-studio-rancher-ca', labels: MANAGED }, data: { 'ca.crt': RANCHER_CA }
        },
        {
          apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'libredb-studio-setup', labels: MANAGED }, data: { 'setup.json': serializeRecord({ ...RECORD, createdNamespace: true }) }
        },
      ]);
    });

    it('installs our chart through Rancher\'s Apps API, as the signed-in user, with the Rancher-mode values', async() => {
      const target = cluster();

      await install(ssoPlan(), target);

      const body = bodyOf(target.store, `POST ${ INSTALL }`) as { charts: { values: { config: Record<string, unknown> } }[] };

      expect(body).toStrictEqual({
        charts: [{
          chartName:   'libredb-studio',
          version:     '0.1.110',
          releaseName: 'libredb-studio',
          annotations: { ...SOURCE, ...MANAGED },
          values:      chartValues({ ...RECORD, createdNamespace: true }),
        }],
        namespace: 'libredb-studio',
        projectId: '',
        wait:      true,
        timeout:   '600s',
        noHooks:   false,
      });
      expect(body.charts[0].values.config.allowCustomConnections).toBe(false);
    });

    it('waits for the client id Rancher assigns', async() => {
      const target = cluster([[`GET ${ CLIENT }`, sequence({ metadata: { labels: MANAGED } }, { metadata: { labels: MANAGED }, status: { clientID: 'client-abc' } })]]);

      await install(ssoPlan(), target);

      expect(lines(target.store).filter((line) => line === `GET ${ CLIENT }`)).toHaveLength(2);
    });
  });

  describe('without single sign-on', () => {
    it('never touches Rancher\'s local cluster', async() => {
      const target = cluster();
      const { result, run } = await install(localPlan(), target);

      expect(result.ok).toBe(true);
      expect(states(run)).toStrictEqual(['namespace:done', 'record:done', 'install:done', 'ready:done']);
      expect(lines(target.store).filter((line) => line.includes(LOCAL))).toStrictEqual([]);
      expect(lines(target.store).filter((line) => line.includes('/secrets'))).toStrictEqual([]);
      expect((bodyOf(target.store, `POST ${ INSTALL }`) as { charts: { values: unknown }[] }).charts[0].values).toStrictEqual(chartValues({ ...LOCAL_RECORD, createdNamespace: true }));
    });
  });

  describe('Studio\'s namespace', () => {
    it('uses a namespace that is already there and outside every project, and records that it did not create it', async() => {
      const target = cluster([[`GET ${ NS }`, { metadata: { name: 'libredb-studio', annotations: {} } }]]);
      const { run } = await install(localPlan(), target);

      expect(states(run)[0]).toBe('namespace:skipped');
      expect(lines(target.store)).not.toContain(`POST ${ K8S }/api/v1/namespaces`);
      expect(bodiesOf(target.store, `POST ${ NS }/configmaps`)[0]).toMatchObject({ data: { 'setup.json': serializeRecord({ ...LOCAL_RECORD, createdNamespace: false }) } });
    });

    it('stops when the namespace was moved into a project after the preflight', async() => {
      const target = cluster([[`GET ${ NS }`, { metadata: { name: 'libredb-studio', annotations: { 'field.cattle.io/projectId': 'c-m-1:p-1' } } }]]);
      const { result, run } = await install(ssoPlan(), target);

      expect(result).toStrictEqual({
        ok: false, failedStep: 'namespace', failure: { reason: 'inProject', args: { namespace: 'libredb-studio' } }, undone: []
      });
      expect(states(run)).toStrictEqual(['namespace:failed']);
      expect(lines(target.store).filter((line) => !line.startsWith('GET'))).toStrictEqual([]);
    });
  });

  describe('when a step fails', () => {
    it('removes the namespace it created when the OIDC client cannot be created', async() => {
      const target = cluster([[`POST ${ LOCAL }/apis/management.cattle.io/v3/oidcclients`, httpError(403, 'oidcclients is forbidden')]]);
      const { result, run } = await install(ssoPlan(), target);

      expect(result).toMatchObject({
        ok: false, failedStep: 'oidcClient', failure: { reason: 'request', args: { detail: 'HTTP 403: oidcclients is forbidden' } }
      });
      expect(run.undone).toStrictEqual([{ undo: 'namespace', outcome: 'removed' }]);
      expect(lines(target.store)).toContain(`DELETE ${ NS }`);
    });

    it('removes the OIDC client when Rancher never assigns its id', async() => {
      const target = cluster([[`GET ${ CLIENT }`, { metadata: { labels: MANAGED } }]]);
      const { result, run } = await install(ssoPlan(), target);

      expect(result).toMatchObject({
        ok: false, failedStep: 'oidcClient', failure: { reason: 'noClientId' }
      });
      expect(run.undone).toStrictEqual([{ undo: 'oidcClient', outcome: 'removed' }, { undo: 'namespace', outcome: 'removed' }]);
      expect(lines(target.store)).toContain(`DELETE ${ CLIENT }`);
    });

    it('stops when Rancher holds no secret for the client', async() => {
      const target = cluster([[`GET ${ CLIENT_SECRET }`, { data: {} }]]);
      const { result } = await install(ssoPlan(), target);

      expect(result).toMatchObject({
        ok: false, failedStep: 'oidcSecret', failure: { reason: 'noClientSecret' }
      });
      expect(lines(target.store)).not.toContain(`POST ${ NS }/secrets`);
    });

    it('waits for the client\'s Secret, which Rancher writes beside the id', async() => {
      const target = cluster([[`GET ${ CLIENT_SECRET }`, sequence(httpError(404), { data: { 'client-secret-1': SECRET_B64 } })]]);
      const { result } = await install(ssoPlan(), target);

      expect(result.ok).toBe(true);
    });

    it('stops when the client\'s Secret never appears', async() => {
      const target = cluster([[`GET ${ CLIENT_SECRET }`, httpError(404)]]);
      const { result } = await install(ssoPlan(), target);

      expect(result).toMatchObject({
        ok: false, failedStep: 'oidcSecret', failure: { reason: 'noClientSecret' }
      });
    });

    it('says only the status when copying the secret fails, whatever the server answered', async() => {
      const echo = httpError(422, `Secret is invalid: ${ SECRET_B64 } ${ SECRET_TEXT }`);
      const target = cluster([[`POST ${ NS }/secrets`, echo]]);
      const { result, run } = await install(ssoPlan(), target);
      const shown = JSON.stringify({ result, run });

      expect(result).toMatchObject({
        ok: false, failedStep: 'oidcSecret', failure: { reason: 'request', args: { detail: 'HTTP 422' } }
      });
      expect(shown).not.toContain(SECRET_B64);
      expect(shown).not.toContain(SECRET_TEXT);
      expect(run.undone).toStrictEqual([{ undo: 'oidcClient', outcome: 'removed' }, { undo: 'namespace', outcome: 'removed' }]);
    });

    it('says only that reading the secret failed, never what came back', async() => {
      const target = cluster([[`GET ${ CLIENT_SECRET }`, httpError(403, `forbidden ${ SECRET_B64 }`)]]);
      const { result } = await install(ssoPlan(), target);

      expect(result.failure).toStrictEqual({ reason: 'request', args: { detail: 'HTTP 403' } });
    });

    it('undoes everything it created when Rancher refuses the install', async() => {
      const target = cluster([[`POST ${ INSTALL }`, httpError(403, 'not allowed to install')]]);
      const { result, run } = await install(ssoPlan(), target);

      expect(result).toMatchObject({
        ok: false, failedStep: 'install', failure: { reason: 'request', args: { detail: 'HTTP 403: not allowed to install' } }
      });
      expect(run.undone).toStrictEqual([
        { undo: 'record', outcome: 'removed' },
        { undo: 'rancherCA', outcome: 'removed' },
        { undo: 'oidcSecret', outcome: 'removed' },
        { undo: 'oidcClient', outcome: 'removed' },
        { undo: 'namespace', outcome: 'removed' },
      ]);
      expect(lines(target.store).filter((line) => line.startsWith('DELETE'))).toStrictEqual([
        `DELETE ${ NS }/configmaps/libredb-studio-setup`,
        `DELETE ${ NS }/configmaps/libredb-studio-rancher-ca`,
        `DELETE ${ NS }/secrets/libredb-studio-oidc`,
        `DELETE ${ CLIENT }`,
        `DELETE ${ NS }`,
      ]);
    });

    it('uninstalls the release it started when Helm reports a failure, then removes the rest', async() => {
      const target = cluster([], 'failed');
      const { result, run } = await install(ssoPlan(), target);

      expect(result).toMatchObject({
        ok: false, failedStep: 'install', failure: { reason: 'helmFailed' }
      });
      expect(run.undone).toStrictEqual([
        { undo: 'release', outcome: 'removed' },
        { undo: 'record', outcome: 'removed' },
        { undo: 'rancherCA', outcome: 'removed' },
        { undo: 'oidcSecret', outcome: 'removed' },
        { undo: 'oidcClient', outcome: 'removed' },
        { undo: 'namespace', outcome: 'removed' },
      ]);
      expect(bodyOf(target.store, `POST ${ UNINSTALL }`)).toStrictEqual({ timeout: '600s' });
    });

    it('uninstalls the release when the Helm operation\'s pod fails before a release exists', async() => {
      const target = cluster([[`GET ${ APP }`, httpError(404)], [`GET ${ POD }`, { status: { phase: 'Failed' } }]]);
      const { result, run } = await install(localPlan(), target);

      expect(result).toMatchObject({
        ok: false, failedStep: 'install', failure: { reason: 'operationFailed' }
      });
      expect(run.undone[0]).toStrictEqual({ undo: 'release', outcome: 'gone' });
    });

    it('gives up on a release that never settles', async() => {
      const target = cluster([[`GET ${ APP }`, { spec: { version: 1, info: { status: 'pending-install' } } }], [`GET ${ OPERATION }`, { status: {} }]]);
      const { result } = await install(localPlan(), target);

      expect(result).toMatchObject({
        ok: false, failedStep: 'install', failure: { reason: 'timeout' }
      });
    });

    it('undoes the install when Studio\'s link never appears', async() => {
      const target = cluster([[`GET ${ NAVLINK }`, httpError(404)]]);
      const { result, run } = await install(localPlan(), target);

      expect(result).toMatchObject({
        ok: false, failedStep: 'ready', failure: { reason: 'notReady' }
      });
      expect(run.undone[0]).toStrictEqual({ undo: 'release', outcome: 'removed' });
      expect(lines(target.store)).toContain(`POST ${ UNINSTALL }`);
    });

    it('waits for Studio to be ready behind an https link', async() => {
      const target = cluster([
        [`GET ${ DEPLOYMENT }`, sequence({ status: {} }, { status: { readyReplicas: 1 } })],
        [`GET ${ NAVLINK }`, sequence({ metadata: { name: 'libredb-studio.libredb-studio' }, spec: { toURL: 'http://studio.example.com' } },
          { metadata: { name: 'libredb-studio.libredb-studio' }, spec: { toURL: 'https://studio.example.com' } })],
      ]);
      const { result } = await install(localPlan(), target);

      expect(result.ok).toBe(true);
    });

    it('keeps a namespace it created when something else lives there', async() => {
      const target = cluster([
        [`POST ${ INSTALL }`, httpError(500)],
        [`GET ${ NS.replace('/api/v1/', '/apis/apps/v1/') }/deployments`, { items: [{ metadata: { name: 'someone-elses' } }] }],
      ]);
      const { run } = await install(localPlan(), target);

      expect(run.undone).toContainEqual({
        undo: 'namespace', outcome: 'kept', failure: { reason: 'notEmpty', args: { namespace: 'libredb-studio' } }
      });
      expect(lines(target.store)).not.toContain(`DELETE ${ NS }`);
    });

    it('ignores what is already being deleted when it decides the namespace is empty', async() => {
      const target = cluster([
        [`POST ${ INSTALL }`, httpError(500)],
        [`GET ${ NS.replace('/api/v1/', '/apis/apps/v1/') }/deployments`, { items: [{ metadata: { name: 'studio', deletionTimestamp: '2026-10-28T10:00:00Z' } }] }],
      ]);
      const { run } = await install(localPlan(), target);

      expect(run.undone).toContainEqual({ undo: 'namespace', outcome: 'removed' });
    });

    it('keeps the namespace when it cannot tell whether it is empty', async() => {
      const target = cluster([[`POST ${ INSTALL }`, httpError(500)], [/\/jobs$/, httpError(403)]]);
      const { run } = await install(localPlan(), target);

      expect(run.undone).toContainEqual({
        undo: 'namespace', outcome: 'kept', failure: { reason: 'notEmpty', args: { namespace: 'libredb-studio' } }
      });
    });

    it('never removes a namespace it did not create', async() => {
      const target = cluster([[`GET ${ NS }`, { metadata: { name: 'libredb-studio' } }], [`POST ${ INSTALL }`, httpError(500)]]);
      const { run } = await install(localPlan(), target);

      expect(run.undone).toStrictEqual([{ undo: 'record', outcome: 'removed' }]);
      expect(lines(target.store)).not.toContain(`DELETE ${ NS }`);
    });

    it('goes on undoing after one removal fails, and says which', async() => {
      const target = cluster([[`POST ${ INSTALL }`, httpError(500)], [`DELETE ${ NS }/secrets/libredb-studio-oidc`, httpError(500, 'etcd unavailable')]]);
      const { run } = await install(ssoPlan(), target);

      expect(run.undone).toContainEqual({
        undo: 'oidcSecret', outcome: 'failed', failure: { reason: 'request', args: { detail: 'HTTP 500' } }
      });
      expect(run.undone).toContainEqual({ undo: 'oidcClient', outcome: 'removed' });
    });

    it('says when something it created was already gone', async() => {
      const target = cluster([[`POST ${ INSTALL }`, httpError(500)], [`DELETE ${ NS }/configmaps/libredb-studio-setup`, httpError(404)]]);
      const { run } = await install(localPlan(), target);

      expect(run.undone[0]).toStrictEqual({ undo: 'record', outcome: 'gone' });
    });

    it('leaves a release without the extension\'s mark, and the namespace it lives in', async() => {
      const target = cluster([], 'failed', SOURCE);
      const { run } = await install(localPlan(), target);

      expect(run.undone[0]).toStrictEqual({
        undo: 'release', outcome: 'kept', failure: { reason: 'notManaged' }
      });
      expect(run.undone).toContainEqual({
        undo: 'namespace', outcome: 'kept', failure: { reason: 'releaseLeft', args: { namespace: 'libredb-studio' } }
      });
      expect(lines(target.store)).not.toContain(`POST ${ UNINSTALL }`);
    });

    it('leaves an object that no longer carries the extension\'s labels', async() => {
      const target = cluster([[`POST ${ INSTALL }`, httpError(500)], [`GET ${ NS }/configmaps/libredb-studio-setup`, { metadata: { labels: { 'app.kubernetes.io/managed-by': 'someone-else' } } }]]);
      const { run } = await install(localPlan(), target);

      expect(run.undone[0]).toStrictEqual({
        undo: 'record', outcome: 'kept', failure: { reason: 'notManaged' }
      });
      expect(lines(target.store)).not.toContain(`DELETE ${ NS }/configmaps/libredb-studio-setup`);
    });

    it('leaves a namespace that no longer carries the extension\'s labels', async() => {
      const target = cluster([[`POST ${ INSTALL }`, httpError(500)], [`GET ${ NS }`, sequence(httpError(404), { metadata: { name: 'libredb-studio' } })]]);
      const { run } = await install(localPlan(), target);

      expect(run.undone).toContainEqual({
        undo: 'namespace', outcome: 'kept', failure: { reason: 'notManaged' }
      });
      expect(lines(target.store)).not.toContain(`DELETE ${ NS }`);
    });

    describe('when the release it started does not go away', () => {
      const stuck = {
        spec: {
          version: 1, info: { status: 'failed' }, chart: { metadata: { annotations: { ...SOURCE, ...MANAGED } } }
        }
      };

      it('gives up on the uninstall in time', async() => {
        const target = cluster([[`GET ${ APP }`, stuck]]);
        const { run } = await install(localPlan(), target);

        expect(run.undone[0]).toStrictEqual({
          undo: 'release', outcome: 'failed', failure: { reason: 'timeout' }
        });
        expect(run.undone).toContainEqual({
          undo: 'namespace', outcome: 'kept', failure: { reason: 'releaseLeft', args: { namespace: 'libredb-studio' } }
        });
      });

      it('says when the uninstall\'s Helm operation failed', async() => {
        const target = cluster([
          [`GET ${ APP }`, stuck],
          [`GET ${ K8S }/apis/catalog.cattle.io/v1/namespaces/cattle-system/operations/helm-operation-2`, { status: { podName: 'helm-operation-2-pod' } }],
          [`GET ${ K8S }/api/v1/namespaces/cattle-system/pods/helm-operation-2-pod`, { status: { phase: 'Failed' } }],
        ]);
        const { run } = await install(localPlan(), target);

        expect(run.undone[0]).toStrictEqual({
          undo: 'release', outcome: 'failed', failure: { reason: 'operationFailed' }
        });
      });
    });

    it('keeps the namespace when the release it started cannot be uninstalled', async() => {
      const target = cluster([[`GET ${ NAVLINK }`, httpError(404)], [`POST ${ UNINSTALL }`, httpError(500, 'helm is busy')]]);
      const { run } = await install(localPlan(), target);

      expect(run.undone[0]).toStrictEqual({
        undo: 'release', outcome: 'failed', failure: { reason: 'request', args: { detail: 'HTTP 500: helm is busy' } }
      });
      expect(run.undone).toContainEqual({
        undo: 'namespace', outcome: 'kept', failure: { reason: 'releaseLeft', args: { namespace: 'libredb-studio' } }
      });
    });

    it('reports a failure that is not a request in words of its own', async() => {
      const target = cluster([[`POST ${ K8S }/api/v1/namespaces`, () => {
        throw new TypeError('boom');
      }]]);
      const { result } = await install(localPlan(), target);

      expect(result.failure).toStrictEqual({ reason: 'request', args: { detail: 'boom' } });
    });

    it('refuses a plan that copies Rancher\'s CA without one', async() => {
      const target = cluster();
      const { result } = await install({ cluster: CLUSTER, record: RECORD }, target);

      expect(result).toMatchObject({
        ok: false, failedStep: 'rancherCA', failure: { reason: 'noRancherCA' }
      });
    });

    it('watches only the release when Rancher names no operation for it', async() => {
      const target = cluster([[`POST ${ INSTALL }`, {}], [`GET ${ APP }`, httpError(404)]]);
      const { result } = await install(localPlan(), target);

      expect(result.failure).toStrictEqual({ reason: 'timeout' });
      expect(lines(target.store).filter((line) => line.includes('/operations/'))).toStrictEqual([]);
    });
  });
});

describe('upgrading Studio', () => {
  it('sends the whole set of values the record gives, at the chosen chart version', async() => {
    const store = fakeStore({ requests: [[`POST ${ K8S }/v1/catalog.cattle.io.clusterrepos/rancher-partner-charts?action=upgrade`, { operationName: 'op', operationNamespace: 'cattle-system' }]] });

    await expect(upgradeRelease(store, CLUSTER, LOCAL_RECORD, '0.1.111')).resolves.toStrictEqual({ name: 'op', namespace: 'cattle-system' });
    expect(store.calls[0].data).toStrictEqual({
      charts: [{
        chartName:   'libredb-studio',
        version:     '0.1.111',
        releaseName: 'libredb-studio',
        annotations: { ...SOURCE, ...MANAGED },
        values:      chartValues(LOCAL_RECORD),
        resetValues: false,
      }],
      namespace:     'libredb-studio',
      wait:          true,
      timeout:       '600s',
      noHooks:       false,
      force:         false,
      historyMax:    5,
      cleanupOnFail: false,
    });
  });
});

describe('waiting', () => {
  it('polls until the probe answers, on real timers by default', async() => {
    const probe = jest.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce('done');

    await expect(waitFor(probe, 1, 1000)).resolves.toBe('done');
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('gives up after the timeout, rethrowing the last failure when the probe kept failing', async() => {
    const clock = fast();

    await expect(waitFor(() => Promise.resolve(undefined), 1000, 3000, clock)).resolves.toBeUndefined();
    await expect(waitFor(() => Promise.reject(new Error('down')), 1000, 3000, fast())).rejects.toThrow('down');
  });

  it('keeps polling through a failure that later clears', async() => {
    const probe = jest.fn().mockRejectedValueOnce(new Error('blip')).mockResolvedValueOnce(undefined).mockResolvedValueOnce(7);

    await expect(waitFor(probe, 1000, 60000, fast())).resolves.toBe(7);
  });
});
