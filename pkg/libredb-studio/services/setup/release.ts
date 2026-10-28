import { StudioLink, usableToURL } from '../navlink';
import type { StoreLike } from '../types';
import { StepFailure } from './failure';
import { kube, kubeGet } from './k8s';
import { CHART_NAME, RELEASE_NAME, STUDIO_NAMESPACE } from './names';
import { chartValues, SetupRecord } from './values';
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
  spec?: { version?: number, info?: { status?: string }, chart?: { metadata?: { version?: string, appVersion?: string } } };
  status?: { summary?: { state?: string } };
}

/** A release as Helm and Rancher's app see it */
export interface ReleaseState {
  status?: string;
  revision: number;
  chartVersion?: string;
  appVersion?: string;
}

const HELM_TIMEOUT = '600s';
/** Helm's own timeout and a minute for Rancher to start its pod */
const RELEASE_TIMEOUT_MS = 660000;
const RELEASE_POLL_MS = 3000;
const READY_TIMEOUT_MS = 120000;
const READY_POLL_MS = 2000;

const appPath = (namespace: string, name: string) => `/apis/catalog.cattle.io/v1/namespaces/${ namespace }/apps/${ name }`;

/** The annotations Rancher's Apps page sets, so the app shows where it came from */
export function sourceAnnotations(repo: string): Record<string, string> {
  return { 'catalog.cattle.io/ui-source-repo-type': 'cluster', 'catalog.cattle.io/ui-source-repo': repo };
}

async function chartAction(store: StoreLike, cluster: string, repo: string, action: 'install' | 'upgrade', body: unknown): Promise<Operation> {
  const started = await kube<{ operationName?: string, operationNamespace?: string } | undefined>(store, cluster, 'post',
    `/v1/catalog.cattle.io.clusterrepos/${ encodeURIComponent(repo) }?action=${ action }`, body);

  return { name: started?.operationName || '', namespace: started?.operationNamespace || '' };
}

/** Starts installing our chart in Rancher mode */
export function installRelease(store: StoreLike, cluster: string, record: SetupRecord): Promise<Operation> {
  return chartAction(store, cluster, record.release.repo, 'install', {
    charts: [{
      chartName:   CHART_NAME,
      version:     record.release.chartVersion,
      releaseName: record.release.name,
      annotations: sourceAnnotations(record.release.repo),
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
  return chartAction(store, cluster, record.release.repo, 'upgrade', {
    charts: [{
      chartName:   CHART_NAME,
      version:     chartVersion,
      releaseName: record.release.name,
      annotations: sourceAnnotations(record.release.repo),
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

/** Uninstalls the release and waits until it is gone: removed, or gone when there was none */
export async function uninstallRelease(store: StoreLike, cluster: string, namespace: string, name: string, options: WaitOptions): Promise<'removed' | 'gone'> {
  if (!await kubeGet(store, cluster, appPath(namespace, name))) {
    return 'gone';
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

const WORKLOAD_LISTS = [
  '/apis/catalog.cattle.io/v1/namespaces/{ns}/apps',
  '/apis/apps/v1/namespaces/{ns}/deployments',
  '/apis/apps/v1/namespaces/{ns}/statefulsets',
  '/apis/apps/v1/namespaces/{ns}/daemonsets',
  '/apis/batch/v1/namespaces/{ns}/jobs',
  '/apis/batch/v1/namespaces/{ns}/cronjobs',
];

/**
 * Whether nothing else lives in a namespace: no app and no workload that is not already being
 * deleted. A list that fails counts as not empty, so a namespace is never removed on a guess.
 */
export async function namespaceIsEmpty(store: StoreLike, cluster: string, namespace: string): Promise<boolean> {
  try {
    const lists = await Promise.all(WORKLOAD_LISTS.map((path) => kube<{ items?: { metadata?: { deletionTimestamp?: string } }[] }>(store, cluster, 'get', path.replace('{ns}', namespace))));

    return lists.every((list) => !(list?.items || []).some((item) => !item.metadata?.deletionTimestamp));
  } catch {
    return false;
  }
}
