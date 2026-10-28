import fs from 'fs';
import path from 'path';
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
});
