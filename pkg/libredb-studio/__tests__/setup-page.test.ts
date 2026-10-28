import { flushPromises, mount, RouterLinkStub, VueWrapper } from '@vue/test-utils';
import { defineComponent, h } from 'vue';
import Setup from '../pages/Setup.vue';
import SetupChecks from '../components/SetupChecks.vue';
import StepList from '../components/StepList.vue';
import { runPreflight, PreflightResult } from '../services/setup/preflight';
import { installStudio, InstallOptions, InstallResult } from '../services/setup/install';
import { RANCHER_CA } from './helpers/cluster';

jest.mock('../services/setup/preflight', () => ({ ...jest.requireActual('../services/setup/preflight'), runPreflight: jest.fn() }));
jest.mock('../services/setup/install', () => ({ ...jest.requireActual('../services/setup/install'), installStudio: jest.fn() }));

const preflightMock = runPreflight as jest.Mock;
const installMock = installStudio as jest.Mock;

const t = (key: string, args?: Record<string, unknown>) => `%${ key }%${ args ? JSON.stringify(args) : '' }`;

const PREFLIGHT: PreflightResult = {
  checks: [
    {
      id: 'owner', state: 'ok', reason: 'ok'
    },
    {
      id: 'aggregation', state: 'warning', reason: 'off'
    },
    {
      id:     'chart',
      state:  'ok',
      reason: 'ok',
      args:   {
        repo: 'rancher-partner-charts', version: '0.1.110', appVersion: '1.2.0'
      }
    },
    {
      id: 'oidcAdmin', state: 'ok', reason: 'ok', sso: true
    },
  ],
  canInstall:      true,
  canUseSso:       true,
  serverUrl:       'https://rancher.example.com',
  serverVersion:   'v2.15.2',
  scopes:          ['openid', 'profile', 'groups'],
  cacerts:         RANCHER_CA,
  ingressClasses:  ['traefik', 'nginx'],
  clusterIssuers:  ['letsencrypt'],
  namespaces:      ['team-a', 'team-b'],
  repo:            'rancher-partner-charts',
  chart:           { version: '0.1.110', appVersion: '1.2.0' },
  namespaceExists: false,
};

const fieldStub = (name: string) => defineComponent({
  name,
  props: {
    value:    { type: [String, Array, Boolean], default: undefined },
    label:    { type: String, default: '' },
    options:  { type: Array, default: () => [] },
    labels:   { type: Array, default: () => [] },
    disabled: { type: Boolean, default: false },
    multiple: { type: Boolean, default: false },
  },
  emits: ['update:value'],
  setup(props) {
    return () => h('div', { class: `stub-${ name }`, 'data-disabled': String(props.disabled) }, props.label);
  },
});

const BannerStub = defineComponent({
  props: { color: { type: String, default: '' }, label: { type: String, default: '' } },
  setup(props) {
    return () => h('div', { class: `banner ${ props.color }` }, props.label);
  },
});

const render = () => mount(Setup, {
  global: {
    mocks: {
      t, $store: { getters: {}, dispatch: jest.fn() }, $route: { params: { cluster: 'c-m-1' } }
    },
    stubs: {
      Banner:        BannerStub,
      Loading:       { template: '<div data-testid="loading" />' },
      LabeledInput:  fieldStub('LabeledInput'),
      LabeledSelect: fieldStub('LabeledSelect'),
      RadioGroup:    fieldStub('RadioGroup'),
      Checkbox:      fieldStub('Checkbox'),
      RouterLink:    RouterLinkStub,
    },
  },
});

const field = (wrapper: VueWrapper, testid: string) => wrapper.findComponent(`[data-testid="${ testid }"]`) as unknown as VueWrapper<InstanceType<ReturnType<typeof fieldStub>>>;

const fill = async(wrapper: VueWrapper, values: Record<string, unknown>) => {
  for (const [testid, value] of Object.entries(values)) {
    field(wrapper, testid).vm.$emit('update:value', value);
  }
  await flushPromises();
};

const VALID = { 'libredb-setup-host': 'studio.example.com', 'libredb-setup-namespaces': ['team-a'] };

describe('setup page', () => {
  beforeEach(() => {
    preflightMock.mockReset().mockResolvedValue(PREFLIGHT);
    installMock.mockReset();
  });

  it('shows the loading state, then every check of the preflight run for this cluster', async() => {
    const wrapper = render();

    expect(wrapper.find('[data-testid="loading"]').exists()).toBe(true);
    await flushPromises();

    expect(preflightMock).toHaveBeenCalledWith(expect.anything(), 'c-m-1');
    expect(wrapper.find('[data-testid="libredb-check-aggregation"]').text()).toContain('%libredbStudio.setup.checks.aggregation.off%');
    expect(wrapper.find('[data-testid="libredb-check-aggregation"] i').classes()).toContain('icon-warning');
    expect(wrapper.find('[data-testid="libredb-setup-form"]').exists()).toBe(true);
  });

  it('offers no form when a check stops the install, only to check again', async() => {
    preflightMock.mockResolvedValueOnce({
      ...PREFLIGHT,
      canInstall: false,
      checks:     [{
        id: 'owner', state: 'error', reason: 'notOwner'
      }]
    });
    const wrapper = render();

    await flushPromises();

    expect(wrapper.find('[data-testid="libredb-setup-form"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="libredb-check-owner"] i').classes()).toContain('icon-error');
    await wrapper.find('[data-testid="libredb-setup-check-again"]').trigger('click');
    await flushPromises();

    expect(preflightMock).toHaveBeenCalledTimes(2);
    expect(wrapper.find('[data-testid="libredb-setup-form"]').exists()).toBe(true);
  });

  it('sends a cluster owner to Settings when Studio is already set up here', async() => {
    preflightMock.mockResolvedValueOnce({
      ...PREFLIGHT,
      canInstall: false,
      checks:     [{
        id: 'installed', state: 'error', reason: 'leftover'
      }]
    });
    const wrapper = render();

    await flushPromises();

    expect(wrapper.findComponent(RouterLinkStub).props('to')).toStrictEqual({ name: 'c-cluster-libredb-settings', params: { cluster: 'c-m-1', product: 'libredb' } });
  });

  it('offers no way to Settings when something else stops the install', async() => {
    preflightMock.mockResolvedValueOnce({
      ...PREFLIGHT,
      canInstall: false,
      checks:     [{
        id: 'cnpg', state: 'error', reason: 'missing'
      }]
    });
    const wrapper = render();

    await flushPromises();

    expect(wrapper.find('[data-testid="libredb-setup-go-settings"]').exists()).toBe(false);
  });

  it('shows where Rancher will send people back, once the host name is a valid one', async() => {
    const wrapper = render();

    await flushPromises();
    expect(wrapper.find('[data-testid="libredb-setup-redirect"]').exists()).toBe(false);

    await fill(wrapper, { 'libredb-setup-host': 'Studio.Example.com' });
    expect(wrapper.find('[data-testid="libredb-setup-redirect"]').text()).toBe('%libredbStudio.setup.form.redirect%{"uri":"https://studio.example.com/api/auth/oidc/callback"}');

    await fill(wrapper, { 'libredb-setup-sso': false });
    expect(wrapper.find('[data-testid="libredb-setup-redirect"]').exists()).toBe(false);
  });

  it('starts from the preflight\'s choices', async() => {
    const wrapper = render();

    await flushPromises();

    expect(field(wrapper, 'libredb-setup-ingress-class').props()).toMatchObject({ value: 'traefik', options: ['traefik', 'nginx'] });
    expect(field(wrapper, 'libredb-setup-tls').props()).toMatchObject({ value: 'secret', options: ['secret', 'cert-manager'] });
    expect(field(wrapper, 'libredb-setup-tls').props('labels')).toStrictEqual([
      '%libredbStudio.setup.form.tls.secret%{"namespace":"libredb-studio"}', '%libredbStudio.setup.form.tls.cert-manager%{"namespace":"libredb-studio"}'
    ]);
    expect(field(wrapper, 'libredb-setup-tls-secret').props('value')).toBe('libredb-studio-tls');
    expect(field(wrapper, 'libredb-setup-namespaces').props()).toMatchObject({
      value: [], options: ['team-a', 'team-b'], multiple: true
    });
    expect(field(wrapper, 'libredb-setup-sso').props()).toMatchObject({ value: true, disabled: false });
    expect(wrapper.find('[data-testid="libredb-setup-local-sign-in"]').exists()).toBe(false);
  });

  it('offers only a TLS Secret without cert-manager, and no single sign-on where it is not available', async() => {
    preflightMock.mockResolvedValueOnce({
      ...PREFLIGHT, clusterIssuers: [], canUseSso: false
    });
    const wrapper = render();

    await flushPromises();

    expect(field(wrapper, 'libredb-setup-tls').props('options')).toStrictEqual(['secret']);
    expect(field(wrapper, 'libredb-setup-sso').props()).toMatchObject({ value: false, disabled: true });
    expect(wrapper.find('[data-testid="libredb-setup-local-sign-in"]').text()).toBe('%libredbStudio.setup.form.localSignIn%');
  });

  it('asks for a ClusterIssuer when cert-manager issues the certificate', async() => {
    const wrapper = render();

    await flushPromises();
    await fill(wrapper, { 'libredb-setup-tls': 'cert-manager' });

    expect(wrapper.find('[data-testid="libredb-setup-tls-secret"]').exists()).toBe(false);
    expect(field(wrapper, 'libredb-setup-cluster-issuer').props()).toMatchObject({ value: 'letsencrypt', options: ['letsencrypt'] });
  });

  it('says what is missing instead of installing an incomplete form', async() => {
    const wrapper = render();

    await flushPromises();
    await wrapper.find('form').trigger('submit');

    expect(installMock).not.toHaveBeenCalled();
    expect(wrapper.find('[data-testid="libredb-setup-errors"]').text()).toContain('%libredbStudio.setup.form.errors.host%');
    expect(wrapper.find('[data-testid="libredb-setup-errors"]').text()).toContain('%libredbStudio.setup.form.errors.namespaces%');
  });

  it('offers no choice of chart repository', async() => {
    const wrapper = render();

    await flushPromises();

    expect(wrapper.find('[data-testid="libredb-setup-repo"]').exists()).toBe(false);
  });

  describe('installing', () => {
    const succeed = (result: Partial<InstallResult> = {}) => installMock.mockImplementation((_store: unknown, _plan: unknown, options: InstallOptions) => {
      options.onStep?.({ step: 'namespace', state: 'running' });
      options.onStep?.({ step: 'namespace', state: 'done' });

      return Promise.resolve({
        ok:     true,
        undone: [],
        link:   {
          name: 'libredb-studio.libredb-studio', toURL: 'https://studio.example.com', namespace: 'libredb-studio', deploymentName: 'libredb-studio'
        },
        ...result,
      });
    });

    it('installs the plan of the form, shows each step, then opens Studio', async() => {
      succeed();
      const wrapper = render();

      await flushPromises();
      await fill(wrapper, VALID);
      await wrapper.find('form').trigger('submit');
      await flushPromises();

      const [, plan] = installMock.mock.calls[0];

      expect(plan.record).toMatchObject({
        host: 'studio.example.com', namespaces: ['team-a'], ingressClassName: 'traefik', sso: { client: 'libredb-studio-c-m-1', scope: 'openid profile groups' }
      });
      expect(wrapper.find('[data-testid="libredb-step-namespace"]').classes()).toContain('step-done');
      expect(wrapper.find('[data-testid="libredb-step-install"]').classes()).toContain('step-pending');
      expect(wrapper.find('[data-testid="libredb-setup-done"]').text()).toContain('%libredbStudio.setup.doneSso%');
      expect(wrapper.find('[data-testid="libredb-setup-open"]').attributes()).toMatchObject({
        href: 'https://studio.example.com', target: '_blank', rel: 'noopener noreferrer nofollow'
      });
      expect(wrapper.findComponent(RouterLinkStub).props('to')).toMatchObject({ name: 'c-cluster-libredb-settings' });
    });

    it('says how to sign in when Studio keeps its own sign-in', async() => {
      succeed({ link: undefined });
      const wrapper = render();

      await flushPromises();
      await fill(wrapper, { ...VALID, 'libredb-setup-sso': false });
      await wrapper.find('form').trigger('submit');
      await flushPromises();

      expect(installMock.mock.calls[0][1].record.sso).toBeUndefined();
      expect(wrapper.find('[data-testid="libredb-setup-done"]').text()).toContain('%libredbStudio.setup.doneLocal%{"namespace":"libredb-studio"}');
      expect(wrapper.find('[data-testid="libredb-setup-open"]').exists()).toBe(false);
    });

    it('shows the failed step and what became of everything it had created, and checks again on request', async() => {
      installMock.mockImplementation((_store: unknown, _plan: unknown, options: InstallOptions) => {
        options.onStep?.({
          step: 'install', state: 'failed', failure: { reason: 'helmFailed' }
        });
        options.onUndo?.({
          undo: 'namespace', outcome: 'kept', failure: { reason: 'notEmpty', args: { namespace: 'libredb-studio' } }
        });

        return Promise.resolve({
          ok: false, failedStep: 'install', failure: { reason: 'helmFailed' }, undone: []
        });
      });
      const wrapper = render();

      await flushPromises();
      await fill(wrapper, VALID);
      await wrapper.find('form').trigger('submit');
      await flushPromises();

      expect(wrapper.find('[data-testid="libredb-step-install-failure"]').text()).toBe('%libredbStudio.setup.failure.helmFailed%');
      expect(wrapper.find('[data-testid="libredb-undo-namespace"]').text()).toContain('%libredbStudio.setup.outcome.kept%');
      expect(wrapper.find('[data-testid="libredb-undo-namespace"]').text()).toContain('%libredbStudio.setup.failure.notEmpty%');
      expect(wrapper.find('[data-testid="libredb-setup-failure"]').exists()).toBe(false);

      await wrapper.find('[data-testid="libredb-setup-retry"]').trigger('click');
      await flushPromises();
      expect(preflightMock).toHaveBeenCalledTimes(2);
      expect(wrapper.find('[data-testid="libredb-setup-form"]').exists()).toBe(true);
    });

    it('reports an install that broke off before any step could say why', async() => {
      installMock.mockRejectedValue(new Error('chunk failed to load'));
      const wrapper = render();

      await flushPromises();
      await fill(wrapper, VALID);
      await wrapper.find('form').trigger('submit');
      await flushPromises();

      expect(wrapper.find('[data-testid="libredb-setup-failure"]').text()).toBe('%libredbStudio.setup.failure.request%{"detail":"chunk failed to load"}');
    });
  });
});

describe('setup components', () => {
  it('marks each check by its state', () => {
    const wrapper = mount(SetupChecks, {
      props: {
        checks: [
          {
            id: 'owner', state: 'ok', reason: 'ok'
          },
          {
            id: 'version', state: 'warning', reason: 'old', args: { version: 'v2.14.3' }
          },
          {
            id: 'cnpg', state: 'error', reason: 'missing'
          },
        ]
      },
      global: { mocks: { t } },
    });

    expect(wrapper.findAll('li').map((item) => item.classes())).toStrictEqual([['check-ok'], ['check-warning'], ['check-error']]);
    expect(wrapper.find('[data-testid="libredb-check-version"]').text()).toBe('%libredbStudio.setup.checks.version.old%{"version":"v2.14.3"}');
  });

  it('lists the steps, and what was removed again only after a failure', () => {
    const steps = mount(StepList, {
      props:  { steps: [{ step: 'namespace', state: 'running' }, { step: 'record', state: 'skipped' }] },
      global: { mocks: { t } },
    });

    expect(steps.find('[data-testid="libredb-step-namespace"] i').classes()).toContain('icon-spinner');
    expect(steps.find('[data-testid="libredb-step-namespace"]').text()).toContain('%libredbStudio.setup.steps.namespace%{"namespace":"libredb-studio"}');
    expect(steps.find('[data-testid="libredb-undone"]').exists()).toBe(false);

    const undone = mount(StepList, {
      props: {
        steps:  [{ step: 'install', state: 'failed' }],
        undone: [{
          undo: 'oidcSecret', outcome: 'failed', failure: { reason: 'request', args: { detail: 'HTTP 500' } }
        }, { undo: 'record', outcome: 'removed' }],
      },
      global: { mocks: { t } },
    });

    expect(undone.find('[data-testid="libredb-undo-oidcSecret"] .text-error').text()).toBe('%libredbStudio.setup.outcome.failed%');
    expect(undone.find('[data-testid="libredb-undo-record"]').text()).toContain('%libredbStudio.setup.outcome.removed%');
  });
});
