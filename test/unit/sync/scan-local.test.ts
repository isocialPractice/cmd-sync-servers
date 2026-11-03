import assert from 'node:assert/strict';
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { siteCloak } from '../../../src/sync/cloak.ts';
import { STATUS } from '../../../src/sync/messages.ts';
import { ROOT, toRemotePath, type LinkPolicy } from '../../../src/sync/paths.ts';
import { scanLocal } from '../../../src/sync/scan-local.ts';
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
});
