import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import golden from '../../../tests/unit/fixtures/kubernetes-discovery-golden.json';
import goldenSource from '../../../tests/unit/fixtures/kubernetes-discovery-golden.source.json';
import { CNPG_CLUSTER_KIND, SUPPORTED_KINDS, kindFor } from '../contract/kinds';
import { connectionId, databaseLink, studioLink, STUDIO_ID_RULE } from '../contract/connection-id';

describe('contract table', () => {
  it('supports CloudNativePG Clusters only in the first release', () => {
    expect(SUPPORTED_KINDS).toStrictEqual([CNPG_CLUSTER_KIND]);
    expect(CNPG_CLUSTER_KIND.type).toBe('postgresql.cnpg.io.cluster');
    expect(CNPG_CLUSTER_KIND.slug).toBe('cnpg');
    expect(CNPG_CLUSTER_KIND.studioType).toBe('postgres');
  });

  it('finds a kind by its store type and refuses others', () => {
    expect(kindFor('postgresql.cnpg.io.cluster')).toBe(CNPG_CLUSTER_KIND);
    expect(kindFor('apps.deployment')).toBeUndefined();
  });

  it('names the CloudNativePG credential Secret <name>-app by default', () => {
    expect(CNPG_CLUSTER_KIND.credentialSecretName({ metadata: { namespace: 'a', name: 'db' } })).toBe('db-app');
    expect(CNPG_CLUSTER_KIND.credentialSecretName({ metadata: { namespace: 'a', name: 'db' }, spec: { bootstrap: { initdb: { secret: {} } } } })).toBe('db-app');
  });

  it('uses the user-supplied initdb Secret when set', () => {
    const resource = { metadata: { namespace: 'a', name: 'db' }, spec: { bootstrap: { initdb: { secret: { name: 'owner' } } } } };

    expect(CNPG_CLUSTER_KIND.credentialSecretName(resource)).toBe('owner');
  });
});

describe('connection summary', () => {
  it('names the read-write Service, port 5432 and CloudNativePG\'s default database and owner', () => {
    expect(CNPG_CLUSTER_KIND.connectionSummary({ metadata: { namespace: 'team-a', name: 'orders' } })).toStrictEqual({
      host: 'orders-rw.team-a.svc', port: 5432, database: 'app', user: 'app'
    });
  });

  it('takes the database from initdb, and the owner when set, else the database', () => {
    const summary = (initdb: Record<string, unknown>) => CNPG_CLUSTER_KIND.connectionSummary({ metadata: { namespace: 'p', name: 'db' }, spec: { bootstrap: { initdb } } });

    expect(summary({ database: 'billing' })).toMatchObject({ database: 'billing', user: 'billing' });
    expect(summary({ database: 'billing', owner: 'billing_owner' })).toMatchObject({ database: 'billing', user: 'billing_owner' });
  });

  it('never carries a password', () => {
    const resource = { metadata: { namespace: 'p', name: 'db' }, spec: { bootstrap: { initdb: { secret: { name: 'owner' } } } } };

    expect(Object.keys(CNPG_CLUSTER_KIND.connectionSummary(resource))).toStrictEqual(['host', 'port', 'database', 'user']);
  });
});

describe('connection id', () => {
  it('is k8s-<slug>-<first 32 hex of sha256("<namespace>/<name>")>', () => {
    const expected = createHash('sha256').update('ns-1/db-1').digest('hex').slice(0, 32);

    expect(connectionId('cnpg', 'ns-1', 'db-1')).toBe(`k8s-cnpg-${ expected }`);
  });

  it('fits the Studio id rule', () => {
    const id = connectionId('cnpg', 'a-very-long-namespace-name-that-is-still-valid', 'a-database');

    expect(id).toMatch(STUDIO_ID_RULE);
    expect(id.length).toBeLessThanOrEqual(64);
  });

  it('differs per namespace for the same name', () => {
    expect(connectionId('cnpg', 'team-a', 'db')).not.toBe(connectionId('cnpg', 'team-b', 'db'));
  });
});

describe('studio link', () => {
  it('appends ?connection=seed%3A<id> to the link, without a doubled slash', () => {
    expect(studioLink('https://studio.example.com', 'k8s-cnpg-0123456789abcdef0123456789abcdef')).toBe('https://studio.example.com/?connection=seed%3Ak8s-cnpg-0123456789abcdef0123456789abcdef');
    expect(studioLink('https://studio.example.com//', 'k8s-cnpg-0123456789abcdef0123456789abcdef')).toBe('https://studio.example.com/?connection=seed%3Ak8s-cnpg-0123456789abcdef0123456789abcdef');
  });
});

describe('database link', () => {
  it('is the Studio link of the resource\'s connection id', () => {
    expect(databaseLink('https://studio.example.com', CNPG_CLUSTER_KIND, { metadata: { namespace: 'team-a', name: 'orders' } }))
      .toBe(studioLink('https://studio.example.com', connectionId('cnpg', 'team-a', 'orders')));
  });
});

// Studio's fixture also holds the kinds this extension does not support yet; it checks the CloudNativePG cases
const cnpgCases = golden.cases.filter((c) => c.resource.apiVersion === 'postgresql.cnpg.io/v1' && c.resource.kind === 'Cluster');

describe('golden fixture', () => {
  it('holds the CloudNativePG cases', () => {
    expect(cnpgCases.map((c) => `${ c.resource.metadata.namespace }/${ c.resource.metadata.name }`)).toStrictEqual(['team-a/orders', 'team-b/analytics', 'prod/billing-db']);
  });

  it.each(cnpgCases.map((c) => [`${ c.resource.metadata.namespace }/${ c.resource.metadata.name }`, c]))('%s maps to its Secret, id and link', (_, c) => {
    const kind = CNPG_CLUSTER_KIND;
    const { namespace, name } = c.resource.metadata;
    const id = connectionId(kind.slug, namespace, name);

    expect(kind.credentialSecretName(c.resource)).toBe(c.secretName);
    expect(id).toBe(c.connectionId);
    expect(studioLink(c.toURL, id)).toBe(c.link);
    expect(databaseLink(c.toURL, kind, c.resource)).toBe(c.link);
  });

  // The user is left out: for a Secret the user supplied, Studio takes it from the Secret, which the
  // extension never reads, so the panel can only show the owner the resource names. Studio connects to the
  // fully qualified name under its configured cluster domain, which the extension does not know, so the
  // panel shows the same Service name up to .svc.
  it.each(cnpgCases.map((c) => [`${ c.resource.metadata.namespace }/${ c.resource.metadata.name }`, c]))('%s shows the host, port and database Studio connects to', (_, c) => {
    const summary = CNPG_CLUSTER_KIND.connectionSummary(c.resource);

    expect(c.connection.host.startsWith(`${ summary.host }.`)).toBe(true);
    expect(summary).toMatchObject({ port: c.connection.port, database: c.connection.database });
  });

  it('is Studio\'s own fixture, copied from the released tag its source file names', () => {
    expect(golden.provenance).toBe('libredb-studio');
    expect(goldenSource).toStrictEqual({
      repository: 'libredb/libredb-studio',
      tag:        '1.2.0',
      path:       'tests/fixtures/kubernetes-discovery-golden.json',
    });
  });

  it('is compared byte for byte with the file at that tag on every pull request', () => {
    const workflow = yaml.load(fs.readFileSync(path.resolve(__dirname, '../../../.github/workflows/ci.yml'), 'utf8')) as {
      on: Record<string, unknown>,
      jobs: Record<string, { steps?: { run?: string }[] }>
    };
    const check = workflow.jobs['golden-fixture']?.steps?.map((step) => step.run).join('\n');

    expect(Object.keys(workflow.on)).toContain('pull_request');
    expect(check).toContain('tests/unit/fixtures/kubernetes-discovery-golden.source.json');
    expect(check).toContain('https://raw.githubusercontent.com/');
    expect(check).toMatch(/cmp .*tests\/unit\/fixtures\/kubernetes-discovery-golden\.json/);
  });

  it('keeps a provisional copy out of a chart release', () => {
    const workflow = yaml.load(fs.readFileSync(path.resolve(__dirname, '../../../.github/workflows/build-extension-charts.yml'), 'utf8')) as {
      jobs: Record<string, { needs?: string | string[], if?: string, steps?: { run?: string }[] }>
    };
    const guard = workflow.jobs['golden-fixture-released'];

    expect(guard.if).toBe(workflow.jobs['build-extension-charts'].if);
    expect(guard.steps?.map((step) => step.run).join('\n')).toContain('tests/unit/fixtures/kubernetes-discovery-golden.json');
    expect([workflow.jobs['build-extension-charts'].needs].flat()).toContain('golden-fixture-released');
  });
});
