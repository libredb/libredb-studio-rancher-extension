import type { SetupPlan } from './install';
import {
  CERT_MANAGER_TLS_SECRET, CHART_NAME, CHART_REPO, RELEASE_NAME, STUDIO_NAMESPACE, oidcClientName
} from './names';
import type { PreflightResult } from './preflight';
import { oidcIssuer, SetupRecord, TlsChoice } from './values';
import type { ChartVersion } from './versions';

/** What the cluster owner enters in F6 (design section 6.4 step 3) */
export interface SetupForm {
  host: string;
  ingressClassName: string;
  tlsSource: TlsChoice['source'];
  tlsSecretName: string;
  clusterIssuer: string;
  namespaces: string[];
  sso: boolean;
}

/** Per field, the l10n key under libredbStudio.setup.form.errors of what is wrong */
export type FormErrors = Partial<Record<'host' | 'ingressClassName' | 'tls' | 'namespaces' | 'sso', string>>;

/** The exporter takes at most this many namespaces */
const MAX_NAMESPACES = 256;

/** A DNS subdomain name: what a host name and a Secret name may be */
const LABEL = '[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?';
const SUBDOMAIN = new RegExp(`^${ LABEL }(\\.${ LABEL })*$`);

const isSubdomain = (name: string) => name.length <= 253 && SUBDOMAIN.test(name);

/** A bare DNS host name: no scheme, port, path, user, whitespace or wildcard */
export function isHostName(name: string): boolean {
  return isSubdomain(name);
}

/** What is wrong with a list of namespaces to discover, as an l10n key, or nothing */
export function namespacesError(namespaces: string[], known: string[]): string | undefined {
  const chosen = new Set(namespaces);

  if (!chosen.size || [...chosen].some((name) => !known.includes(name))) {
    return 'namespaces';
  }

  return chosen.size > MAX_NAMESPACES ? 'tooManyNamespaces' : undefined;
}

export function normalizeHost(host: string): string {
  return host.trim().toLowerCase();
}

export function initialForm(preflight: PreflightResult): SetupForm {
  return {
    host:             '',
    ingressClassName: preflight.ingressClasses[0] || '',
    tlsSource:        'secret',
    tlsSecretName:    CERT_MANAGER_TLS_SECRET,
    clusterIssuer:    preflight.clusterIssuers[0] || '',
    namespaces:       [],
    sso:              preflight.canUseSso,
  };
}

/**
 * What stops the form: a host name the chart's NavLink and the OIDC callback can use, a concrete
 * DNS name without scheme, port, path or wildcard; choices the cluster offers; at least one
 * namespace to discover; single sign-on only where the preflight allowed it.
 */
export function validateForm(form: SetupForm, preflight: PreflightResult): FormErrors {
  const errors: FormErrors = {};

  if (!isSubdomain(normalizeHost(form.host))) {
    errors.host = 'host';
  }

  if (!preflight.ingressClasses.includes(form.ingressClassName)) {
    errors.ingressClassName = 'ingressClass';
  }

  if (form.tlsSource === 'secret' && !isSubdomain(form.tlsSecretName.trim())) {
    errors.tls = 'tlsSecretName';
  } else if (form.tlsSource === 'cert-manager' && !preflight.clusterIssuers.includes(form.clusterIssuer)) {
    errors.tls = 'clusterIssuer';
  }

  const namespaces = namespacesError(form.namespaces, preflight.namespaces);

  if (namespaces) {
    errors.namespaces = namespaces;
  }

  if (form.sso && !preflight.canUseSso) {
    errors.sso = 'sso';
  }

  return errors;
}

/** The plan of a valid form: the record of what is set up, and Rancher's CA when single sign-on copies it */
export function planFrom(cluster: string, preflight: PreflightResult, form: SetupForm): SetupPlan {
  const tls: TlsChoice = form.tlsSource === 'secret' ? { source: 'secret', secretName: form.tlsSecretName.trim() } : { source: 'cert-manager', clusterIssuer: form.clusterIssuer };
  const record: SetupRecord = {
    version: 1,
    cluster,
    release: {
      namespace: STUDIO_NAMESPACE, name: RELEASE_NAME, repo: CHART_REPO, chart: CHART_NAME, chartVersion: (preflight.chart as ChartVersion).version
    },
    host:             normalizeHost(form.host),
    ingressClassName: form.ingressClassName,
    tls,
    namespaces:       [...new Set(form.namespaces)].sort((a, b) => a.localeCompare(b)),
    createdNamespace: !preflight.namespaceExists,
  };

  if (!form.sso) {
    return { cluster, record };
  }

  record.sso = {
    client:    oidcClientName(cluster),
    issuer:    oidcIssuer(preflight.serverUrl as string),
    scope:     preflight.scopes.join(' '),
    rancherCA: !!preflight.cacerts,
  };

  return {
    cluster, record, cacerts: preflight.cacerts
  };
}
