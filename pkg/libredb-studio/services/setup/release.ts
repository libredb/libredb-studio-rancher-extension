import { CNPG_CLUSTER_TYPE } from '../../config';
import { StudioLink, usableToURL } from '../navlink';
import type { StoreLike } from '../types';
import { StepFailure } from './failure';
import {
  kube, kubeGet, kubeMetadataList, kubePatch, ListedMetadata
} from './k8s';
import {
  CERT_MANAGER_TLS_SECRET, CHART_NAME, CHART_REPO, MANAGED_LABELS, RELEASE_NAME, STUDIO_NAMESPACE, isManaged
} from './names';
import { chartValues, SetupRecord, TlsChoice } from './values';
import { waitFor, WaitOptions } from './wait';

/**
 * Studio's release through Rancher's Apps API: the ClusterRepo's install and upgrade actions and the
 * app's uninstall action. Helm runs under Rancher's own install machinery, as the signed-in user.
 */

/** The Helm operation Rancher started, whose pod runs Helm */
export interface Operation {
  name: string;
  namespace: string;
}

interface App {
  spec?: {
    version?: number,
    info?: { status?: string },
    chart?: { metadata?: { name?: string, version?: string, appVersion?: string, annotations?: Record<string, string> } },
  };
  status?: { summary?: { state?: string } };
}

/** A release as Helm and Rancher's app see it */
export interface ReleaseState {
  status?: string;
  revision: number;
  chartVersion?: string;
  appVersion?: string;
  /**
   * Whether the release carries the extension's mark, which an upgrade through Rancher's Apps page
   * drops, since that page sends only its own chart annotations
   */
  managed: boolean;
}

const HELM_TIMEOUT = '600s';
/** Helm's own timeout and a minute for Rancher to start its pod */
const RELEASE_TIMEOUT_MS = 660000;
const RELEASE_POLL_MS = 3000;
const READY_TIMEOUT_MS = 120000;
const READY_POLL_MS = 2000;

const appPath = (namespace: string, name: string) => `/apis/catalog.cattle.io/v1/namespaces/${ namespace }/apps/${ name }`;

/**
 * The chart annotations Rancher writes into the release: where it came from, as Rancher's Apps page
 * sets them, and the extension's mark, without which the extension never uninstalls a release.
 */
export function sourceAnnotations(repo: string): Record<string, string> {
  return {
    'catalog.cattle.io/ui-source-repo-type': 'cluster', 'catalog.cattle.io/ui-source-repo': repo, ...MANAGED_LABELS
  };
}

/** Always on the extension's own repository: a record never chooses where a chart comes from */
async function chartAction(store: StoreLike, cluster: string, action: 'install' | 'upgrade', body: unknown): Promise<Operation> {
  const started = await kube<{ operationName?: string, operationNamespace?: string } | undefined>(store, cluster, 'post',
    `/v1/catalog.cattle.io.clusterrepos/${ encodeURIComponent(CHART_REPO) }?action=${ action }`, body);

  return { name: started?.operationName || '', namespace: started?.operationNamespace || '' };
}

/** Starts installing our chart in Rancher mode */
export function installRelease(store: StoreLike, cluster: string, record: SetupRecord): Promise<Operation> {
  return chartAction(store, cluster, 'install', {
    charts: [{
      chartName:   CHART_NAME,
      version:     record.release.chartVersion,
      releaseName: record.release.name,
      annotations: sourceAnnotations(CHART_REPO),
      values:      chartValues(record),
    }],
    namespace: record.release.namespace,
    projectId: '',
    wait:      true,
    timeout:   HELM_TIMEOUT,
    noHooks:   false,
  });
}

/**
 * Starts an upgrade to the record's values at a chart version. An upgrade with values replaces the
 * release's values, so they are always the whole set the record gives.
 */
export function upgradeRelease(store: StoreLike, cluster: string, record: SetupRecord, chartVersion: string): Promise<Operation> {
  return chartAction(store, cluster, 'upgrade', {
    charts: [{
      chartName:   CHART_NAME,
      version:     chartVersion,
      releaseName: record.release.name,
      annotations: sourceAnnotations(CHART_REPO),
      values:      chartValues(record),
      resetValues: false,
    }],
    namespace:     record.release.namespace,
    wait:          true,
    timeout:       HELM_TIMEOUT,
    noHooks:       false,
    force:         false,
    historyMax:    5,
    cleanupOnFail: false,
  });
}

/** Whether the pod Rancher runs Helm in has failed */
async function operationFailed(store: StoreLike, cluster: string, operation: Operation): Promise<boolean> {
  if (!operation.name || !operation.namespace) {
    return false;
  }

  const found = await kubeGet<{ status?: { podName?: string, podNamespace?: string } }>(store, cluster,
    `/apis/catalog.cattle.io/v1/namespaces/${ operation.namespace }/operations/${ operation.name }`);
  const podName = found?.status?.podName;
  const pod = podName ? await kubeGet<{ status?: { phase?: string } }>(store, cluster,
    `/api/v1/namespaces/${ found?.status?.podNamespace || operation.namespace }/pods/${ podName }`) : undefined;

  return pod?.status?.phase === 'Failed';
}

/** The release's Helm state, revision and chart, or nothing when there is no release */
export async function releaseState(store: StoreLike, cluster: string, namespace: string, name: string): Promise<ReleaseState | undefined> {
  const app = await kubeGet<App>(store, cluster, appPath(namespace, name));

  return app ? {
    status:       app.spec?.info?.status || app.status?.summary?.state,
    revision:     app.spec?.version || 0,
    chartVersion: app.spec?.chart?.metadata?.version,
    appVersion:   app.spec?.chart?.metadata?.appVersion,
    managed:      isManaged(app.spec?.chart?.metadata?.annotations),
  } : undefined;
}

/**
 * Waits until Helm has deployed a revision after `sinceRevision` (any revision for an install), and
 * fails when Helm reports a failure, its pod fails, or nothing settles in time.
 */
export async function waitForRelease(store: StoreLike, cluster: string, record: SetupRecord, operation: Operation, sinceRevision: number, options: WaitOptions): Promise<void> {
  const settled = await waitFor(async() => {
    const release = await releaseState(store, cluster, record.release.namespace, record.release.name);

    if (release && release.revision > sinceRevision && (release.status === 'deployed' || release.status === 'failed')) {
      return release.status;
    }

    return await operationFailed(store, cluster, operation) ? 'operationFailed' : undefined;
  }, RELEASE_POLL_MS, RELEASE_TIMEOUT_MS, options);

  if (settled !== 'deployed') {
    throw new StepFailure(settled === 'failed' ? 'helmFailed' : settled || 'timeout');
  }
}

/**
 * Uninstalls the release and waits until it is gone: removed, gone when there was none, or
 * notManaged for a release without the extension's mark, which is left as it is.
 */
export async function uninstallRelease(store: StoreLike, cluster: string, namespace: string, name: string, options: WaitOptions): Promise<'removed' | 'gone' | 'notManaged'> {
  const app = await kubeGet<App>(store, cluster, appPath(namespace, name));

  if (!app) {
    return 'gone';
  }

  if (!isManaged(app.spec?.chart?.metadata?.annotations)) {
    return 'notManaged';
  }

  const started = await kube<{ operationName?: string, operationNamespace?: string } | undefined>(store, cluster, 'post',
    `/v1/catalog.cattle.io.apps/${ namespace }/${ name }?action=uninstall`, { timeout: HELM_TIMEOUT });
  const operation = { name: started?.operationName || '', namespace: started?.operationNamespace || '' };
  const settled = await waitFor(async() => {
    if (!await kubeGet(store, cluster, appPath(namespace, name))) {
      return 'removed';
    }

    return await operationFailed(store, cluster, operation) ? 'operationFailed' : undefined;
  }, RELEASE_POLL_MS, RELEASE_TIMEOUT_MS, options);

  if (settled !== 'removed') {
    throw new StepFailure(settled || 'timeout');
  }

  return 'removed';
}

/**
 * Waits until Studio's Deployment is ready and its NavLink points at an https URL, then answers the
 * link, as the Databases page reads it.
 */
export async function waitForStudio(store: StoreLike, cluster: string, options: WaitOptions): Promise<StudioLink> {
  const name = `${ STUDIO_NAMESPACE }.${ RELEASE_NAME }`;
  const toURL = await waitFor(async() => {
    const navlink = await kubeGet<{ metadata: { name: string }, spec?: { toURL?: string } }>(store, cluster, `/apis/ui.cattle.io/v1/navlinks/${ name }`);
    const url = navlink && usableToURL(navlink);

    if (!url) {
      return undefined;
    }

    const deployment = await kubeGet<{ status?: { readyReplicas?: number } }>(store, cluster, `/apis/apps/v1/namespaces/${ STUDIO_NAMESPACE }/deployments/${ RELEASE_NAME }`);

    return (deployment?.status?.readyReplicas || 0) >= 1 ? url : undefined;
  }, READY_POLL_MS, READY_TIMEOUT_MS, options);

  if (!toURL) {
    throw new StepFailure('notReady');
  }

  return {
    name, toURL, namespace: STUDIO_NAMESPACE, deploymentName: RELEASE_NAME
  };
}

/** The pod template annotation kubectl rollout restart sets, and Rancher's Redeploy with it */
export const RESTARTED_AT = 'kubectl.kubernetes.io/restartedAt';
/** Studio's pods start in well under a minute; a pull or a slow volume takes longer */
const RESTART_TIMEOUT_MS = 300000;
const RESTART_POLL_MS = 2000;

interface Deployment {
  metadata?: { generation?: number };
  spec?: { replicas?: number };
  status?: { observedGeneration?: number, replicas?: number, updatedReplicas?: number, availableReplicas?: number };
}

/**
 * Whether a Deployment has rolled out a generation, as kubectl rollout status decides it: the
 * generation observed, every replica updated, none of the old ones left, and the new ones available.
 */
function rolledOut(deployment: Deployment | undefined, generation: number): boolean {
  const status = deployment?.status;
  const updated = status?.updatedReplicas || 0;

  return (status?.observedGeneration || 0) >= generation && updated >= (deployment?.spec?.replicas ?? 1) &&
    (status?.replicas || 0) <= updated && (status?.availableReplicas || 0) >= updated;
}

/**
 * Restarts Studio, so that its pods read again the Secrets their environment comes from, and waits
 * until every replica runs the new pod template. Helm keeps the annotation on later upgrades, so they
 * restart nothing for it.
 */
export async function restartStudio(store: StoreLike, cluster: string, options: WaitOptions): Promise<void> {
  const path = `/apis/apps/v1/namespaces/${ STUDIO_NAMESPACE }/deployments/${ RELEASE_NAME }`;
  const now = options.now || Date.now;
  const restarted = await kubePatch<Deployment | undefined>(store, cluster, path, { spec: { template: { metadata: { annotations: { [RESTARTED_AT]: new Date(now()).toISOString() } } } } });
  const generation = restarted?.metadata?.generation;
  const notRestarted = new StepFailure('notRestarted', { namespace: STUDIO_NAMESPACE });

  // Without the generation the patch made, an old rollout could pass for this one
  if (!generation) {
    throw notRestarted;
  }

  const done = await waitFor(async() => (rolledOut(await kubeGet<Deployment>(store, cluster, path), generation) || undefined),
    RESTART_POLL_MS, RESTART_TIMEOUT_MS, options);

  if (!done) {
    throw notRestarted;
  }
}

/** A list of what may live in a namespace beside Studio; `controlled`: what goes with its controller */
interface NamespaceList {
  path: string;
  controlled?: true;
}

const NAMESPACE_LISTS: NamespaceList[] = [
  { path: '/apis/catalog.cattle.io/v1/namespaces/{ns}/apps' },
  { path: '/apis/apps/v1/namespaces/{ns}/deployments' },
  { path: '/apis/apps/v1/namespaces/{ns}/replicasets', controlled: true },
  { path: '/apis/apps/v1/namespaces/{ns}/statefulsets' },
  { path: '/apis/apps/v1/namespaces/{ns}/daemonsets' },
  { path: '/apis/batch/v1/namespaces/{ns}/jobs' },
  { path: '/apis/batch/v1/namespaces/{ns}/cronjobs' },
  { path: '/api/v1/namespaces/{ns}/pods', controlled: true },
  { path: '/api/v1/namespaces/{ns}/persistentvolumeclaims' },
  { path: '/api/v1/namespaces/{ns}/services' },
];
const CNPG_CLUSTERS: NamespaceList = { path: '/apis/postgresql.cnpg.io/v1/namespaces/{ns}/clusters' };

interface Listed {
  metadata?: { deletionTimestamp?: string, ownerReferences?: { controller?: boolean }[] };
}

/**
 * Whether nothing else lives in a namespace: no app, workload, pod, volume claim, service or
 * CloudNativePG database that is not already being deleted. A pod or replica set with a controller
 * goes with that controller, which the garbage collector may not have reached yet when an uninstall
 * ends, so it does not count by itself. A list that fails counts as not empty, so a namespace is
 * never removed on a guess.
 */
export async function namespaceIsEmpty(store: StoreLike, cluster: string, namespace: string): Promise<boolean> {
  const lists: NamespaceList[] = store.getters['cluster/schemaFor'](CNPG_CLUSTER_TYPE) ? [...NAMESPACE_LISTS, CNPG_CLUSTERS] : NAMESPACE_LISTS;
  const lives = (item: Listed, controlled?: true) => !item.metadata?.deletionTimestamp && !(controlled && item.metadata?.ownerReferences?.some((owner) => owner.controller));

  try {
    const found = await Promise.all(lists.map(({ path }) => kube<{ items?: Listed[] }>(store, cluster, 'get', path.replace('{ns}', namespace))));

    return found.every((list, index) => !(list?.items || []).some((item) => lives(item, lists[index].controlled)));
  } catch {
    return false;
  }
}

/** What Kubernetes itself puts in every namespace, which goes with the namespace */
const KUBE_ROOT_CA = 'kube-root-ca.crt';
const SERVICE_ACCOUNT_ANNOTATION = 'kubernetes.io/service-account.name';

/**
 * Whether a Secret is the TLS Secret cert-manager issued for the chart's Ingress on a cert-manager
 * install: named as the setup names it and annotated by cert-manager as issued from the
 * ClusterIssuer the setup chose. cert-manager does not delete it when the Ingress goes, so it is
 * left once the app is removed although nobody added it.
 */
function issuedForStudio(item: ListedMetadata, tls: TlsChoice): boolean {
  const annotations = item.metadata?.annotations || {};

  return tls.source === 'cert-manager' && item.metadata?.name === CERT_MANAGER_TLS_SECRET &&
    annotations['cert-manager.io/issuer-name'] === tls.clusterIssuer && annotations['cert-manager.io/issuer-kind'] === 'ClusterIssuer';
}

/**
 * The Secrets and ConfigMaps left in a namespace that do not carry the extension's labels, such as a
 * TLS Secret its owner created, each as `<Kind> <name>`. Deleting the namespace would delete them, so
 * while any is left it stays. Both lists are read as metadata alone, so no Secret's data reaches the
 * browser. Ignored: what is being deleted, a service account's token Secret, the CA ConfigMap
 * Kubernetes writes into every namespace, and on a cert-manager install the TLS Secret cert-manager
 * issued for the chart's Ingress. A list that fails throws.
 */
export async function unmanagedLeft(store: StoreLike, cluster: string, namespace: string, tls: TlsChoice): Promise<string[]> {
  const inNamespace = (kind: string) => `/api/v1/namespaces/${ namespace }/${ kind }`;
  const [secrets, configMaps] = await Promise.all([
    kubeMetadataList(store, cluster, inNamespace('secrets')),
    kubeMetadataList(store, cluster, inNamespace('configmaps')),
  ]);
  const left = (item: ListedMetadata) => !item.metadata?.deletionTimestamp && !isManaged(item.metadata?.labels);

  return [
    ...secrets.filter((item) => left(item) && !item.metadata?.annotations?.[SERVICE_ACCOUNT_ANNOTATION] && !issuedForStudio(item, tls)).map((item) => `Secret ${ item.metadata?.name }`),
    ...configMaps.filter((item) => left(item) && item.metadata?.name !== KUBE_ROOT_CA).map((item) => `ConfigMap ${ item.metadata?.name }`),
  ];
}
