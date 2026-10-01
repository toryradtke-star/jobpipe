import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseDetail, parseList, parseSlug } from './workday.ts';
import type { Company } from '../types.ts';

const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const company: Company = { name: '23andMe', ats: 'workday', slug: '23andme|wd5|23' };

test('slug splits into tenant, data center and site', () => {
  assert.deepEqual(parseSlug('23andme|wd5|23'), { tenant: '23andme', wd: 'wd5', site: '23' });
  assert.throws(() => parseSlug('23andme'));
});

test('a search page reads as hits with their paths', () => {
  const { total, hits } = parseList(fixture('workday-list.json'));
  assert.ok(total >= hits.length);
  assert.equal(hits[0].title, 'Senior Product Designer');
  assert.match(hits[0].externalPath, /^\/job\//);
});

test('a job detail becomes a Posting with country and public URL', () => {
  const hit = parseList(fixture('workday-list.json')).hits[0];
  const p = parseDetail(fixture('workday-job.json'), company, hit, '2026-10-01T00:00:00.000Z')!;
  assert.equal(p.id, 'workday:23andme|wd5|23:2026048');
  assert.equal(p.location, 'Palo Alto (HQ)');
  assert.equal(p.postedAt, '2026-08-03T00:00:00.000Z');
  assert.match(p.description, /^Country: United States of America\n/);
  assert.equal(p.url, 'https://23andme.wd5.myworkdayjobs.com/23/job/Palo-Alto-HQ/Senior-Product-Designer_2026048');
  assert.doesNotMatch(p.description, /<p>/);
});

test('a detail response without jobPostingInfo is skipped, not thrown', () => {
  const hit = { title: 'x', externalPath: '/job/x', locationsText: null };
  assert.equal(parseDetail({}, company, hit, 'now'), null);
});
