import { FakeStoreSetup, Request, reviewAnswer } from './fake-store';

/** The downstream cluster every setup spec runs against */
export const CLUSTER = 'c-m-1';

export const SSAR_DOWN = `POST /k8s/clusters/${ CLUSTER }/apis/authorization.k8s.io/v1/selfsubjectaccessreviews`;
export const SSAR_LOCAL = 'POST /k8s/clusters/local/apis/authorization.k8s.io/v1/selfsubjectaccessreviews';
export const INDEX_URL = `/k8s/clusters/${ CLUSTER }/v1/catalog.cattle.io.clusterrepos/rancher-partner-charts?link=index`;
export const INSTALL_URL = `/k8s/clusters/${ CLUSTER }/v1/catalog.cattle.io.clusterrepos/rancher-partner-charts?action=install`;
export const UPGRADE_URL = `/k8s/clusters/${ CLUSTER }/v1/catalog.cattle.io.clusterrepos/rancher-partner-charts?action=upgrade`;
export const UNINSTALL_URL = `/k8s/clusters/${ CLUSTER }/v1/catalog.cattle.io.apps/libredb-studio/libredb-studio?action=uninstall`;

/** A CA as the cacerts setting holds one; not a real certificate */
export const RANCHER_CA = '-----BEGIN CERTIFICATE-----\nnot-a-real-ca\n-----END CERTIFICATE-----\n';

export const CNPG_LIST_RULE = {
  apiGroups: ['postgresql.cnpg.io'], resources: ['backups', 'clusters'], verbs: ['get', 'list', 'watch']
};

export const reviewOf = (request: Request) => (request.data as { spec: { resourceAttributes: Record<string, string> } }).spec.resourceAttributes;

/** Answers every review with whether `allow` allows its attributes */
export const reviews = (allow: (attributes: Record<string, string>) => boolean) => (request: Request) => reviewAnswer(allow(reviewOf(request)));

export const ENTRIES = [
  { version: '0.1.104', appVersion: '1.1.0' },
  { version: '0.1.110', appVersion: '1.2.0' },
];

/**
 * A cluster ready for Studio, seen by a Rancher administrator: CloudNativePG with aggregated
 * roles, an ingress and a default storage class, the Partners repository with a Rancher-mode
 * chart, the OIDC provider on, and nothing of Studio's yet.
 */
export function readyCluster(): FakeStoreSetup {
  return {
    schemas: {
      'cluster/postgresql.cnpg.io.cluster':            { id: 'postgresql.cnpg.io.cluster' },
      'cluster/rbac.authorization.k8s.io.clusterrole': { id: 'rbac.authorization.k8s.io.clusterrole' },
      'cluster/networking.k8s.io.ingressclass':        { id: 'networking.k8s.io.ingressclass' },
      'cluster/storage.k8s.io.storageclass':           { id: 'storage.k8s.io.storageclass' },
      'cluster/cert-manager.io.clusterissuer':         { id: 'cert-manager.io.clusterissuer' },
      'cluster/namespace':                             { id: 'namespace' },
      'cluster/catalog.cattle.io.clusterrepo':         { id: 'catalog.cattle.io.clusterrepo' },
      'cluster/catalog.cattle.io.app':                 { id: 'catalog.cattle.io.app' },
      'cluster/ui.cattle.io.navlink':                  { id: 'ui.cattle.io.navlink' },
      'cluster/apps.deployment':                       { id: 'apps.deployment' },
      'management/management.cattle.io.setting':       { id: 'management.cattle.io.setting' },
      'management/management.cattle.io.feature':       { id: 'management.cattle.io.feature' },
    },
    find: {
      'management/management.cattle.io.setting/server-version': { value: 'v2.15.2' },
      'management/management.cattle.io.setting/server-url':     { value: 'https://rancher.example.com' },
      'management/management.cattle.io.setting/cacerts':        { value: RANCHER_CA },
      'management/management.cattle.io.feature/oidc-provider':  { spec: { value: true }, status: { default: false, lockedValue: null } },
      'cluster/rbac.authorization.k8s.io.clusterrole/view':     { rules: [CNPG_LIST_RULE] },
      'cluster/rbac.authorization.k8s.io.clusterrole/edit':     {
        rules: [{
          apiGroups: ['postgresql.cnpg.io'], resources: ['clusters'], verbs: ['create']
        }, CNPG_LIST_RULE]
      },
      'cluster/catalog.cattle.io.clusterrepo/rancher-partner-charts': {
        metadata: { name: 'rancher-partner-charts' },
        links:    { index: INDEX_URL },
        actions:  { install: INSTALL_URL, upgrade: UPGRADE_URL },
      },
    },
    findAll: {
      'cluster/networking.k8s.io.ingressclass': [
        { metadata: { name: 'nginx' } },
        { metadata: { name: 'traefik', annotations: { 'ingressclass.kubernetes.io/is-default-class': 'true' } } },
      ],
      'cluster/storage.k8s.io.storageclass': [
        { metadata: { name: 'fast' } },
        { metadata: { name: 'local-path', annotations: { 'storageclass.kubernetes.io/is-default-class': 'true' } } },
      ],
      'cluster/cert-manager.io.clusterissuer': [{ metadata: { name: 'letsencrypt' } }],
      'cluster/namespace':                     [
        { metadata: { name: 'team-b', annotations: { 'field.cattle.io/projectId': 'c-m-1:p-b' } } },
        { metadata: { name: 'team-a', annotations: { 'field.cattle.io/projectId': 'c-m-1:p-a' } } },
        { metadata: { name: 'kube-system' } },
      ],
      'cluster/catalog.cattle.io.clusterrepo': [
        { metadata: { name: 'mirror' } },
        { metadata: { name: 'rancher-partner-charts' } },
        { metadata: { name: 'rancher-charts' } },
      ],
    },
    requests: [
      [SSAR_DOWN, reviewAnswer(true)],
      [SSAR_LOCAL, reviewAnswer(true)],
      [`GET ${ INDEX_URL }`, { entries: { 'libredb-studio': ENTRIES, other: [{ version: '9.9.9' }] } }],
    ],
  };
}

/** The same cluster seen by its owner, who is not a Rancher administrator */
export function ownerOnly(setup: FakeStoreSetup = readyCluster()): FakeStoreSetup {
  return {
    ...setup,
    requests: [
      [SSAR_LOCAL, reviewAnswer(false)],
      ...(setup.requests || []).filter(([pattern]) => pattern !== SSAR_LOCAL),
    ],
  };
}
