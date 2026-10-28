import packageJson from '../package.json';
import rootPackageJson from '../../../package.json';

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

  it('names the product and targets Rancher Manager', () => {
    expect(annotations['catalog.cattle.io/display-name']).toBe('LibreDB Studio');
    expect(annotations['catalog.cattle.io/ui-extensions-host']).toBe('rancher-manager');
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
