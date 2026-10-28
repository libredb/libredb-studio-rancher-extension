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
      ...['not-set-up', 'pending', 'denied'].map((state) => `libredbStudio.databases.reason.${ state }`),
      ...['not-set-up', 'ready', 'not-ready', 'unknown', 'open', 'severalLinks'].map((key) => `libredbStudio.status.${ key }`),
    ];

    expect(keys.filter((key) => typeof lookup(key) !== 'string')).toStrictEqual([]);
  });
});
