import fs from 'fs';
import path from 'path';
import packageJson from '../package.json';
import rootPackageJson from '../../../package.json';
import { MIN_APP_VERSION, MIN_CHART_VERSION } from '../services/setup/versions';

/**
 * The package.json annotations become the extension chart's catalog annotations, which decide on
 * which Rancher and Kubernetes versions the Extensions page offers the extension at all.
 */
describe('extension package manifest', () => {
  const annotations: Record<string, string> = packageJson.rancher.annotations;

  it('uses the manifest key as the package name, distinct from the root app name', () => {
    expect(packageJson.name).toBe('libredb-studio');
    expect(rootPackageJson.name).toBe('libredb-studio-rancher-extension');
    expect(rootPackageJson.private).toBe(true);
  });

  it('declares Rancher 2.15 as the floor with no upper bound', () => {
    expect(annotations['catalog.cattle.io/rancher-version']).toBe('>= 2.15.0-0');
  });

  it('guards against a Shell major change', () => {
    expect(annotations['catalog.cattle.io/ui-extensions-version']).toBe('>= 3.0.0 < 4.0.0');
  });

  it('declares the Kubernetes floor of the Studio chart with no upper bound', () => {
    expect(annotations['catalog.cattle.io/kube-version']).toBe('>= 1.26.0-0');
  });

  it('names the product as the catalog shows it', () => {
    expect(annotations['catalog.cattle.io/display-name']).toBe('LibreDB Studio');
  });

  it('names no host application, which the Extensions page checks as a version range and so refuses for any value', () => {
    expect(Object.keys(annotations)).not.toContain('catalog.cattle.io/ui-extensions-host');
  });

  it('is never marked Prime-only', () => {
    expect(Object.keys(annotations)).not.toContain('catalog.cattle.io/prime-only');
  });

  it('is MIT licensed in the package and the root app', () => {
    expect(packageJson.license).toBe('MIT');
    expect(rootPackageJson.license).toBe('MIT');
  });

  it('points the chart home at this repository', () => {
    expect(packageJson.homepage).toBe('https://github.com/libredb/libredb-studio-rancher-extension');
  });

  it('pins @rancher/shell exactly', () => {
    expect(rootPackageJson.dependencies['@rancher/shell']).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

/**
 * The publish script makes package.json's icon the chart's icon, which the Extensions page shows on
 * the card and in the details, and the Installed card reads it from the plugin's metadata, which is
 * package.json. The partner catalog takes only an https icon on raw.githubusercontent.com.
 */
describe('the extension icon', () => {
  const RAW_MAIN = 'https://raw.githubusercontent.com/libredb/libredb-studio-rancher-extension/main/';
  const repoFile = (url: string) => path.resolve(__dirname, '../../..', url.slice(RAW_MAIN.length));

  it('is served from this repository\'s main branch on raw.githubusercontent.com', () => {
    expect(packageJson.icon.startsWith(RAW_MAIN)).toBe(true);
    expect(repoFile(packageJson.icon)).toBe(path.resolve(__dirname, '../assets/icon.svg'));
    expect(fs.existsSync(repoFile(packageJson.icon))).toBe(true);
  });

  it('is a self-contained SVG with no script and nothing fetched from elsewhere', () => {
    const svg = fs.readFileSync(repoFile(packageJson.icon), 'utf8');

    expect(svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"[^>]* viewBox="[^"]+">/);
    expect(svg).not.toMatch(/<script|<foreignObject|\son[a-z]+=/i);
    expect([...svg.matchAll(/href="([^"]*)"/g)].map(([, ref]) => ref).filter((ref) => !ref.startsWith('#'))).toStrictEqual([]);
  });

  it('keeps its own white backdrop inside the outline, so it reads on light and dark themes alike', () => {
    const svg = fs.readFileSync(repoFile(packageJson.icon), 'utf8');

    expect(svg).toMatch(/<g>\n<path fill="#ffffff" d="M325\.19,23\.39/);
  });
});

describe('what the READMEs promise', () => {
  const read = (file: string) => fs.readFileSync(path.resolve(__dirname, file), 'utf8');

  it('states the chart floor the setup enforces', () => {
    const card = read('../README.md');

    expect(card).toContain(`chart ${ MIN_CHART_VERSION } or later`);
    expect(MIN_APP_VERSION).toBe('1.1.1');
    expect(card).toContain('LibreDB Studio after 1.1.0');
  });

  it('keeps the development chart repository out of every workflow, so no published build names one', () => {
    const workflows = path.resolve(__dirname, '../../../.github/workflows');
    const naming = fs.readdirSync(workflows).filter((file) => fs.readFileSync(path.join(workflows, file), 'utf8').includes('VUE_APP_LIBREDB_DEV_REPO'));

    expect(naming).toStrictEqual([]);
    expect(read('../../../README.md')).toContain('VUE_APP_LIBREDB_DEV_REPO');
  });
});
