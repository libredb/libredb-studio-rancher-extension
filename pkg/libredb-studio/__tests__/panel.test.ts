import { flushPromises, mount } from '@vue/test-utils';
import StudioPanel from '../components/StudioPanel.vue';
import { CNPG_CLUSTER_TYPE } from '../config';
import { connectionId } from '../contract/connection-id';
import { clearReviews } from '../services/access';
import * as openService from '../services/open';
import type { ShellResource } from '../services/open';

const NAVLINK = { metadata: { name: 'studio.libredb-studio' }, spec: { toURL: 'https://studio.example.com' } };

// Arguments show as JSON, none as nothing; whether a text was asked for raw is checked on its own
const t = (key: string, args?: Record<string, unknown>) => `%${ key }%${ args && Object.keys(args).length ? JSON.stringify(args) : '' }`;

type Answer = boolean | 'error' | 'never';

const setup = (cluster: string, answers: { allowed: Answer, navlinks: unknown[] }) => {
  const dispatch = jest.fn((action: string, _payload?: unknown) => {
    if (action === 'cluster/findLabelSelector') {
      return Promise.resolve(answers.navlinks);
    }

    switch (answers.allowed) {
    case 'never':
      return new Promise(() => undefined);
    case 'error':
      return Promise.reject(new Error('network'));
    default:
      return Promise.resolve({ status: { allowed: answers.allowed } });
    }
  });
  const resource: ShellResource = {
    type:         CNPG_CLUSTER_TYPE,
    metadata:     { namespace: 'team-a', name: 'orders' },
    spec:         { bootstrap: { initdb: { database: 'shop', owner: 'shop_owner' } } },
    $rootGetters: { 'cluster/schemaFor': () => ({}), clusterId: cluster },
    $dispatch:    (action: string, payload?: unknown) => dispatch(action, payload),
  };

  clearReviews(cluster);

  return { dispatch, resource };
};

const render = (resource: ShellResource) => mount(StudioPanel, { props: { resource }, global: { mocks: { t } } });

/** The NavLink read, then the review */
const settle = async() => {
  await flushPromises();
  await flushPromises();
};

describe('LibreDB Studio masthead panel', () => {
  it('renders nothing while Studio\'s NavLink is unknown or absent', async() => {
    const { resource } = setup('c-pan-1', { allowed: true, navlinks: [] });
    const wrapper = render(resource);

    expect(wrapper.find('[data-testid="libredb-panel"]').exists()).toBe(false);
    await settle();
    expect(wrapper.find('[data-testid="libredb-panel"]').exists()).toBe(false);
  });

  it('renders nothing for a kind the contract does not support', async() => {
    const { dispatch, resource } = setup('c-pan-2', { allowed: true, navlinks: [NAVLINK] });
    const wrapper = render({ ...resource, type: 'apps.deployment' });

    await settle();
    expect(wrapper.find('[data-testid="libredb-panel"]').exists()).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('renders nothing and asks nothing for a resource with no name yet', async() => {
    const { dispatch, resource } = setup('c-pan-new', { allowed: true, navlinks: [NAVLINK] });
    const wrapper = render({ ...resource, metadata: { namespace: 'team-a' } as never });

    await settle();
    expect(wrapper.find('[data-testid="libredb-panel"]').exists()).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('shows host, database and user, never a password, and Open when the review allows', async() => {
    const { resource } = setup('c-pan-3', { allowed: true, navlinks: [NAVLINK] });
    const wrapper = render(resource);

    await settle();

    const panel = wrapper.find('[data-testid="libredb-panel"]');

    expect(panel.find('[data-testid="libredb-panel-host"]').text()).toContain('orders-rw.team-a.svc:5432');
    expect(panel.find('[data-testid="libredb-panel-database"]').text()).toContain('shop');
    expect(panel.find('[data-testid="libredb-panel-user"]').text()).toContain('shop_owner');
    expect(panel.text()).not.toMatch(/password/i);
    expect(panel.find('[data-testid="libredb-panel-open"]').text()).toContain('%libredbStudio.databases.open%');
  });

  it('gives no reason under Open for a database the user may open', async() => {
    const { resource } = setup('c-pan-allowed', { allowed: true, navlinks: [NAVLINK] });
    const wrapper = render(resource);

    await settle();

    const panel = wrapper.find('[data-testid="libredb-panel"]');

    expect(panel.find('[data-testid="libredb-panel-open"]').exists()).toBe(true);
    expect(panel.find('[data-testid="libredb-panel-allowed"]').exists()).toBe(false);
    expect(panel.text()).not.toContain('libredbStudio.databases.reason.');
  });

  it('says it is checking while the review is out', async() => {
    const { resource } = setup('c-pan-4', { allowed: 'never', navlinks: [NAVLINK] });
    const wrapper = render(resource);

    await settle();
    expect(wrapper.find('[data-testid="libredb-panel-pending"]').text()).toContain('%libredbStudio.databases.reason.pending%');
  });

  it.each([
    ['denied', false],
    ['failed', 'error'],
  ])('gives the reason when access is %s, and no Open', async(reason, allowed) => {
    const { resource } = setup(`c-pan-${ reason }`, { allowed: allowed as Answer, navlinks: [NAVLINK] });
    const wrapper = render(resource);

    await settle();

    expect(wrapper.find(`[data-testid="libredb-panel-${ reason }"]`).text()).toBe(`%libredbStudio.databases.reason.${ reason }%{"secret":"orders-app","namespace":"team-a"}`);
    expect(wrapper.find('[data-testid="libredb-panel-open"]').exists()).toBe(false);
  });

  it('checks again on Open and opens the Studio link without an opener', async() => {
    const open = jest.spyOn(window, 'open').mockImplementation(() => null);
    const { dispatch, resource } = setup('c-pan-5', { allowed: true, navlinks: [NAVLINK] });
    const wrapper = render(resource);

    await settle();
    dispatch.mockClear();
    await wrapper.find('[data-testid="libredb-panel-open"]').trigger('click');
    expect(wrapper.find('[data-testid="libredb-panel-open"]').attributes('disabled')).toBeDefined();
    await flushPromises();

    expect(dispatch.mock.calls.map(([action]) => action)).toStrictEqual(['cluster/findLabelSelector', 'cluster/request']);
    expect(open).toHaveBeenCalledWith(`https://studio.example.com/?connection=seed%3A${ connectionId('cnpg', 'team-a', 'orders') }`, '_blank', 'noopener,noreferrer');
    expect(wrapper.find('[data-testid="libredb-panel-open"]').attributes('disabled')).toBeUndefined();
  });

  it('shows the reason instead of opening when the check on Open refuses', async() => {
    const open = jest.spyOn(window, 'open').mockImplementation(() => null);
    const answers = { allowed: true as Answer, navlinks: [NAVLINK] as unknown[] };
    const { resource } = setup('c-pan-6', answers);
    const wrapper = render(resource);

    await settle();
    answers.allowed = false;
    await wrapper.find('[data-testid="libredb-panel-open"]').trigger('click');
    await flushPromises();

    expect(open).not.toHaveBeenCalled();
    expect(wrapper.find('[data-testid="libredb-panel-denied"]').exists()).toBe(true);
  });

  it('says opening failed and enables Open again when the open itself fails', async() => {
    const open = jest.spyOn(window, 'open').mockImplementation(() => null);
    const answers = { allowed: true as Answer, navlinks: [NAVLINK] as unknown[] };
    const { resource } = setup('c-pan-7', answers);
    const wrapper = render(resource);

    await settle();
    jest.spyOn(openService, 'openDatabase').mockRejectedValueOnce(new Error('Loading chunk studio-link failed'));
    await wrapper.find('[data-testid="libredb-panel-open"]').trigger('click');
    await flushPromises();

    expect(open).not.toHaveBeenCalled();
    expect(wrapper.find('[data-testid="libredb-panel-open"]').attributes('disabled')).toBeUndefined();
    expect(wrapper.find('[data-testid="libredb-panel-open-failed"]').text()).toBe('%libredbStudio.databases.reason.failed%{"secret":"orders-app","namespace":"team-a"}');
  });
});

// The shell's t escapes HTML unless asked for raw, and text interpolation would show that escape as
// it is, an apostrophe as &#39;, so everything the panel shows is asked for raw text.
describe('LibreDB Studio masthead panel messages', () => {
  it('asks t for raw text for its title, its labels, Open and every reason', async() => {
    const raw = jest.fn((key: string, _args?: unknown, _raw?: boolean) => key);
    const show = (cluster: string, allowed: Answer) => {
      const { resource } = setup(cluster, { allowed, navlinks: [NAVLINK] });

      return mount(StudioPanel, { props: { resource }, global: { mocks: { t: raw } } });
    };

    show('c-raw-pending', 'never');
    show('c-raw-denied', false);
    show('c-raw-failed', 'error');
    const allowed = show('c-raw-allowed', true);

    await settle();
    jest.spyOn(openService, 'openDatabase').mockRejectedValueOnce(new Error('Loading chunk studio-link failed'));
    await allowed.find('[data-testid="libredb-panel-open"]').trigger('click');
    await flushPromises();

    expect([...new Set(raw.mock.calls.map((call) => call[0]))].sort()).toStrictEqual([
      'libredbStudio.databases.open', 'libredbStudio.databases.reason.denied', 'libredbStudio.databases.reason.failed', 'libredbStudio.databases.reason.pending',
      'libredbStudio.panel.database', 'libredbStudio.panel.host', 'libredbStudio.panel.title', 'libredbStudio.panel.user',
    ]);
    expect(raw.mock.calls.filter((call) => call[2] !== true)).toStrictEqual([]);
  });
});
