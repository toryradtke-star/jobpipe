import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseJobspy } from './jobspy.ts';

const rows = JSON.parse(readFileSync(new URL('./fixtures/jobspy.json', import.meta.url), 'utf8'));
const NOW = '2026-10-01T00:00:00.000Z';

test('the direct employer URL wins over the Indeed listing URL', () => {
  const p = parseJobspy(rows, NOW).find((x) => x.company === 'Monotype')!;
  assert.match(p.url, /^https:\/\/monotype\.wd1\.myworkdayjobs\.com\//);
  assert.match(p.id, /^jobspy:monotype:indeed-/);
});

test('yearly pay is structured; a missing company becomes Unknown, not a crash', () => {
  const ps = parseJobspy(rows, NOW);
  const b = ps.find((x) => x.company === 'Buildinglink')!;
  assert.equal(b.salaryMin, 95000);
  assert.equal(b.salarySource, 'structured');
  assert.ok(ps.some((x) => x.company === 'Unknown'));
});

test('hourly pay annualizes at 2,080 hours', () => {
  const [p] = parseJobspy([{ id: 'x', site: 'indeed', title: 'Dev', job_url: 'https://e.x', company: 'Co',
    min_amount: 50, max_amount: 60, interval: 'hourly', currency: 'USD' }], NOW);
  assert.deepEqual([p.salaryMin, p.salaryMax], [104000, 124800]);
});

test('the remote flag is labeled as the site\'s claim', () => {
  const [p] = parseJobspy([{ id: 'x', site: 'indeed', title: 'Dev', job_url: 'https://e.x', company: 'Co', is_remote: true }], NOW);
  assert.match(p.description, /^Remote: yes \(per indeed\)/);
});
