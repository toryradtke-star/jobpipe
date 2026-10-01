import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { applyUrl, confirmedSubmission, factCheck, matchTitle, parseApplyResult, slugCandidates, type ApplyResult } from './autoapply.ts';
import type { Posting } from './types.ts';

// A made-up candidate, so the tests run anywhere and publish nothing personal.
const MASTER = readFileSync(new URL('./fixtures/resume-master.md', import.meta.url), 'utf8');
const swap = (from: string, to: string) => { assert.ok(MASTER.includes(from), `fixture moved: ${from}`); return MASTER.replace(from, to); };

test('a reordered, reworded resume passes the fact check', () => {
  const tailored = swap('Web developer who ships production Next.js applications',
    'Marketing technology engineer who ships production Next.js applications');
  assert.deepEqual(factCheck(tailored, MASTER, ''), []);
});

test('a sentence-opening word whose stem is known passes', () => {
  const tailored = swap('Web developer who ships', 'Marketer turned web developer who ships');
  assert.deepEqual(factCheck(tailored, MASTER, ''), []);
});

test('a new number is caught', () => {
  const tailored = swap('rose from ~300K to 5.9M', 'rose from ~300K to 9.2M');
  assert.match(factCheck(tailored, MASTER, '').join(), /9\.2m/);
});

test('a new tool is caught', () => {
  const tailored = swap('Git/GitHub, Vercel', 'Git/GitHub, Vercel, Salesforce, HubSpot');
  const problems = factCheck(tailored, MASTER, '').join();
  assert.match(problems, /salesforce/);
  assert.match(problems, /hubspot/);
});

test('a tool named in the source documents is allowed', () => {
  const tailored = swap('Git/GitHub, Vercel', 'Git/GitHub, Vercel, BullMQ');
  assert.deepEqual(factCheck(tailored, MASTER, ''), []);
});

test('claiming to manage ad spend is caught', () => {
  const tailored = swap('Analyze Google Ads and paid social performance across accounts running ~$50K/month in spend',
    'Managed ~$50K/month in paid social spend');
  assert.match(factCheck(tailored, MASTER, '').join(), /ad spend/);
});

test('a changed header is caught', () => {
  assert.match(factCheck(swap('phone: 555-0100', 'phone: 555-0199'), MASTER, '').join(), /header/);
});

test('slug candidates cover the usual spellings', () => {
  assert.deepEqual(slugCandidates('Hello Alice'), ['hello-alice', 'helloalice']);
  assert.ok(slugCandidates('Canvas Medical, Inc.').includes('canvasmedical'));
});

const posting = (over: Partial<Posting>): Posting => ({
  id: 'x', ats: 'greenhouse', slug: 'acme', company: 'Acme', externalId: '123', title: 'GTM Engineer',
  description: '', location: null, department: null, employmentType: null, postedAt: null, url: 'https://acme.com/careers?gh_jid=123',
  salaryMin: null, salaryMax: null, salarySource: null, firstSeen: '', lastSeen: '', ...over,
});

test('the title match ignores remote suffixes but not a different level', () => {
  assert.equal(matchTitle('GTM Engineer (Remote)', [posting({})])?.id, 'x');
  assert.equal(matchTitle('Senior GTM Engineer', [posting({})]), null);
});

test('apply URLs point at the hosted form, not the careers site', () => {
  assert.equal(applyUrl(posting({})), 'https://job-boards.greenhouse.io/acme/jobs/123');
  assert.equal(applyUrl(posting({ ats: 'lever', externalId: 'ab-cd' })), 'https://jobs.lever.co/acme/ab-cd/apply');
  assert.equal(applyUrl(posting({ ats: 'workday' })), null);
});

test('a submission counts only on a lane host with a confirmation', () => {
  const r = (over: Partial<ApplyResult>): ApplyResult => ({ status: 'submitted', reason: '', finalUrl: 'https://job-boards.greenhouse.io/acme/jobs/123/confirmation',
    confirmation: 'Thank you for applying.', answers: [], blank: [], ...over });
  assert.ok(confirmedSubmission(r({})));
  assert.ok(!confirmedSubmission(r({ confirmation: '' })));
  assert.ok(!confirmedSubmission(r({ finalUrl: 'https://acme.myworkdayjobs.com/x' })));
  assert.ok(!confirmedSubmission(r({ status: 'skipped' })));
});

test('the apply reply is parsed out of surrounding text', () => {
  const out = parseApplyResult('Done.\n{"status":"skipped","reason":"asks for a password","finalUrl":"","confirmation":"","answers":[],"blank":[]}');
  assert.equal(out?.status, 'skipped');
  assert.equal(parseApplyResult('no json here'), null);
});
