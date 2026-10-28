import { flushPromises, mount, RouterLinkStub, VueWrapper } from '@vue/test-utils';
import { defineComponent, h } from 'vue';
import Settings from '../pages/Settings.vue';
import {
  disableSso, enableSso, loadSettings, rotateClientSecret, saveNamespaces, uninstallStudio, ChangeOptions, StudioSettings
} from '../services/setup/settings';
import type { SetupRecord } from '../services/setup/values';
import { RANCHER_CA } from './helpers/cluster';

jest.mock('../services/setup/settings', () => ({
  ...jest.requireActual('../services/setup/settings'),
  loadSettings:       jest.fn(),
  saveNamespaces:     jest.fn(),
  enableSso:          jest.fn(),
  rotateClientSecret: jest.fn(),
  disableSso:         jest.fn(),
  uninstallStudio:    jest.fn(),
}));

const loadMock = loadSettings as jest.Mock;
const saveMock = saveNamespaces as jest.Mock;
const ssoMock = enableSso as jest.Mock;
const rotateMock = rotateClientSecret as jest.Mock;
const ssoOffMock = disableSso as jest.Mock;
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
    chartVersion: '0.1.110', appVersion: '1.2.0', status: 'deployed', revision: 3, managed: true
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
    value: { type: [String, Array, Boolean], default: undefined }, label: { type: String, default: '' }, options: { type: Array, default: () => [] }
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
      Checkbox:      fieldStub('Checkbox'),
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
    rotateMock.mockReset();
    ssoOffMock.mockReset();
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
    expect(has(wrapper, 'libredb-settings-unmarked')).toBe(false);
  });

  it('says what an upgrade in Apps did to the app, and how to change or remove it from here on', async() => {
    const wrapper = await loaded({ ...SETTINGS, app: { ...SETTINGS.app!, managed: false } });

    expect(text(wrapper, 'libredb-settings-unmarked')).toBe('%libredbStudio.settings.unmarked%');
    expect(has(wrapper, 'libredb-settings-uninstall')).toBe(true);
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

  it('asks t for raw text for every banner, which escapes its label itself', async() => {
    // A text t escaped already would show &#39; for an apostrophe, as in the unmarked and in-project banners
    const bannersOf = async(settings: StudioSettings, act?: (wrapper: VueWrapper) => Promise<void>) => {
      loadMock.mockResolvedValue(settings);
      const raw = jest.fn((key: string, _args?: unknown, _raw?: boolean) => key);
      const wrapper = mount(Settings, {
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
      await act?.(wrapper);

      const labels = wrapper.findAllComponents(BannerStub).map((banner) => banner.props('label') as string);

      return { labels, asked: raw.mock.calls.filter((call) => labels.includes(call[0])) };
    };
    const ssoRecord = {
      ...RECORD,
      sso: {
        client: 'libredb-studio-c-m-1', issuer: 'https://rancher.example.com/oidc', scope: 'openid profile groups', rancherCA: true
      }
    };
    const warned = await bannersOf({
      ...SETTINGS,
      inProject:   true,
      app:         { ...SETTINGS.app!, managed: false },
      aggregation: {
        id: 'aggregation', state: 'warning', reason: 'off'
      }
    });
    const ssoOn = await bannersOf({
      ...SETTINGS, record: ssoRecord, sso: undefined, ssoAdmin: true
    }, async(wrapper) => {
      rotateMock.mockResolvedValue({ ok: true, undone: [] });
      await wrapper.find('[data-testid="libredb-settings-rotate-start"]').trigger('click');
      await wrapper.find('[data-testid="libredb-settings-rotate-confirm-button"]').trigger('click');
      await flushPromises();
    });

    expect(warned.labels).toStrictEqual([
      'libredbStudio.setup.checks.aggregation.off', 'libredbStudio.settings.inProject', 'libredbStudio.settings.unmarked', 'libredbStudio.settings.uninstallWarning'
    ]);
    expect(ssoOn.labels).toStrictEqual(['libredbStudio.settings.done.rotate', 'libredbStudio.settings.turnOffWarning', 'libredbStudio.settings.uninstallWarning']);
    expect([...warned.asked, ...ssoOn.asked].every((call) => call[2] === true)).toBe(true);
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
      expect(field(wrapper, 'libredb-settings-sso-trust').props()).toMatchObject({ value: false, label: '%libredbStudio.setup.form.ssoTrust%' });
      expect(disabled(wrapper, 'libredb-settings-sso-confirm-button')).toBe(true);
      expect(ssoMock).not.toHaveBeenCalled();

      field(wrapper, 'libredb-settings-sso-trust').vm.$emit('update:value', true);
      await flushPromises();
      expect(disabled(wrapper, 'libredb-settings-sso-confirm-button')).toBe(false);
      await wrapper.find('[data-testid="libredb-settings-sso-confirm-button"]').trigger('click');
      await flushPromises();

      expect(ssoMock).toHaveBeenCalledWith(expect.anything(), 'c-m-1', RECORD, SETTINGS.app, CONTEXT, {
        host: 'studio.example.com', namespaces: ['team-a'], ownersTrusted: true
      }, expect.anything());
      expect(wrapper.findAll('[data-testid^="libredb-step-"]').map((item) => item.attributes('data-testid')))
        .toStrictEqual(['libredb-step-oidcClient', 'libredb-step-oidcSecret', 'libredb-step-rancherCA', 'libredb-step-upgrade', 'libredb-step-saveRecord']);
      expect(text(wrapper, 'libredb-settings-result')).toBe('%libredbStudio.settings.done.sso%');
    });

    it('can be called off at the confirmation, which asks for the acknowledgement afresh', async() => {
      const wrapper = await loaded();

      await wrapper.find('[data-testid="libredb-settings-sso-start"]').trigger('click');
      field(wrapper, 'libredb-settings-sso-trust').vm.$emit('update:value', true);
      await flushPromises();
      await wrapper.find('[data-testid="libredb-settings-sso-cancel"]').trigger('click');

      expect(has(wrapper, 'libredb-settings-sso-confirm')).toBe(false);
      expect(ssoMock).not.toHaveBeenCalled();

      await wrapper.find('[data-testid="libredb-settings-sso-start"]').trigger('click');
      expect(field(wrapper, 'libredb-settings-sso-trust').props('value')).toBe(false);
    });

    it('asks t for the acknowledgement as raw text, which the checkbox renders as text', async() => {
      loadMock.mockResolvedValue(SETTINGS);
      const raw = jest.fn((key: string, _args?: unknown, _raw?: boolean) => key);
      const wrapper = mount(Settings, {
        global: {
          mocks: {
            t: raw, $store: { getters: {}, dispatch: jest.fn() }, $route: { params: { cluster: 'c-m-1' } }
          },
          stubs: {
            Banner: BannerStub, Loading: true, LabeledInput: fieldStub('LabeledInput'), LabeledSelect: fieldStub('LabeledSelect'), Checkbox: fieldStub('Checkbox'), RouterLink: RouterLinkStub, StudioStatus: true, SetupChecks: true
          },
        },
      });

      await flushPromises();
      await wrapper.find('[data-testid="libredb-settings-sso-start"]').trigger('click');

      const asked = raw.mock.calls.filter((call) => call[0] === 'libredbStudio.setup.form.ssoTrust');

      expect(asked.length).toBeGreaterThan(0);
      expect(asked.every((call) => call[2] === true)).toBe(true);
    });

    it('plans no CA step when Rancher has no CA of its own', async() => {
      ssoMock.mockReturnValue(new Promise(() => undefined));
      const wrapper = await loaded({ ...SETTINGS, sso: { ...SETTINGS.sso as NonNullable<StudioSettings['sso']>, context: { ...CONTEXT, cacerts: undefined } } });

      await wrapper.find('[data-testid="libredb-settings-sso-start"]').trigger('click');
      field(wrapper, 'libredb-settings-sso-trust').vm.$emit('update:value', true);
      await flushPromises();
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

  describe('single sign-on once it is on', () => {
    const SSO_RECORD: SetupRecord = {
      ...RECORD,
      sso: {
        client: 'libredb-studio-c-m-1', issuer: 'https://rancher.example.com/oidc', scope: 'openid profile groups', rancherCA: true
      }
    };
    const SSO_ON: StudioSettings = {
      ...SETTINGS, record: SSO_RECORD, sso: undefined, ssoAdmin: true
    };
    const steps = (wrapper: VueWrapper) => wrapper.findAll('[data-testid^="libredb-step-"]').map((item) => item.attributes('data-testid'));

    it('rotates the client secret once the administrator confirms, and shows each step', async() => {
      rotateMock.mockImplementation((_store: unknown, _cluster: string, _record: unknown, _app: unknown, options: ChangeOptions) => {
        options.onStep?.({ step: 'regenerate', state: 'done' });

        return Promise.resolve({ ok: true, undone: [] });
      });
      const wrapper = await loaded(SSO_ON);

      expect(text(wrapper, 'libredb-settings-sso-on')).toContain('%libredbStudio.settings.ssoOnIntro%{"client":"libredb-studio-c-m-1"}');
      await wrapper.find('[data-testid="libredb-settings-rotate-start"]').trigger('click');

      expect(text(wrapper, 'libredb-settings-rotate-confirm')).toContain('%libredbStudio.settings.rotateConfirm%{"client":"libredb-studio-c-m-1"}');
      expect(rotateMock).not.toHaveBeenCalled();

      await wrapper.find('[data-testid="libredb-settings-rotate-confirm-button"]').trigger('click');
      await flushPromises();

      expect(rotateMock).toHaveBeenCalledWith(expect.anything(), 'c-m-1', SSO_RECORD, SETTINGS.app, expect.anything());
      expect(steps(wrapper)).toStrictEqual(['libredb-step-regenerate', 'libredb-step-oidcSecret', 'libredb-step-restart']);
      expect(wrapper.find('[data-testid="libredb-step-regenerate"]').classes()).toContain('step-done');
      expect(text(wrapper, 'libredb-settings-result')).toBe('%libredbStudio.settings.done.rotate%');
      expect(loadMock).toHaveBeenCalledTimes(2);
    });

    it('can call the rotation off at the confirmation', async() => {
      const wrapper = await loaded(SSO_ON);

      await wrapper.find('[data-testid="libredb-settings-rotate-start"]').trigger('click');
      await wrapper.find('[data-testid="libredb-settings-rotate-cancel"]').trigger('click');

      expect(has(wrapper, 'libredb-settings-rotate-confirm')).toBe(false);
      expect(has(wrapper, 'libredb-settings-rotate-start')).toBe(true);
      expect(rotateMock).not.toHaveBeenCalled();
    });

    it('says why a rotation was refused before it started', async() => {
      rotateMock.mockResolvedValue({
        ok: false, failure: { reason: 'clientNotManaged', args: { name: 'libredb-studio-c-m-1' } }, undone: []
      });
      const wrapper = await loaded(SSO_ON);

      await wrapper.find('[data-testid="libredb-settings-rotate-start"]').trigger('click');
      await wrapper.find('[data-testid="libredb-settings-rotate-confirm-button"]').trigger('click');
      await flushPromises();

      expect(text(wrapper, 'libredb-settings-result')).toBe('%libredbStudio.settings.failed.rotate%');
      expect(text(wrapper, 'libredb-settings-failure')).toBe('%libredbStudio.setup.failure.clientNotManaged%{"name":"libredb-studio-c-m-1"}');
    });

    it('turns single sign-on off only once the OIDC client\'s name is typed by hand', async() => {
      ssoOffMock.mockResolvedValue({ ok: true, undone: [] });
      const wrapper = await loaded(SSO_ON);

      expect(text(wrapper, 'libredb-settings-sso-off')).toContain('%libredbStudio.settings.turnOffWarning%{"client":"libredb-studio-c-m-1","namespace":"libredb-studio"}');
      expect(text(wrapper, 'libredb-settings-sso-off')).toContain('%libredbStudio.settings.ssoNamespaces%{"namespaces":"team-a"}');
      expect(field(wrapper, 'libredb-settings-sso-off-name').props('label')).toBe('%libredbStudio.settings.typeName%{"name":"libredb-studio-c-m-1"}');
      expect(disabled(wrapper, 'libredb-settings-sso-off-button')).toBe(true);

      field(wrapper, 'libredb-settings-sso-off-name').vm.$emit('update:value', 'libredb-studio');
      await flushPromises();
      expect(disabled(wrapper, 'libredb-settings-sso-off-button')).toBe(true);

      field(wrapper, 'libredb-settings-sso-off-name').vm.$emit('update:value', ' libredb-studio-c-m-1 ');
      await flushPromises();
      expect(disabled(wrapper, 'libredb-settings-sso-off-button')).toBe(false);
      await wrapper.find('[data-testid="libredb-settings-sso-off-button"]').trigger('click');
      await flushPromises();

      expect(ssoOffMock).toHaveBeenCalledWith(expect.anything(), 'c-m-1', SSO_RECORD, SETTINGS.app, { name: ' libredb-studio-c-m-1 ', namespaces: ['team-a'] }, expect.anything());
      expect(steps(wrapper)).toStrictEqual([
        'libredb-step-upgrade', 'libredb-step-removeOidcClient', 'libredb-step-removeOidcSecret', 'libredb-step-removeRancherCA', 'libredb-step-saveRecord'
      ]);
      expect(text(wrapper, 'libredb-settings-result')).toBe('%libredbStudio.settings.done.ssoOff%');
      expect(field(wrapper, 'libredb-settings-sso-off-name').props('value')).toBe('');
    });

    it('says that single sign-on could not be turned off completely', async() => {
      ssoOffMock.mockResolvedValue({
        ok: false, failedStep: 'removeOidcSecret', failure: { reason: 'request', args: { detail: 'HTTP 500' } }, undone: []
      });
      const wrapper = await loaded(SSO_ON);

      field(wrapper, 'libredb-settings-sso-off-name').vm.$emit('update:value', 'libredb-studio-c-m-1');
      await flushPromises();
      await wrapper.find('[data-testid="libredb-settings-sso-off-button"]').trigger('click');
      await flushPromises();

      expect(text(wrapper, 'libredb-settings-result')).toBe('%libredbStudio.settings.failed.ssoOff%');
      expect(has(wrapper, 'libredb-settings-failure')).toBe(false);
    });

    it('tells anyone but a Rancher administrator that rotating and turning off need one', async() => {
      const wrapper = await loaded({ ...SSO_ON, ssoAdmin: false });

      expect(text(wrapper, 'libredb-settings-sso-admin-only')).toBe('%libredbStudio.settings.ssoAdminOnly%');
      expect(has(wrapper, 'libredb-settings-rotate')).toBe(false);
      expect(has(wrapper, 'libredb-settings-sso-off')).toBe(false);
      expect(has(wrapper, 'libredb-settings-sso')).toBe(false);
    });

    it('offers neither while the app is not there', async() => {
      const wrapper = await loaded({ ...SSO_ON, app: undefined });

      expect(has(wrapper, 'libredb-settings-sso-on')).toBe(false);
      expect(has(wrapper, 'libredb-settings-uninstall')).toBe(true);
    });

    it('asks t for raw text wherever it renders a message as text', async() => {
      loadMock.mockResolvedValue(SSO_ON);
      const raw = jest.fn((key: string, _args?: unknown, _raw?: boolean) => key);
      const wrapper = mount(Settings, {
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
      await wrapper.find('[data-testid="libredb-settings-rotate-start"]').trigger('click');

      const keys = ['ssoOnIntro', 'rotateTitle', 'rotateIntro', 'rotateConfirm', 'turnOffTitle', 'turnOff', 'ssoNamespaces'].map((key) => `libredbStudio.settings.${ key }`);
      const asked = raw.mock.calls.filter((call) => keys.includes(call[0]));

      expect([...new Set(asked.map((call) => call[0]))].sort()).toStrictEqual([...keys].sort());
      expect(asked.every((call) => call[2] === true)).toBe(true);
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
