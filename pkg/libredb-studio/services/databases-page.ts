import { CNPG_CLUSTER_TYPE } from '../config';
import { clearReviews } from './access';
import { findStudioLinks, selectStudioLink, StudioLink } from './navlink';
import { studioStatus, StudioStatus } from './studio-status';
import type { StoreLike } from './types';

export interface SchemaLike {
  id: string;
  collectionMethods?: string[];
}

export interface DatabasesPageState {
  /** The CloudNativePG Cluster schema, when the user can see it */
  schema?: SchemaLike;
  /** Whether the schema lets the user list Clusters */
  canList: boolean;
  /** How many usable Studio links the cluster has */
  found: number;
  link?: StudioLink;
  status: StudioStatus;
}

/**
 * What the Databases page shows before its table: the schema first, then Studio's link and state.
 * Opening the page forgets the cluster's cached access reviews, so every row is reviewed afresh.
 */
export async function loadDatabasesPage(store: StoreLike, cluster: string): Promise<DatabasesPageState> {
  clearReviews(cluster);

  const schema = store.getters['cluster/schemaFor'](CNPG_CLUSTER_TYPE) as SchemaLike | undefined;
  const canList = !!schema?.collectionMethods?.some((method) => method.toUpperCase() === 'GET');
  const { found, link } = selectStudioLink(await findStudioLinks(store));

  return {
    schema, canList, found, link, status: await studioStatus(store, link)
  };
}
