/**
 * The contract table: one row per supported database kind. Studio's exporter and its mapping hold
 * the same rows, and the golden fixture under tests/unit keeps the three sides identical.
 */

export interface ContractResource {
  metadata: { namespace: string, name: string };
  spec?: { bootstrap?: { initdb?: { secret?: { name?: string } } } };
}

export interface ContractKind {
  /** The type id in Rancher's cluster store */
  type: string;
  /** The kind slug in the connection id */
  slug: string;
  /** The Studio connection type the kind maps to */
  studioType: string;
  /** The Secret that holds the credentials Studio connects with; the extension never reads it */
  credentialSecretName(resource: ContractResource): string;
}

export const CNPG_CLUSTER_KIND: ContractKind = {
  type:       'postgresql.cnpg.io.cluster',
  slug:       'cnpg',
  studioType: 'postgres',
  credentialSecretName(resource) {
    return resource.spec?.bootstrap?.initdb?.secret?.name || `${ resource.metadata.name }-app`;
  },
};

export const SUPPORTED_KINDS: ContractKind[] = [CNPG_CLUSTER_KIND];

export function kindFor(type: string): ContractKind | undefined {
  return SUPPORTED_KINDS.find((kind) => kind.type === type);
}
