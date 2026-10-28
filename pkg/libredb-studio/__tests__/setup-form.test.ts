import {
  initialForm, namespacesError, normalizeHost, planFrom, validateForm, SetupForm
} from '../services/setup/form';
import { summarize, PreflightResult } from '../services/setup/preflight';
import { RANCHER_CA } from './helpers/cluster';

const PREFLIGHT: PreflightResult = {
  checks: [
    {
      id: 'owner', state: 'ok', reason: 'ok'
    },
    {
      id: 'chart', state: 'ok', reason: 'ok'
    },
    {
      id: 'oidcProvider', state: 'ok', reason: 'ok', sso: true
    },
  ],
  canInstall:      true,
  canUseSso:       true,
  serverUrl:       'https://rancher.example.com/',
  serverVersion:   'v2.15.2',
  scopes:          ['openid', 'profile', 'groups'],
  cacerts:         RANCHER_CA,
  ingressClasses:  ['traefik', 'nginx'],
  clusterIssuers:  ['letsencrypt'],
  namespaces:      ['team-a', 'team-b', 'team-c'],
  repo:            'rancher-partner-charts',
  chart:           { version: '0.1.110', appVersion: '1.2.0' },
  namespaceExists: false,
};

const FORM: SetupForm = {
  host:             'Studio.Example.com ',
  ingressClassName: 'nginx',
  tlsSource:        'secret',
  tlsSecretName:    'studio-tls',
  clusterIssuer:    'letsencrypt',
  namespaces:       ['team-b', 'team-a', 'team-b'],
  sso:              true,
};

describe('setup form', () => {
  it('starts from the default ingress class, a TLS Secret, the first ClusterIssuer, no namespace, and single sign-on where it can', () => {
    expect(initialForm(PREFLIGHT)).toStrictEqual({
      host:             '',
      ingressClassName: 'traefik',
      tlsSource:        'secret',
      tlsSecretName:    'libredb-studio-tls',
      clusterIssuer:    'letsencrypt',
      namespaces:       [],
      sso:              true,
    });
    expect(initialForm({
      ...PREFLIGHT, canUseSso: false, ingressClasses: [], clusterIssuers: []
    })).toMatchObject({
      ingressClassName: '', clusterIssuer: '', sso: false
    });
  });

  it('takes a host name in lower case without surrounding spaces', () => {
    expect(normalizeHost(' Studio.Example.COM ')).toBe('studio.example.com');
  });

  it('accepts a complete form', () => {
    expect(validateForm(FORM, PREFLIGHT)).toStrictEqual({});
    expect(validateForm({
      ...FORM, tlsSource: 'cert-manager', tlsSecretName: ''
    }, PREFLIGHT)).toStrictEqual({});
  });

  it.each([
    [''],
    ['https://studio.example.com'],
    ['studio.example.com:8443'],
    ['studio.example.com/path'],
    ['*.example.com'],
    ['-studio.example.com'],
    ['studio_one.example.com'],
    [`${ 'a'.repeat(64) }.example.com`],
    [`${ 'a.'.repeat(127) }com`],
  ])('refuses the host name %s', (host) => {
    expect(validateForm({ ...FORM, host }, PREFLIGHT)).toStrictEqual({ host: 'host' });
  });

  it('accepts a single-label host and long valid ones', () => {
    expect(validateForm({ ...FORM, host: 'studio' }, PREFLIGHT)).toStrictEqual({});
    expect(validateForm({ ...FORM, host: `${ 'a'.repeat(63) }.example.com` }, PREFLIGHT)).toStrictEqual({});
  });

  it('needs an ingress class the cluster has', () => {
    expect(validateForm({ ...FORM, ingressClassName: 'haproxy' }, PREFLIGHT)).toStrictEqual({ ingressClassName: 'ingressClass' });
  });

  it('needs a valid TLS Secret name, or a ClusterIssuer the cluster has', () => {
    expect(validateForm({ ...FORM, tlsSecretName: 'Not Valid' }, PREFLIGHT)).toStrictEqual({ tls: 'tlsSecretName' });
    expect(validateForm({ ...FORM, tlsSecretName: '' }, PREFLIGHT)).toStrictEqual({ tls: 'tlsSecretName' });
    expect(validateForm({
      ...FORM, tlsSource: 'cert-manager', clusterIssuer: 'other'
    }, PREFLIGHT)).toStrictEqual({ tls: 'clusterIssuer' });
  });

  it('needs between one and 256 namespaces the cluster has', () => {
    expect(validateForm({ ...FORM, namespaces: [] }, PREFLIGHT)).toStrictEqual({ namespaces: 'namespaces' });
    expect(validateForm({ ...FORM, namespaces: ['team-x'] }, PREFLIGHT)).toStrictEqual({ namespaces: 'namespaces' });

    const many = Array.from({ length: 257 }, (_, i) => `ns-${ i }`);

    expect(validateForm({ ...FORM, namespaces: many }, { ...PREFLIGHT, namespaces: many })).toStrictEqual({ namespaces: 'tooManyNamespaces' });
  });

  it('checks a namespace list on its own, as Settings does', () => {
    expect(namespacesError(['team-a', 'team-a'], ['team-a'])).toBeUndefined();
    expect(namespacesError([], ['team-a'])).toBe('namespaces');
    expect(namespacesError(['team-x'], ['team-a'])).toBe('namespaces');
  });

  it('refuses single sign-on the preflight did not allow', () => {
    expect(validateForm(FORM, { ...PREFLIGHT, canUseSso: false })).toStrictEqual({ sso: 'sso' });
    expect(validateForm({ ...FORM, sso: false }, { ...PREFLIGHT, canUseSso: false })).toStrictEqual({});
  });

  it('installs from the extension\'s own repository, whatever the preflight read', () => {
    expect(planFrom('c-m-1', { ...PREFLIGHT, repo: 'mirror' }, FORM).record.release.repo).toBe('rancher-partner-charts');
  });

  it('plans Rancher mode with single sign-on from the form and the preflight', () => {
    expect(planFrom('c-m-1', PREFLIGHT, FORM)).toStrictEqual({
      cluster: 'c-m-1',
      cacerts: RANCHER_CA,
      record:  {
        version: 1,
        cluster: 'c-m-1',
        release: {
          namespace: 'libredb-studio', name: 'libredb-studio', repo: 'rancher-partner-charts', chart: 'libredb-studio', chartVersion: '0.1.110'
        },
        host:             'studio.example.com',
        ingressClassName: 'nginx',
        tls:              { source: 'secret', secretName: 'studio-tls' },
        namespaces:       ['team-a', 'team-b'],
        sso:              {
          client: 'libredb-studio-c-m-1', issuer: 'https://rancher.example.com/oidc', scope: 'openid profile groups', rancherCA: true
        },
        createdNamespace: true,
      },
    });
  });

  it('plans without single sign-on, a cert-manager certificate and no CA', () => {
    const plan = planFrom('c-m-1', { ...PREFLIGHT, namespaceExists: true }, {
      ...FORM, sso: false, tlsSource: 'cert-manager'
    });

    expect(plan.cacerts).toBeUndefined();
    expect(plan.record.sso).toBeUndefined();
    expect(plan.record.tls).toStrictEqual({ source: 'cert-manager', clusterIssuer: 'letsencrypt' });
    expect(plan.record.createdNamespace).toBe(false);
  });

  it('copies no CA when Rancher has none of its own', () => {
    const plan = planFrom('c-m-1', { ...PREFLIGHT, cacerts: undefined }, FORM);

    expect(plan.record.sso?.rancherCA).toBe(false);
    expect(plan.cacerts).toBeUndefined();
  });
});

describe('preflight summary', () => {
  it('lets an error outside single sign-on stop the install, and single sign-on stop only itself', () => {
    expect(summarize([{
      id: 'owner', state: 'ok', reason: 'ok'
    }, {
      id: 'cnpg', state: 'error', reason: 'missing'
    }])).toStrictEqual({ canInstall: false });
    expect(summarize([{
      id: 'owner', state: 'ok', reason: 'ok'
    }, {
      id: 'oidcClient', state: 'error', reason: 'exists', sso: true
    }])).toStrictEqual({ canInstall: true });
  });
});
