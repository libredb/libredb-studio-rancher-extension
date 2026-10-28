import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import packageJson from '../package.json';

const enUsPath = path.resolve(__dirname, '../l10n/en-us.yaml');

describe('translations', () => {
  it('ship an en-us file, the locale the shell falls back to', () => {
    expect(fs.existsSync(enUsPath)).toBe(true);
  });

  it('name the product as the catalog does', () => {
    const enUs = fs.readFileSync(enUsPath, 'utf8');
    const displayName = packageJson.rancher.annotations['catalog.cattle.io/display-name'];

    expect(enUs).toMatch(/^libredbStudio:\n {2}productName: (.+)$/m);
    expect(enUs.match(/^ {2}productName: (.+)$/m)?.[1]).toBe(displayName);
  });

  it('label the product in the navigation as the catalog does', () => {
    const enUs = fs.readFileSync(enUsPath, 'utf8');
    const displayName = packageJson.rancher.annotations['catalog.cattle.io/display-name'];

    expect(enUs).toMatch(new RegExp(`^product:\\n {2}libredb: ${ displayName }$`, 'm'));
  });

  it('hold every key the package uses', () => {
    const enUs = yaml.load(fs.readFileSync(enUsPath, 'utf8')) as Record<string, unknown>;
    const lookup = (key: string) => key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown>)?.[part], enUs);
    const keys = [
      'libredbStudio.databases.label',
      'libredbStudio.databases.studioColumn',
      'libredbStudio.databases.open',
      'libredbStudio.databases.noSchema',
      'libredbStudio.databases.cannotList',
      'libredbStudio.open.refused',
      ...['title', 'host', 'database', 'user'].map((key) => `libredbStudio.panel.${ key }`),
      ...['not-set-up', 'pending', 'denied', 'failed'].map((state) => `libredbStudio.databases.reason.${ state }`),
      ...['not-set-up', 'ready', 'not-ready', 'unknown', 'failed', 'open', 'severalLinks'].map((key) => `libredbStudio.status.${ key }`),
    ];

    expect(keys.filter((key) => typeof lookup(key) !== 'string')).toStrictEqual([]);
  });

  it('hold every message the setup can show', () => {
    const enUs = yaml.load(fs.readFileSync(enUsPath, 'utf8')) as Record<string, unknown>;
    const lookup = (key: string) => key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown>)?.[part], enUs);
    const under = (prefix: string, names: string[]) => names.map((name) => `libredbStudio.setup.${ prefix }${ name }`);
    const checks: Record<string, string[]> = {
      owner:        ['ok', 'notOwner'],
      version:      ['ok', 'old', 'unknown'],
      cnpg:         ['ok', 'missing'],
      aggregation:  ['ok', 'off', 'unknown'],
      ingressClass: ['ok', 'none'],
      storageClass: ['ok', 'none'],
      namespace:    ['new', 'existing', 'inProject'],
      installed:    ['ok', 'installed', 'linked', 'leftover', 'unknown'],
      chart:        ['ok', 'noRepo', 'noChart', 'tooOld', 'unreadable'],
      oidcProvider: ['ok', 'off', 'noServerUrl'],
      oidcAdmin:    ['ok', 'notAdmin'],
      oidcClient:   ['ok', 'exists', 'unknown'],
    };
    const keys = [
      'libredbStudio.settings.inProject',
      'libredbStudio.settings.unmarked',
      ...under('', ['title', 'intro', 'blocked', 'checkAgain', 'failed', 'doneSso', 'doneLocal', 'undoneTitle']),
      ...Object.entries(checks).flatMap(([id, reasons]) => under(`checks.${ id }.`, reasons)),
      ...under('form.', ['host', 'hostHelp', 'ingressClass', 'tlsTitle', 'tls.secret', 'tls.cert-manager', 'tlsSecretName', 'tlsSecretNew', 'tlsSecretExisting', 'clusterIssuer', 'namespaces', 'namespacesHelp', 'sso', 'ssoTrust', 'redirect', 'localSignIn', 'install']),
      ...under('form.errors.', ['host', 'ingressClass', 'tlsSecretName', 'clusterIssuer', 'namespaces', 'tooManyNamespaces', 'sso', 'ssoTrust']),
      ...under('steps.', [
        'namespace', 'oidcClient', 'oidcSecret', 'rancherCA', 'record', 'install', 'ready', 'upgrade', 'saveRecord', 'regenerate', 'restart', 'removeOidcClient',
        'removeOidcSecret', 'removeRancherCA',
      ]),
      ...under('state.', ['pending', 'running', 'done', 'skipped', 'failed']),
      ...under('undo.', ['release', 'upgrade', 'navLink', 'record', 'rancherCA', 'oidcSecret', 'oidcClient', 'namespace']),
      ...under('outcome.', ['removed', 'gone', 'kept', 'restored', 'failed', 'unchecked']),
      ...under('failure.', [
        'request', 'inProject', 'noClientId', 'noClientSecret', 'noRancherCA', 'helmFailed', 'operationFailed', 'timeout', 'notReady', 'releaseLeft', 'notEmpty',
        'notManaged', 'notOurs', 'notAllowed', 'retryLater', 'upgradeLeft', 'untrustedRecord', 'noHost', 'hostChanged', 'ssoUnavailable', 'notConfirmed', 'badNamespaces',
        'changedSinceLoad', 'mayBeLeft', 'notAcknowledged', 'notRegenerated', 'notRestarted', 'clientMissing', 'clientNotManaged', 'objectNotManaged', 'ssoNeedsAdmin',
        'ssoNotOn', 'notConfirmedClient',
      ]),
      ...['label', 'title', 'notOwner', 'notSetUp', 'otherInstall', 'recordUnreadable', 'host', 'unknownHost', 'chart', 'chartValue', 'noApp', 'signIn', 'ssoOn', 'ssoOff',
        'save', 'ssoTitle', 'ssoIntro', 'enableSso', 'redirectConfirm', 'ssoNamespaces', 'ssoOnIntro', 'ssoAdminOnly', 'rotateTitle', 'rotateIntro', 'rotate', 'rotateConfirm',
        'turnOffTitle', 'turnOffWarning', 'turnOff', 'confirm', 'cancel', 'uninstallTitle', 'uninstallWarning', 'typeName', 'uninstall', 'uninstalledTitle',
        'done.namespaces', 'done.sso', 'done.rotate', 'done.ssoOff', 'done.uninstall', 'failed.namespaces', 'failed.sso', 'failed.rotate', 'failed.ssoOff',
        'failed.uninstall'].map((key) => `libredbStudio.settings.${ key }`),
    ];

    expect(keys.filter((key) => typeof lookup(key) !== 'string')).toStrictEqual([]);
  });

  it('say word for word what single sign-on lets this cluster\'s owners do, and call it experimental', () => {
    const enUs = yaml.load(fs.readFileSync(enUsPath, 'utf8')) as Record<string, unknown>;
    const lookup = (key: string) => key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown>)?.[part], enUs);

    expect(lookup('libredbStudio.setup.form.ssoTrust')).toBe(
      'Owners of this cluster will be able to act in Rancher as any user who signs in to LibreDB Studio. Enable single sign-on only on clusters whose owners you trust with that.'
    );
    expect(lookup('libredbStudio.setup.form.sso')).toBe('Sign in with Rancher (single sign-on, experimental)');
    expect(lookup('libredbStudio.settings.ssoTitle')).toBe('Single sign-on (experimental)');
  });

  it('offer no choice of chart repository, which the setup does not have', () => {
    const enUs = yaml.load(fs.readFileSync(enUsPath, 'utf8')) as Record<string, unknown>;
    const lookup = (key: string) => key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown>)?.[part], enUs);

    expect(lookup('libredbStudio.setup.checks.chart.noRepo')).toBe('This cluster has no chart repository {repo}. Add Rancher\'s Partners repository in Apps.');
  });
});
