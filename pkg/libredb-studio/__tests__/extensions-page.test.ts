import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import yaml from 'js-yaml';
import packageJson from '../package.json';

/**
 * What Rancher decides about the chart a release publishes. The chart is built as the shell's publish
 * script builds it: the shell's ui-plugin-server template, with the annotations of this package's
 * package.json copied into Chart.yaml by the shell's own helmpatch, and into the UIPlugin's metadata.
 * The Extensions page offers a version for install only when the shell's isSupportedChartVersion
 * passes it, and the dashboard loads the UIPlugin the chart creates only when shouldNotLoadPlugin lets
 * it, so both run here as a host runs them, for every Rancher line the extension declares.
 */
const SHELL = path.resolve(__dirname, '../../../node_modules/@rancher/shell');
const PACKAGE_JSON = path.resolve(__dirname, '../package.json');
const HOST_ANNOTATION = 'catalog.cattle.io/ui-extensions-host';

type Annotations = Record<string, string>;

interface HostGates {
  isSupportedChartVersion(data: { version: { version: string, annotations: Annotations }, rancherVersion: string, kubeVersion: string }, returnObj: true): {
    isVersionCompatible: boolean;
    versionIncompatibilityData: Record<string, unknown>;
  };
  shouldNotLoadPlugin(plugin: Record<string, unknown>, versions: { rancherVersion: string, kubeVersion: string }, loaded: unknown[]): string | boolean;
}

/** The annotations of Chart.yaml once the shell's helmpatch has run on its template with the given package.json */
function chartAnnotations(packageJsonPath: string): Annotations {
  const chart = fs.mkdtempSync(path.join(os.tmpdir(), 'libredb-chart-'));

  try {
    fs.cpSync(path.join(SHELL, 'scripts/extension/helm/charts/ui-plugin-server'), chart, { recursive: true });
    execFileSync(process.execPath, [path.join(SHELL, 'scripts/extension/helmpatch'), chart, packageJsonPath], {
      env: {
        ...process.env, GITHUB_BUILD: 'true', GITHUB_SOURCE: 'libredb/libredb-studio-rancher-extension', GITHUB_BRANCH: 'gh-pages'
      },
      stdio: 'pipe',
    });

    return (yaml.load(fs.readFileSync(path.join(chart, 'Chart.yaml'), 'utf8')) as { annotations: Annotations }).annotations;
  } finally {
    fs.rmSync(chart, { recursive: true, force: true });
  }
}

/** The shell's gates as a host runs them, whose dashboard was built from the given shell version */
function hostGates(shellVersion: string): HostGates {
  const saved = process.env.UI_EXTENSIONS_API_VERSION;
  let gates: HostGates | undefined;

  jest.isolateModules(() => {
    process.env.UI_EXTENSIONS_API_VERSION = shellVersion;
    gates = require('@shell/config/uiplugins');
  });

  if (saved === undefined) {
    delete process.env.UI_EXTENSIONS_API_VERSION;
  } else {
    process.env.UI_EXTENSIONS_API_VERSION = saved;
  }

  return gates as HostGates;
}

/** The declared Rancher lines, each with the shell its dashboard bundles, on the oldest and a current Kubernetes */
const HOSTS = ['v2.15.0', 'v2.15.2', 'v2.15-head', 'v2.16.0'].flatMap((rancherVersion) => ['v1.26.0', 'v1.35.5+k3s1'].map((kubeVersion) => ({
  rancherVersion,
  kubeVersion,
  shellVersion: rancherVersion.startsWith('v2.15') ? '3.0.12-rc.7' : '3.0.15-rc.4',
})));

describe('the published chart on Rancher', () => {
  const annotations = chartAnnotations(PACKAGE_JSON);

  it('carries every annotation of the package in Chart.yaml, which the Extensions page judges', () => {
    expect(annotations).toMatchObject(packageJson.rancher.annotations);
    expect(annotations['catalog.cattle.io/ui-component']).toBe('plugins');
  });

  it.each(HOSTS)('is offered for install on Rancher $rancherVersion with Kubernetes $kubeVersion', ({ rancherVersion, kubeVersion, shellVersion }) => {
    const version = { version: packageJson.version, annotations };
    const { isVersionCompatible, versionIncompatibilityData } = hostGates(shellVersion).isSupportedChartVersion({
      version, rancherVersion, kubeVersion
    }, true);

    expect({ isVersionCompatible, versionIncompatibilityData }).toStrictEqual({ isVersionCompatible: true, versionIncompatibilityData: {} });
  });

  it.each(HOSTS)('is loaded once installed on Rancher $rancherVersion with Kubernetes $kubeVersion', ({ rancherVersion, kubeVersion, shellVersion }) => {
    // The shell's patch script copies the package's annotations into the UIPlugin's metadata
    const uiPlugin = {
      name: packageJson.name, version: packageJson.version, endpoint: 'https://example.invalid/plugin', metadata: packageJson.rancher.annotations
    };

    expect(hostGates(shellVersion).shouldNotLoadPlugin(uiPlugin, { rancherVersion, kubeVersion }, [])).toBe(false);
  });

  it('would not be offered with a host annotation, which the Extensions page checks as a version range', () => {
    const named = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'libredb-package-')), 'package.json');

    try {
      const withHost = { ...packageJson, rancher: { annotations: { ...packageJson.rancher.annotations, [HOST_ANNOTATION]: 'rancher-manager' } } };

      fs.writeFileSync(named, JSON.stringify(withHost));

      const version = { version: packageJson.version, annotations: chartAnnotations(named) };

      expect(hostGates('3.0.12-rc.7').isSupportedChartVersion({
        version, rancherVersion: 'v2.15.2', kubeVersion: 'v1.35.5+k3s1'
      }, true)).toMatchObject({
        isVersionCompatible:        false,
        versionIncompatibilityData: { type: 'host', required: 'rancher-manager' },
      });
    } finally {
      fs.rmSync(path.dirname(named), { recursive: true, force: true });
    }
  });
});
