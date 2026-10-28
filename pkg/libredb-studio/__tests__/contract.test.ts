import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import golden from '../../../tests/unit/fixtures/kubernetes-discovery-golden.json';
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
  it('is k8s-<slug>-<first 12 hex of sha256("<namespace>/<name>")>', () => {
    const expected = createHash('sha256').update('ns-1/db-1').digest('hex').slice(0, 12);

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
    expect(studioLink('https://studio.example.com', 'k8s-cnpg-0123456789ab')).toBe('https://studio.example.com/?connection=seed%3Ak8s-cnpg-0123456789ab');
    expect(studioLink('https://studio.example.com//', 'k8s-cnpg-0123456789ab')).toBe('https://studio.example.com/?connection=seed%3Ak8s-cnpg-0123456789ab');
  });
});

describe('database link', () => {
  it('is the Studio link of the resource\'s connection id', () => {
    expect(databaseLink('https://studio.example.com', CNPG_CLUSTER_KIND, { metadata: { namespace: 'team-a', name: 'orders' } }))
      .toBe(studioLink('https://studio.example.com', connectionId('cnpg', 'team-a', 'orders')));
  });
});

describe('golden fixture', () => {
  it.each(golden.cases.map((c) => [`${ c.resource.metadata.namespace }/${ c.resource.metadata.name }`, c]))('%s maps to its Secret, id and link', (_, c) => {
    const kind = CNPG_CLUSTER_KIND;
    const { namespace, name } = c.resource.metadata;
    const id = connectionId(kind.slug, namespace, name);

    expect(kind.credentialSecretName(c.resource)).toBe(c.secretName);
    expect(id).toBe(c.connectionId);
    expect(studioLink(c.toURL, id)).toBe(c.link);
    expect(databaseLink(c.toURL, kind, c.resource)).toBe(c.link);
  });

  it('is still the provisional copy, until the copy of Studio\'s fixture from a released tag replaces it', () => {
    expect(golden.provenance).toBe('provisional');
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
