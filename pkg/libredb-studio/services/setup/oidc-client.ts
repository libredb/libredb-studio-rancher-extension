import type { StoreLike } from '../types';
import { StepFailure } from './failure';
import {
  kube, kubeGet, kubeMetadata, kubePatch, LOCAL_CLUSTER, ObjectMetadata
} from './k8s';
import {
  MANAGED_LABELS, OIDC_CLIENT_ID_KEY, OIDC_CLIENT_SECRET_KEY, OIDC_CLIENT_SECRET_SOURCE_KEY, OIDC_CLIENT_SECRETS_NAMESPACE, OIDC_SECRET, STUDIO_NAMESPACE
} from './names';
import type { SetupRecord, SsoRecord } from './values';
import { waitFor, WaitOptions } from './wait';

/**
 * Studio as an OIDC client of Rancher: the client, then its secret copied into Studio's own Secret,
 * and later a new secret in its place. Creating the client, regenerating its secret and reading it
 * all need a Rancher administrator, and all happen on Rancher's local cluster.
 */

/** Studio never asks for offline_access, so no refresh token is issued; 300 only bounds a mistake */
const TOKEN_LIFETIME_SECONDS = 300;
const CLIENT_TIMEOUT_MS = 60000;
const CLIENT_POLL_MS = 1000;

/**
 * Rancher's OIDC client controller (pkg/controllers/management/oidcprovider at v2.15.2) gives each
 * key of the client's Secret that this annotation names a newly generated secret, then removes the
 * annotation from the client. The old value stops working at once.
 */
export const REGENERATE_ANNOTATION = 'cattle.io/oidc-client-secret-regenerate';

/** An OIDC client as the settings read it */
export interface OidcClient {
  metadata?: { labels?: Record<string, string>, annotations?: Record<string, string>, resourceVersion?: string };
  status?: { clientID?: string };
}

export function oidcClientPath(name: string): string {
  return `/apis/management.cattle.io/v3/oidcclients/${ encodeURIComponent(name) }`;
}

/** The Secret Rancher keeps a client's secrets in, named after the client id */
function clientSecretsPath(clientId: string): string {
  return `/api/v1/namespaces/${ OIDC_CLIENT_SECRETS_NAMESPACE }/secrets/${ encodeURIComponent(clientId) }`;
}

/** Registers Studio's callback on Rancher's local cluster, with the scopes of the Rancher line */
export async function createOidcClient(store: StoreLike, record: SetupRecord, sso: SsoRecord): Promise<void> {
  await kube(store, LOCAL_CLUSTER, 'post', '/apis/management.cattle.io/v3/oidcclients', {
    apiVersion: 'management.cattle.io/v3',
    kind:       'OIDCClient',
    metadata:   { name: sso.client, labels: { ...MANAGED_LABELS } },
    spec:       {
      description:                   `LibreDB Studio in cluster ${ record.cluster }`,
      redirectURIs:                  [`https://${ record.host }/api/auth/oidc/callback`],
      tokenExpirationSeconds:        TOKEN_LIFETIME_SECONDS,
      refreshTokenExpirationSeconds: TOKEN_LIFETIME_SECONDS,
      scopes:                        sso.scope.split(' '),
    },
  });
}

/** Waits for the client id Rancher writes into the client's status */
export async function waitForClientId(store: StoreLike, name: string, options: WaitOptions): Promise<string> {
  const clientId = await waitFor(async() => {
    const client = await kubeGet<{ status?: { clientID?: string } }>(store, LOCAL_CLUSTER, oidcClientPath(name));

    return client?.status?.clientID || undefined;
  }, CLIENT_POLL_MS, CLIENT_TIMEOUT_MS, options);

  if (!clientId) {
    throw new StepFailure('noClientId');
  }

  return clientId;
}

/**
 * Has Rancher replace the secret Studio uses with a new one, on the version of the client that was
 * checked, and waits until Rancher wrote it: the annotation gone and the client's Secret changed.
 * Only metadata is read here, never a secret. Answers the client id.
 */
export async function regenerateClientSecret(store: StoreLike, name: string, client: OidcClient, options: WaitOptions): Promise<string> {
  const clientId = client.status?.clientID;

  if (!clientId) {
    throw new StepFailure('noClientId');
  }

  const before = await kubeMetadata(store, LOCAL_CLUSTER, clientSecretsPath(clientId));

  if (!before) {
    throw new StepFailure('noClientSecret');
  }

  await kubePatch(store, LOCAL_CLUSTER, oidcClientPath(name), { metadata: { resourceVersion: client.metadata?.resourceVersion, annotations: { [REGENERATE_ANNOTATION]: OIDC_CLIENT_SECRET_SOURCE_KEY } } });

  // Still pending while the annotation is there; once Rancher took it away, done only if the Secret changed
  const regenerated = await waitFor(async() => {
    const current = await kubeGet<OidcClient>(store, LOCAL_CLUSTER, oidcClientPath(name));

    if (current?.metadata?.annotations?.[REGENERATE_ANNOTATION] !== undefined) {
      return undefined;
    }

    const after = current && await kubeMetadata(store, LOCAL_CLUSTER, clientSecretsPath(clientId));

    return !!after && after.metadata?.resourceVersion !== before.metadata?.resourceVersion;
  }, CLIENT_POLL_MS, CLIENT_TIMEOUT_MS, options);

  if (!regenerated) {
    throw new StepFailure('notRegenerated');
  }

  return clientId;
}

/**
 * Reads the client's secret once, as Rancher stores it, and writes the client id and secret straight
 * into Studio's own Secret: a new one, or over the version of an existing one that was checked. The
 * secret is never decoded, kept, shown or logged: it lives in this function only, and a failure here
 * is reported by its status alone.
 */
export async function copyClientSecret(store: StoreLike, cluster: string, clientId: string, options: WaitOptions, replacing?: ObjectMetadata): Promise<void> {
  const source = await waitFor(() => kubeGet<{ data?: Record<string, string> }>(store, LOCAL_CLUSTER, clientSecretsPath(clientId)),
    CLIENT_POLL_MS, CLIENT_TIMEOUT_MS, options);
  const secret = source?.data?.[OIDC_CLIENT_SECRET_SOURCE_KEY];

  if (!secret) {
    throw new StepFailure('noClientSecret');
  }

  const secrets = `/api/v1/namespaces/${ STUDIO_NAMESPACE }/secrets`;
  const metadata = replacing ? {
    name: OIDC_SECRET, labels: { ...MANAGED_LABELS }, resourceVersion: replacing.metadata?.resourceVersion
  } : { name: OIDC_SECRET, labels: { ...MANAGED_LABELS } };
  const body = {
    apiVersion: 'v1',
    kind:       'Secret',
    metadata,
    type:       'Opaque',
    data:       { [OIDC_CLIENT_ID_KEY]: btoa(clientId), [OIDC_CLIENT_SECRET_KEY]: secret },
  };

  await (replacing ? kube(store, cluster, 'put', `${ secrets }/${ OIDC_SECRET }`, body) : kube(store, cluster, 'post', secrets, body));
}
