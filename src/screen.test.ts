/**
 * The screen's rules, pinned by example.
 *
 * Every case here is a posting shape that actually came back from a real board
 * and was decided wrongly at some point. Run with: node --test src/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { screenPosting } from './screen.ts';
import { parseSalary } from './normalize.ts';
import { readPlace } from './place.ts';
import type { Posting } from './types.ts';

const posting = (over: Partial<Posting>): Posting => ({
  id: 'x', ats: 'greenhouse', slug: 's', company: 'C', externalId: '1',
  title: 'Web Developer', description: 'Remote role.', location: 'Remote, United States',
  department: null, employmentType: null, postedAt: null, url: 'u',
  salaryMin: 90_000, salaryMax: 120_000, salarySource: 'description',
  firstSeen: 'now', lastSeen: 'now', ...over,
});

const reasons = (over: Partial<Posting>) => screenPosting(posting(over)).reasons;

test('a remote US role at the right level passes', () => {
  assert.deepEqual(reasons({}), []);
});

test('a numeral does not rescue a senior title', () => {
  // "Senior Platform Software Engineer II" once passed: the II was read as a
  // junior marker cancelling the word Senior.
  assert.ok(reasons({ title: 'Senior Platform Software Engineer II' }).includes('too-senior'));
});

test('a junior marker does rescue a soft level word', () => {
  assert.deepEqual(reasons({ title: 'Associate Marketing Manager' }), []);
});

test('an office-only location is not saved by the word remote in the body', () => {
  // Figma and Asana office roles passed on a stray "remote" in body copy.
  assert.ok(reasons({
    location: 'San Francisco, CA • New York, NY',
    description: 'We are a remote-friendly company with great benefits.',
  }).includes('not-remote'));
});

test('a remote label with office days required is caught', () => {
  assert.ok(reasons({
    location: 'Remote (Work from Home)',
    description: 'Are you able to work onsite five days a week at our Chelsea Piers office?',
  }).includes('office-days-required'));
});

test('a non-US city is ruled out even when remote', () => {
  assert.ok(reasons({ location: 'Remote - London, United Kingdom' }).includes('outside-us'));
});

test('a stated range under the floor is ruled out; silence is not', () => {
  assert.ok(reasons({ salaryMin: 50_000, salaryMax: 68_000 }).includes('below-floor'));
  assert.ok(!reasons({ salaryMin: null, salaryMax: null }).includes('below-floor'));
});

test('a degree requirement the posting softens does not fire', () => {
  const hard = 'Requires a Bachelor of Science in Computer Science.';
  const soft = 'Requires a BS in Computer Science or equivalent hands-on experience.';
  assert.ok(reasons({ description: `Remote. ${hard}` }).includes('hard-degree'));
  assert.ok(!reasons({ description: `Remote. ${soft}` }).includes('hard-degree'));
});

test('clearance anywhere in the posting rules it out', () => {
  assert.ok(reasons({ description: 'Remote. Must hold an active TS/SCI clearance.' }).includes('clearance'));
});

test('salary parsing reads ranges and ignores funding rounds', () => {
  assert.deepEqual(parseSalary('The range is $135,000 - $180,000 per year.'), { min: 135_000, max: 180_000 });
  assert.deepEqual(parseSalary('$90k–$140k base'), { min: 90_000, max: 140_000 });
  assert.equal(parseSalary('We raised a $50M Series B'), null);
  assert.deepEqual(parseSalary('We pay $85/hour.'), { min: 176_800, max: 176_800 });
});

test('place reads the location field over the description', () => {
  assert.equal(readPlace('New York, NY (HQ)', 'Fully remote team.').remote, false);
  assert.equal(readPlace(null, 'This is a fully remote role in the United States.').remote, true);
});

test('a remote role that never names a country passes, flagged for the judge', () => {
  // "us-not-stated" alone cut 161 postings in the 2026-09-22 run, most of them
  // "Remote" with no country at all — a question for the judge, not a rule-out.
  const s = screenPosting(posting({ location: 'Remote', description: 'Fully remote team.' }));
  assert.equal(s.verdict, 'pass');
  assert.deepEqual(s.reasons, []);
  assert.deepEqual(s.flags, ['us-not-stated']);
});

test('a remote role placed outside the US is still ruled out', () => {
  const s = screenPosting(posting({ location: 'Remote, Germany', description: 'Remote within Germany.' }));
  assert.ok(s.reasons.includes('outside-us'));
});
