import { flushPromises, mount, RouterLinkStub, VueWrapper } from '@vue/test-utils';
import { defineComponent, h } from 'vue';
import Settings from '../pages/Settings.vue';
import {
  enableSso, loadSettings, saveNamespaces, uninstallStudio, ChangeOptions, StudioSettings
} from '../services/setup/settings';
import type { SetupRecord } from '../services/setup/values';
import { RANCHER_CA } from './helpers/cluster';

jest.mock('../services/setup/settings', () => ({
  ...jest.requireActual('../services/setup/settings'),
  loadSettings:    jest.fn(),
  saveNamespaces:  jest.fn(),
  enableSso:       jest.fn(),
  uninstallStudio: jest.fn(),
}));

const loadMock = loadSettings as jest.Mock;
const saveMock = saveNamespaces as jest.Mock;
const ssoMock = enableSso as jest.Mock;
const uninstallMock = uninstallStudio as jest.Mock;

// Arguments show as JSON, none as nothing; whether a text was asked for raw is checked on its own
const t = (key: string, args?: Record<string, unknown>) => `%${ key }%${ args && Object.keys(args).length ? JSON.stringify(args) : '' }`;

const RECORD: SetupRecord = {
  version: 1,
  cluster: 'c-m-1',
  release: {
    namespace: 'libredb-studio', name: 'libredb-studio', repo: 'rancher-partner-charts', chart: 'libredb-studio', chartVersion: '0.1.110'
  },
  host:             'studio.example.com',
  ingressClassName: 'traefik',
  tls:              { source: 'secret', secretName: 'studio-tls' },
  namespaces:       ['team-a'],
  createdNamespace: true,
};
const CONTEXT = {
  serverUrl: 'https://rancher.example.com', serverVersion: 'v2.15.2', scopes: ['openid', 'profile', 'groups'], cacerts: RANCHER_CA
};
const SETTINGS: StudioSettings = {
  canChange:        true,
  record:           RECORD,
  recordUnreadable: false,
  host:             'studio.example.com',
  app:              {
    chartVersion: '0.1.110', appVersion: '1.2.0', status: 'deployed', revision: 3
  },
  link: {
    name: 'libredb-studio.libredb-studio', toURL: 'https://studio.example.com', namespace: 'libredb-studio', deploymentName: 'libredb-studio'
  },
  status:      'ready',
  aggregation: {
    id: 'aggregation', state: 'ok', reason: 'ok'
  },
  namespaces: ['team-a', 'team-b'],
  sso:        {
    checks: [{
      id: 'oidcAdmin', state: 'ok', reason: 'ok', sso: true
    }],
    canUseSso: true,
    context:   CONTEXT,
  },
};

const fieldStub = (name: string) => defineComponent({
  name,
  props: {
    value: { type: [String, Array], default: undefined }, label: { type: String, default: '' }, options: { type: Array, default: () => [] }
  },
  emits: ['update:value'],
  setup(props) {
    return () => h('div', { class: `stub-${ name }` }, props.label);
  },
});

const BannerStub = defineComponent({
  props: { color: { type: String, default: '' }, label: { type: String, default: '' } },
  setup(props, { slots }) {
    return () => h('div', { class: `banner ${ props.color }` }, [props.label, slots.default?.()]);
  },
});

const render = () => mount(Settings, {
  global: {
    mocks: {
      t, $store: { getters: {}, dispatch: jest.fn() }, $route: { params: { cluster: 'c-m-1' } }
    },
    stubs: {
      Banner:        BannerStub,
      Loading:       { template: '<div data-testid="loading" />' },
      LabeledInput:  fieldStub('LabeledInput'),
      LabeledSelect: fieldStub('LabeledSelect'),
      RouterLink:    RouterLinkStub,
    },
  },
});

const field = (wrapper: VueWrapper, testid: string) => wrapper.findComponent(`[data-testid="${ testid }"]`) as unknown as VueWrapper<InstanceType<ReturnType<typeof fieldStub>>>;
const has = (wrapper: VueWrapper, testid: string) => wrapper.find(`[data-testid="${ testid }"]`).exists();
const text = (wrapper: VueWrapper, testid: string) => wrapper.find(`[data-testid="${ testid }"]`).text();
const disabled = (wrapper: VueWrapper, testid: string) => wrapper.find(`[data-testid="${ testid }"]`).attributes('disabled') !== undefined;

async function loaded(settings: StudioSettings = SETTINGS) {
  loadMock.mockResolvedValue(settings);
  const wrapper = render();

  await flushPromises();

  return wrapper;
}

describe('settings page', () => {
  beforeEach(() => {
    loadMock.mockReset();
    saveMock.mockReset();
    ssoMock.mockReset();
    uninstallMock.mockReset();
  });

  it('shows the loading state, then the settings read for this cluster', async() => {
    loadMock.mockResolvedValue(SETTINGS);
    const wrapper = render();

    expect(has(wrapper, 'loading')).toBe(true);
    await flushPromises();
    expect(loadMock).toHaveBeenCalledWith(expect.anything(), 'c-m-1');
    expect(text(wrapper, 'libredb-settings-summary')).toContain('studio.example.com');
    expect(text(wrapper, 'libredb-settings-summary')).toContain('%libredbStudio.settings.chartValue%{"chartVersion":"0.1.110","appVersion":"1.2.0"}');
    expect(text(wrapper, 'libredb-settings-summary')).toContain('%libredbStudio.settings.ssoOff%');
    expect(text(wrapper, 'libredb-studio-status')).toContain('%libredbStudio.status.ready%');
    expect(has(wrapper, 'libredb-settings-aggregation')).toBe(false);
    expect(has(wrapper, 'libredb-settings-in-project')).toBe(false);
  });

  it('warns that project members can read Studio\'s Secrets once its namespace is in a project', async() => {
    const wrapper = await loaded({ ...SETTINGS, inProject: true });

    expect(text(wrapper, 'libredb-settings-in-project')).toBe('%libredbStudio.settings.inProject%{"namespace":"libredb-studio"}');
  });

  it('asks t for raw text wherever it renders a message as text', async() => {
    loadMock.mockResolvedValue(SETTINGS);
    const raw = jest.fn((key: string, _args?: unknown, _raw?: boolean) => key);

    mount(Settings, {
      global: {
        mocks: {
          t: raw, $store: { getters: {}, dispatch: jest.fn() }, $route: { params: { cluster: 'c-m-1' } }
        },
        stubs: {
          Banner: BannerStub, Loading: true, LabeledInput: fieldStub('LabeledInput'), LabeledSelect: fieldStub('LabeledSelect'), RouterLink: RouterLinkStub, StudioStatus: true
        },
      },
    });
    await flushPromises();

    const asText = raw.mock.calls.filter((call) => ['libredbStudio.settings.title', 'libredbStudio.settings.host', 'libredbStudio.settings.ssoOff', 'libredbStudio.settings.ssoIntro'].includes(call[0]));

    expect(asText.length).toBeGreaterThanOrEqual(4);
    expect(asText.every((call) => call[2] === true)).toBe(true);
  });

  it('says only that the settings need an owner of the cluster to anyone else', async() => {
    const wrapper = await loaded({
      canChange: false, recordUnreadable: false, namespaces: []
    });

    expect(text(wrapper, 'libredb-settings-not-owner')).toBe('%libredbStudio.settings.notOwner%');
    expect(has(wrapper, 'libredb-settings-uninstall')).toBe(false);
  });

  it('warns that project members cannot list Clusters when the roles are not aggregated', async() => {
    const wrapper = await loaded({
      ...SETTINGS,
      aggregation: {
        id: 'aggregation', state: 'warning', reason: 'off'
      }
    });

    expect(text(wrapper, 'libredb-settings-aggregation')).toBe('%libredbStudio.setup.checks.aggregation.off%');
  });

  it('offers nothing on a record it does not trust, and says why', async() => {
    const wrapper = await loaded({ ...SETTINGS, recordProblem: 'client' });

    expect(text(wrapper, 'libredb-settings-untrusted')).toBe('%libredbStudio.setup.failure.untrustedRecord%{"field":"client"}');
    expect(has(wrapper, 'libredb-settings-summary')).toBe(false);
    expect(has(wrapper, 'libredb-settings-uninstall')).toBe(false);
  });

  it('sends a Studio it did not set up to Apps', async() => {
    const unreadable = await loaded({
      ...SETTINGS, record: undefined, recordUnreadable: true
    });

    expect(text(unreadable, 'libredb-settings-unreadable')).toBe('%libredbStudio.settings.recordUnreadable%{"namespace":"libredb-studio","name":"libredb-studio-setup"}');

    const other = await loaded({
      ...SETTINGS, record: undefined, sso: undefined
    });

    expect(text(other, 'libredb-settings-other')).toBe('%libredbStudio.settings.otherInstall%');
    expect(has(other, 'libredb-settings-uninstall')).toBe(false);
  });

  it('links to the setup when Studio is not set up', async() => {
    const wrapper = await loaded({
      canChange: true, recordUnreadable: false, namespaces: [], status: 'not-set-up'
    });

    expect(wrapper.findComponent(RouterLinkStub).props('to')).toStrictEqual({ name: 'c-cluster-libredb-setup', params: { cluster: 'c-m-1', product: 'libredb' } });
    expect(has(wrapper, 'libredb-studio-status')).toBe(false);
  });

  it('offers only the uninstall when an earlier uninstall left the record', async() => {
    const wrapper = await loaded({
      ...SETTINGS, app: undefined, link: undefined, status: 'not-set-up', host: undefined
    });

    expect(text(wrapper, 'libredb-settings-summary')).toContain('%libredbStudio.settings.noApp%');
    expect(text(wrapper, 'libredb-settings-summary')).toContain('%libredbStudio.settings.unknownHost%');
    expect(has(wrapper, 'libredb-settings-namespaces')).toBe(false);
    expect(has(wrapper, 'libredb-settings-sso')).toBe(false);
    expect(has(wrapper, 'libredb-settings-uninstall')).toBe(true);
  });

  describe('the discovered namespaces', () => {
    it('saves a changed list and shows the upgrade step by step, then reads the settings again', async() => {
      saveMock.mockImplementation((_store: unknown, _cluster: string, _record: unknown, _app: unknown, _namespaces: string[], options: ChangeOptions) => {
        options.onStep?.({ step: 'upgrade', state: 'done' });

        return Promise.resolve({ ok: true, undone: [] });
      });
      const wrapper = await loaded();

      expect(disabled(wrapper, 'libredb-settings-save')).toBe(true);
      field(wrapper, 'libredb-settings-namespaces-select').vm.$emit('update:value', ['team-b', 'team-a']);
      await flushPromises();
      expect(disabled(wrapper, 'libredb-settings-save')).toBe(false);

      await wrapper.find('[data-testid="libredb-settings-save"]').trigger('click');
      await flushPromises();

      expect(saveMock).toHaveBeenCalledWith(expect.anything(), 'c-m-1', RECORD, SETTINGS.app, ['team-b', 'team-a'], expect.anything());
      expect(wrapper.find('[data-testid="libredb-step-upgrade"]').classes()).toContain('step-done');
      expect(wrapper.find('[data-testid="libredb-step-saveRecord"]').classes()).toContain('step-pending');
      expect(text(wrapper, 'libredb-settings-result')).toBe('%libredbStudio.settings.done.namespaces%');
      expect(loadMock).toHaveBeenCalledTimes(2);
    });

    it('says what is wrong with the list and does not save it', async() => {
      const wrapper = await loaded();

      field(wrapper, 'libredb-settings-namespaces-select').vm.$emit('update:value', []);
      await flushPromises();

      expect(text(wrapper, 'libredb-settings-namespaces-error')).toBe('%libredbStudio.setup.form.errors.namespaces%');
      expect(disabled(wrapper, 'libredb-settings-save')).toBe(true);
    });

    it('says why a change was refused before it started', async() => {
      saveMock.mockResolvedValue({
        ok: false, failure: { reason: 'noHost' }, undone: []
      });
      const wrapper = await loaded();

      field(wrapper, 'libredb-settings-namespaces-select').vm.$emit('update:value', ['team-b']);
      await flushPromises();
      await wrapper.find('[data-testid="libredb-settings-save"]').trigger('click');
      await flushPromises();

      expect(text(wrapper, 'libredb-settings-result')).toBe('%libredbStudio.settings.failed.namespaces%');
      expect(text(wrapper, 'libredb-settings-failure')).toBe('%libredbStudio.setup.failure.noHost%');
    });

    it('reports a change that broke off before any step could say why', async() => {
      saveMock.mockRejectedValue(new Error('chunk failed to load'));
      const wrapper = await loaded();

      field(wrapper, 'libredb-settings-namespaces-select').vm.$emit('update:value', ['team-b']);
      await flushPromises();
      await wrapper.find('[data-testid="libredb-settings-save"]').trigger('click');
      await flushPromises();

      expect(text(wrapper, 'libredb-settings-failure')).toBe('%libredbStudio.setup.failure.request%{"detail":"chunk failed to load"}');
    });
  });

  describe('single sign-on', () => {
    it('shows the exact redirect before anything is created, and turns it on only once the administrator confirms', async() => {
      ssoMock.mockResolvedValue({ ok: true, undone: [] });
      const wrapper = await loaded();

      expect(text(wrapper, 'libredb-settings-sso')).toContain('%libredbStudio.setup.checks.oidcAdmin.ok%');
      await wrapper.find('[data-testid="libredb-settings-sso-start"]').trigger('click');

      expect(text(wrapper, 'libredb-settings-sso-confirm')).toContain('%libredbStudio.settings.redirectConfirm%{"uri":"https://studio.example.com/api/auth/oidc/callback"}');
      expect(text(wrapper, 'libredb-settings-sso-confirm')).toContain('%libredbStudio.settings.ssoNamespaces%{"namespaces":"team-a"}');
      expect(ssoMock).not.toHaveBeenCalled();

      await wrapper.find('[data-testid="libredb-settings-sso-confirm-button"]').trigger('click');
      await flushPromises();

      expect(ssoMock).toHaveBeenCalledWith(expect.anything(), 'c-m-1', RECORD, SETTINGS.app, CONTEXT, { host: 'studio.example.com', namespaces: ['team-a'] }, expect.anything());
      expect(wrapper.findAll('[data-testid^="libredb-step-"]').map((item) => item.attributes('data-testid')))
        .toStrictEqual(['libredb-step-oidcClient', 'libredb-step-oidcSecret', 'libredb-step-rancherCA', 'libredb-step-upgrade', 'libredb-step-saveRecord']);
      expect(text(wrapper, 'libredb-settings-result')).toBe('%libredbStudio.settings.done.sso%');
    });

    it('can be called off at the confirmation', async() => {
      const wrapper = await loaded();

      await wrapper.find('[data-testid="libredb-settings-sso-start"]').trigger('click');
      await wrapper.find('[data-testid="libredb-settings-sso-cancel"]').trigger('click');

      expect(has(wrapper, 'libredb-settings-sso-confirm')).toBe(false);
      expect(ssoMock).not.toHaveBeenCalled();
    });

    it('plans no CA step when Rancher has no CA of its own', async() => {
      ssoMock.mockReturnValue(new Promise(() => undefined));
      const wrapper = await loaded({ ...SETTINGS, sso: { ...SETTINGS.sso as NonNullable<StudioSettings['sso']>, context: { ...CONTEXT, cacerts: undefined } } });

      await wrapper.find('[data-testid="libredb-settings-sso-start"]').trigger('click');
      await wrapper.find('[data-testid="libredb-settings-sso-confirm-button"]').trigger('click');

      expect(has(wrapper, 'libredb-step-rancherCA')).toBe(false);
    });

    it('cannot start without a host read from Studio\'s Ingress, nor where the checks forbid it', async() => {
      expect(disabled(await loaded({ ...SETTINGS, host: undefined }), 'libredb-settings-sso-start')).toBe(true);

      const forbidden = await loaded({
        ...SETTINGS,
        sso: {
          checks: [], canUseSso: false, context: CONTEXT
        }
      });

      expect(has(forbidden, 'libredb-settings-sso')).toBe(true);
      expect(has(forbidden, 'libredb-settings-sso-start')).toBe(false);
    });

    it('says when single sign-on is already on', async() => {
      const wrapper = await loaded({
        ...SETTINGS,
        record: {
          ...RECORD,
          sso: {
            client: 'libredb-studio-c-m-1', issuer: 'https://rancher.example.com/oidc', scope: 'openid profile groups', rancherCA: true
          }
        },
        sso: undefined,
      });

      expect(text(wrapper, 'libredb-settings-summary')).toContain('%libredbStudio.settings.ssoOn%{"client":"libredb-studio-c-m-1"}');
      expect(has(wrapper, 'libredb-settings-sso')).toBe(false);
    });
  });

  describe('uninstall', () => {
    it('warns that the data volume goes, and uninstalls only once the release name is typed by hand', async() => {
      uninstallMock.mockImplementation((_store: unknown, _cluster: string, _record: unknown, _confirm: string, options: ChangeOptions) => {
        options.onUndo?.({
          undo: 'oidcClient', outcome: 'kept', failure: { reason: 'notAllowed', args: { name: 'libredb-studio-c-m-1' } }
        });

        return Promise.resolve({ ok: true, undone: [] });
      });
      const wrapper = await loaded();

      expect(text(wrapper, 'libredb-settings-uninstall')).toContain('%libredbStudio.settings.uninstallWarning%{"namespace":"libredb-studio"}');
      expect(disabled(wrapper, 'libredb-settings-uninstall-button')).toBe(true);

      field(wrapper, 'libredb-settings-uninstall-name').vm.$emit('update:value', 'libredb');
      await flushPromises();
      expect(disabled(wrapper, 'libredb-settings-uninstall-button')).toBe(true);

      field(wrapper, 'libredb-settings-uninstall-name').vm.$emit('update:value', 'libredb-studio');
      await flushPromises();
      await wrapper.find('[data-testid="libredb-settings-uninstall-button"]').trigger('click');
      await flushPromises();

      expect(uninstallMock).toHaveBeenCalledWith(expect.anything(), 'c-m-1', RECORD, 'libredb-studio', expect.anything());
      expect(wrapper.text()).toContain('%libredbStudio.settings.uninstalledTitle%');
      expect(text(wrapper, 'libredb-undo-oidcClient')).toContain('%libredbStudio.setup.failure.notAllowed%{"name":"libredb-studio-c-m-1"}');
      expect(text(wrapper, 'libredb-settings-result')).toBe('%libredbStudio.settings.done.uninstall%');
    });
  });
});
