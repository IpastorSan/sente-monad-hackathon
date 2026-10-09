/** The "How it works" copy (SEN-181): anchors and links. Plain node, no device. */
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { anchorIndex, anchorNames, HOW_IT_WORKS_PATH, resolveAnchor, SECTIONS } from './content.ts';
import { linksOf, parseParagraph } from './markup.ts';

const APP_DIR = fileURLToPath(new URL('../app', import.meta.url));

/** Every screen route under `src/app`, as path segments: groups dropped, `index` is the parent. */
function routePatterns(): string[][] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.tsx?$/.test(entry.name) && !/\.test\.ts$/.test(entry.name)) files.push(path);
    }
  };
  walk(APP_DIR);
  return files
    .map((file) => relative(APP_DIR, file).replace(/\.tsx?$/, ''))
    .filter((route) => !route.split('/').some((seg) => seg.startsWith('_') || seg.startsWith('+')))
    .map((route) =>
      route
        .split('/')
        .filter((seg) => !/^\(.*\)$/.test(seg))
        .filter((seg, i, all) => !(seg === 'index' && i === all.length - 1)),
    );
}

const ROUTES = routePatterns();

function routeExists(pathname: string): boolean {
  const segments = pathname.split('/').filter((seg) => seg !== '');
  return ROUTES.some((pattern) => {
    if (pattern.some((seg) => seg.startsWith('[...')))
      throw new Error('catch-all routes are not handled here');
    return (
      pattern.length === segments.length &&
      pattern.every((seg, i) => seg === segments[i] || /^\[[^.\]]+\]$/.test(seg))
    );
  });
}

const ALL_LINKS = SECTIONS.flatMap((section) =>
  section.items.flatMap((item) =>
    item.body.flatMap((paragraph) =>
      linksOf(paragraph).map((href) => ({ href, where: `${section.id}#${item.id}` })),
    ),
  ),
);

test('the page itself is a route file', () => {
  assert.ok(routeExists(HOW_IT_WORKS_PATH), `${HOW_IT_WORKS_PATH} has no file under src/app`);
});

test('the route matcher tells real routes from made-up ones', () => {
  assert.ok(routeExists('/'));
  assert.ok(routeExists('/markets'));
  assert.ok(routeExists('/markets/kuru/MON-USDC'));
  assert.ok(routeExists('/trade/perpl-setup'));
  assert.ok(!routeExists('/nowhere'));
  assert.ok(!routeExists('/markets/kuru'));
});

test('every anchor, alias included, is unique and URL-safe', () => {
  const names = anchorNames();
  const seen = new Set<string>();
  for (const name of names) {
    assert.match(name, /^[a-z0-9]+(-[a-z0-9]+)*$/, `"${name}" is a lowercase-hyphen slug`);
    assert.ok(!seen.has(name), `anchor "${name}" is used twice`);
    seen.add(name);
  }
  assert.equal(anchorIndex().size, names.length);
});

test('the anchors other screens link to exist', () => {
  // SEN-177's hire flow links #mandate and #limits; trading screens #trading and #relay.
  for (const name of ['mandate', 'limits', 'trading', 'relay']) {
    assert.ok(resolveAnchor(name), `#${name} is missing`);
  }
  assert.deepEqual(resolveAnchor('#mandate'), { sectionId: 'agents', itemId: 'mandate' });
  assert.deepEqual(resolveAnchor('trading'), { sectionId: 'trading', itemId: null });
  assert.deepEqual(resolveAnchor('%23relay'), { sectionId: 'trading', itemId: 'relay' });
  assert.equal(resolveAnchor('nope'), null);
  assert.equal(resolveAnchor(''), null);
  assert.equal(resolveAnchor(undefined), null);
});

test('every link is internal and reaches a route file or an anchor on this page', () => {
  assert.ok(ALL_LINKS.length > 0);
  for (const { href, where } of ALL_LINKS) {
    if (href.startsWith('#')) {
      assert.ok(resolveAnchor(href), `${where}: ${href} is not an anchor on this page`);
      continue;
    }
    assert.ok(href.startsWith('/'), `${where}: ${href} is not an in-app link`);
    const [beforeHash = '', hash] = href.split('#');
    const pathname = beforeHash.split('?')[0] ?? '';
    assert.ok(routeExists(pathname), `${where}: ${href} has no route file`);
    if (hash !== undefined && pathname === HOW_IT_WORKS_PATH)
      assert.ok(resolveAnchor(hash), `${where}: ${href} names a missing anchor`);
  }
});

test('every section and question has copy', () => {
  for (const section of SECTIONS) {
    assert.ok(section.title && section.summary, `${section.id} has a title and a summary`);
    assert.ok(section.items.length > 0, `${section.id} has questions`);
    for (const item of section.items) {
      assert.ok(item.question.endsWith('?'), `${item.id} is a question`);
      assert.ok(item.body.length > 0, `${item.id} has an answer`);
    }
  }
});

test('markup: links and literals split out, text kept verbatim', () => {
  assert.deepEqual(parseParagraph('Open [Account](/account) and read `sente.lol`.'), [
    { kind: 'text', text: 'Open ' },
    { kind: 'link', text: 'Account', href: '/account' },
    { kind: 'text', text: ' and read ' },
    { kind: 'code', text: 'sente.lol' },
    { kind: 'text', text: '.' },
  ]);
  assert.deepEqual(parseParagraph('plain'), [{ kind: 'text', text: 'plain' }]);
  assert.deepEqual(parseParagraph('[a](#b)'), [{ kind: 'link', text: 'a', href: '#b' }]);
});

test('no paragraph leaves stray markup behind', () => {
  for (const section of SECTIONS)
    for (const item of section.items)
      for (const paragraph of item.body)
        for (const span of parseParagraph(paragraph))
          if (span.kind === 'text')
            assert.ok(!/[`]|\]\(/.test(span.text), `${item.id}: unparsed markup in "${span.text}"`);
});
