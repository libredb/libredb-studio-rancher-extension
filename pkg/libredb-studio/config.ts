import { CNPG_CLUSTER_KIND } from './contract/kinds';

/**
 * The product id. One word, because the shell reads a product back from a route name
 * c-cluster-<product>-... up to the first hyphen.
 */
export const PRODUCT_NAME = 'libredb';

export const CNPG_CLUSTER_TYPE = CNPG_CLUSTER_KIND.type;

export const DATABASES_PAGE = 'databases';
export const DATABASES_ROUTE = `c-cluster-${ PRODUCT_NAME }-${ DATABASES_PAGE }`;
