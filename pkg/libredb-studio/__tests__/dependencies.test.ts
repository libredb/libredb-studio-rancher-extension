import fs from 'fs';
import path from 'path';

// Versions the lockfile must never resolve again. Each row is an advisory this repository fixed
// with a direct upgrade or a `resolutions` entry in package.json; a row is refused when
// `introduced <= version < fixed`. A row goes away only with the reason it no longer applies.
const REFUSED: { name: string, introduced: string, fixed: string, advisory: string }[] = [
  // Shipped in the extension bundle: the shell's sanitiser is built into our chunks.
  {
    name: 'dompurify', introduced: '0.0.0', fixed: '3.4.17', advisory: 'GHSA-cg2g-xh64-v4q7, GHSA-mrv2-3pqr-j5jr, GHSA-c6gr-qvv4-5v3f'
  },
  // Shipped in the extension bundle through diff2html.
  {
    name: 'diff', introduced: '5.0.0', fixed: '5.2.2', advisory: 'GHSA-73rr-hh4g-fpgx'
  },
  // Build and development tooling only.
  {
    name: 'markdown-it', introduced: '0.0.0', fixed: '14.3.3', advisory: 'GHSA-r7fv-28h4-cvq7, GHSA-vfgh-jcmw-g37q, GHSA-6v5v-wf23-fmfq, GHSA-253c-mchw-3w2r'
  },
  {
    name: 'linkify-it', introduced: '0.0.0', fixed: '5.0.2', advisory: 'GHSA-22p9-wv53-3rq4, GHSA-v245-v573-v5vm'
  },
  {
    name: 'postcss', introduced: '0.0.0', fixed: '8.5.23', advisory: 'GHSA-6g55-p6wh-862q, GHSA-r28c-9q8g-f849, GHSA-7fh5-64p2-3v2j, GHSA-qx2v-qp2m-jg93, GHSA-fxqj-rqcc-2cmp'
  },
  {
    name: 'semver', introduced: '7.0.0', fixed: '7.5.2', advisory: 'GHSA-c2qf-rxjj-qqgw'
  },
  {
    name: 'serialize-javascript', introduced: '0.0.0', fixed: '7.1.3', advisory: 'GHSA-5c6j-r48x-rmvq, GHSA-m5mm-p8h7-m29v, GHSA-qj8w-gfj5-8c6v'
  },
  {
    name: 'tmp', introduced: '0.0.0', fixed: '0.2.6', advisory: 'GHSA-ph9p-34f9-6g65, GHSA-52f5-9888-hmc6'
  },
  {
    name: 'webpack-dev-middleware', introduced: '0.0.0', fixed: '7.4.6', advisory: 'GHSA-g84c-rxfj-3j2c'
  },
  {
    name: 'cookie', introduced: '0.0.0', fixed: '0.7.0', advisory: 'GHSA-pxg6-pf52-xh8x'
  },
  {
    name: 'uuid', introduced: '0.0.0', fixed: '11.1.1', advisory: 'GHSA-w5hq-g745-h8pq'
  },
  {
    name: 'fast-xml-parser', introduced: '0.0.0', fixed: '5.7.0', advisory: 'GHSA-gh4j-gqv2-49f6'
  },
];

function parse(version: string): number[] {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);

  if (!match) {
    throw new Error(`not a release version: ${ version }`);
  }

  return match.slice(1).map(Number);
}

function compare(a: string, b: string): number {
  const x = parse(a);
  const y = parse(b);

  for (let i = 0; i < 3; i++) {
    if (x[i] !== y[i]) {
      return x[i] - y[i];
    }
  }

  return 0;
}

// Every version the yarn v1 lockfile resolves for a package name.
function lockedVersions(lockfile: string, name: string): string[] {
  const versions: string[] = [];

  for (const block of lockfile.split(/\n\n+/)) {
    const [header, ...body] = block.split('\n');
    const specs = header.replace(/:$/, '').split(', ').map((spec) => spec.replace(/^"|"$/g, ''));

    if (!specs.some((spec) => spec.slice(0, spec.lastIndexOf('@')) === name)) {
      continue;
    }

    const version = body.map((line) => /^ {2}version "([^"]+)"$/.exec(line)).find(Boolean);

    if (!version) {
      throw new Error(`no version line for ${ header }`);
    }
    versions.push(version[1]);
  }

  return versions;
}

describe('dependency advisories', () => {
  const lockfile = fs.readFileSync(path.resolve(__dirname, '../../../yarn.lock'), 'utf8');

  it.each(REFUSED)('the lockfile resolves no $name below $fixed ($advisory)', ({ name, introduced, fixed }) => {
    const versions = lockedVersions(lockfile, name);

    expect(versions.length).toBeGreaterThan(0);
    expect(versions.filter((v) => compare(v, introduced) >= 0 && compare(v, fixed) < 0)).toStrictEqual([]);
  });

  it('reads scoped names and quoted specs the way yarn writes them', () => {
    const sample = [
      '"@scope/pkg@^1.0.0", "@scope/pkg@~1.0.1":',
      '  version "1.0.4"',
      '',
      'pkg@^2.0.0:',
      '  version "2.1.0"',
      '',
      'pkg-other@^1.0.0:',
      '  version "9.9.9"',
    ].join('\n');

    expect(lockedVersions(sample, '@scope/pkg')).toStrictEqual(['1.0.4']);
    expect(lockedVersions(sample, 'pkg')).toStrictEqual(['2.1.0']);
    expect(() => lockedVersions('pkg@^1.0.0:\n  resolved "x"', 'pkg')).toThrow('no version line');
    expect(() => compare('1.0', '1.0.0')).toThrow('not a release version');
    expect(compare('7.8.5', '7.5.2')).toBeGreaterThan(0);
  });
});
