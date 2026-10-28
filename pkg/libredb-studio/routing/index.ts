import Databases from '../pages/Databases.vue';
import { PRODUCT_NAME, DATABASES_ROUTE } from '../config';

/** The product's pages, under the cluster explorer's default layout */
const routes = [
  {
    parent: 'default',
    route:  {
      name:      DATABASES_ROUTE,
      path:      `/c/:cluster/${ PRODUCT_NAME }/databases`,
      component: Databases,
      meta:      { product: PRODUCT_NAME },
    },
  },
];

export default routes;
