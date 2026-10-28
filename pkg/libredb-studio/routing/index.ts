import { PRODUCT_NAME, DATABASES_ROUTE, SETUP_PAGE, SETUP_ROUTE } from '../config';

/**
 * The product's pages, under the cluster explorer's default layout. Each page is its own chunk,
 * loaded on the first visit, because the extension's entry loads on every Rancher page and the
 * shell's list components a page bundles are large.
 */
const routes = [
  {
    parent: 'default',
    route:  {
      name:      DATABASES_ROUTE,
      path:      `/c/:cluster/${ PRODUCT_NAME }/databases`,
      component: () => import(/* webpackChunkName: "databases" */ '../pages/Databases.vue'),
      meta:      { product: PRODUCT_NAME },
    },
  },
  {
    parent: 'default',
    route:  {
      name:      SETUP_ROUTE,
      path:      `/c/:cluster/${ PRODUCT_NAME }/${ SETUP_PAGE }`,
      component: () => import(/* webpackChunkName: "setup" */ '../pages/Setup.vue'),
      meta:      { product: PRODUCT_NAME },
    },
  },
];

export default routes;
