/**
 * The contract table: one row per supported database kind. Studio's exporter and its mapping hold
 * the same rows, and the golden fixture under tests/unit keeps the three sides identical.
 */

export interface ContractResource {
  metadata: { namespace: string, name: string };
  spec?: { bootstrap?: { initdb?: { database?: string, owner?: string, secret?: { name?: string } } } };
}

/** Where a database is and who connects to it, as its resource says; never a password */
export interface ConnectionSummary {
  host: string;
  port: number;
  database: string;
  user: string;
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
  /** What a user may be shown about the connection, read from the resource alone */
  connectionSummary(resource: ContractResource): ConnectionSummary;
}

export const CNPG_CLUSTER_KIND: ContractKind = {
  type:       'postgresql.cnpg.io.cluster',
  slug:       'cnpg',
  studioType: 'postgres',
  credentialSecretName(resource) {
    return resource.spec?.bootstrap?.initdb?.secret?.name || `${ resource.metadata.name }-app`;
  },
  connectionSummary(resource) {
    const initdb = resource.spec?.bootstrap?.initdb;
    // CloudNativePG's defaults: the database is app, and its owner is named after the database
    const database = initdb?.database || 'app';

    return {
      host: `${ resource.metadata.name }-rw.${ resource.metadata.namespace }.svc`,
      port: 5432,
      database,
      user: initdb?.owner || database,
    };
  },
};

export const SUPPORTED_KINDS: ContractKind[] = [CNPG_CLUSTER_KIND];

export function kindFor(type: string): ContractKind | undefined {
  return SUPPORTED_KINDS.find((kind) => kind.type === type);
}
