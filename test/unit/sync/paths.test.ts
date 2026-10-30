import assert from 'node:assert/strict';
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { isSyncError } from '../../../src/errors.ts';
import {
  baseName,
  caseCollisions,
  checkPath,
  childPath,
  isCaseSensitive,
  isInside,
  joinLocal,
  joinRemote,
  nameProblem,
  parentPath,
  realpathOfNearest,
  ROOT,
  safeLocalTarget,
  toRemotePath,
  type RemotePath,
} from '../../../src/sync/paths.ts';
import { tempDir } from '../../helpers/cli.ts';

const unsafe = (error: unknown): boolean => isSyncError(error, 'E_PATH_UNSAFE');

describe('nameProblem', () => {
  test('accepts ordinary names on every platform', () => {
    for (const platform of ['linux', 'darwin', 'win32'] as const) {
      for (const name of ['index.html', 'site.css', '.htaccess', 'my file.txt', 'café', 'x'.repeat(255), 'CONSOLE', 'COM10', 'xCON']) {
        assert.equal(nameProblem(name, platform), undefined, `${name} on ${platform}`);
      }
    }
  });

  test('rejects names that are not names', () => {
    assert.equal(nameProblem(''), 'empty name');
    assert.equal(nameProblem('.'), '"." is not a file name');
    assert.equal(nameProblem('..'), '".." is not a file name');
    assert.equal(nameProblem('a/b'), 'contains a slash');
    assert.equal(nameProblem('/etc/passwd'), 'contains a slash');
  });

  test('rejects NUL and every control character', () => {
    for (const name of ['bad\u0000name', 'line\nbreak', 'tab\there', 'bell\u0007', 'del\u007f', '\u001b[31m', 'csi\u009b2J', 'c1\u0080']) {
      assert.equal(nameProblem(name, 'linux'), 'contains a control character', JSON.stringify(name));
    }
  });

  test('rejects names longer than 255 bytes, counting UTF-8 bytes', () => {
    assert.equal(nameProblem('x'.repeat(256)), 'longer than 255 bytes');
    assert.equal(nameProblem('x'.repeat(4096)), 'longer than 255 bytes');
    assert.equal(nameProblem('é'.repeat(128)), 'longer than 255 bytes');
    assert.equal(nameProblem('é'.repeat(127)), undefined);
  });

  test('rejects backslashes everywhere, since Windows servers read them as separators', () => {
    assert.equal(nameProblem('a\\b.txt', 'win32'), 'contains a backslash');
    assert.equal(nameProblem('..\\..\\x', 'linux'), 'contains a backslash');
  });

  test('on Windows, rejects names shaped like short 8.3 names', () => {
    for (const name of ['GIT~1', 'git~1', 'PROGRA~1', 'NOTES~12.TXT', 'a~1.b']) {
      assert.match(nameProblem(name, 'win32') ?? '', /short 8\.3 name/, name);
      assert.equal(nameProblem(name, 'linux'), undefined, name);
    }
    for (const name of ['backup~', 'a~b.txt', 'longname~1.txt', 'file~1.html']) {
      assert.equal(nameProblem(name, 'win32'), undefined, name);
    }
  });

  test('on Windows, rejects forbidden characters and trailing dots or spaces', () => {
    for (const char of ['<', '>', ':', '"', '|', '?', '*']) {
      assert.match(nameProblem(`a${char}b`, 'win32') ?? '', /character Windows does not allow/);
      assert.equal(nameProblem(`a${char}b`, 'darwin'), undefined);
    }
    assert.equal(nameProblem('name.', 'win32'), 'ends with a dot or a space');
    assert.equal(nameProblem('name ', 'win32'), 'ends with a dot or a space');
    assert.equal(nameProblem('name.', 'linux'), undefined);
  });

  test('on Windows, rejects reserved device names with or without an extension', () => {
    for (const name of ['CON', 'con', 'PRN', 'AUX', 'NUL', 'COM0', 'COM1', 'com9', 'LPT1', 'LPT9', 'COM\u00b9', 'LPT\u00b3', 'CON.txt', 'nul.tar.gz', 'CON .txt']) {
      assert.equal(nameProblem(name, 'win32'), 'reserved device name', name);
      assert.equal(nameProblem(name, 'linux'), undefined, name);
    }
  });
});

describe('checkPath and toRemotePath', () => {
  test('the empty path is the root', () => {
    assert.deepEqual(checkPath(''), { ok: true, path: ROOT });
  });

  test('accepts relative slash-separated paths', () => {
    assert.deepEqual(checkPath('css/site.css'), { ok: true, path: 'css/site.css' });
    assert.equal(toRemotePath('img/hero.svg'), 'img/hero.svg');
  });

  test('normalizes to NFC', () => {
    const decomposed = 'cafe\u0301/menu.html';
    assert.equal(toRemotePath(decomposed), 'caf\u00e9/menu.html');
  });

  test('rejects absolute paths, escapes and empty segments', () => {
    assert.deepEqual(checkPath('/etc/passwd'), { ok: false, reason: 'absolute path' });
    assert.deepEqual(checkPath('../escape'), { ok: false, reason: '".." is not a file name' });
    assert.deepEqual(checkPath('a/../../b'), { ok: false, reason: '".." is not a file name' });
    assert.deepEqual(checkPath('a/./b'), { ok: false, reason: '"." is not a file name' });
    assert.deepEqual(checkPath('a//b'), { ok: false, reason: 'empty name' });
    assert.deepEqual(checkPath('a/'), { ok: false, reason: 'empty name' });
  });

  test('applies the platform rules to every segment', () => {
    assert.deepEqual(checkPath('docs/CON.txt', 'win32'), { ok: false, reason: 'reserved device name' });
    assert.deepEqual(checkPath('docs/CON.txt', 'linux'), { ok: true, path: 'docs/CON.txt' });
  });

  test('toRemotePath throws E_PATH_UNSAFE naming the path and the reason', () => {
    assert.throws(
      () => toRemotePath('../escape'),
      (error) => unsafe(error) && error instanceof Error && error.message === '"../escape" is not a safe path: ".." is not a file name.',
    );
  });
});

describe('childPath, parentPath and baseName', () => {
  test('builds child paths from validated names', () => {
    assert.deepEqual(childPath(ROOT, 'css'), { ok: true, path: 'css' });
    assert.deepEqual(childPath(toRemotePath('css'), 'site.css'), { ok: true, path: 'css/site.css' });
    assert.deepEqual(childPath(ROOT, 'cafe\u0301'), { ok: true, path: 'caf\u00e9' });
  });

  test('refuses hostile names from a listing', () => {
    for (const name of ['../escape', '/etc/passwd', '..', '', 'bad\u0000name']) {
      assert.equal(childPath(ROOT, name, 'linux').ok, false, JSON.stringify(name));
    }
    assert.equal(childPath(ROOT, 'a\\b.txt', 'win32').ok, false);
    assert.equal(childPath(ROOT, 'CON.txt', 'win32').ok, false);
  });

  test('walks up and names the last segment', () => {
    assert.equal(parentPath(ROOT), undefined);
    assert.equal(parentPath(toRemotePath('css')), ROOT);
    assert.equal(parentPath(toRemotePath('a/b/c.txt')), 'a/b');
    assert.equal(baseName(ROOT), '');
    assert.equal(baseName(toRemotePath('css')), 'css');
    assert.equal(baseName(toRemotePath('a/b/c.txt')), 'c.txt');
  });
});

describe('joinRemote', () => {
  test('joins with POSIX rules under the remote root', () => {
    assert.equal(joinRemote('/var/www/my-site', toRemotePath('css/site.css')), '/var/www/my-site/css/site.css');
    assert.equal(joinRemote('/var/www/my-site/', ROOT), '/var/www/my-site');
    assert.equal(joinRemote('//var//www', toRemotePath('a')), '/var/www/a');
    assert.equal(joinRemote('/', toRemotePath('a')), '/a');
    assert.equal(joinRemote('/', ROOT), '/');
  });

  test('refuses a relative root or one with control characters', () => {
    assert.throws(() => joinRemote('var/www', toRemotePath('a')), unsafe);
    assert.throws(() => joinRemote('/var/\nwww', toRemotePath('a')), unsafe);
  });

  test('refuses a path that would leave the root, even if it slipped past validation', () => {
    assert.throws(() => joinRemote('/var/www', '../etc/passwd' as RemotePath), unsafe);
  });
});

describe('isInside and joinLocal', () => {
  test('compares POSIX paths exactly', () => {
    assert.equal(isInside('/sites/my-site', '/sites/my-site', 'linux'), true);
    assert.equal(isInside('/sites/my-site', '/sites/my-site/css', 'linux'), true);
    assert.equal(isInside('/sites/my-site', '/sites/my-site-copy', 'linux'), false);
    assert.equal(isInside('/sites/my-site', '/sites', 'linux'), false);
    assert.equal(isInside('/sites/my-site', '/Sites/My-Site/css', 'linux'), false);
    assert.equal(isInside('/sites/my-site', '/sites/my-site/..foo', 'linux'), true);
  });

  test('ignores case on Windows and macOS', () => {
    assert.equal(isInside('C:\\Sites\\My-Site', 'c:\\sites\\my-site\\css', 'win32'), true);
    assert.equal(isInside('C:\\Sites\\My-Site', 'D:\\Sites\\My-Site', 'win32'), false);
    assert.equal(isInside('/Users/<user>/Sites', '/users/<user>/sites/a', 'darwin'), true);
  });

  test('joinLocal stays inside the local root', () => {
    const root = path.resolve('/sites/my-site');
    assert.equal(joinLocal(root, ROOT), root);
    assert.equal(joinLocal(root, toRemotePath('css/site.css')), path.join(root, 'css', 'site.css'));
    assert.throws(() => joinLocal(root, '../outside' as RemotePath), unsafe);
  });
});

describe('safeLocalTarget', () => {
  let temp: ReturnType<typeof tempDir>;
  let root: string;
  let outside: string;
  let folderLinks = true;
  let fileLinks = true;

  before(() => {
    temp = tempDir();
    root = realpathSync(temp.dir);
    mkdirSync(path.join(root, 'site', 'css'), { recursive: true });
    outside = path.join(root, 'outside');
    mkdirSync(outside);
    writeFileSync(path.join(outside, 'secret.txt'), 'outside');
    // A junction needs no privilege on Windows; a file link may.
    try {
      symlinkSync(outside, path.join(root, 'site', 'linked'), 'junction');
    } catch {
      folderLinks = false;
    }
    try {
      symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'site', 'link.txt'), 'file');
    } catch {
      fileLinks = false;
    }
  });

  after(() => {
    temp.cleanup();
  });

  test('returns the real path of an ordinary or a new target', async () => {
    const site = path.join(root, 'site');
    assert.equal(await safeLocalTarget(site, ROOT), site);
    assert.equal(await safeLocalTarget(site, toRemotePath('css/site.css')), path.join(site, 'css', 'site.css'));
    assert.equal(await safeLocalTarget(site, toRemotePath('new/deep/file.txt')), path.join(site, 'new', 'deep', 'file.txt'));
  });

  test('the nearest real path walks up past missing folders and passes on other errors', async () => {
    const missing = Object.assign(new Error('missing'), { code: 'ENOENT' });
    const top = path.parse(root).root;
    const existing = path.join(root, 'site');
    const lookup = (file: string): Promise<string> => (file === existing ? Promise.resolve(`real:${file}`) : Promise.reject(missing));
    assert.equal(await realpathOfNearest(path.join(existing, 'a', 'b'), lookup), `real:${existing}`);
    await assert.rejects(realpathOfNearest(path.join(top, 'nothing'), () => Promise.reject(missing)), /missing/);
    await assert.rejects(realpathOfNearest(existing, () => Promise.reject(Object.assign(new Error('not a folder'), { code: 'ENOTDIR' }))), /not a folder/);
  });

  test('refuses a target inside a linked folder that leads out of the root', async (t) => {
    if (!folderLinks) {
      t.skip('creating folder links is not permitted here');
      return;
    }
    await assert.rejects(safeLocalTarget(path.join(root, 'site'), toRemotePath('linked/secret.txt')), unsafe);
  });

  test('refuses a target reached through another name for a folder: a link inside the root, or a short name', async () => {
    const site = path.join(root, 'site');
    const another = (error: unknown): boolean => unsafe(error) && error instanceof Error && error.message.includes('another name for a folder');
    const realCss = path.join(site, 'css');
    // The folder css answers to the real path of another folder, as GIT~1 does for .git on Windows.
    const elsewhere = (file: string): Promise<string> => Promise.resolve(file === realCss ? path.join(site, 'other') : file);
    await assert.rejects(safeLocalTarget(site, toRemotePath('css/site.css'), elsewhere), another);
    const deeper = (file: string): Promise<string> => Promise.resolve(file === realCss ? path.join(realCss, 'inner') : file);
    await assert.rejects(safeLocalTarget(site, toRemotePath('css/site.css'), deeper), another);
    const identity = (file: string): Promise<string> => Promise.resolve(file);
    assert.equal(await safeLocalTarget(site, toRemotePath('css/site.css'), identity), path.join(realCss, 'site.css'));
  });

  test('refuses a target that is itself a symbolic link or junction', async (t) => {
    const site = path.join(root, 'site');
    const isLink = (error: unknown): boolean => unsafe(error) && error instanceof Error && error.message.includes('symbolic link');
    if (folderLinks) {
      await assert.rejects(safeLocalTarget(site, toRemotePath('linked')), isLink);
    }
    if (!fileLinks) {
      t.skip('creating file links is not permitted here');
      return;
    }
    await assert.rejects(safeLocalTarget(site, toRemotePath('link.txt')), isLink);
  });
});

describe('case', () => {
  test('caseCollisions finds every name that differs from another only by case', () => {
    assert.deepEqual(caseCollisions(['Index.html', 'index.html', 'about.html', 'INDEX.HTML']), new Set(['Index.html', 'index.html', 'INDEX.HTML']));
    assert.deepEqual(caseCollisions(['a', 'b']), new Set());
    assert.deepEqual(caseCollisions(['same', 'same']), new Set());
  });

  test('isCaseSensitive reads either answer, and passes on other errors', async () => {
    const temp = tempDir();
    try {
      assert.equal(await isCaseSensitive(temp.dir, () => Promise.resolve()), false);
      assert.equal(await isCaseSensitive(temp.dir, () => Promise.reject(Object.assign(new Error('missing'), { code: 'ENOENT' }))), true);
      await assert.rejects(isCaseSensitive(temp.dir, () => Promise.reject(Object.assign(new Error('denied'), { code: 'EACCES' }))), /denied/);
      const { readdirSync } = await import('node:fs');
      assert.deepEqual(readdirSync(temp.dir), []);
    } finally {
      temp.cleanup();
    }
  });

  test('isCaseSensitive probes the file system and cleans up', async () => {
    const temp = tempDir();
    try {
      const sensitive = await isCaseSensitive(temp.dir);
      if (process.platform === 'win32') {
        assert.equal(sensitive, false);
      } else if (process.platform === 'linux') {
        assert.equal(sensitive, true);
      }
      const { readdirSync } = await import('node:fs');
      assert.deepEqual(readdirSync(temp.dir), []);
    } finally {
      temp.cleanup();
    }
  });
});
