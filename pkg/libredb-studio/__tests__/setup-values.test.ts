import {
  chartTakesAllKinds, compareVersions, parseVersion, rancherLine, oidcScopes, pickChartVersion, MIN_CHART_VERSION, MIN_APP_VERSION, MIN_KINDS_CHART_VERSION
} from '../services/setup/versions';
import {
  chartValues, oidcIssuer, parseRecord, sameRecord, serializeRecord, SetupRecord, DISCOVERY_KINDS
} from '../services/setup/values';
import {
  STUDIO_NAMESPACE, RELEASE_NAME, CHART_NAME, OIDC_SECRET, RANCHER_CA_CONFIGMAP, RECORD_CONFIGMAP, CHART_REPO, chartRepo, oidcClientName
} from '../services/setup/names';

describe('versions', () => {
  it('reads major, minor, patch and prerelease, with or without a leading v', () => {
    expect(parseVersion('v2.15.2')).toStrictEqual({
      major: 2, minor: 15, patch: 2, prerelease: []
    });
    expect(parseVersion('1.2.0-rc.1+build.5')).toStrictEqual({
      major: 1, minor: 2, patch: 0, prerelease: ['rc', '1']
    });
    expect(parseVersion('1.2')).toBeUndefined();
    expect(parseVersion('dev')).toBeUndefined();
    expect(parseVersion(undefined)).toBeUndefined();
  });

  it('compares numerically and puts a prerelease before its release', () => {
    expect(compareVersions('0.1.107', '0.1.107')).toBe(0);
    expect(compareVersions('0.1.108', '0.1.107')).toBeGreaterThan(0);
    expect(compareVersions('0.1.99', '0.1.107')).toBeLessThan(0);
    expect(compareVersions('0.2.0', '0.1.107')).toBeGreaterThan(0);
    expect(compareVersions('2.0.0', '1.9.9')).toBeGreaterThan(0);
    expect(compareVersions('v2.15.2', '2.15.2')).toBe(0);
    expect(compareVersions('1.2.0+build', '1.2.0')).toBe(0);
    expect(compareVersions('1.2.0-rc.1', '1.2.0')).toBeLessThan(0);
    expect(compareVersions('1.2.0', '1.2.0-rc.1')).toBeGreaterThan(0);
    expect(compareVersions('1.2.0-rc.2', '1.2.0-rc.10')).toBeLessThan(0);
    expect(compareVersions('1.2.0-alpha', '1.2.0-1')).toBeGreaterThan(0);
    expect(compareVersions('1.2.0-1', '1.2.0-alpha')).toBeLessThan(0);
    expect(compareVersions('1.2.0-beta', '1.2.0-alpha')).toBeGreaterThan(0);
    expect(compareVersions('1.2.0-alpha', '1.2.0-beta')).toBeLessThan(0);
    expect(compareVersions('1.2.0-rc', '1.2.0-rc.1')).toBeLessThan(0);
    expect(compareVersions('1.2.0-rc.1', '1.2.0-rc')).toBeGreaterThan(0);
  });

  it('refuses to compare what is not a version', () => {
    expect(() => compareVersions('dev', '1.0.0')).toThrow('Not a version: dev');
    expect(() => compareVersions('1.0.0', 'head')).toThrow('Not a version: head');
  });

  it('reads the Rancher line from the server-version setting', () => {
    expect(rancherLine('v2.15.2')).toStrictEqual({ major: 2, minor: 15 });
    expect(rancherLine('v2.15-head')).toStrictEqual({ major: 2, minor: 15 });
    expect(rancherLine('v2.16.0-rc3')).toStrictEqual({ major: 2, minor: 16 });
    expect(rancherLine('head')).toBeUndefined();
    expect(rancherLine(undefined)).toBeUndefined();
  });

  it('asks for groups from Rancher 2.15, and only for openid and profile before', () => {
    expect(oidcScopes({ major: 2, minor: 15 })).toStrictEqual(['openid', 'profile', 'groups']);
    expect(oidcScopes({ major: 2, minor: 16 })).toStrictEqual(['openid', 'profile', 'groups']);
    expect(oidcScopes({ major: 3, minor: 0 })).toStrictEqual(['openid', 'profile', 'groups']);
    expect(oidcScopes({ major: 2, minor: 14 })).toStrictEqual(['openid', 'profile']);
    expect(oidcScopes({ major: 1, minor: 99 })).toStrictEqual(['openid', 'profile']);
    // The extension declares 2.15 as its floor, so an unknown build is taken as a current line
    expect(oidcScopes(undefined)).toStrictEqual(['openid', 'profile', 'groups']);
  });

  it('needs a chart with Rancher mode and an application after 1.1.0', () => {
    expect(MIN_CHART_VERSION).toBe('0.1.107');
    expect(MIN_APP_VERSION).toBe('1.1.1');
  });

  it('takes discovery kinds other than CloudNativePG only from chart 0.1.113, whose schema allows them', () => {
    expect(MIN_KINDS_CHART_VERSION).toBe('0.1.113');
    expect(chartTakesAllKinds('0.1.113')).toBe(true);
    expect(chartTakesAllKinds('0.2.0')).toBe(true);
    expect(chartTakesAllKinds('0.1.112')).toBe(false);
    expect(chartTakesAllKinds('0.1.113-rc.1')).toBe(false);
    expect(chartTakesAllKinds('not-a-version')).toBe(false);
    expect(chartTakesAllKinds(undefined)).toBe(false);
  });

  it('picks the newest chart version with Rancher mode, and names the newest one either way', () => {
    const entries = [
      { version: '0.1.104', appVersion: '1.1.0' },
      { version: '0.1.110', appVersion: '1.2.0' },
      { version: '0.1.109', appVersion: '1.2.0' },
      { version: '0.1.111-rc.1', appVersion: '1.3.0-rc.1' },
      { version: 'not-a-version', appVersion: '9.9.9' },
    ];

    expect(pickChartVersion(entries)).toStrictEqual({
      chosen: { version: '0.1.110', appVersion: '1.2.0' },
      newest: { version: '0.1.110', appVersion: '1.2.0' },
    });
  });

  it('picks nothing when no version has Rancher mode or a later application', () => {
    expect(pickChartVersion([
      { version: '0.1.104', appVersion: '1.1.0' },
      { version: '0.1.107', appVersion: '1.1.0' },
      { version: '0.1.106', appVersion: '1.2.0' },
    ])).toStrictEqual({ chosen: undefined, newest: { version: '0.1.107', appVersion: '1.1.0' } });
    expect(pickChartVersion([{ version: '0.1.108' }])).toStrictEqual({ chosen: undefined, newest: { version: '0.1.108', appVersion: undefined } });
    expect(pickChartVersion([])).toStrictEqual({ chosen: undefined, newest: undefined });
    expect(pickChartVersion(undefined)).toStrictEqual({ chosen: undefined, newest: undefined });
  });
});

describe('names', () => {
  it('keeps Studio in its own namespace and release, from our chart', () => {
    expect(STUDIO_NAMESPACE).toBe('libredb-studio');
    expect(RELEASE_NAME).toBe('libredb-studio');
    expect(CHART_NAME).toBe('libredb-studio');
    expect(OIDC_SECRET).toBe('libredb-studio-oidc');
    expect(RANCHER_CA_CONFIGMAP).toBe('libredb-studio-rancher-ca');
    expect(RECORD_CONFIGMAP).toBe('libredb-studio-setup');
  });

  it('installs and upgrades from Rancher\'s Partners repository only, unless a development build names another', () => {
    expect(CHART_REPO).toBe('rancher-partner-charts');
    expect(chartRepo(undefined)).toBe('rancher-partner-charts');
    expect(chartRepo('')).toBe('rancher-partner-charts');
    expect(chartRepo('rl-lab-charts')).toBe('rl-lab-charts');
  });

  it('names the OIDC client after the cluster', () => {
    expect(oidcClientName('c-m-1a2b3c')).toBe('libredb-studio-c-m-1a2b3c');
  });
});

describe('chart values', () => {
  const base: SetupRecord = {
    version: 1,
    cluster: 'c-m-1',
    release: {
      namespace: 'libredb-studio', name: 'libredb-studio', repo: 'rancher-partner-charts', chart: 'libredb-studio', chartVersion: '0.1.110'
    },
    host:             'studio.example.com',
    ingressClassName: 'nginx',
    tls:              { source: 'secret', secretName: 'studio-tls' },
    namespaces:       ['team-a', 'team-b'],
    createdNamespace: true,
  };
  const sso = {
    client: 'libredb-studio-c-m-1', issuer: 'https://rancher.example.com/oidc', scope: 'openid profile groups', rancherCA: true
  };

  it('installs with single sign-on in Rancher mode, the access review on and every other way in off', () => {
    expect(chartValues({ ...base, sso })).toStrictEqual({
      authProvider: 'oidc',
      config:       {
        allowCustomConnections: false,
        oidcIssuer:             'https://rancher.example.com/oidc',
        oidcScope:              'openid profile groups',
        oidcPrompt:             'omit',
        oidcAutoRedirect:       true,
        oidcRoleClaim:          '',
        sessionTtlSeconds:      900,
      },
      secrets:         { oidcExistingSecret: 'libredb-studio-oidc' },
      accessReview:    { enabled: true, cacheSeconds: 15 },
      agent:           { enabled: false },
      mcp:             { enabled: false },
      persistence:     { enabled: true },
      seedConnections: { cacheTTL: 10000 },
      discovery:       { kubernetes: { enabled: true, namespaces: ['team-a', 'team-b'] } },
      rancher:         { navLink: { enabled: true } },
      ingress:         {
        enabled:     true,
        className:   'nginx',
        annotations: {},
        hosts:       [{ host: 'studio.example.com', paths: [{ path: '/', pathType: 'Prefix' }] }],
        tls:         [{ secretName: 'studio-tls', hosts: ['studio.example.com'] }],
      },
      extraVolumes:      [{ name: 'rancher-ca', configMap: { name: 'libredb-studio-rancher-ca' } }],
      extraVolumeMounts: [{
        name: 'rancher-ca', mountPath: '/etc/libredb/rancher-ca', readOnly: true
      }],
      extraEnv: [{ name: 'NODE_EXTRA_CA_CERTS', value: '/etc/libredb/rancher-ca/ca.crt' }],
    });
  });

  it('mounts no CA when Rancher has none of its own', () => {
    const values = chartValues({ ...base, sso: { ...sso, rancherCA: false } });

    expect(values).not.toHaveProperty('extraVolumes');
    expect(values).not.toHaveProperty('extraVolumeMounts');
    expect(values).not.toHaveProperty('extraEnv');
  });

  it('finds Rancher\'s OIDC issuer under its server URL', () => {
    expect(oidcIssuer('https://rancher.example.com')).toBe('https://rancher.example.com/oidc');
    expect(oidcIssuer('https://rancher.example.com//')).toBe('https://rancher.example.com/oidc');
  });

  it('installs with Studio\'s own sign-in and no review without single sign-on', () => {
    expect(chartValues(base)).toStrictEqual({
      config:          { allowCustomConnections: false },
      agent:           { enabled: false },
      mcp:             { enabled: false },
      persistence:     { enabled: true },
      seedConnections: { cacheTTL: 10000 },
      discovery:       { kubernetes: { enabled: true, namespaces: ['team-a', 'team-b'] } },
      rancher:         { navLink: { enabled: true } },
      ingress:         {
        enabled:     true,
        className:   'nginx',
        annotations: {},
        hosts:       [{ host: 'studio.example.com', paths: [{ path: '/', pathType: 'Prefix' }] }],
        tls:         [{ secretName: 'studio-tls', hosts: ['studio.example.com'] }],
      },
    });
  });

  it('always switches custom connections off, so users reach only what the review allows', () => {
    expect((chartValues(base).config as Record<string, unknown>).allowCustomConnections).toBe(false);
    expect((chartValues({ ...base, sso }).config as Record<string, unknown>).allowCustomConnections).toBe(false);
  });

  it('asks a cert-manager ClusterIssuer for the certificate', () => {
    const { ingress } = chartValues({ ...base, tls: { source: 'cert-manager', clusterIssuer: 'letsencrypt' } }) as { ingress: Record<string, unknown> };

    expect(ingress.annotations).toStrictEqual({ 'cert-manager.io/cluster-issuer': 'letsencrypt' });
    expect(ingress.tls).toStrictEqual([{ secretName: 'libredb-studio-tls', hosts: ['studio.example.com'] }]);
  });

  it('names the CustomResourceDefinition each discovery kind needs, as Studio\'s chart lists the kinds', () => {
    expect(DISCOVERY_KINDS).toStrictEqual([
      { id: 'cnpg', crd: 'clusters.postgresql.cnpg.io' },
      { id: 'edbpg', crd: 'clusters.postgresql.k8s.enterprisedb.io' },
      { id: 'pgo', crd: 'postgresclusters.postgres-operator.crunchydata.com' },
      { id: 'mongo', crd: 'mongodbcommunity.mongodbcommunity.mongodb.com' },
    ]);
  });

  it('writes no kinds for a record without them, so the chart discovers CloudNativePG alone as before', () => {
    expect((chartValues(base) as { discovery: { kubernetes: Record<string, unknown> } }).discovery.kubernetes).not.toHaveProperty('kinds');
  });

  it('writes the kinds a record names, a copy of them, and CloudNativePG alone as charts before 0.1.113 accept it', () => {
    const record: SetupRecord = { ...base, kinds: ['cnpg', 'mongo'] };
    const values = chartValues(record) as { discovery: { kubernetes: Record<string, unknown> } };

    record.kinds?.push('pgo');
    expect(values.discovery.kubernetes).toStrictEqual({
      enabled: true, namespaces: ['team-a', 'team-b'], kinds: ['cnpg', 'mongo']
    });
    expect((chartValues({ ...base, kinds: ['cnpg'] }) as { discovery: { kubernetes: Record<string, unknown> } }).discovery.kubernetes.kinds).toStrictEqual(['cnpg']);
  });

  it('copies the namespace list, so a later change to the record does not reach built values', () => {
    const record = { ...base, namespaces: ['team-a'] };
    const values = chartValues(record) as { discovery: { kubernetes: { namespaces: string[] } } };

    record.namespaces.push('team-c');
    expect(values.discovery.kubernetes.namespaces).toStrictEqual(['team-a']);
  });
});

describe('setup record', () => {
  const record: SetupRecord = {
    version: 1,
    cluster: 'c-m-1',
    release: {
      namespace: 'libredb-studio', name: 'libredb-studio', repo: 'rancher-partner-charts', chart: 'libredb-studio', chartVersion: '0.1.110'
    },
    host:             'studio.example.com',
    ingressClassName: 'nginx',
    tls:              { source: 'cert-manager', clusterIssuer: 'letsencrypt' },
    namespaces:       ['team-a'],
    sso:              {
      client: 'libredb-studio-c-m-1', issuer: 'https://rancher.example.com/oidc', scope: 'openid profile groups', rancherCA: false
    },
    createdNamespace: false,
  };

  it('reads back what it wrote', () => {
    const local: SetupRecord = { ...record };

    delete local.sso;
    expect(parseRecord(serializeRecord(record))).toStrictEqual(record);
    expect(parseRecord(serializeRecord(local))).toStrictEqual(local);
    expect(parseRecord(serializeRecord({ ...record, kinds: ['cnpg', 'edbpg', 'pgo', 'mongo'] }))).toStrictEqual({ ...record, kinds: ['cnpg', 'edbpg', 'pgo', 'mongo'] });
  });

  it('tells a record that says the same from one that says something else, whatever the order of its keys', () => {
    const reversed = (value: unknown): unknown => (value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reversed(item)])) : value);

    expect(sameRecord(record, reversed(record) as SetupRecord)).toBe(true);
    expect(sameRecord(record, { ...record, sso: { ...record.sso!, rancherCA: true } })).toBe(false);
    expect(sameRecord(record, { ...record, namespaces: ['team-a', 'team-b'] })).toBe(false);
    expect(sameRecord(record, { ...record, namespaces: [] })).toBe(false);
    expect(sameRecord({ ...record, sso: undefined }, { ...record, sso: undefined })).toBe(true);
    expect(sameRecord({ ...record, sso: undefined }, record)).toBe(false);
    expect(sameRecord(record, { ...record, kinds: ['cnpg'] })).toBe(false);
  });

  it('refuses a record it cannot trust to rebuild the values from', () => {
    const variant = (change: Record<string, unknown>) => JSON.stringify({ ...record, ...change });

    expect(parseRecord(undefined)).toBeUndefined();
    expect(parseRecord('not json')).toBeUndefined();
    expect(parseRecord('null')).toBeUndefined();
    expect(parseRecord(variant({ version: 2 }))).toBeUndefined();
    expect(parseRecord(variant({ cluster: 7 }))).toBeUndefined();
    expect(parseRecord(variant({ release: null }))).toBeUndefined();
    expect(parseRecord(variant({ release: { ...record.release, chartVersion: 1 } }))).toBeUndefined();
    expect(parseRecord(variant({ host: '' }))).toBeUndefined();
    expect(parseRecord(variant({ ingressClassName: 3 }))).toBeUndefined();
    expect(parseRecord(variant({ tls: { source: 'other' } }))).toBeUndefined();
    expect(parseRecord(variant({ tls: { source: 'secret' } }))).toBeUndefined();
    expect(parseRecord(variant({ tls: { source: 'cert-manager', clusterIssuer: '' } }))).toBeUndefined();
    expect(parseRecord(variant({ namespaces: 'team-a' }))).toBeUndefined();
    expect(parseRecord(variant({ namespaces: ['team-a', 4] }))).toBeUndefined();
    expect(parseRecord(variant({ sso: { ...record.sso, rancherCA: 'yes' } }))).toBeUndefined();
    expect(parseRecord(variant({ sso: { ...record.sso, client: '' } }))).toBeUndefined();
    expect(parseRecord(variant({ createdNamespace: 'no' }))).toBeUndefined();
    expect(parseRecord(variant({ kinds: 'cnpg' }))).toBeUndefined();
    expect(parseRecord(variant({ kinds: [] }))).toBeUndefined();
    expect(parseRecord(variant({ kinds: ['cnpg', 'mysql'] }))).toBeUndefined();
    expect(parseRecord(variant({ kinds: ['cnpg', 'mongo', 'cnpg'] }))).toBeUndefined();
  });
});
