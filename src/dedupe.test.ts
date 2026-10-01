import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fingerprint, preferred } from './dedupe.ts';

test('company suffixes and punctuation do not split a match', () => {
  assert.equal(fingerprint('Kintsugi AI', 'GTM Engineer'), fingerprint('Kintsugi', 'GTM Engineer'));
  assert.equal(fingerprint('Acme, Inc.', 'Growth Engineer'), fingerprint('ACME', 'Growth Engineer'));
});

test('remote markers in a title do not split a match', () => {
  const base = fingerprint('Popmenu', 'GTM Engineer');
  assert.equal(fingerprint('Popmenu', 'GTM Engineer (Remote)'), base);
  assert.equal(fingerprint('Popmenu', 'GTM Engineer - Remote, US'), base);
  assert.equal(fingerprint('Popmenu', 'Remote GTM Engineer'), base);
});

test('different roles at one company stay apart', () => {
  assert.notEqual(fingerprint('Vercel', 'GTM Engineer'), fingerprint('Vercel', 'Senior GTM Engineer'));
  assert.equal(fingerprint('Vercel', 'Sr. GTM Engineer'), fingerprint('Vercel', 'Senior GTM Engineer'));
});

test('the employer board beats a feed, and a feed beats a scrape', () => {
  const L = '2026-10-01T00:00:00Z';
  const copies = [
    { id: 'jobspy:a:1', ats: 'jobspy' as const, firstSeen: '2026-09-01', lastSeen: L },
    { id: 'himalayas:a:1', ats: 'himalayas' as const, firstSeen: '2026-09-02', lastSeen: L },
    { id: 'ashby:a:1', ats: 'ashby' as const, firstSeen: '2026-09-30', lastSeen: L },
  ];
  assert.equal(preferred(copies).id, 'ashby:a:1');
  assert.equal(preferred(copies.slice(0, 2)).id, 'himalayas:a:1');
});

test('a live copy beats a closed one, and a judged copy beats an unjudged one', () => {
  const closed = { id: 'greenhouse:a:1', ats: 'greenhouse' as const, firstSeen: '2026-09-01', lastSeen: '2026-09-10T00:00:00Z' };
  const live = { id: 'greenhouse:a:2', ats: 'greenhouse' as const, firstSeen: '2026-09-20', lastSeen: '2026-10-01T09:00:00Z' };
  assert.equal(preferred([closed, live]).id, 'greenhouse:a:2');
  assert.equal(preferred([{ ...closed, judged: true }, live]).id, 'greenhouse:a:1');
});
