/**
 * RFC 4180 CSV, just enough for the application tracker.
 *
 * The tracker's notes column carries commas, quotes and long sentences, so a
 * split(',') would mangle it. Fields are quoted on the way out only when they
 * need it, which keeps a round trip byte-identical to what a spreadsheet wrote.
 */

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/** Rows as objects keyed by the header line. */
export function parseCsvRecords(text: string): Record<string, string>[] {
  const [header, ...body] = parseCsv(text);
  if (!header) return [];
  return body.map((cells) => Object.fromEntries(header.map((h, i) => [h, cells[i] ?? ''])));
}

function cell(v: string): string {
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** `eol` defaults to CRLF, the RFC's line ending and what spreadsheets write. */
export function toCsv(header: string[], records: Record<string, string | null | undefined>[],
  eol: '\n' | '\r\n' = '\r\n'): string {
  const lines = [header.map(cell).join(',')];
  for (const r of records) lines.push(header.map((h) => cell(r[h] ?? '')).join(','));
  return lines.join(eol) + eol;
}

/** The line ending a CSV already uses, so rewriting it does not churn every line. */
export function detectEol(text: string): '\n' | '\r\n' {
  return /\r\n/.test(text) || !text.includes('\n') ? '\r\n' : '\n';
}
