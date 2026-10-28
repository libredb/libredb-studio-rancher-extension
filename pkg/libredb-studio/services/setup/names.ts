/**
 * The names the setup wizard (F6) and the settings page (F7) give what they create. One Studio
 * serves one cluster, so they are fixed rather than chosen.
 */

/** Studio's namespace, outside every project, so project members cannot read its Secrets */
export const STUDIO_NAMESPACE = 'libredb-studio';
export const RELEASE_NAME = 'libredb-studio';
export const CHART_NAME = 'libredb-studio';

/** Rancher's Partners chart repository, where our partner chart reaches every Rancher */
export const DEFAULT_REPO = 'rancher-partner-charts';

/**
 * The only ClusterRepo the extension installs and upgrades from, never one a record names. A
 * development or lab build may name another at build time (VUE_APP_LIBREDB_DEV_REPO, inlined by
 * the build); a release build does not.
 */
export function chartRepo(devRepo: string | undefined): string {
  return devRepo || DEFAULT_REPO;
}

export const CHART_REPO = chartRepo(process.env.VUE_APP_LIBREDB_DEV_REPO);

/** The Secret that holds only the OIDC client id and secret, under the chart's default keys */
export const OIDC_SECRET = 'libredb-studio-oidc';
export const OIDC_CLIENT_ID_KEY = 'oidc-client-id';
export const OIDC_CLIENT_SECRET_KEY = 'oidc-client-secret';

/** Rancher's CA, from the cacerts setting, for Studio's server-to-server calls to Rancher */
export const RANCHER_CA_CONFIGMAP = 'libredb-studio-rancher-ca';
export const RANCHER_CA_KEY = 'ca.crt';

/** The wizard's inputs, which the settings page rebuilds Studio's values from */
export const RECORD_CONFIGMAP = 'libredb-studio-setup';
export const RECORD_KEY = 'setup.json';

/** The certificate Secret cert-manager writes for a ClusterIssuer */
export const CERT_MANAGER_TLS_SECRET = 'libredb-studio-tls';

/** Rancher keeps every OIDC client's secrets in this namespace of its local cluster */
export const OIDC_CLIENT_SECRETS_NAMESPACE = 'cattle-oidc-client-secrets';
export const OIDC_CLIENT_SECRET_SOURCE_KEY = 'client-secret-1';

/**
 * On every object the wizard creates, as labels, and on the chart it installs, as annotations; the
 * extension deletes nothing that does not carry them.
 */
export const MANAGED_LABELS: Record<string, string> = {
  'app.kubernetes.io/managed-by': 'libredb-studio-rancher-extension',
  'app.kubernetes.io/part-of':    'libredb-studio',
};

/** Whether labels or annotations carry the extension's mark */
export function isManaged(marks: Record<string, string> | undefined): boolean {
  return Object.entries(MANAGED_LABELS).every(([key, value]) => marks?.[key] === value);
}

/** One OIDC client per cluster, on Rancher's local cluster */
export function oidcClientName(cluster: string): string {
  return `libredb-studio-${ cluster }`;
}
