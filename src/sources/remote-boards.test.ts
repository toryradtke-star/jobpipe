import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { employerSlug, parseHimalayas, parseRemoteOk, parseRemotive, parseWwr } from './remote-boards.ts';
import { readPlace } from '../place.ts';

const raw = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const NOW = '2026-10-01T00:00:00.000Z';

test('employer slugs are stable and url-safe', () => {
  assert.equal(employerSlug('Acme Labs, Inc.'), 'acme-labs-inc');
  assert.equal(employerSlug('!!!'), 'unknown');
});

test('Himalayas: structured annual USD pay is kept, ids ignore the search term', () => {
  const ps = parseHimalayas(JSON.parse(raw('himalayas.json')), NOW);
  const popmenu = ps.find((p) => p.company === 'Popmenu')!;
  assert.equal(popmenu.id, 'himalayas:popmenu:gtm-engineer');
  assert.deepEqual([popmenu.salaryMin, popmenu.salaryMax, popmenu.salarySource], [140000, 150000, 'structured']);
  assert.equal(popmenu.location, 'Remote (United States)');
  assert.equal(popmenu.postedAt, new Date(1789612839 * 1000).toISOString());
});

test('Himalayas: a US-restricted remote job reads as remote and in the US', () => {
  const p = parseHimalayas(JSON.parse(raw('himalayas.json')), NOW).find((x) => x.company === 'Popmenu')!;
  const place = readPlace(p.location, p.description);
  assert.equal(place.remote, true);
  assert.equal(place.us, true);
});

test('RemoteOK: the legal row is skipped and implausible pay is dropped', () => {
  const ps = parseRemoteOk(JSON.parse(raw('remoteok.json')), NOW);
  assert.equal(ps.length, 2);
  const toptal = ps.find((p) => p.company === 'Toptal')!;
  assert.equal(toptal.salaryMin, null); // the feed says 10000–50000, which is not a salary
  assert.equal(toptal.id, 'remoteok:toptal:1137439');
});

test('Remotive: jobs parse with their location restriction', () => {
  const ps = parseRemotive(JSON.parse(raw('remotive.json')), NOW);
  assert.equal(ps.length, 2);
  assert.match(ps[0].description, /^Remote: yes\nLocation restriction: USA/);
  assert.equal(ps[0].postedAt, '2026-09-21T12:55:11.000Z');
});

test('WWR: "Company: Role" titles split, escaped HTML becomes text', () => {
  const ps = parseWwr(raw('wwr.xml'), NOW);
  assert.equal(ps.length, 2);
  assert.equal(ps[0].company, 'Melio');
  assert.equal(ps[0].title, 'Senior Account Executive - UHV Payors');
  assert.equal(ps[1].title, 'Manager, Enterprise Sales');
  assert.match(ps[0].description, /Headquarters: Remote, US/);
  assert.doesNotMatch(ps[0].description, /&lt;|<p>/);
  assert.equal(ps[0].postedAt, '2026-10-01T07:31:05.000Z');
});
