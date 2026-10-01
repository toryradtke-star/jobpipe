import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectEol, parseCsv, parseCsvRecords, toCsv } from './csv.ts';

test('quoted fields keep their commas, quotes and newlines', () => {
  const rows = parseCsv('a,b\n"x, y","say ""hi""\nthere"\n');
  assert.deepEqual(rows, [['a', 'b'], ['x, y', 'say "hi"\nthere']]);
});

test('empty trailing fields survive', () => {
  assert.deepEqual(parseCsv('a,b,c\n1,,\n'), [['a', 'b', 'c'], ['1', '', '']]);
});

test('records round-trip through toCsv unchanged', () => {
  const text = `company,role,notes\nAcme,GTM Engineer,"Blocked: 'SF office', 3+ days"\nGlobex,"Dev, Web",plain\n`;
  const header = parseCsv(text)[0];
  assert.equal(toCsv(header, parseCsvRecords(text), detectEol(text)), text);
});

test('CRLF files round-trip as CRLF', () => {
  const text = 'a,b\r\n"1,2",3\r\n';
  assert.equal(toCsv(['a', 'b'], parseCsvRecords(text), detectEol(text)), text);
});
