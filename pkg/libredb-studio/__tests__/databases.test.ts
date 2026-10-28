import { flushPromises, mount, RouterLinkStub } from '@vue/test-utils';
import { defineComponent, h } from 'vue';
import Databases from '../pages/Databases.vue';
import StudioStatus from '../components/StudioStatus.vue';
import DatabaseAccessCell from '../components/DatabaseAccessCell.vue';
import { clearReviews, reviewState } from '../services/access';
import { connectionId } from '../contract/connection-id';
import { CNPG_CLUSTER_TYPE } from '../config';
import { NAVLINK_TYPE } from '../services/navlink';
import { DEPLOYMENT_TYPE, StudioStatus as Status } from '../services/studio-status';

// The shell's table pulls in the whole list stack, which the dashboard provides at run time; the
// page's own logic is what these specs cover, and the end-to-end specs cover the real table.
jest.mock('@shell/components/PaginatedResourceTable.vue', () => ({ __esModule: true, default: { name: 'PaginatedResourceTable', render: () => null } }));

const LINK = {
  name: 'studio.libredb-studio', toURL: 'https://studio.example.com', namespace: 'studio', deploymentName: 'libredb-studio'
};

const ROW = { metadata: { namespace: 'team-a', name: 'orders' } };

// Arguments show as JSON, none as nothing; whether a text was asked for raw is checked on its own
const t = (key: string, args?: Record<string, unknown>) => `%${ key }%${ args && Object.keys(args).length ? JSON.stringify(args) : '' }`;

const BannerStub = defineComponent({
  props: { color: { type: String, default: '' }, label: { type: String, default: '' } },
  setup(props, { slots }) {
    return () => h('div', { class: `banner ${ props.color }` }, [props.label, slots.default?.()]);
  },
});

const SETUP_ROUTE = { name: 'c-cluster-libredb-setup', params: { cluster: 'c-1', product: 'libredb' } };

describe('studio status', () => {
  const render = (props: { status: Status, link?: typeof LINK, found?: number, setupRoute?: typeof SETUP_ROUTE }) => mount(StudioStatus, { props, global: { mocks: { t }, stubs: { Banner: BannerStub, RouterLink: RouterLinkStub } } });

  it('offers the setup where Studio is not set up, to someone who may set it up', () => {
    const wrapper = render({ status: 'not-set-up', setupRoute: SETUP_ROUTE });

    expect(wrapper.findComponent(RouterLinkStub).props('to')).toStrictEqual(SETUP_ROUTE);
    expect(wrapper.find('[data-testid="libredb-studio-setup"]').text()).toBe('%libredbStudio.setup.title%');
  });

  it('offers no setup to anyone else, nor where Studio is set up', () => {
    expect(render({ status: 'not-set-up' }).findComponent(RouterLinkStub).exists()).toBe(false);
    expect(render({
      status: 'ready', link: LINK, setupRoute: SETUP_ROUTE
    }).findComponent(RouterLinkStub).exists()).toBe(false);
  });

  it.each([
    ['not-set-up', 'warning'],
    ['ready', 'success'],
    ['not-ready', 'warning'],
    ['unknown', 'info'],
    ['failed', 'warning'],
  ])('shows %s as a %s banner', (status, color) => {
    const wrapper = render({ status: status as Status, link: status === 'not-set-up' ? undefined : LINK });
    const banner = wrapper.find('[data-testid="libredb-studio-status"]');

    expect(banner.classes()).toContain(color);
    expect(banner.text()).toContain(`%libredbStudio.status.${ status }%`);
  });

  it('links to Studio in a new tab without an opener or referrer', () => {
    const anchor = render({ status: 'ready', link: LINK }).find('[data-testid="libredb-studio-link"]');

    expect(anchor.attributes()).toMatchObject({
      href: 'https://studio.example.com', target: '_blank', rel: 'noopener noreferrer nofollow'
    });
  });

  it('has no link when Studio is not set up', () => {
    expect(render({ status: 'not-set-up' }).find('[data-testid="libredb-studio-link"]').exists()).toBe(false);
  });

  it('says which link it uses when the cluster has several', () => {
    expect(render({
      status: 'ready', link: LINK, found: 1
    }).find('[data-testid="libredb-studio-several-links"]').exists()).toBe(false);
    expect(render({
      status: 'ready', link: LINK, found: 2
    }).find('[data-testid="libredb-studio-several-links"]').text()).toContain('"count":2');
  });
});

describe('database access cell', () => {
  const allowed = (value: boolean) => ({ status: { allowed: value } });

  const render = (dispatch: jest.Mock, props: Record<string, unknown> = {}) => mount(DatabaseAccessCell, {
    props: {
      row: ROW, cluster: 'c-1', link: LINK, ...props
    },
    global: { mocks: { t, $store: { getters: {}, dispatch } } },
  });

  beforeEach(() => clearReviews('c-1'));

  it('says Studio is not set up without a link, and reviews nothing', async() => {
    const dispatch = jest.fn();
    const wrapper = render(dispatch, { link: undefined });

    await flushPromises();
    expect(wrapper.find('[data-testid="libredb-access-not-set-up"]').text()).toContain('%libredbStudio.databases.reason.not-set-up%');
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('checks access, then offers Open when the user may get the credential Secret', async() => {
    const wrapper = render(jest.fn().mockResolvedValue(allowed(true)));

    expect(wrapper.find('[data-testid="libredb-access-pending"]').exists()).toBe(true);
    await flushPromises();

    expect(wrapper.find('[data-testid="libredb-open"]').text()).toBe('%libredbStudio.databases.open%');
  });

  it('names the Secret and the namespace when the user may not', async() => {
    const wrapper = render(jest.fn().mockResolvedValue(allowed(false)));

    await flushPromises();

    const reason = wrapper.find('[data-testid="libredb-access-denied"]').text();

    expect(reason).toContain('%libredbStudio.databases.reason.denied%');
    expect(reason).toContain('"secret":"orders-app"');
    expect(reason).toContain('"namespace":"team-a"');
  });

  it('says the check failed, not that access is refused, when the review cannot be made', async() => {
    const wrapper = render(jest.fn().mockRejectedValue(new Error('network')));

    await flushPromises();

    expect(wrapper.find('[data-testid="libredb-access-failed"]').text()).toContain('%libredbStudio.databases.reason.failed%');
    expect(wrapper.find('[data-testid="libredb-open"]').exists()).toBe(false);
  });

  it('reviews again on Open and opens the Studio link without an opener', async() => {
    const dispatch = jest.fn().mockResolvedValue(allowed(true));
    const open = jest.spyOn(window, 'open').mockImplementation(() => null);
    const wrapper = render(dispatch);

    await flushPromises();
    await wrapper.find('[data-testid="libredb-open"]').trigger('click');
    await flushPromises();

    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(open).toHaveBeenCalledWith(
      `https://studio.example.com/?connection=seed%3A${ connectionId('cnpg', 'team-a', 'orders') }`, '_blank', 'noopener,noreferrer'
    );
  });

  it('does not open when the second review refuses, and shows the reason', async() => {
    const dispatch = jest.fn().mockResolvedValueOnce(allowed(true)).mockResolvedValueOnce(allowed(false));
    const open = jest.spyOn(window, 'open').mockImplementation(() => null);
    const wrapper = render(dispatch);

    await flushPromises();
    await wrapper.find('[data-testid="libredb-open"]').trigger('click');
    await flushPromises();

    expect(open).not.toHaveBeenCalled();
    expect(wrapper.find('[data-testid="libredb-access-denied"]').exists()).toBe(true);
  });

  it('reviews the new Secret when the row changes', async() => {
    const dispatch = jest.fn().mockResolvedValue(allowed(true));
    const wrapper = render(dispatch);

    await flushPromises();
    await wrapper.setProps({ row: { metadata: { namespace: 'team-a', name: 'billing' }, spec: { bootstrap: { initdb: { secret: { name: 'billing-owner' } } } } } });
    await flushPromises();

    expect(reviewState('c-1', 'team-a', 'billing-owner')).toBe('allowed');
    expect(dispatch).toHaveBeenCalledTimes(2);
  });
});

describe('databases page', () => {
  const TableStub = defineComponent({
    props: {
      schema: { type: Object, required: true }, headers: { type: Array, default: null }, paginationHeaders: { type: Array, default: null }
    },
    setup(props, { slots }) {
      return () => h('div', { 'data-testid': 'table' }, slots['cell:studio']?.({ row: ROW }));
    },
  });

  interface StoreSetup {
    cnpgSchema?: Record<string, unknown>;
    navlinks?: unknown[];
    deployment?: unknown;
    reviewAllowed?: boolean;
    clusterRoleSchema?: Record<string, unknown>;
  }

  const storeFor = ({
    cnpgSchema, navlinks = [], deployment, reviewAllowed = true, clusterRoleSchema
  }: StoreSetup) => {
    const schemas: Record<string, unknown> = {
      [CNPG_CLUSTER_TYPE]: cnpgSchema, [NAVLINK_TYPE]: {}, [DEPLOYMENT_TYPE]: {}, 'rbac.authorization.k8s.io.clusterrole': clusterRoleSchema
    };
    const dispatch = jest.fn((action: string) => {
      switch (action) {
      case 'cluster/findLabelSelector':
        return Promise.resolve(navlinks);
      case 'cluster/find':
        return Promise.resolve(deployment);
      default:
        return Promise.resolve({ status: { allowed: reviewAllowed } });
      }
    });

    return { getters: { 'cluster/schemaFor': (type: string) => schemas[type] }, dispatch };
  };

  const render = (store: ReturnType<typeof storeFor>) => mount(Databases, {
    global: {
      mocks: {
        t, $store: store, $route: { params: { cluster: 'c-1' } }
      },
      stubs: {
        Banner: BannerStub, Loading: { template: '<div data-testid="loading" />' }, PaginatedResourceTable: TableStub, RouterLink: RouterLinkStub
      },
    },
  });

  const CNPG_SCHEMA = { id: CNPG_CLUSTER_TYPE, collectionMethods: ['GET', 'POST'] };
  const NAVLINK = { metadata: { name: 'studio.libredb-studio' }, spec: { toURL: 'https://studio.example.com' } };

  it('shows the loading state first', () => {
    expect(render(storeFor({ cnpgSchema: CNPG_SCHEMA })).find('[data-testid="loading"]').exists()).toBe(true);
  });

  it('lists the Clusters with the paginated table, schema first, and a Studio column', async() => {
    const store = storeFor({
      cnpgSchema: CNPG_SCHEMA, navlinks: [NAVLINK], deployment: { status: { readyReplicas: 1 } }
    });
    const wrapper = render(store);

    await flushPromises();

    const table = wrapper.findComponent(TableStub);

    expect(table.props('schema')).toStrictEqual(CNPG_SCHEMA);
    expect((table.props('headers') as { name: string }[]).map((c) => c.name)).toStrictEqual(['state', 'name', 'namespace', 'studio', 'age']);
    expect((table.props('paginationHeaders') as { name: string }[]).map((c) => c.name)).toContain('studio');
    expect(wrapper.find('[data-testid="libredb-studio-status"]').text()).toContain('%libredbStudio.status.ready%');
    expect(wrapper.find('[data-testid="libredb-open"]').exists()).toBe(true);
  });

  it('says Studio is not set up, per page and per row, without a NavLink', async() => {
    const wrapper = render(storeFor({ cnpgSchema: CNPG_SCHEMA }));

    await flushPromises();

    expect(wrapper.find('[data-testid="libredb-studio-status"]').text()).toContain('%libredbStudio.status.not-set-up%');
    expect(wrapper.find('[data-testid="libredb-access-not-set-up"]').exists()).toBe(true);
  });

  it('links to the setup for someone who could create the chart\'s cluster roles', async() => {
    const owner = render(storeFor({ cnpgSchema: CNPG_SCHEMA, clusterRoleSchema: { collectionMethods: ['GET', 'POST'] } }));

    await flushPromises();
    expect(owner.findComponent(StudioStatus).props('setupRoute')).toStrictEqual(SETUP_ROUTE);

    const member = render(storeFor({ cnpgSchema: CNPG_SCHEMA, clusterRoleSchema: { collectionMethods: ['GET'] } }));

    await flushPromises();
    expect(member.findComponent(StudioStatus).props('setupRoute')).toBeUndefined();

    const noSchema = render(storeFor({ cnpgSchema: CNPG_SCHEMA }));

    await flushPromises();
    expect(noSchema.findComponent(StudioStatus).props('setupRoute')).toBeUndefined();
  });

  it('tells a user who cannot list Clusters what is missing and who can fix it', async() => {
    const wrapper = render(storeFor({ cnpgSchema: { id: CNPG_CLUSTER_TYPE, collectionMethods: [] } }));

    await flushPromises();

    expect(wrapper.find('[data-testid="libredb-cannot-list"]').text()).toBe('%libredbStudio.databases.cannotList%');
    expect(wrapper.findComponent(TableStub).exists()).toBe(false);
  });

  it('treats a schema without collection methods as not listable', async() => {
    const wrapper = render(storeFor({ cnpgSchema: { id: CNPG_CLUSTER_TYPE } }));

    await flushPromises();

    expect(wrapper.find('[data-testid="libredb-cannot-list"]').exists()).toBe(true);
  });

  it('says CloudNativePG is missing when its schema is not visible', async() => {
    const wrapper = render(storeFor({}));

    await flushPromises();

    expect(wrapper.find('[data-testid="libredb-no-schema"]').text()).toBe('%libredbStudio.databases.noSchema%');
  });

  it('never reads or lists a Secret, through a full render and an Open', async() => {
    const store = storeFor({
      cnpgSchema: CNPG_SCHEMA, navlinks: [NAVLINK], deployment: { status: { readyReplicas: 1 } }
    });

    jest.spyOn(window, 'open').mockImplementation(() => null);
    const wrapper = render(store);

    await flushPromises();
    await wrapper.find('[data-testid="libredb-open"]').trigger('click');
    await flushPromises();

    expect(store.dispatch).toHaveBeenCalledWith('cluster/request', expect.objectContaining({ method: 'post' }));
    const touchesSecrets = store.dispatch.mock.calls.filter((call: unknown[]) => {
      const payload = (call[1] || {}) as { type?: unknown, url?: unknown };

      return /secret/i.test(String(payload.type || '')) || /\/secrets/i.test(String(payload.url || ''));
    });

    expect(touchesSecrets).toStrictEqual([]);
  });

  it('forgets the cluster\'s cached reviews when it opens', async() => {
    const store = storeFor({
      cnpgSchema: CNPG_SCHEMA, navlinks: [NAVLINK], reviewAllowed: false
    });

    render(store);
    await flushPromises();
    expect(reviewState('c-1', 'team-a', 'orders-app')).toBe('denied');

    store.dispatch.mockImplementation((action: string) => Promise.resolve(action === 'cluster/findLabelSelector' ? [NAVLINK] : { status: { allowed: true } }));
    render(store);
    await flushPromises();
    expect(reviewState('c-1', 'team-a', 'orders-app')).toBe('allowed');
  });
});

// The shell's t escapes HTML unless asked for raw, and both text interpolation and the Banner, which
// escapes its label itself, would show that escape as it is: an apostrophe as &#39;. Everything these
// render is text or a banner label, so every message is asked for raw text.
describe('the Databases page\'s messages', () => {
  const asRaw = () => jest.fn((key: string, _args?: unknown, _raw?: boolean) => key);
  const escapedUnlessRaw = (_key: string, _args?: unknown, isRaw?: boolean) => (isRaw ? 'Studio\'s admin' : 'Studio&#39;s admin');
  const notRaw = (raw: jest.Mock) => raw.mock.calls.filter((call) => call[2] !== true);

  it('asks t for raw text for the title and both banners of the page', async() => {
    const raw = asRaw();
    const page = (schema?: Record<string, unknown>) => mount(Databases, {
      global: {
        mocks: {
          t: raw, $store: { getters: { 'cluster/schemaFor': (type: string) => (type === CNPG_CLUSTER_TYPE ? schema : undefined) }, dispatch: jest.fn().mockResolvedValue([]) }, $route: { params: { cluster: 'c-1' } }
        },
        stubs: {
          Banner: BannerStub, Loading: true, PaginatedResourceTable: true, RouterLink: RouterLinkStub, StudioStatus: true
        },
      },
    });

    page();
    page({ id: CNPG_CLUSTER_TYPE, collectionMethods: [] });
    await flushPromises();

    expect([...new Set(raw.mock.calls.map((call) => call[0]))].sort()).toStrictEqual(['libredbStudio.databases.cannotList', 'libredbStudio.databases.label', 'libredbStudio.databases.noSchema']);
    expect(notRaw(raw)).toStrictEqual([]);
  });

  it('asks t for raw text for every status, its link, the setup and the several-links banner', () => {
    const raw = asRaw();

    (['not-set-up', 'ready', 'not-ready', 'unknown', 'failed'] as Status[]).forEach((status) => mount(StudioStatus, {
      props: {
        status, link: status === 'not-set-up' ? undefined : LINK, found: 2, setupRoute: status === 'not-set-up' ? SETUP_ROUTE : undefined
      },
      global: { mocks: { t: raw }, stubs: { Banner: BannerStub, RouterLink: RouterLinkStub } },
    }));

    expect(raw.mock.calls.map((call) => call[0])).toEqual(expect.arrayContaining(['libredbStudio.status.open', 'libredbStudio.setup.title', 'libredbStudio.status.severalLinks']));
    expect(notRaw(raw)).toStrictEqual([]);
  });

  it('asks t for raw text for each row\'s Open and reason', async() => {
    const raw = asRaw();
    const cell = (dispatch: jest.Mock, link?: typeof LINK) => mount(DatabaseAccessCell, {
      props: {
        row: ROW, cluster: 'c-raw', link
      },
      global: { mocks: { t: raw, $store: { getters: {}, dispatch } } },
    });

    clearReviews('c-raw');
    cell(jest.fn());
    cell(jest.fn().mockResolvedValue({ status: { allowed: true } }), LINK);
    await flushPromises();
    clearReviews('c-raw');
    cell(jest.fn().mockResolvedValue({ status: { allowed: false } }), LINK);
    await flushPromises();

    expect([...new Set(raw.mock.calls.map((call) => call[0]))].sort()).toStrictEqual([
      'libredbStudio.databases.open', 'libredbStudio.databases.reason.denied', 'libredbStudio.databases.reason.not-set-up', 'libredbStudio.databases.reason.pending',
    ]);
    expect(notRaw(raw)).toStrictEqual([]);
  });

  it('shows an apostrophe as an apostrophe, in the shell\'s own Banner and in the status text', async() => {
    const page = mount(Databases, {
      global: {
        mocks: {
          t: escapedUnlessRaw, $store: { getters: { 'cluster/schemaFor': () => undefined }, dispatch: jest.fn().mockResolvedValue([]) }, $route: { params: { cluster: 'c-1' } }
        },
        stubs: {
          Loading: true, PaginatedResourceTable: true, RouterLink: RouterLinkStub, StudioStatus: true
        },
      },
    });
    const status = mount(StudioStatus, { props: { status: 'not-set-up' }, global: { mocks: { t: escapedUnlessRaw }, stubs: { RouterLink: RouterLinkStub } } });

    await flushPromises();

    expect(page.find('[data-testid="libredb-no-schema"]').text()).toBe('Studio\'s admin');
    expect(status.find('[data-testid="libredb-studio-status"]').text()).toBe('Studio\'s admin');
  });
});
