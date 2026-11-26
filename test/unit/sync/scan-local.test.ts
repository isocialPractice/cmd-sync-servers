import assert from 'node:assert/strict';
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { siteCloak } from '../../../src/sync/cloak.ts';
import { STATUS } from '../../../src/sync/messages.ts';
import { ROOT, toRemotePath, type LinkPolicy } from '../../../src/sync/paths.ts';
import { HashCache, scanLocal } from '../../../src/sync/scan-local.ts';
import { tempDir } from '../../helpers/cli.ts';

// A site whose local folder holds links of every kind:
//   index.html, shared/site.css, shared/img/hero.svg, drafts/img/raw.svg, drafts/notes.md
//   img -> shared/img            pics -> shared/img          (two links to one folder)
//   hidden -> drafts/img         (into a cloaked folder)     css/loop -> the root
//   fonts -> <outside>/fonts     gone -> a folder that does not exist
//   css/site.css -> ../shared/site.css    css/theme.css -> <outside>/theme/theme.css
//   notes.md -> drafts/notes.md  (to a cloaked file)
// Folder links are junctions, which need no privilege on Windows; file links
// are left out where creating them is refused.
describe('scanLocal and symbolic links', () => {
  let temp: ReturnType<typeof tempDir>;
  let local: string;
  let outside: string;
  let folderLinks = true;
  let fileLinks = true;
  const cloak = siteCloak({ cloaking: { enabled: true, patterns: ['/drafts/'], paths: [] } });

  const write = (file: string, content: string): void => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  };

  before(() => {
    temp = tempDir();
    const real = realpathSync.native(temp.dir);
    local = path.join(real, 'site');
    outside = path.join(real, 'outside');
    write(path.join(local, 'index.html'), '<h1>Home</h1>');
    write(path.join(local, 'shared', 'site.css'), 'body {}');
    write(path.join(local, 'shared', 'img', 'hero.svg'), '<svg/>');
    write(path.join(local, 'drafts', 'img', 'raw.svg'), '<svg id="raw"/>');
    write(path.join(local, 'drafts', 'notes.md'), 'Notes');
    write(path.join(outside, 'fonts', 'site.woff2'), 'font');
    write(path.join(outside, 'theme', 'theme.css'), 'h1 {}');
    mkdirSync(path.join(local, 'css'));
    try {
      symlinkSync(path.join(local, 'shared', 'img'), path.join(local, 'img'), 'junction');
      symlinkSync(path.join(local, 'shared', 'img'), path.join(local, 'pics'), 'junction');
      symlinkSync(path.join(local, 'drafts', 'img'), path.join(local, 'hidden'), 'junction');
      symlinkSync(local, path.join(local, 'css', 'loop'), 'junction');
      symlinkSync(path.join(outside, 'fonts'), path.join(local, 'fonts'), 'junction');
      symlinkSync(path.join(real, 'missing'), path.join(local, 'gone'), 'junction');
    } catch {
      folderLinks = false;
    }
    try {
      symlinkSync(path.join('..', 'shared', 'site.css'), path.join(local, 'css', 'site.css'), 'file');
      symlinkSync(path.join(outside, 'theme', 'theme.css'), path.join(local, 'css', 'theme.css'), 'file');
      symlinkSync(path.join(local, 'drafts', 'notes.md'), path.join(local, 'notes.md'), 'file');
    } catch {
      fileLinks = false;
    }
  });

  after(() => {
    temp.cleanup();
  });

  const scan = async (symlinks: LinkPolicy, scopes: readonly string[] = ['']) => {
    const result = await scanLocal({ root: local, cloak, symlinks, checksum: false, scopes: scopes.map((scope) => (scope === '' ? ROOT : toRemotePath(scope))) });
    return {
      files: [...result.files.keys()].sort(),
      problems: result.problems.map((problem) => `${problem.path}: ${problem.status}`).sort(),
      linked: [...result.linked.entries()].map(([key, value]) => `${key} -> ${path.relative(path.dirname(local), value.real).split(path.sep).join('/')}${value.outside ? ' (outside)' : ''}`).sort(),
      cloaked: result.cloaked,
    };
  };

  const fileLinked = (...items: string[]): string[] => (fileLinks ? items : []);

  test('skip lists every link as a problem and follows none', async (t) => {
    if (!folderLinks) {
      t.skip('creating folder links is not permitted here');
      return;
    }
    const result = await scan('skip');
    assert.deepEqual(result.files, ['index.html', 'shared/img/hero.svg', 'shared/site.css']);
    assert.deepEqual(
      result.problems,
      [
        ...['css/loop', 'fonts', 'gone', 'hidden', 'img', 'pics'],
        ...fileLinked('css/site.css', 'css/theme.css', 'notes.md'),
      ]
        .map((item) => `${item}: ${STATUS.linkNotFollowed}`)
        .sort(),
    );
    assert.deepEqual(result.linked, []);
    assert.equal(result.cloaked, 1);
  });

  test('follow-inside-root follows links inside the site and says why it skips the rest', async (t) => {
    if (!folderLinks) {
      t.skip('creating folder links is not permitted here');
      return;
    }
    const result = await scan('follow-inside-root');
    assert.deepEqual(result.files, ['index.html', 'img/hero.svg', 'pics/hero.svg', 'shared/img/hero.svg', 'shared/site.css', ...fileLinked('css/site.css')].sort());
    assert.deepEqual(
      result.problems,
      [`css/loop: ${STATUS.linkLoop}`, `fonts: ${STATUS.linkOutside}`, `gone: ${STATUS.linkBroken}`, ...fileLinked(`css/theme.css: ${STATUS.linkOutside}`)].sort(),
    );
    assert.deepEqual(result.linked, ['img/hero.svg -> site/shared/img/hero.svg', 'pics/hero.svg -> site/shared/img/hero.svg', ...fileLinked('css/site.css -> site/shared/site.css')].sort());
    // drafts/, and hidden/ and notes.md, which lead into it.
    assert.equal(result.cloaked, fileLinks ? 3 : 2);
  });

  test('follow also follows links out of the site, and marks what they reach as outside', async (t) => {
    if (!folderLinks) {
      t.skip('creating folder links is not permitted here');
      return;
    }
    const result = await scan('follow');
    assert.deepEqual(
      result.files,
      ['fonts/site.woff2', 'index.html', 'img/hero.svg', 'pics/hero.svg', 'shared/img/hero.svg', 'shared/site.css', ...fileLinked('css/site.css', 'css/theme.css')].sort(),
    );
    assert.deepEqual(result.problems, [`css/loop: ${STATUS.linkLoop}`, `gone: ${STATUS.linkBroken}`]);
    assert.deepEqual(
      result.linked,
      [
        'fonts/site.woff2 -> outside/fonts/site.woff2 (outside)',
        'img/hero.svg -> site/shared/img/hero.svg',
        'pics/hero.svg -> site/shared/img/hero.svg',
        ...fileLinked('css/site.css -> site/shared/site.css', 'css/theme.css -> outside/theme/theme.css (outside)'),
      ].sort(),
    );
  });

  test('a single path is reached through the links above it by the same rules', async (t) => {
    if (!folderLinks) {
      t.skip('creating folder links is not permitted here');
      return;
    }
    const skipped = await scan('skip', ['img/hero.svg', 'img/icon.svg']);
    assert.deepEqual(skipped, { files: [], problems: [`img: ${STATUS.linkNotFollowed}`], linked: [], cloaked: 0 });

    const inside = await scan('follow-inside-root', ['img/hero.svg']);
    assert.deepEqual(inside, { files: ['img/hero.svg'], problems: [], linked: ['img/hero.svg -> site/shared/img/hero.svg'], cloaked: 0 });

    assert.deepEqual((await scan('follow-inside-root', ['fonts/site.woff2'])).problems, [`fonts: ${STATUS.linkOutside}`]);
    assert.deepEqual((await scan('follow', ['fonts/site.woff2'])).linked, ['fonts/site.woff2 -> outside/fonts/site.woff2 (outside)']);
    assert.deepEqual((await scan('follow', ['gone/notes.md'])).problems, [`gone: ${STATUS.linkBroken}`]);
    assert.deepEqual((await scan('follow', ['css/loop/index.html'])).problems, [`css/loop: ${STATUS.linkLoop}`]);
    assert.deepEqual((await scan('follow', ['hidden/raw.svg'])).cloaked, 1);
    assert.deepEqual(await scan('follow', ['missing/notes.md', 'index.html/notes.md']), { files: [], problems: [], linked: [], cloaked: 0 });
  });

  test('a single path that is itself a link is followed or reported', async (t) => {
    if (!folderLinks) {
      t.skip('creating folder links is not permitted here');
      return;
    }
    assert.deepEqual((await scan('follow-inside-root', ['img'])).files, ['img/hero.svg']);
    assert.deepEqual((await scan('skip', ['img'])).problems, [`img: ${STATUS.linkNotFollowed}`]);
    assert.deepEqual((await scan('follow', ['css/loop'])).problems, [`css/loop: ${STATUS.linkLoop}`]);
  });

  test('a file accept leaves out is not among the files reached through links either', async (t) => {
    if (!folderLinks) {
      t.skip('creating folder links is not permitted here');
      return;
    }
    const options = { root: local, cloak, symlinks: 'follow', checksum: false, scopes: [ROOT] } as const;
    const all = await scanLocal(options);
    const asked: string[] = [];
    const kept = await scanLocal({
      ...options,
      accept: (file) => {
        asked.push(file);
        return Promise.resolve(path.basename(file) !== 'hero.svg');
      },
    });
    const withoutHero = (paths: Iterable<string>): string[] => [...paths].filter((target) => !target.endsWith('hero.svg')).sort();
    assert.deepEqual([...kept.files.keys()].sort(), withoutHero(all.files.keys()));
    assert.deepEqual([...kept.linked.keys()].sort(), withoutHero(all.linked.keys()));
    assert.ok(all.linked.has(toRemotePath('img/hero.svg')) && all.linked.has(toRemotePath('pics/hero.svg')));
    assert.deepEqual([...kept.dirs].sort(), [...all.dirs].sort());
    assert.equal(kept.cloaked, all.cloaked);
    assert.deepEqual(kept.problems, all.problems);
    // Once per file that would be listed, and never for what cloaking hides: drafts/, hidden/ and notes.md.
    assert.equal(asked.length, all.files.size);
    assert.deepEqual(asked.filter((file) => file.split(path.sep).includes('drafts') || path.basename(file) === 'notes.md'), []);
  });
});

// A site of plain files, with a cloaked folder:
//   index.html, about.html, css/site.css, img/hero.svg, drafts/notes.md
describe('scanLocal with accept', () => {
  let temp: ReturnType<typeof tempDir>;
  let local: string;
  const cloak = siteCloak({ cloaking: { enabled: true, patterns: ['/drafts/'], paths: ['about.html'] } });
  const FILES = ['css/site.css', 'img/hero.svg', 'index.html'];

  before(() => {
    temp = tempDir();
    local = path.join(realpathSync.native(temp.dir), 'site');
    for (const file of [...FILES, 'about.html', 'drafts/notes.md']) {
      mkdirSync(path.dirname(path.join(local, file)), { recursive: true });
      writeFileSync(path.join(local, file), `<!-- ${file} -->`);
    }
  });

  after(() => {
    temp.cleanup();
  });

  const sitePath = (file: string): string => path.relative(local, file).split(path.sep).join('/');

  test('files answered false are left out, and every file that would be listed is asked about once', async () => {
    const asked: string[] = [];
    const result = await scanLocal({
      root: local,
      cloak,
      symlinks: 'skip',
      checksum: false,
      scopes: [ROOT],
      accept: (file) => {
        asked.push(sitePath(file));
        return Promise.resolve(sitePath(file) !== 'css/site.css');
      },
    });
    assert.deepEqual([...result.files.keys()].sort(), ['img/hero.svg', 'index.html']);
    assert.deepEqual(asked.sort(), FILES);
    assert.deepEqual([...result.dirs].sort(), ['css', 'img'], 'a folder is entered whatever accept says of its files');
    assert.deepEqual([...result.linked.keys()], []);
  });

  test('a cloaked file is never asked about, and the counts are as without the option', async () => {
    const plain = await scanLocal({ root: local, cloak, symlinks: 'skip', checksum: false, scopes: [ROOT] });
    const asked: string[] = [];
    const none = await scanLocal({
      root: local,
      cloak,
      symlinks: 'skip',
      checksum: false,
      scopes: [ROOT],
      accept: (file) => {
        asked.push(sitePath(file));
        return Promise.resolve(false);
      },
    });
    assert.deepEqual([...plain.files.keys()].sort(), FILES);
    assert.deepEqual([...none.files.keys()], []);
    assert.ok(!asked.includes('about.html') && !asked.includes('drafts/notes.md'));
    assert.equal(plain.cloaked, 2);
    assert.equal(none.cloaked, plain.cloaked);
    assert.deepEqual(none.problems, plain.problems);
  });

  test('a checksum scan hashes only the files kept', async (t) => {
    const cache = await HashCache.open(undefined);
    const hash = t.mock.method(cache, 'hash');
    const result = await scanLocal({
      root: local,
      cloak,
      symlinks: 'skip',
      checksum: true,
      scopes: [ROOT],
      cache,
      accept: (file) => Promise.resolve(sitePath(file) === 'index.html'),
    });
    assert.deepEqual(hash.mock.calls.map((call) => call.arguments[0]), ['index.html']);
    assert.match(result.files.get(toRemotePath('index.html'))?.sha256 ?? '', /^[0-9a-f]{64}$/);
    assert.equal(result.files.size, 1);
  });

  test('a single path is asked about like any file', async () => {
    const asked: string[] = [];
    const result = await scanLocal({
      root: local,
      cloak,
      symlinks: 'skip',
      checksum: false,
      scopes: ['index.html', 'img', 'about.html', 'missing.html'].map((scope) => toRemotePath(scope)),
      accept: (file) => {
        asked.push(sitePath(file));
        return Promise.resolve(sitePath(file) !== 'index.html');
      },
    });
    assert.deepEqual([...result.files.keys()], ['img/hero.svg']);
    assert.deepEqual(asked.sort(), ['img/hero.svg', 'index.html']);
    assert.equal(result.cloaked, 1);
  });
});

// A site Dreamweaver synchronized keeps its records beside the files of each folder:
//   index.html, css/site.css, docs/dwsync.xml
//   _notes/dwsync.xml, _notes/index.html.mno, css/_notes/dwsync.xml, img/_Notes/DwSync.XML
describe('scanLocal and the records Dreamweaver keeps', () => {
  let temp: ReturnType<typeof tempDir>;
  let local: string;
  const cloak = siteCloak({ cloaking: { enabled: true, patterns: [], paths: [] } });

  before(() => {
    temp = tempDir();
    local = path.join(realpathSync.native(temp.dir), 'site');
    for (const [file, content] of [
      ['index.html', '<h1>Home</h1>'],
      ['css/site.css', 'body {}'],
      ['docs/dwsync.xml', '<dwsync/>'],
      ['_notes/dwsync.xml', '<dwsync/>'],
      ['_notes/index.html.mno', '<info/>'],
      ['css/_notes/dwsync.xml', '<dwsync/>'],
      ['img/_Notes/DwSync.XML', '<dwsync/>'],
    ] as const) {
      mkdirSync(path.dirname(path.join(local, file)), { recursive: true });
      writeFileSync(path.join(local, file), content);
    }
  });

  after(() => {
    temp.cleanup();
  });

  const files = async (...scopes: string[]): Promise<string[]> => {
    const result = await scanLocal({ root: local, cloak, symlinks: 'skip', checksum: false, scopes: scopes.length === 0 ? [ROOT] : scopes.map((scope) => toRemotePath(scope)) });
    assert.equal(result.cloaked, 0);
    assert.deepEqual(result.problems, []);
    return [...result.files.keys()].sort();
  };

  test('_notes/dwsync.xml is never listed, in any folder and whatever the case of its name', async () => {
    assert.deepEqual(await files(), ['_notes/index.html.mno', 'css/site.css', 'docs/dwsync.xml', 'index.html']);
  });

  test('a single path that is such a file yields nothing', async () => {
    assert.deepEqual(await files('_notes/dwsync.xml', 'css/_notes/dwsync.xml', 'img/_Notes/DwSync.XML'), []);
    assert.deepEqual(await files('_notes'), ['_notes/index.html.mno']);
    assert.deepEqual(await files('docs/dwsync.xml'), ['docs/dwsync.xml']);
  });
});
