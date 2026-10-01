/**
 * The one way adapters talk to a board: a timeout, a polite user agent, and
 * two retries with backoff on the failures worth retrying.
 */

export type FetchContext = { now: string; timeoutMs: number };

export const USER_AGENT = 'jobpipe/0.1 (personal job search; contact via repo)';

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number) { super(`http ${status}`); this.status = status; }
}

/**
 * One JSON request, retried on network errors, 429 and 5xx. A 4xx other than
 * 429 is the board telling us the slug is wrong, and asking again will not
 * change its mind.
 */
export async function request(
  url: string,
  init: { method?: string; body?: unknown; accept?: string; timeoutMs?: number; retries?: number } = {},
): Promise<Response> {
  const { method = 'GET', body, accept = 'application/json', timeoutMs = 30_000, retries = 2 } = init;
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, {
        method,
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          accept, 'user-agent': USER_AGENT,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (res.ok) return res;
      if (attempt >= retries || (res.status < 500 && res.status !== 429)) throw new HttpError(res.status);
    } catch (err) {
      if (err instanceof HttpError || attempt >= retries) throw err;
    }
    await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt + Math.random() * 500));
  }
}

export async function getJson(url: string, init: Parameters<typeof request>[1] = {}): Promise<unknown> {
  return (await request(url, init)).json();
}
