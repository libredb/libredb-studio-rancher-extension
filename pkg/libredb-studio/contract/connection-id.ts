import { sha256 } from '@shell/utils/crypto';

/** Studio's rule for a connection id */
export const STUDIO_ID_RULE = /^[a-z0-9-]{1,64}$/;

/**
 * The id Studio lists a discovered database under: k8s-<kind slug>-<first 12 hex characters of
 * sha256("<namespace>/<name>")>. The cluster is not part of it, because one Studio serves one cluster.
 */
export function connectionId(slug: string, namespace: string, name: string): string {
  const digest = String(sha256(`${ namespace }/${ name }`, 'hex', undefined));

  return `k8s-${ slug }-${ digest.slice(0, 12) }`;
}

/** The link that opens the connection in Studio; Studio lists it as seed:<id> */
export function studioLink(toURL: string, id: string): string {
  return `${ toURL.replace(/\/+$/, '') }/?connection=${ encodeURIComponent(`seed:${ id }`) }`;
}
