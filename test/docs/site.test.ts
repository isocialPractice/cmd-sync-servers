import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { commandReference, END, START } from '../../scripts/lib/cli-reference.ts';
import { COMMANDS } from '../../src/cli/router.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const docs = path.join(root, 'docs');
const site = path.join(root, '_site');
/** The en dash and the em dash, which no page uses. */
const DASHES = new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`);
/** True once `npm run docs:site` has assembled the site. */
const built = existsSync(path.join(site, 'index.html'));

const PAGES = [
  'index.html',
  'getting-started.html',
  'configuration.html',
  'cli.html',
  'synchronization.html',
  'api.html',
  'security.html',
  'troubleshooting.html',
];

function read(name: string): string {
  return readFileSync(path.join(docs, name), 'utf8');
}

function ids(html: string): Set<string> {
  return new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1] ?? ''));
}

function links(html: string): string[] {
  return [...html.matchAll(/\s(?:href|src)="([^"]*)"/g)].map((match) => match[1] ?? '');
}

/** Pages served beside docs/ in the published site: the JSON Schema, and the API reference once built. */
function extraTarget(target: string): string | undefined {
  if (target === 'schema/site.schema.json') {
    return path.join(root, 'schema', 'site.schema.json');
  }
  if (target.startsWith('api/')) {
    return path.join(site, target);
  }
  return undefined;
}

test('docs/ holds every page of the site, and nothing unexpected', () => {
  const html = readdirSync(docs).filter((name) => name.endsWith('.html')).sort();
  assert.deepEqual(html, [...PAGES].sort());
  assert.deepEqual(readdirSync(path.join(docs, 'assets')), ['site.css']);
});

for (const name of PAGES) {
  test(`${name} is a complete page: language, policy, title, one h1, navigation and no scripts`, () => {
    const html = read(name);
    assert.match(html, /^<!doctype html>\n<html lang="en">/);
    assert.match(html, /<meta charset="utf-8">/);
    assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
    assert.match(
      html,
      /<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'">/,
    );
    assert.match(html, /<title>[^<]+<\/title>/);
    assert.match(html, /<meta name="description" content="[^"]+">/);
    assert.match(html, /<link rel="stylesheet" href="assets\/site\.css">/);
    assert.equal(html.match(/<h1[\s>]/g)?.length, 1, 'one h1');
    assert.match(html, /<main id="main">/);
    assert.match(html, /<a class="skip" href="#main">/);
    assert.match(html, new RegExp(`<a href="${name.replace('.', '\\.')}" aria-current="page">`));
    assert.doesNotMatch(html, /<script|\son[a-z]+="|\sstyle="|javascript:/i, 'no scripts, handlers or inline styles');
    assert.doesNotMatch(html, /<link[^>]+href="https?:/i, 'no third-party stylesheets or fonts');
    assert.doesNotMatch(html, DASHES, 'no en or em dashes');
    for (const image of html.matchAll(/<img\b[^>]*>/g)) {
      assert.match(image[0], /\salt="/, 'every image has alt text');
    }
  });

  test(`${name} links only to pages, anchors and files that exist, and to HTTPS`, () => {
    const html = read(name);
    for (const link of links(html)) {
      if (/^https:\/\//.test(link)) {
        continue;
      }
      assert.doesNotMatch(link, /^[a-z]+:/i, `${link}: only https links leave the site`);
      const [target = '', fragment] = link.split('#');
      if (target === '') {
        assert.ok(fragment !== undefined && ids(html).has(fragment), `${name}: #${fragment ?? ''} has no target`);
        continue;
      }
      const extra = extraTarget(target);
      if (extra !== undefined) {
        if (target.startsWith('api/') && !built) {
          continue;
        }
        assert.ok(existsSync(extra), `${name}: ${link} is not built; run npm run docs:site`);
        continue;
      }
      assert.ok(existsSync(path.join(docs, target)), `${name}: ${link} does not exist`);
      if (fragment !== undefined) {
        assert.ok(ids(read(target)).has(fragment), `${name}: ${link} has no such anchor`);
      }
    }
  });
}

test('the README is the front door: under 300 lines, pointing at the site', () => {
  const readme = readFileSync(path.join(root, 'README.md'), 'utf8');
  assert.ok(readme.split('\n').length < 300, 'README.md has 300 lines or more');
  assert.ok(readme.includes('https://isocialpractice.github.io/cmd-sync-servers/'));
  assert.doesNotMatch(readme, DASHES, 'no en or em dashes');
});

test('ids are unique on every page', () => {
  for (const name of PAGES) {
    const all = [...read(name).matchAll(/\sid="([^"]+)"/g)].map((match) => match[1] ?? '');
    assert.deepEqual(all, [...new Set(all)], `${name} repeats an id`);
  }
});

test('the command reference on cli.html matches the commands, as --help prints them', () => {
  const html = read('cli.html');
  const start = html.indexOf(START);
  const end = html.indexOf(END);
  assert.ok(start !== -1 && end > start, 'cli.html has the generated section');
  assert.equal(html.slice(start, end + END.length), commandReference(), 'cli.html is out of date: run npm run docs:cli');
  for (const command of COMMANDS) {
    assert.ok(html.includes(`id="command-${command.path.join('-')}"`), command.path.join(' '));
  }
});

// WCAG 2.2 contrast of the colour pairs the stylesheet uses.
function luminance(hex: string): number {
  const channels = [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16) / 255);
  const [r = 0, g = 0, b = 0] = channels.map((value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05);
}

test('every text and background pair of the stylesheet meets WCAG AA', () => {
  const css = readFileSync(path.join(docs, 'assets', 'site.css'), 'utf8');
  const colors = new Map([...css.matchAll(/--([a-z-]+):\s*(#[0-9a-f]{6});/g)].map((match) => [match[1] ?? '', match[2] ?? '']));
  const color = (name: string): string => {
    const value = colors.get(name);
    assert.ok(value !== undefined, `--${name} is not a six-digit colour`);
    return value;
  };
  const text: readonly (readonly [string, string])[] = [
    ['text', 'bg'],
    ['text', 'surface'],
    ['text', 'secondary'],
    ['text', 'warn-bg'],
    ['muted', 'bg'],
    ['muted', 'surface'],
    ['primary', 'bg'],
    ['primary', 'surface'],
    ['primary', 'secondary'],
    ['primary-strong', 'surface'],
    ['code-text', 'code-bg'],
    ['warn-text', 'warn-bg'],
  ];
  for (const [foreground, background] of text) {
    const ratio = contrast(color(foreground), color(background));
    assert.ok(ratio >= 4.5, `--${foreground} on --${background} is ${ratio.toFixed(2)}:1, below 4.5:1`);
  }
  for (const background of ['bg', 'surface', 'secondary']) {
    const ratio = contrast(color('focus'), color(background));
    assert.ok(ratio >= 3, `the focus ring on --${background} is ${ratio.toFixed(2)}:1, below 3:1`);
  }
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.match(css, /:focus-visible/);
  assert.doesNotMatch(css, /@import|url\(/, 'no imported stylesheets, fonts or images');
});

test('the assembled site holds the pages and the JSON Schema, when built', (context) => {
  if (!built) {
    context.skip('run npm run docs:site to build _site/');
    return;
  }
  for (const name of PAGES) {
    assert.ok(existsSync(path.join(site, name)), name);
  }
  assert.ok(existsSync(path.join(site, 'assets', 'site.css')));
  assert.equal(readFileSync(path.join(site, 'schema', 'site.schema.json'), 'utf8'), readFileSync(path.join(root, 'schema', 'site.schema.json'), 'utf8'));
  assert.ok(existsSync(path.join(site, 'api', 'index.html')), 'the API reference is built');
});
