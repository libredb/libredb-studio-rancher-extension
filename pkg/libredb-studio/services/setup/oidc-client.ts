import type { StoreLike } from '../types';
import { StepFailure } from './failure';
import { kube, kubeGet, LOCAL_CLUSTER } from './k8s';
import {
  MANAGED_LABELS, OIDC_CLIENT_ID_KEY, OIDC_CLIENT_SECRET_KEY, OIDC_CLIENT_SECRET_SOURCE_KEY, OIDC_CLIENT_SECRETS_NAMESPACE, OIDC_SECRET, STUDIO_NAMESPACE
} from './names';
import type { SetupRecord, SsoRecord } from './values';
import { waitFor, WaitOptions } from './wait';

/**
 * Studio as an OIDC client of Rancher (design section 6.4 steps 5 and 6). Creating the client and
 * reading its secret both need a Rancher administrator, and both happen on Rancher's local cluster.
 */

/** Studio never asks for offline_access, so no refresh token is issued; 300 only bounds a mistake */
const TOKEN_LIFETIME_SECONDS = 300;
const CLIENT_TIMEOUT_MS = 60000;
const CLIENT_POLL_MS = 1000;

export function oidcClientPath(name: string): string {
  return `/apis/management.cattle.io/v3/oidcclients/${ encodeURIComponent(name) }`;
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
 * Reads the client's secret once, as Rancher stores it, and writes the client id and secret straight
 * into Studio's own Secret. The secret is never decoded, kept, shown or logged: it lives in this
 * function only, and a failure here is reported by its status alone.
 */
export async function copyClientSecret(store: StoreLike, cluster: string, clientId: string, options: WaitOptions): Promise<void> {
  const source = await waitFor(() => kubeGet<{ data?: Record<string, string> }>(store, LOCAL_CLUSTER,
    `/api/v1/namespaces/${ OIDC_CLIENT_SECRETS_NAMESPACE }/secrets/${ encodeURIComponent(clientId) }`), CLIENT_POLL_MS, CLIENT_TIMEOUT_MS, options);
  const secret = source?.data?.[OIDC_CLIENT_SECRET_SOURCE_KEY];

  if (!secret) {
    throw new StepFailure('noClientSecret');
  }

  await kube(store, cluster, 'post', `/api/v1/namespaces/${ STUDIO_NAMESPACE }/secrets`, {
    apiVersion: 'v1',
    kind:       'Secret',
    metadata:   { name: OIDC_SECRET, labels: { ...MANAGED_LABELS } },
    type:       'Opaque',
    data:       { [OIDC_CLIENT_ID_KEY]: btoa(clientId), [OIDC_CLIENT_SECRET_KEY]: secret },
  });
}
