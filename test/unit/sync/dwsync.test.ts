import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, test } from 'node:test';
import { serverSchema, type ServerInput } from '../../../src/config/schema.ts';
import {
  daylightState,
  dreamweaverServerName,
  filetimeToMs,
  isDwsyncPath,
  parseDwsync,
  sameServerName,
  serializeDwsync,
  toFiletime,
} from '../../../src/sync/dwsync.ts';
import { dwsyncEntry } from '../../helpers/dwsync.ts';

const FTP = '203.0.113.10//public_html/';
const FOLDER = 'D:/Sites/my-site-testing/';

/** A folder's records as Dreamweaver writes them: CRLF line ends and none after the closing tag. */
const SAMPLE = [
  '<?xml version="1.0" encoding="utf-8" ?>',
  '<dwsync>',
  `<file name="index.html" server="${FTP}" local="134129604153427891" remote="134129604600000000" Dst="1" />`,
  `<file name="index.html" server="${FOLDER}" local="134129604153427891" remote="134129604150000000" Dst="1" />`,
  `<file name="about.html" server="${FTP}" local="133966144428615532" remote="133966144800000000" Dst="2" />`,
  '</dwsync>',
].join('\r\n');

function document(...elements: string[]): string {
  return ['<?xml version="1.0" encoding="utf-8" ?>', '<dwsync>', ...elements, '</dwsync>'].join('\n');
}

describe('parseDwsync and serializeDwsync', () => {
  test('a file as Dreamweaver writes it parses and is written back byte for byte', () => {
    const parsed = parseDwsync(SAMPLE);
    assert.ok(parsed !== undefined);
    assert.equal(parsed.newline, '\r\n');
    assert.deepEqual(
      parsed.entries.map((entry) => [entry.name, entry.server, entry.local, entry.remote]),
      [
        ['index.html', FTP, 134129604153427891n, 134129604600000000n],
        ['index.html', FOLDER, 134129604153427891n, 134129604150000000n],
        ['about.html', FTP, 133966144428615532n, 133966144800000000n],
      ],
    );
    assert.deepEqual(parsed.entries[2]?.attributes.map(([name]) => name), ['name', 'server', 'local', 'remote', 'Dst']);
    assert.equal(serializeDwsync(parsed), SAMPLE);
  });

  test('line feeds stay line feeds', () => {
    const text = SAMPLE.replaceAll('\r\n', '\n');
    const parsed = parseDwsync(text);
    assert.ok(parsed !== undefined);
    assert.equal(parsed.newline, '\n');
    assert.equal(serializeDwsync(parsed), text);
  });

  test('a byte order mark and a missing declaration are accepted', () => {
    assert.equal(parseDwsync(`\uFEFF${SAMPLE}`)?.entries.length, 3);
    assert.equal(parseDwsync(SAMPLE.slice(SAMPLE.indexOf('<dwsync>')))?.entries.length, 3);
  });

  test('a root without entries holds none', () => {
    for (const text of ['<dwsync/>', '<?xml version="1.0" encoding="utf-8" ?>\r\n<dwsync />\r\n', '<dwsync>\n</dwsync>', '<dwsync></dwsync >']) {
      assert.deepEqual(parseDwsync(text)?.entries, [], text);
    }
    assert.equal(serializeDwsync({ entries: [], newline: '\n' }), '<?xml version="1.0" encoding="utf-8" ?>\n<dwsync>\n</dwsync>');
  });

  test('anything but file elements in a dwsync root is refused whole', () => {
    const file = `<file name="index.html" server="${FTP}" local="1" remote="2" Dst="1" />`;
    const refused = [
      '',
      'not xml',
      `<!DOCTYPE dwsync [<!ENTITY more "more">]>\n<dwsync>\n${file}\n</dwsync>`,
      document(file, '<note>text</note>'),
      document(file, 'text'),
      document('<!-- a comment -->', file),
      document(`<file name="a.html" name="b.html" server="${FTP}" local="1" remote="2" />`),
      document(`<file name="index.html" server="${FTP}" local="1" remote="2"`),
      document(`<file name="index.html" server="${FTP}" local="1" remote="2"></file>`),
      document(`<filename="index.html" />`),
      `<dwsync>\n${file}\n`,
      `<notes>\n${file}\n</dwsync>`,
      `${document(file)}\n<dwsync/>`,
      `${document(file)} trailing`,
    ];
    for (const text of refused) {
      assert.equal(parseDwsync(text), undefined, text);
    }
  });

  test('an element that names no usable file is kept and never matched', () => {
    const elements = [
      `<file server="${FTP}" local="1" remote="2" Dst="1" />`,
      '<file name="index.html" local="1" remote="2" Dst="1" />',
      `<file name="index.html" server="${FTP}" local="soon" remote="2" Dst="1" />`,
      `<file name="index.html" server="${FTP}" local="1" remote="-2" Dst="1" />`,
      '<file />',
    ];
    const text = document(...elements);
    const parsed = parseDwsync(text);
    assert.ok(parsed !== undefined);
    assert.deepEqual(
      parsed.entries.map((entry) => [entry.name, entry.local, entry.remote]),
      elements.map(() => ['', 0n, 0n]),
    );
    assert.deepEqual(parsed.entries.map((entry) => entry.server), [FTP, '', FTP, FTP, '']);
    assert.equal(serializeDwsync(parsed), text);
  });

  test('values are read with the XML entities and numeric references, and nothing else is expanded', () => {
    const parsed = parseDwsync(
      document(
        `<file name="fish &amp; chips &lt;1&gt; &quot;a&quot; &apos;b&apos; &#39;c&#39; &#x26;.html" server='${FTP}' local="1" remote="2" />`,
        `<file name="a&nbsp;b &#0; &#9999999; &#xFFFFFF; R&D.html" server="${FTP}" local = "1" remote= "2" />`,
      ),
    );
    assert.ok(parsed !== undefined);
    assert.deepEqual(
      parsed.entries.map((entry) => entry.name),
      [`fish & chips <1> "a" 'b' 'c' &.html`, 'a&nbsp;b &#0; &#9999999; &#xFFFFFF; R&D.html'],
    );
    assert.equal(parsed.entries[0]?.server, FTP);
  });

  test('values are written with what a quoted attribute cannot hold escaped, and an apostrophe as it is', () => {
    const entry = dwsyncEntry({ name: `Tom & Jerry's <"draft">\tone\ntwo\rthree.html`, server: FTP, local: 1n, remote: 2n });
    const text = serializeDwsync({ entries: [entry], newline: '\n' });
    assert.ok(text.includes(`name="Tom &amp; Jerry's &lt;&quot;draft&quot;&gt;&#9;one&#10;two&#13;three.html"`));
    assert.equal(parseDwsync(text)?.entries[0]?.name, entry.name);
  });

  test('names with spaces and letters beyond ASCII survive', () => {
    const entry = dwsyncEntry({ name: 'été à la plage 夏.html', server: FTP, local: 1n, remote: 2n });
    const text = serializeDwsync({ entries: [entry], newline: '\r\n' });
    assert.equal(parseDwsync(text)?.entries[0]?.name, entry.name);
  });

  test('an attribute it does not know and the entry of another server stay as they were', () => {
    const text = document(
      `<file name="index.html" server="${FTP}" local="1" remote="2" Dst="1" testing="3" />`,
      `<file name="index.html" server="${FOLDER}" local="1" remote="4" Dst="2" />`,
    );
    const parsed = parseDwsync(text);
    assert.ok(parsed !== undefined);
    assert.deepEqual(parsed.entries[0]?.attributes.at(-1), ['testing', '3']);
    assert.equal(serializeDwsync(parsed), text);
  });
});

test('isDwsyncPath is true for _notes/dwsync.xml in any folder, and for nothing else', () => {
  for (const target of ['_notes/dwsync.xml', 'css/_notes/dwsync.xml', 'a/b/_notes/dwsync.xml']) {
    assert.equal(isDwsyncPath(target, false), true, target);
  }
  for (const target of ['dwsync.xml', 'docs/dwsync.xml', '_notes/index.html.mno', '_notes', 'x_notes/dwsync.xml', '_notes/dwsync.xml.bak', '_notes/sub/dwsync.xml']) {
    assert.equal(isDwsyncPath(target, false), false, target);
    assert.equal(isDwsyncPath(target, true), false, target);
  }
  assert.equal(isDwsyncPath('img/_Notes/DwSync.XML', true), true);
  assert.equal(isDwsyncPath('img/_Notes/DwSync.XML', false), false);
});

test('times convert between nanoseconds, FILETIME steps and milliseconds', () => {
  const local = BigInt(Date.parse('2026-01-15T14:20:15.342Z')) * 1_000_000n + 789_100n;
  assert.equal(toFiletime(local), 134129604153427891n);
  assert.ok(Math.abs(filetimeToMs(134129604153427891n) - (Date.parse('2026-01-15T14:20:15.342Z') + 0.7891)) < 0.001);
  assert.equal(filetimeToMs(134129604600000000n), Date.parse('2026-01-15T14:21:00.000Z'));
  assert.equal(filetimeToMs(134091687410000000n), Date.parse('2025-12-02T17:05:41.000Z'));
  assert.equal(filetimeToMs(toFiletime(0n)), 0);
  assert.equal(filetimeToMs(0n), Date.parse('1601-01-01T00:00:00.000Z'));
});

describe('daylightState', () => {
  const month = (atMs: number): number => new Date(atMs).getUTCMonth();
  /** A northern zone five hours behind UTC, four in daylight time from April to October. */
  const northern = (atMs: number): number => (month(atMs) >= 3 && month(atMs) <= 9 ? 240 : 300);
  /** A southern zone ten hours ahead of UTC, eleven in daylight time from October to March. */
  const southern = (atMs: number): number => (month(atMs) >= 3 && month(atMs) <= 8 ? -600 : -660);

  test('is 1 in standard time and 2 in daylight time, north and south', () => {
    assert.equal(daylightState(Date.parse('2026-01-15T14:20:15Z'), northern), 1);
    assert.equal(daylightState(Date.parse('2025-07-10T09:47:22Z'), northern), 2);
    assert.equal(daylightState(Date.parse('2026-01-15T14:20:15Z'), southern), 2);
    assert.equal(daylightState(Date.parse('2025-07-10T09:47:22Z'), southern), 1);
  });

  test('is 0 where the zone has no daylight time', () => {
    assert.equal(daylightState(Date.parse('2025-07-10T09:47:22Z'), () => -330), 0);
  });

  test('asks this computer when no zone is given', () => {
    assert.ok([0, 1, 2].includes(daylightState(Date.now())));
  });
});

describe('dreamweaverServerName', () => {
  const server = (overrides: Partial<ServerInput>) =>
    serverSchema.parse({ id: randomUUID(), name: 'Production', protocol: 'sftp', host: 'sftp.example.com', username: 'demo-user', remoteRoot: '/var/www/my-site', ...overrides });

  test('is the host, a slash, and the remote root ending in a slash', () => {
    assert.equal(dreamweaverServerName(server({})), 'sftp.example.com//var/www/my-site/');
    assert.equal(dreamweaverServerName(server({ protocol: 'ftps', host: '203.0.113.10', remoteRoot: '/public_html/' })), FTP);
    assert.equal(dreamweaverServerName(server({ remoteRoot: '/' })), 'sftp.example.com//');
  });

  test('is the folder with forward slashes for a local or network folder', () => {
    const local = (remoteRoot: string) => ({ ...server({}), protocol: 'local' as const, host: undefined, remoteRoot });
    assert.equal(dreamweaverServerName(local('D:\\Sites\\my-site-testing')), FOLDER);
    assert.equal(dreamweaverServerName(local('D:\\Sites\\my-site-testing\\')), FOLDER);
    assert.equal(dreamweaverServerName(local('D:\\')), 'D:/');
    assert.equal(dreamweaverServerName(local('/srv/www/my-site')), '/srv/www/my-site/');
    assert.equal(dreamweaverServerName(local('/')), '/');
  });

  test('is the name the server sets, when it sets one', () => {
    assert.equal(dreamweaverServerName(server({ host: 'server1.hosting.example.net', options: { dreamweaverServer: FTP } })), FTP);
  });

  test('is built without a host when the server has none', () => {
    assert.equal(dreamweaverServerName({ ...server({}), host: undefined }), '//var/www/my-site/');
  });
});

test('server names are the same whatever their case and with or without the final slash', () => {
  assert.equal(sameServerName(FTP, '203.0.113.10//public_html'), true);
  assert.equal(sameServerName(FOLDER, 'd:/sites/MY-SITE-TESTING/'), true);
  assert.equal(sameServerName('sftp.example.com//', 'SFTP.example.com'), true);
  assert.equal(sameServerName(FTP, '203.0.113.10//public_html/blog/'), false);
});
