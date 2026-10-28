import { CNPG_CLUSTER_TYPE } from '../../config';
import { findStudioLinks, selectStudioLink } from '../navlink';
import { statusOf } from '../studio-status';
import type { StoreLike } from '../types';
import {
  canI, findAllIfVisible, findIfVisible, kubeGet, LOCAL_CLUSTER
} from './k8s';
import {
  CHART_NAME, DEFAULT_REPO, OIDC_CLIENT_SECRETS_NAMESPACE, RECORD_CONFIGMAP, RELEASE_NAME, STUDIO_NAMESPACE, oidcClientName
} from './names';
import {
  ChartVersion, MIN_APP_VERSION, MIN_CHART_VERSION, oidcScopes, pickChartVersion, rancherLine
} from './versions';

/**
 * F6's preflight, design section 6.4 step 1: every check with its result, and its reason as an
 * l10n key under libredbStudio.setup.checks.<id>. Errors stop the install; the single sign-on
 * checks (sso) stop only single sign-on, which the cluster owner can leave off.
 */
export type CheckId = 'owner' | 'version' | 'cnpg' | 'aggregation' | 'ingressClass' | 'storageClass' | 'namespace' | 'installed' | 'chart' |
  'oidcProvider' | 'oidcAdmin' | 'oidcClient';
export type CheckState = 'ok' | 'warning' | 'error';

export interface Check {
  id: CheckId;
  state: CheckState;
  reason: string;
  args?: Record<string, string>;
  /** Decides single sign-on only */
  sso?: true;
}

export interface PreflightResult {
  checks: Check[];
  canInstall: boolean;
  canUseSso: boolean;
  serverUrl?: string;
  serverVersion?: string;
  /** The OIDC scopes this Rancher line accepts */
  scopes: string[];
  /** Rancher's CA, when it has its own */
  cacerts?: string;
  /** The default class first */
  ingressClasses: string[];
  clusterIssuers: string[];
  /** The namespaces discovery may cover, Studio's own left out */
  namespaces: string[];
  /** The cluster's chart repositories, the Partners one first */
  repos: string[];
  repo: string;
  chart?: ChartVersion;
  namespaceExists: boolean;
}

interface Named {
  metadata: { name: string, annotations?: Record<string, string> };
}

interface Rule {
  apiGroups?: string[];
  resources?: string[];
  verbs?: string[];
}

const SETTING = 'management.cattle.io.setting';
const FEATURE = 'management.cattle.io.feature';
const CLUSTER_ROLE = 'rbac.authorization.k8s.io.clusterrole';
const INGRESS_CLASS = 'networking.k8s.io.ingressclass';
const STORAGE_CLASS = 'storage.k8s.io.storageclass';
const CLUSTER_ISSUER = 'cert-manager.io.clusterissuer';
const CLUSTER_REPO = 'catalog.cattle.io.clusterrepo';
const APP = 'catalog.cattle.io.app';
const PROJECT_ANNOTATION = 'field.cattle.io/projectId';

function check(id: CheckId, state: CheckState, reason: string, args?: Record<string, string>): Check {
  return args ? {
    id, state, reason, args
  } : {
    id, state, reason
  };
}

function ssoCheck(id: CheckId, state: CheckState, reason: string, args?: Record<string, string>): Check {
  return { ...check(id, state, reason, args), sso: true };
}

const names = (items: Named[]) => items.map((item) => item.metadata.name).sort((a, b) => a.localeCompare(b));

const annotated = (item: Named, keys: string[]) => keys.some((key) => item.metadata.annotations?.[key] === 'true');

/** The sorted names with the first one that matches put in front */
function defaultFirst(items: Named[], isDefault: (item: Named) => boolean): string[] {
  const all = names(items);
  const chosen = items.filter(isDefault).map((item) => item.metadata.name).sort((a, b) => a.localeCompare(b))[0];

  return chosen ? [chosen, ...all.filter((name) => name !== chosen)] : all;
}

async function setting(store: StoreLike, id: string): Promise<string | undefined> {
  return (await findIfVisible<{ value?: string }>(store, 'management', SETTING, id))?.value || undefined;
}

/** A feature flag's effective value, as Rancher reads it: a locked value, then the value, then the default */
export function featureEnabled(feature: { spec?: { value?: boolean | null }, status?: { default?: boolean, lockedValue?: boolean | null } } | undefined): boolean {
  const locked = feature?.status?.lockedValue;
  const value = feature?.spec?.value;

  if (locked !== null && locked !== undefined) {
    return locked;
  }

  return value !== null && value !== undefined ? value : feature?.status?.default === true;
}

const grantsClusterList = (rules: Rule[] = []) => rules.some((rule) => ['postgresql.cnpg.io', '*'].some((group) => rule.apiGroups?.includes(group)) &&
  ['clusters', '*'].some((resource) => rule.resources?.includes(resource)) &&
  ['list', '*'].some((verb) => rule.verbs?.includes(verb)));

/**
 * Whether project members can list CloudNativePG Clusters: Rancher's Project Member role inherits
 * the edit ClusterRole and Read-only inherits view, and the CloudNativePG chart adds its rules to
 * them only with rbac.aggregateClusterRoles. Without it the Databases page stays empty for them.
 */
export async function aggregationCheck(store: StoreLike): Promise<Check> {
  const [view, edit] = await Promise.all(['view', 'edit'].map((id) => findIfVisible<{ rules?: Rule[] }>(store, 'cluster', CLUSTER_ROLE, id)));

  if (!view || !edit) {
    return check('aggregation', 'warning', 'unknown');
  }

  return grantsClusterList(view.rules) && grantsClusterList(edit.rules) ? check('aggregation', 'ok', 'ok') : check('aggregation', 'warning', 'off');
}

/** The newest chart version with Rancher mode in a ClusterRepo of this cluster */
export async function chartCheck(store: StoreLike, repoName: string): Promise<{ check: Check, chart?: ChartVersion }> {
  const repo = await findIfVisible<{ links?: { index?: string } }>(store, 'cluster', CLUSTER_REPO, repoName);

  if (!repo) {
    return { check: check('chart', 'error', 'noRepo', { repo: repoName }) };
  }

  let entries: ChartVersion[] | undefined;

  try {
    if (!repo.links?.index) {
      throw new Error('no index link');
    }

    const index = await store.dispatch('cluster/request', {
      url: repo.links.index, method: 'get', redirectUnauthorized: false
    }) as { entries?: Record<string, ChartVersion[]> };

    entries = index?.entries?.[CHART_NAME];
  } catch {
    return { check: check('chart', 'error', 'unreadable', { repo: repoName }) };
  }

  const { chosen, newest } = pickChartVersion(entries);

  if (chosen) {
    return {
      check: check('chart', 'ok', 'ok', {
        repo: repoName, version: chosen.version, appVersion: chosen.appVersion as string
      }),
      chart: chosen
    };
  }

  return {
    check: newest ? check('chart', 'error', 'tooOld', {
      repo: repoName, newest: newest.version, newestApp: newest.appVersion || '', min: MIN_CHART_VERSION, minApp: MIN_APP_VERSION
    }) : check('chart', 'error', 'noChart', { repo: repoName })
  };
}

async function installedCheck(store: StoreLike, cluster: string): Promise<Check> {
  if (store.getters['cluster/schemaFor'](APP)) {
    try {
      await store.dispatch('cluster/find', { type: APP, id: `${ STUDIO_NAMESPACE }/${ RELEASE_NAME }` });

      return check('installed', 'error', 'installed', { namespace: STUDIO_NAMESPACE, name: RELEASE_NAME });
    } catch (err) {
      if (statusOf(err) !== 404) {
        return check('installed', 'error', 'unknown');
      }
    }
  }

  const { link } = selectStudioLink(await findStudioLinks(store));

  if (link) {
    return check('installed', 'error', 'linked', { namespace: link.namespace });
  }

  // A record without an app is what a failed uninstall leaves; Settings removes it
  try {
    const record = await kubeGet(store, cluster, `/api/v1/namespaces/${ STUDIO_NAMESPACE }/configmaps/${ RECORD_CONFIGMAP }`);

    return record ? check('installed', 'error', 'leftover', { namespace: STUDIO_NAMESPACE, name: RECORD_CONFIGMAP }) : check('installed', 'ok', 'ok');
  } catch {
    return check('installed', 'error', 'unknown');
  }
}

/**
 * Whether the signed-in user can do the single sign-on step: create the OIDC client on Rancher's
 * local cluster and read the secret Rancher generates for it, which only an administrator can.
 */
export async function oidcAdminCheck(store: StoreLike): Promise<Check> {
  const allowed = await canI(store, LOCAL_CLUSTER, {
    group: 'management.cattle.io', resource: 'oidcclients', verb: 'create'
  }) &&
    await canI(store, LOCAL_CLUSTER, {
      namespace: OIDC_CLIENT_SECRETS_NAMESPACE, resource: 'secrets', verb: 'get'
    });

  return allowed ? ssoCheck('oidcAdmin', 'ok', 'ok') : ssoCheck('oidcAdmin', 'warning', 'notAdmin');
}

/** The cluster's OIDC client must not exist yet: the wizard never takes over a client it did not create */
export async function oidcClientCheck(store: StoreLike, cluster: string): Promise<Check> {
  const name = oidcClientName(cluster);

  try {
    const existing = await kubeGet(store, LOCAL_CLUSTER, `/apis/management.cattle.io/v3/oidcclients/${ encodeURIComponent(name) }`);

    return existing ? ssoCheck('oidcClient', 'error', 'exists', { name }) : ssoCheck('oidcClient', 'ok', 'ok', { name });
  } catch {
    return ssoCheck('oidcClient', 'error', 'unknown', { name });
  }
}

/** Single sign-on's own checks; the OIDC client is checked only for someone who could create it */
export async function ssoChecks(store: StoreLike, cluster: string, serverUrl: string | undefined): Promise<{ checks: Check[], canUseSso: boolean }> {
  const feature = await findIfVisible<Parameters<typeof featureEnabled>[0]>(store, 'management', FEATURE, 'oidc-provider');
  let provider = ssoCheck('oidcProvider', 'ok', 'ok');

  if (!featureEnabled(feature)) {
    provider = ssoCheck('oidcProvider', 'warning', 'off');
  } else if (!serverUrl) {
    provider = ssoCheck('oidcProvider', 'warning', 'noServerUrl');
  }

  const admin = await oidcAdminCheck(store);
  const checks = [provider, admin, ...(admin.state === 'ok' ? [await oidcClientCheck(store, cluster)] : [])];

  return { checks, canUseSso: checks.length === 3 && checks.every((item) => item.state === 'ok') };
}

function versionCheck(serverVersion: string | undefined): Check {
  const line = rancherLine(serverVersion);
  const args = { version: serverVersion || '' };

  if (!line) {
    return check('version', 'warning', 'unknown', args);
  }

  return line.major > 2 || line.minor >= 15 ? check('version', 'ok', 'ok', args) : check('version', 'warning', 'old', args);
}

function namespaceCheck(namespaces: Named[]): { check: Check, exists: boolean } {
  const studio = namespaces.find((item) => item.metadata.name === STUDIO_NAMESPACE);
  const args = { namespace: STUDIO_NAMESPACE };

  if (!studio) {
    return { check: check('namespace', 'ok', 'new', args), exists: false };
  }

  return { check: studio.metadata.annotations?.[PROJECT_ANNOTATION] ? check('namespace', 'error', 'inProject', args) : check('namespace', 'ok', 'existing', args), exists: true };
}

/** Everything F6 checks before it offers the install, read as the signed-in user */
export async function runPreflight(store: StoreLike, cluster: string, repoName = DEFAULT_REPO): Promise<PreflightResult> {
  const owner = await canI(store, cluster, {
    verb: '*', group: '*', resource: '*'
  });

  if (!owner) {
    return {
      checks: [check('owner', 'error', 'notOwner')], canInstall: false, canUseSso: false, scopes: [], ingressClasses: [], clusterIssuers: [], namespaces: [], repos: [], repo: repoName, namespaceExists: false
    };
  }

  const [serverVersion, serverUrl, cacerts] = await Promise.all(['server-version', 'server-url', 'cacerts'].map((id) => setting(store, id)));
  const [ingressClasses, storageClasses, clusterIssuers, namespaces, repos] = await Promise.all([INGRESS_CLASS, STORAGE_CLASS, CLUSTER_ISSUER, 'namespace', CLUSTER_REPO]
    .map((type) => findAllIfVisible<Named>(store, type)));
  const ingress = defaultFirst(ingressClasses, (item) => annotated(item, ['ingressclass.kubernetes.io/is-default-class']));
  const storage = storageClasses.filter((item) => annotated(item, ['storageclass.kubernetes.io/is-default-class', 'storageclass.beta.kubernetes.io/is-default-class']));
  const studioNamespace = namespaceCheck(namespaces);
  const chart = await chartCheck(store, repoName);
  const sso = await ssoChecks(store, cluster, serverUrl);

  const checks = [
    check('owner', 'ok', 'ok'),
    versionCheck(serverVersion),
    store.getters['cluster/schemaFor'](CNPG_CLUSTER_TYPE) ? check('cnpg', 'ok', 'ok') : check('cnpg', 'error', 'missing'),
    await aggregationCheck(store),
    ingress.length ? check('ingressClass', 'ok', 'ok', { name: ingress[0] }) : check('ingressClass', 'error', 'none'),
    storage.length ? check('storageClass', 'ok', 'ok', { name: names(storage)[0] }) : check('storageClass', 'error', 'none'),
    studioNamespace.check,
    await installedCheck(store, cluster),
    chart.check,
    ...sso.checks,
  ];

  return {
    checks,
    canInstall:      !checks.some((item) => !item.sso && item.state === 'error'),
    canUseSso:       sso.canUseSso,
    serverUrl,
    serverVersion,
    scopes:          oidcScopes(rancherLine(serverVersion)),
    cacerts,
    ingressClasses:  ingress,
    clusterIssuers:  names(clusterIssuers),
    namespaces:      names(namespaces).filter((name) => name !== STUDIO_NAMESPACE),
    repos:           defaultFirst(repos, (item) => item.metadata.name === DEFAULT_REPO),
    repo:            repoName,
    chart:           chart.chart,
    namespaceExists: studioNamespace.exists,
  };
}
