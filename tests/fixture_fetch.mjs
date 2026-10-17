// A `fetch` over the files in tests/fixtures, standing in for the data host.
//
// Every library's `latest.json` names FIXTURE_RELEASE. Honours `Range` with a
// 206 by default, like the real origin; with `{ranges: false}` it answers every
// request with the whole object and a 200, which is what a proxy that strips
// the header looks like. Counts requests so tests can assert on what was
// fetched.

import { readFileSync, existsSync } from 'node:fs';

const FIX = new URL('./fixtures/', import.meta.url).pathname;

/// The release the fixtures were copied from.
export const FIXTURE_RELEASE = '2026-10-12.1';

/// The `latest.json` the host publishes for `library`.
export function fixtureLatest(library, overrides = {}) {
  return {
    schema: 'yamc-data-latest', schema_version: 1, keyword: library,
    release: FIXTURE_RELEASE, format_version: 2,
    manifest: `${FIXTURE_RELEASE}/manifest.json`, ...overrides,
  };
}

/// Map a host path to a fixture path, or `{latest}` for a library's pointer:
/// `/<lib>/<release>/neutron/Li6.arrow/energy.arrow` -> `fixtures/Li6.arrow/energy.arrow`;
/// photon `H.arrow` -> `H.photon.arrow`; `/<lib>/<release>/<particle>/index.json`
/// -> `fixtures/index/<lib>/<particle>/index.json`. A release other than
/// FIXTURE_RELEASE is not on the host.
export function fixturePath(pathname) {
  const [, library, release, particle, dir, file] = pathname.split('/');
  if (release === 'latest.json' && particle === undefined) return { latest: library };
  if (release !== FIXTURE_RELEASE) return null;
  if (dir === 'index.json' && file === undefined) return `${FIX}index/${library}/${particle}/index.json`;
  const stem = particle === 'photon' ? dir.replace(/\.arrow$/, '.photon.arrow') : dir;
  return `${FIX}${stem}/${file}`;
}

export function fixtureFetch({ origin, ranges = true, log = [], latest = fixtureLatest } = {}) {
  const fetchImpl = async (url, opts = {}) => {
    const path = fixturePath(url.slice(origin.length));
    const range = opts.headers?.Range;
    log.push({ url: url.slice(origin.length), range: range ?? null });
    if (path?.latest) return Response.json(latest(path.latest));
    if (!path || !existsSync(path)) {
      return new Response('not found', { status: 404, statusText: 'Not Found' });
    }
    const whole = new Uint8Array(readFileSync(path));
    if (range && ranges) {
      const m = /^bytes=(\d+)-(\d+)$/.exec(range);
      const body = whole.subarray(Number(m[1]), Number(m[2]) + 1);
      return new Response(body, { status: 206, statusText: 'Partial Content' });
    }
    return new Response(whole, { status: 200, statusText: 'OK' });
  };
  fetchImpl.log = log;
  return fetchImpl;
}
