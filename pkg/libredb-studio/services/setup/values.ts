import { CERT_MANAGER_TLS_SECRET, OIDC_SECRET, RANCHER_CA_CONFIGMAP, RANCHER_CA_KEY } from './names';

/** Where the ingress certificate comes from */
export type TlsChoice = { source: 'secret', secretName: string } | { source: 'cert-manager', clusterIssuer: string };

/** Single sign-on through Rancher's OIDC provider, as the wizard registered it */
export interface SsoRecord {
  /** The OIDCClient on Rancher's local cluster */
  client: string;
  /** <server-url>/oidc */
  issuer: string;
  scope: string;
  /** Whether Rancher's CA was copied into Studio's namespace for NODE_EXTRA_CA_CERTS */
  rancherCA: boolean;
}

/**
 * What the wizard was told, kept in Studio's namespace without any secret. Rancher no longer keeps
 * an app's values on the app, and an upgrade with values replaces them all, so the settings page
 * rebuilds the whole set from this record.
 */
export interface SetupRecord {
  version: 1;
  cluster: string;
  release: { namespace: string, name: string, repo: string, chart: string, chartVersion: string };
  host: string;
  ingressClassName: string;
  tls: TlsChoice;
  /** The namespaces whose CloudNativePG databases Studio discovers */
  namespaces: string[];
  /** Absent: Studio's own sign-in */
  sso?: SsoRecord;
  /** Whether the wizard created Studio's namespace, which decides whether uninstall removes it */
  createdNamespace: boolean;
}

const CA_DIR = '/etc/libredb/rancher-ca';

/** How often the browser rereads the managed list, discovered databases included */
const SEED_CACHE_TTL_MS = 10000;
/** How long Studio keeps an access review's answer */
const REVIEW_CACHE_SECONDS = 15;
/** Signing out of Rancher reaches Studio only when its session ends */
const SESSION_TTL_SECONDS = 900;

function ingressValues({ host, ingressClassName, tls }: SetupRecord): Record<string, unknown> {
  return {
    enabled:     true,
    className:   ingressClassName,
    annotations: tls.source === 'cert-manager' ? { 'cert-manager.io/cluster-issuer': tls.clusterIssuer } : {},
    hosts:       [{ host, paths: [{ path: '/', pathType: 'Prefix' }] }],
    tls:         [{ secretName: tls.source === 'secret' ? tls.secretName : CERT_MANAGER_TLS_SECRET, hosts: [host] }],
  };
}

function caValues(): Record<string, unknown> {
  return {
    extraVolumes:      [{ name: 'rancher-ca', configMap: { name: RANCHER_CA_CONFIGMAP } }],
    extraVolumeMounts: [{
      name: 'rancher-ca', mountPath: CA_DIR, readOnly: true
    }],
    extraEnv: [{ name: 'NODE_EXTRA_CA_CERTS', value: `${ CA_DIR }/${ RANCHER_CA_KEY }` }],
  };
}

/**
 * The chart values of Rancher mode. Custom connections are always off, so a user reaches only the
 * databases discovery lists, and the agent and MCP are off, which the access review requires.
 * Without single sign-on Studio keeps its own sign-in and lists discovered databases to its admin.
 */
export function chartValues(record: SetupRecord): Record<string, unknown> {
  const common = {
    agent:           { enabled: false },
    mcp:             { enabled: false },
    persistence:     { enabled: true },
    seedConnections: { cacheTTL: SEED_CACHE_TTL_MS },
    discovery:       { kubernetes: { enabled: true, namespaces: [...record.namespaces] } },
    rancher:         { navLink: { enabled: true } },
    ingress:         ingressValues(record),
  };

  if (!record.sso) {
    return { config: { allowCustomConnections: false }, ...common };
  }

  return {
    authProvider: 'oidc',
    config:       {
      allowCustomConnections: false,
      oidcIssuer:             record.sso.issuer,
      oidcScope:              record.sso.scope,
      oidcPrompt:             'omit',
      oidcAutoRedirect:       true,
      oidcRoleClaim:          '',
      sessionTtlSeconds:      SESSION_TTL_SECONDS,
    },
    secrets:      { oidcExistingSecret: OIDC_SECRET },
    accessReview: { enabled: true, cacheSeconds: REVIEW_CACHE_SECONDS },
    ...common,
    ...(record.sso.rancherCA ? caValues() : {}),
  };
}

export function serializeRecord(record: SetupRecord): string {
  return JSON.stringify(record);
}

/** JSON with every object's keys in order, so the same content always reads the same */
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => (item && typeof item === 'object' && !Array.isArray(item) ?
  Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item));

/** Whether two records say the same, whatever the order of their keys */
export function sameRecord(a: SetupRecord, b: SetupRecord): boolean {
  return canonical(a) === canonical(b);
}

const isText = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object';

function validTls(tls: unknown): boolean {
  return isObject(tls) && ((tls.source === 'secret' && isText(tls.secretName)) || (tls.source === 'cert-manager' && isText(tls.clusterIssuer)));
}

function validSso(sso: unknown): boolean {
  return sso === undefined || (isObject(sso) && isText(sso.client) && isText(sso.issuer) && isText(sso.scope) && typeof sso.rancherCA === 'boolean');
}

function validRelease(release: unknown): boolean {
  return isObject(release) && ['namespace', 'name', 'repo', 'chart', 'chartVersion'].every((key) => isText(release[key]));
}

/** The record from its ConfigMap, or nothing when it is missing or not one this version wrote */
export function parseRecord(text: string | undefined): SetupRecord | undefined {
  let record: unknown;

  try {
    record = JSON.parse(text || '');
  } catch {
    return undefined;
  }

  const valid = isObject(record) && record.version === 1 && isText(record.cluster) && validRelease(record.release) &&
    isText(record.host) && isText(record.ingressClassName) && validTls(record.tls) &&
    Array.isArray(record.namespaces) && record.namespaces.every(isText) && validSso(record.sso) &&
    typeof record.createdNamespace === 'boolean';

  return valid ? record as unknown as SetupRecord : undefined;
}
