import { createHash } from 'crypto';
import golden from '../../../tests/unit/fixtures/kubernetes-discovery-golden.json';
import { CNPG_CLUSTER_KIND, SUPPORTED_KINDS, kindFor } from '../contract/kinds';
import { connectionId, studioLink, STUDIO_ID_RULE } from '../contract/connection-id';

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

describe('golden fixture', () => {
  it.each(golden.cases.map((c) => [`${ c.resource.metadata.namespace }/${ c.resource.metadata.name }`, c]))('%s maps to its Secret, id and link', (_, c) => {
    const kind = CNPG_CLUSTER_KIND;
    const { namespace, name } = c.resource.metadata;
    const id = connectionId(kind.slug, namespace, name);

    expect(kind.credentialSecretName(c.resource)).toBe(c.secretName);
    expect(id).toBe(c.connectionId);
    expect(studioLink(c.toURL, id)).toBe(c.link);
  });

  it('is still the provisional copy, until the copy of Studio\'s fixture from a released tag replaces it', () => {
    expect(golden.provenance).toBe('provisional');
  });
});
