import assert from 'node:assert/strict';
import { test } from 'node:test';
import { siteSchema } from '../../../src/config/schema.ts';
import { cloakingSummary, cloakPatternToGitignore, siteCloak, splitPatterns } from '../../../src/sync/cloak.ts';
import { siteGuard } from '../../../src/sync/guard.ts';

function site(cloaking: { enabled?: boolean; useGlobalPatterns?: boolean; patterns?: string[]; paths?: string[] }, guard: { enabled?: boolean; patterns?: string[] } = {}) {
  return siteSchema.parse({ id: crypto.randomUUID(), name: 'My Site', localRoot: process.cwd(), cloaking, sync: { guard } });
}

test('cloak patterns translate Dreamweaver suffixes to gitignore', () => {
  assert.equal(cloakPatternToGitignore('.psd'), '*.psd');
  assert.equal(cloakPatternToGitignore('!.psd'), '!*.psd');
  assert.equal(cloakPatternToGitignore('archive*'), 'archive*');
  assert.equal(cloakPatternToGitignore('node_modules/'), 'node_modules/');
  assert.equal(cloakPatternToGitignore('/drafts/'), '/drafts/');
  assert.equal(cloakPatternToGitignore('.git/'), '.git/');
  assert.deepEqual(splitPatterns(' .psd  archive*\nnode_modules/ '), ['.psd', 'archive*', 'node_modules/']);
});

test('suffix, name, folder, anchored and re-included patterns', () => {
  const cloak = siteCloak(site({ patterns: ['.psd archive*', 'node_modules/', '/drafts/', '!keep.psd'] }), 'linux');
  assert.equal(cloak.isCloaked('img/hero.psd', false), true);
  assert.equal(cloak.isCloaked('keep.psd', false), false);
  assert.equal(cloak.isCloaked('archive-2026.zip', false), true);
  assert.equal(cloak.isCloaked('old/archive', true), true);
  assert.equal(cloak.isCloaked('node_modules', true), true);
  assert.equal(cloak.isCloaked('lib/node_modules', true), true);
  assert.equal(cloak.isCloaked('node_modules', false), false);
  assert.equal(cloak.isCloaked('drafts', true), true);
  assert.equal(cloak.isCloaked('blog/drafts', true), false);
  assert.equal(cloak.isCloaked('index.html', false), false);
  assert.equal(cloak.isCloaked('', true), false);
});

test('single cloaked paths cloak everything beneath them', () => {
  const cloak = siteCloak(site({ paths: ['img/raw', '/docs/old.html/'] }), 'linux');
  assert.equal(cloak.isCloaked('img/raw', true), true);
  assert.equal(cloak.isCloaked('img/raw/photo.jpg', false), true);
  assert.equal(cloak.isCloaked('img/rawer.jpg', false), false);
  assert.equal(cloak.isCloaked('docs/old.html', false), true);
  assert.equal(cloak.isCloaked('IMG/RAW/photo.jpg', false), false);
  assert.equal(siteCloak(site({ paths: ['img/raw'] }), 'win32').isCloaked('IMG/RAW/photo.jpg', false), true);
});

test('cloaking can be switched off without losing its patterns', () => {
  const cloak = siteCloak(site({ enabled: false, patterns: ['.psd'] }), 'linux');
  assert.equal(cloak.enabled, false);
  assert.equal(cloak.isCloaked('a.psd', false), false);
});

test('a new site cloaks nothing', () => {
  assert.equal(siteCloak(site({}), 'linux').isCloaked('anything.psd', false), false);
});

test('the guard matches the built-in sensitive patterns', () => {
  const guard = siteGuard(site({}), 'linux');
  for (const [file, pattern] of [
    ['.env', '.env'],
    ['config/.env.production', '.env.*'],
    ['certs/server.pem', '*.pem'],
    ['keys/id_ed25519.pub', 'id_ed25519*'],
    ['.git/config', '.git/'],
    ['vendor/lib/.git/HEAD', '.git/'],
    ['.npmrc', '.npmrc'],
  ]) {
    assert.equal(guard.match(file ?? ''), pattern, file);
  }
  assert.equal(guard.match('index.html'), undefined);
  assert.equal(guard.match('docs/environment.md'), undefined);
});

test('a site can add guard patterns or switch the guard off', () => {
  assert.equal(siteGuard(site({}, { patterns: ['*.sql'] }), 'linux').match('backup/db.sql'), '*.sql');
  assert.equal(siteGuard(site({}, { enabled: false }), 'linux').match('.env'), undefined);
});

test('global patterns come before the site patterns, so a site re-includes with !, and a site can turn them off', () => {
  const global = ['node_modules/', '.git/', '*.lnk', '/drafts/'];
  const both = siteCloak(site({ patterns: ['!node_modules/'] }), 'linux', global);
  assert.equal(both.isCloaked('node_modules', true), false, 're-included by the site');
  assert.equal(both.isCloaked('.git', true), true);
  assert.equal(both.isCloaked('docs/Shortcut.lnk', false), true);
  assert.equal(both.isCloaked('drafts', true), true);
  assert.equal(both.isCloaked('blog/drafts', true), false, 'a leading / anchors at the site root');
  assert.equal(siteCloak(site({ useGlobalPatterns: false }), 'linux', global).isCloaked('.git', true), false);
  assert.equal(siteCloak(site({ enabled: false }), 'linux', global).isCloaked('.git', true), false, 'cloaking off turns the global patterns off too');
  assert.equal(siteCloak(site({}), 'linux').isCloaked('.git', true), false, 'no global patterns unless given');
  assert.equal(siteCloak(site({}), 'win32', ['Thumbs.db']).isCloaked('img/thumbs.DB', false), true);
  assert.equal(siteCloak(site({}), 'linux', ['Thumbs.db']).isCloaked('img/thumbs.DB', false), false);
  assert.equal(cloakingSummary(site({ patterns: ['.psd'], paths: ['img/raw'] }).cloaking, global), 'on, 1 pattern(s), 1 path(s), 4 global pattern(s)');
  assert.equal(cloakingSummary(site({ useGlobalPatterns: false }).cloaking, global), 'on, 0 pattern(s), 0 path(s), global patterns not used');
});
