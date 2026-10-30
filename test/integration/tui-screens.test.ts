import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { MemoryCredentialStore } from '../../src/credentials/memory.ts';
import { createLogger } from '../../src/log/logger.ts';
import type { App } from '../../src/tui/app.ts';
import { ServerEditorView } from '../../src/tui/screens/server-editor.ts';
import { SiteSetupView } from '../../src/tui/screens/site-setup.ts';
import { SitesView } from '../../src/tui/screens/sites.ts';
import type { TuiServices } from '../../src/tui/services.ts';
import { makeFolder } from '../helpers/cli.ts';
import { matchSnapshot, press, screen, testApp, type } from '../helpers/tui.ts';
import { startSiteRig, type SiteRig } from '../sandbox/site-rig.ts';

function services(rig: SiteRig, store = new MemoryCredentialStore()): TuiServices {
  return {
    registry: () => Promise.resolve(rig.registry),
    credentialStore: () => Promise.resolve(store),
    logger: createLogger({ level: 'debug', sinks: [] }),
    env: {},
    cwd: rig.localDir,
    platform: process.platform,
  };
}

async function open(app: App, ...views: Parameters<App['push']>[0][]): Promise<void> {
  for (const view of views) {
    app.push(view);
  }
  await app.idle();
}

async function withRig(run: (rig: SiteRig) => Promise<void>): Promise<void> {
  const rig = await startSiteRig('local');
  try {
    await run(rig);
  } finally {
    await rig.close();
  }
}

test('sites, site home, synchronize, preview, progress and results, all from the keyboard', async () => {
  await withRig(async (rig) => {
    rig.write('local', 'index.html', 'home');
    rig.write('local', 'css/site.css', 'body {}');
    rig.write('local', '.env', 'SECRET=1');
    rig.write('remote', 'old.html', 'old');
    const app = testApp();
    await open(app, new SitesView(services(rig)));
    assert.match(screen(app), /^ {2}My Site +.+ +Folder$/m);

    await press(app, 'enter');
    assert.equal(app.cdTarget, rig.localDir);
    assert.equal(rig.registry.list()[0]?.id, rig.site.id);
    const home = screen(app);
    assert.match(home, /^ Site: My Site +s Synchronize$/m);
    assert.match(home, /^ {2}Server {6}Folder \(Local\/Network /m);
    assert.match(home, /^ {2}Changes {5}3 local, 1 on the server, 0 on both sides$/m);
    assert.match(home, /^> Synchronize\.\.\.$/m);

    await press(app, 's');
    matchSnapshot('synchronize-put', screen(app));
    await press(app, 'right', 'right');
    assert.match(screen(app), /^ {2}Direction +< Get and put newer files >$/m);
    await press(app, 'left');
    assert.match(screen(app), /Delete local files not on remote server +\[ \]/);
    await press(app, 'left', 'down', 'space');
    assert.match(screen(app), /Delete remote files not on local drive +\[x\]/);

    await press(app, 'enter');
    matchSnapshot('preview-put-delete', screen(app));
    await press(app, 'down', 's');
    assert.match(screen(app), /^ {2}\[ \] - Skip +css\/site\.css/m);
    await press(app, 'tab');
    const puts = screen(app);
    assert.match(puts, /Showing Put: 2/);
    assert.doesNotMatch(puts, /old\.html/);
    await press(app, 'tab');
    assert.match(screen(app), /^ {2}No rows match this filter\. Tab shows the next one\.$/m);
    await press(app, 'shift+tab', 'shift+tab');
    assert.match(screen(app), /old\.html/);

    await press(app, '/');
    await type(app, 'old');
    assert.match(screen(app), /^ \/old$/m);
    await press(app, 'enter');
    assert.match(screen(app), /^ {2}\[ \] x Delete +old\.html +On the server only and never synchronized/m);
    await press(app, 'space');
    assert.match(screen(app), /^ {2}\[x\] x Delete +old\.html/m);
    assert.match(screen(app), /1 will be deleted/);
    await press(app, 'space', 'escape');
    assert.match(screen(app), /index\.html/);

    await press(app, 'end', 'up', 'd');
    const diff = screen(app);
    assert.match(diff, /^ Diff: index\.html$/m);
    assert.match(diff, /^ --- local\/index\.html\n \+\+\+ remote\/index\.html$/m);
    assert.match(diff, /^ -home$/m);
    assert.match(diff, /^ Lines 1 to \d+ of \d+$/m);
    await press(app, 'down', 'j', 'pagedown', 'end', 'up', 'k', 'pageup', 'home', 'space');
    await press(app, 'escape', '?');
    assert.match(screen(app), /m +Mark synchronized: record both copies as in sync/);
    await press(app, 'escape');

    await press(app, 'enter');
    assert.match(screen(app), /Synchronize 1 file\(s\) now\?/);
    await press(app, 'enter');
    const results = screen(app);
    matchSnapshot('results', results);
    assert.equal(rig.read('remote', 'index.html'), 'home');
    assert.equal(rig.read('remote', 'css/site.css'), undefined);
    assert.equal(rig.read('remote', '.env'), undefined);
    assert.equal(rig.read('remote', 'old.html'), 'old');
    assert.ok(app.outcome !== undefined);

    await press(app, 'escape');
    assert.match(screen(app), /^ Site: My Site/m);
    assert.match(screen(app), /^ {2}Changes {5}2 local, 1 on the server, 0 on both sides$/m);
    await press(app, 'escape');
    assert.match(screen(app), /^ Sites +Enter Open$/m);
    await press(app, 'q');
    await app.finished;
  });
});

test('put and get from the site home preview only the newer files of one direction', async () => {
  await withRig(async (rig) => {
    rig.write('remote', 'news.html', 'news');
    const app = testApp();
    await open(app, new SitesView(services(rig)));
    await press(app, 'enter', 'down', 'down', 'enter');
    assert.match(screen(app), /Get newer files from remote/);
    assert.match(screen(app), /^ {2}\[x\] v Get +news\.html/m);
    await press(app, 'enter', 'enter');
    assert.equal(rig.read('local', 'news.html'), 'news');
    await press(app, 'escape', 'up', 'enter');
    assert.match(screen(app), /^ {2}Nothing to synchronize: every compared file is in sync\.$/m);
    await press(app, 'enter');
    assert.match(screen(app), /Nothing is checked/);
    await press(app, 'escape');
    assert.match(screen(app), /^ Site: My Site/m);
  });
});

test('site setup adds a site, a server and cloaking, and checks each field before saving', async () => {
  await withRig(async (rig) => {
    const store = new MemoryCredentialStore();
    const svc = services(rig, store);
    const app = testApp();
    await open(app, new SitesView(svc));
    await press(app, 'n');
    assert.match(screen(app), /^ Site Setup: New site +Ctrl\+S Save$/m);
    await press(app, 'tab', 'ctrl+u');
    await press(app, 'ctrl+s');
    assert.match(screen(app), /^> Site {18}Site name +▏\n {2}Servers {15} +! Enter a name\.$/m);
    assert.match(screen(app), /^ ! Enter a name\.$/m);
    await type(app, 'Second Site');
    await press(app, 'down', 'ctrl+u');
    const folder = makeFolder(rig.home, '..', 'second');
    await type(app, folder);
    await press(app, 'ctrl+s');
    assert.match(screen(app), /Saved "Second Site"\./);
    const second = rig.registry.list().find((site) => site.name === 'Second Site');
    assert.ok(second !== undefined);
    assert.equal(second.localRoot, path.resolve(folder));

    await press(app, 'tab', 'down');
    assert.match(screen(app), /^> Servers {15}No servers yet\. Press a to add one\./m);
    await press(app, 'tab');
    await press(app, 'a');
    matchSnapshot('server-editor-new-sftp', screen(app));
    await press(app, 'ctrl+s');
    const problems = screen(app);
    assert.match(problems, /^ {2}Server name +▏\n {2,}! Enter a name\.$/m);
    assert.match(problems, /! Required for the "sftp" protocol\./);
    assert.match(problems, /^ ! Enter a name\.$/m);
    await type(app, 'Backup');
    await press(app, 'down', 'right', 'right', 'right', 'right');
    assert.match(screen(app), /Connect using +< Local or network folder >/);
    assert.doesNotMatch(screen(app), /Address/);
    const backupDir = makeFolder(rig.home, '..', 'backup');
    await press(app, 'down');
    await type(app, backupDir);
    await press(app, 'tab');
    matchSnapshot('server-editor-local-advanced', screen(app));
    await press(app, 'tab', 'ctrl+s');
    assert.match(screen(app), /Saved "Backup"\./);
    await press(app, 'escape');
    const servers = screen(app);
    assert.match(servers, /^ {2}Site {18}Name +Address +Type +Remote +Testing$/m);
    assert.match(servers, /^> Servers {15}Backup .+Local\/Network +\(\*\) +\( \)$/m);

    await press(app, 't');
    assert.match(screen(app), /Connected to Backup: 0 entries/);
    await press(app, 'T');
    assert.match(screen(app), /\(\*\) +\(\*\)$/m);
    await press(app, 'c');
    assert.match(screen(app), /Added "Backup copy"\./);
    assert.equal(rig.registry.list().find((site) => site.name === 'Second Site')?.servers.length, 2);
    await press(app, 'down', 'r');
    assert.match(screen(app), / {2}Backup copy .+\(\*\) +\( \)$/m);
    await press(app, 'delete');
    assert.match(screen(app), /Remove "Backup copy" from "Second Site"\?/);
    await press(app, 'left', 'enter');
    assert.equal(rig.registry.list().find((site) => site.name === 'Second Site')?.servers.length, 1);

    await press(app, 'tab', 'down', 'down');
    assert.match(screen(app), /^> {3}Cloaking/m);
    await press(app, 'tab', 'down');
    await type(app, '.psd');
    await press(app, 'enter');
    await type(app, 'node_modules/');
    matchSnapshot('site-setup-cloaking', screen(app));
    await press(app, 'ctrl+s');
    assert.deepEqual(rig.registry.list().find((site) => site.name === 'Second Site')?.cloaking.patterns, ['.psd', 'node_modules/']);

    await press(app, 'tab', 'down', 'tab', 'down', 'down');
    await type(app, 'x');
    await press(app, 'ctrl+s');
    assert.match(screen(app), /^ ! The tolerance must be a whole number from 0 to 3600\.$/m);
    await press(app, 'backspace', 'ctrl+s', 'escape');
    await press(app, 'escape');
    assert.match(screen(app), /^ Sites/m);
    assert.match(screen(app), /Second Site/);
  });
});

test('the server editor saves secrets only in the credential store, and leaving asks before dropping changes', async () => {
  await withRig(async (rig) => {
    const store = new MemoryCredentialStore();
    const svc = services(rig, store);
    const app = testApp();
    await open(app, new SitesView(svc), new ServerEditorView(svc, rig.site.id, undefined));
    await type(app, 'Production');
    await press(app, 'down', 'down');
    await type(app, 'sftp.example.com');
    await press(app, 'down');
    await type(app, '70000');
    await press(app, 'ctrl+s');
    assert.match(screen(app), /! Enter a port from 1 to 65535, or leave it empty\./);
    await press(app, 'ctrl+u');
    await type(app, '2222');
    await press(app, 'down');
    await type(app, 'demo-user');
    await press(app, 'down', 'down', 'space', 'down');
    assert.match(screen(app), /Save the server first|Set password/);
    await press(app, 'enter');
    assert.match(screen(app), /Save the server first \(Ctrl\+S\), then set its password\./);
    await press(app, 'ctrl+s');
    const saved = rig.registry.get(rig.site.id)?.servers.find((server) => server.name === 'Production');
    assert.ok(saved !== undefined);
    assert.equal(saved.port, 2222);
    assert.equal(saved.username, 'demo-user');
    assert.equal(saved.auth?.savePassword, true);

    await press(app, 'enter');
    assert.match(screen(app), /Set password/);
    await type(app, 'p4ss-word');
    assert.doesNotMatch(screen(app), /p4ss-word/);
    await press(app, 'enter');
    assert.equal(await store.get({ siteId: rig.site.id, serverId: saved.id, kind: 'password' }), 'p4ss-word');
    assert.match(screen(app), /Saved the password in the memory/);
    assert.ok(!JSON.stringify(rig.registry.get(rig.site.id)).includes('p4ss-word'));

    await press(app, 'up', 'space', 'ctrl+s');
    assert.equal(await store.get({ siteId: rig.site.id, serverId: saved.id, kind: 'password' }), undefined);
    assert.equal(rig.registry.get(rig.site.id)?.servers.find((server) => server.id === saved.id)?.auth?.savePassword, false);

    await press(app, 'tab');
    assert.match(screen(app), /Host key +Not trusted yet; the first connection asks\./);
    await press(app, 'up', 'up', 'up', 'up', 'up', 'up', 'up');
    await press(app, 'space');
    await press(app, 'escape');
    assert.match(screen(app), /Leave without saving the changes to this server\?/);
    await press(app, 'escape');
    assert.match(screen(app), /Server editor|Production/);
    await press(app, 'escape', 'left', 'enter');
    assert.match(screen(app), /^ Sites/m);
  });
});

test('removing a site leaves its folder and asks first; a site setup for a missing folder refuses to save', async () => {
  await withRig(async (rig) => {
    const app = testApp();
    const svc = services(rig);
    await open(app, new SitesView(svc));
    await press(app, 'd');
    assert.match(screen(app), /Remove "My Site" and its 1 server\(s\)\?/);
    await press(app, 'escape');
    assert.equal(rig.registry.list().length, 1);
    await press(app, 'd', 'left', 'enter');
    assert.equal(rig.registry.list().length, 0);
    assert.match(screen(app), /No sites yet\. Press n to add one\./);
    rig.write('local', 'kept.html', 'kept');
    assert.equal(rig.read('local', 'kept.html'), 'kept');

    await open(app, new SiteSetupView(svc, undefined));
    await press(app, 'tab');
    await type(app, 'Elsewhere');
    await press(app, 'down', 'ctrl+u');
    await type(app, path.join(rig.home, 'missing-folder'));
    await press(app, 'ctrl+s');
    assert.match(screen(app), /! Folder not found:/);
    assert.equal(rig.registry.list().length, 0);
  });
});
