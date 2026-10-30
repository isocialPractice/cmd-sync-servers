import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { hostFieldProblem, parseServerAddress, type ServerAddress } from '../../../src/config/address.ts';
import { formatIssues, serverSchema } from '../../../src/config/schema.ts';

function parsed(text: string): ServerAddress {
  const result = parseServerAddress(text);
  assert.ok(result.ok, `${text} should parse: ${result.ok ? '' : result.problem}`);
  return result.address;
}

function problem(text: string): string {
  const result = parseServerAddress(text);
  assert.ok(!result.ok, `${text} should be refused`);
  return result.problem;
}

test('a host name or an IP address alone is the host', () => {
  for (const [text, host] of [
    ['sftp.example.com', 'sftp.example.com'],
    ['203.0.113.10', '203.0.113.10'],
    ['2001:db8::10', '2001:db8::10'],
    ['[2001:db8::10]', '2001:db8::10'],
    ['  sftp.example.com  ', 'sftp.example.com'],
  ] as const) {
    const address = parsed(text);
    assert.equal(address.host, host);
    assert.deepEqual([address.port, address.protocol, address.username, address.remoteRoot], [undefined, undefined, undefined, undefined]);
  }
});

test('host:port and [IPv6]:port give the host and the port', () => {
  assert.deepEqual([parsed('sftp.example.com:2222').host, parsed('sftp.example.com:2222').port], ['sftp.example.com', 2222]);
  assert.deepEqual([parsed('[2001:db8::10]:2222').host, parsed('[2001:db8::10]:2222').port], ['2001:db8::10', 2222]);
});

test('an sftp:// address gives the protocol, user, host, port and folder', () => {
  const address = parsed('sftp://demo-user@sftp.example.com:2222/var/www/my-site');
  assert.deepEqual(
    [address.protocol, address.username, address.host, address.port, address.remoteRoot],
    ['sftp', 'demo-user', 'sftp.example.com', 2222, '/var/www/my-site'],
  );
});

test('ftpes:// is explicit TLS, ftps:// implicit TLS, and ftp:// explicit TLS with a note, never plain FTP', () => {
  assert.equal(parsed('ftpes://ftp.example.com').protocol, 'ftps');
  assert.equal(parsed('ftps://ftp.example.com').protocol, 'ftps-implicit');
  const ftp = parsed('ftp://ftp.example.com');
  assert.equal(ftp.protocol, 'ftps');
  assert.match(ftp.note ?? '', /--protocol ftp --allow-insecure/);
  assert.equal(parsed('FTPES://ftp.example.com').protocol, 'ftps');
});

test('a user that holds an @ is split at the last one', () => {
  const address = parsed('demo-user@example.com@ftp.example.com');
  assert.deepEqual([address.username, address.host], ['demo-user@example.com', 'ftp.example.com']);
  const encoded = parsed('ftpes://demo-user%40example.com@server1.hosting.example.net');
  assert.deepEqual([encoded.username, encoded.host], ['demo-user@example.com', 'server1.hosting.example.net']);
});

test('web addresses are refused with what to enter instead', () => {
  for (const text of ['http://www.example.com/', 'https://www.example.com/my-site/', 'www.example.com/my-site', 'example.com\\my-site']) {
    assert.match(problem(text), /web address.*ftp\.example\.com/);
  }
});

test('spaces, an empty value, bad ports, other schemes and passwords are refused', () => {
  assert.match(problem(''), /Enter the host/);
  assert.match(problem('   '), /Enter the host/);
  assert.match(problem('ftp example com'), /no spaces/);
  for (const text of ['sftp.example.com:0', 'sftp.example.com:65536', 'sftp.example.com:ssh', 'sftp.example.com:', '[2001:db8::10]:99999']) {
    assert.match(problem(text), /port/i, text);
  }
  assert.match(problem('scp://sftp.example.com'), /sftp:\/\//);
  assert.match(problem('sftp://demo-user:secret@sftp.example.com'), /password/);
  assert.match(problem('demo-user:secret@sftp.example.com'), /password/);
  assert.match(problem('bad_host!.example.com'), /not a host name/);
  assert.match(problem('[sftp.example.com]'), /not an IPv6/);
  assert.match(problem('@sftp.example.com'), /user/);
});

test('ports that web control panels use get a warning', () => {
  for (const port of [80, 443, 2082, 2083, 2086, 2087, 2095, 2096, 8443]) {
    assert.match(parsed(`server1.hosting.example.net:${String(port)}`).warning ?? '', new RegExp(`Port ${String(port)} is usually a web`));
  }
  assert.equal(parsed('sftp.example.com:2222').warning, undefined);
});

test('the host field of sites.json holds the host alone', () => {
  assert.equal(hostFieldProblem('server1.hosting.example.net'), undefined);
  assert.equal(hostFieldProblem('2001:db8::10'), undefined);
  assert.equal(hostFieldProblem('server1.hosting.example.net:2083'), 'Holds a port: set "port": 2083 and keep the host name alone.');
  assert.match(hostFieldProblem('demo-user@ftp.example.com') ?? '', /^Holds a user name: set "username": "demo-user"/);
  assert.match(hostFieldProblem('sftp://sftp.example.com') ?? '', /^Holds a whole address/);
  assert.match(hostFieldProblem('[2001:db8::10]') ?? '', /without brackets: 2001:db8::10/);
  assert.match(hostFieldProblem('https://www.example.com/') ?? '', /web address/);
});

test('the schema refuses a host with a port, naming the fix', () => {
  const result = serverSchema.safeParse({
    id: randomUUID(),
    name: 'Production',
    protocol: 'ftps',
    host: 'server1.hosting.example.net:2083',
    remoteRoot: '/',
  });
  assert.equal(result.success, false);
  assert.deepEqual(formatIssues(result.error.issues),['host: Holds a port: set "port": 2083 and keep the host name alone.']);
});
