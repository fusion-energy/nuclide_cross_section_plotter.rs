// Fetching and decoding cross sections on demand from the published Arrow
// directories, without a wasm: a microscopic cross section is read straight
// out of its record batch.
//
// Per nuclide the first request costs `version.json` (a few tens of kB), the
// energy grid of the wanted temperature (one record batch, about 200 kB for
// Fe56) and one reaction batch (3 to 340 kB). Every further reaction at that
// temperature is one range request; every further temperature is one grid
// batch plus one reaction batch per MT. The pieces are spliced into Arrow IPC
// streams with `ranges.js` and decoded by `arrow.js`.
//
// Photon data has no index and no temperature: `element.arrow` is fetched
// whole once per element.
//
// Each library is published as immutable releases under
// `<library>/<release>/`; `<library>/latest.json` names the current one. It is
// read once per library per session, so every file of a library the page
// shows comes from one release.
//
// Nothing here touches the DOM or `self`; the same code runs in the worker
// and under Node against fixture files.

import { reactionRanges, energyRanges, coalesce, rangeHeader, EOS } from './ranges.js';
import { reactionSeries, energyGrid } from './arrow.js';
import { PHOTON_MTS } from './photon.js';
import { LIBRARIES } from './libraries.js';

export const ORIGIN = 'https://yamc-data.xsplot.com';
/// The release `format_version`s this page can read.
export const SUPPORTED_FORMAT_VERSIONS = Object.freeze([2]);
const KNOWN_LIBRARIES = new Set(LIBRARIES.map((l) => l.id));

/// Lower-case hex sha256 of `bytes`.
async function sha256Hex(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

/// Build the engine around a decoder from `createArrowDecoder`.
export function createEngine({ origin = ORIGIN, fetchImpl = fetch, decoder }) {
  if (!decoder) throw new Error('createEngine needs a decoder');

  /// Per-(library, nuclide) state, held as the in-flight promise so concurrent
  /// callers coalesce onto one download.
  const nuclides = new Map();
  /// Per-library release id from `latest.json`, as the in-flight promise.
  const releases = new Map();
  /// Per-(library, element) decoded photon data, likewise.
  const elements = new Map();
  /// Once a ranged request has come back as a whole object, something between
  /// here and the bucket strips `Range`; every later fetch asks for whole
  /// files so a plan of several spans does not download the file repeatedly.
  let rangesStripped = false;

  const url = (library, release, particle, name, file) =>
    `${origin}/${library}/${release}/${particle}/${name}.arrow/${file}`;

  function checkLibrary(library) {
    if (!KNOWN_LIBRARIES.has(library)) {
      throw new Error(`unknown library ${library}; one of ${[...KNOWN_LIBRARIES].join(', ')}`);
    }
  }

  /// The current release of a library, read from its `latest.json` once.
  function ensureRelease(library) {
    checkLibrary(library);
    if (!releases.has(library)) {
      releases.set(library, loadRelease(library).catch((err) => {
        releases.delete(library);
        throw err;
      }));
    }
    return releases.get(library);
  }

  async function loadRelease(library) {
    const target = `${origin}/${library}/latest.json`;
    const resp = await fetchImpl(target);
    if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText} fetching ${target}`);
    const latest = await resp.json();
    if (latest?.schema !== 'yamc-data-latest' || typeof latest.release !== 'string' || !latest.release) {
      throw new Error(`${target} does not name a release`);
    }
    if (latest.keyword !== library) {
      throw new Error(`${target} is for ${latest.keyword}, not ${library}`);
    }
    if (!SUPPORTED_FORMAT_VERSIONS.includes(latest.format_version)) {
      throw new Error(
        `${library} release ${latest.release} is data format ${latest.format_version}; ` +
        `this page reads format ${SUPPORTED_FORMAT_VERSIONS.join(', ')}`);
    }
    return latest.release;
  }

  async function fetchBytes(target, range = null) {
    const resp = await fetchImpl(target, range ? { headers: { Range: rangeHeader(range) } } : undefined);
    if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText} fetching ${target}`);
    const bytes = new Uint8Array(await resp.arrayBuffer());
    if (range && resp.status !== 206) {
      // The whole object arrived instead of the slice. Still the right data;
      // the caller takes it as the file rather than splicing it.
      rangesStripped = true;
      return { bytes, whole: true };
    }
    if (range && bytes.length !== range.len) {
      throw new Error(`${target}: asked for ${range.len} bytes, got ${bytes.length}`);
    }
    return { bytes, whole: false };
  }

  /// Fetch a version.json, turning a 404 into the message a user picking a
  /// library needs (coverage differs: TENDL-2025 has no H1).
  async function fetchVersion(library, release, particle, name) {
    const target = url(library, release, particle, name, 'version.json');
    const resp = await fetchImpl(target);
    if (resp.status === 404) throw new Error(`${name} is not published in ${library}`);
    if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText} fetching ${target}`);
    try {
      return JSON.parse(new TextDecoder().decode(new Uint8Array(await resp.arrayBuffer())));
    } catch (err) {
      throw new Error(`${library} ${name}: version.json does not parse: ${err.message}`);
    }
  }

  // --- neutron -------------------------------------------------------------

  function ensureNuclide(library, name) {
    checkLibrary(library);
    const key = `${library}/${name}`;
    if (!nuclides.has(key)) {
      nuclides.set(key, loadNuclide(library, name).catch((err) => {
        // A failed load is not cached: a transient network error would
        // otherwise poison the nuclide for the rest of the session.
        nuclides.delete(key);
        throw err;
      }));
    }
    return nuclides.get(key);
  }

  async function loadNuclide(library, name) {
    const release = await ensureRelease(library);
    const version = await fetchVersion(library, release, 'neutron', name);
    const reactions = reactionRanges(version);
    const energy = energyRanges(version);
    const entry = {
      library, release, name, version,
      dataVersion: version.data_version ?? null,
      /// null when the file carries no usable index; then everything is read
      /// from the whole files.
      reactions: rangesStripped ? null : reactions,
      energy: rangesStripped ? null : energy,
      /// Cached schema messages, one per section, so a later batch is one
      /// request rather than two.
      schema: { energy: null, reactions: null },
      /// Decoded energy grids by temperature label ("294K").
      grids: new Map(),
      /// Decoded series by `${mt}@${label}`.
      series: new Map(),
      inFlight: new Map(),
      /// Set once the whole reactions.arrow has been decoded (fallback path).
      wholeLoaded: false,
    };
    return entry;
  }

  /// Run `job` once per `key` on the entry, sharing the promise with concurrent
  /// callers and forgetting it on failure.
  function once(entry, key, job) {
    if (!entry.inFlight.has(key)) {
      const p = job().finally(() => entry.inFlight.delete(key));
      entry.inFlight.set(key, p);
    }
    return entry.inFlight.get(key);
  }

  /// Fetch the batches of a section as one Arrow IPC stream, remembering the
  /// schema bytes so every later batch of that section is one request.
  ///
  /// The stream is `schema ++ batches (file order) ++ EOS`, the shape the
  /// decoder accepts. Coalesced spans may carry bytes between the wanted
  /// batches; only the wanted parts are copied out.
  async function fetchSpliced(entry, section, batchRanges) {
    const ranges = entry[section];
    const target = url(entry.library, entry.release, 'neutron', entry.name, `${section}.arrow`);
    const wanted = [...batchRanges].sort((a, b) => a.off - b.off);
    const cachedSchema = entry.schema[section];
    const parts = cachedSchema ? wanted : [ranges.schema, ...wanted];
    const spans = coalesce(parts);
    const got = await Promise.all(spans.map((span) => fetchBytes(target, span)));
    const whole = got.find((g) => g.whole);
    if (whole) return { bytes: whole.bytes, whole: true };
    const bodies = got.map((g) => g.bytes);
    const cut = (part) => {
      const i = spans.findIndex((sp) => part.off >= sp.off && part.off + part.len <= sp.off + sp.len);
      if (i < 0) throw new Error(`${target}: no fetched span covers ${part.off}+${part.len}`);
      const from = part.off - spans[i].off;
      return bodies[i].subarray(from, from + part.len);
    };
    // Every piece is checked against the sha256 in version.json: a wrong byte
    // still frames as Arrow and would decode into wrong numbers.
    const checked = async (part) => {
      const bytes = cut(part);
      const got = await sha256Hex(bytes);
      if (got !== part.sha256) {
        throw new Error(`${target}: bytes ${part.off}+${part.len} have sha256 ${got}, version.json says ${part.sha256}`);
      }
      return bytes;
    };
    if (!cachedSchema) entry.schema[section] = (await checked(ranges.schema)).slice();
    const schema = entry.schema[section];
    const batches = await Promise.all(wanted.map(checked));
    const out = new Uint8Array(schema.length + batches.reduce((n, b) => n + b.length, 0) + EOS.length);
    out.set(schema, 0);
    let at = schema.length;
    for (const b of batches) {
      out.set(b, at);
      at += b.length;
    }
    out.set(EOS, at);
    return { bytes: out, whole: false };
  }

  /// Read every batch of a whole file into the entry (fallback path).
  async function loadWhole(entry) {
    return once(entry, 'whole', async () => {
      if (entry.wholeLoaded) return;
      const [e, r] = await Promise.all([
        fetchBytes(url(entry.library, entry.release, 'neutron', entry.name, 'energy.arrow')),
        fetchBytes(url(entry.library, entry.release, 'neutron', entry.name, 'reactions.arrow')),
      ]);
      for (const batch of decoder.readBatches(e.bytes)) {
        const { temperature, grid } = energyGrid(decoder, batch);
        entry.grids.set(temperature, grid);
      }
      for (const batch of decoder.readBatches(r.bytes)) {
        const temperature = decoder.scalarList(batch, 'xs_temperatures')[0];
        const grid = entry.grids.get(temperature);
        if (!grid) continue;
        const s = reactionSeries(decoder, batch, grid);
        entry.series.set(`${s.mt}@${s.temperature}`, s);
      }
      entry.wholeLoaded = true;
    });
  }

  async function ensureGrid(entry, label) {
    if (entry.grids.has(label)) return entry.grids.get(label);
    if (!entry.energy || rangesStripped) {
      await loadWhole(entry);
    } else {
      await once(entry, `grid@${label}`, async () => {
        const range = entry.energy.temperatures.get(label);
        if (!range) throw new Error(`${entry.name} in ${entry.library} has no energy grid at ${label}`);
        const got = await fetchSpliced(entry, 'energy', [range]);
        if (got.whole) {
          for (const batch of decoder.readBatches(got.bytes)) {
            const g = energyGrid(decoder, batch);
            entry.grids.set(g.temperature, g.grid);
          }
        } else {
          const [batch] = decoder.readBatches(got.bytes);
          const g = energyGrid(decoder, batch);
          entry.grids.set(g.temperature, g.grid);
        }
      });
    }
    const grid = entry.grids.get(label);
    if (!grid) throw new Error(`${entry.name} in ${entry.library} has no energy grid at ${label}`);
    return grid;
  }

  /// The published temperature labels of a nuclide, numeric order, 0K last.
  function temperaturesOf(entry) {
    const labels = entry.energy ? [...entry.energy.temperatures.keys()] : [...entry.grids.keys()];
    const k = (l) => parseFloat(l);
    return labels.sort((a, b) => (k(a) === 0) - (k(b) === 0) || k(a) - k(b));
  }

  /// One reaction of one nuclide at one temperature:
  /// `{mt, label, temperature, energy, xs, threshold}` with typed arrays.
  async function series(library, name, mt, temperature) {
    const entry = await ensureNuclide(library, name);
    const key = `${mt}@${temperature}`;
    if (entry.series.has(key)) return entry.series.get(key);
    const grid = await ensureGrid(entry, temperature);
    if (entry.series.has(key)) return entry.series.get(key);

    if (!entry.reactions || rangesStripped) {
      await loadWhole(entry);
    } else {
      await once(entry, key, async () => {
        const range = entry.reactions.mts.get(Number(mt))?.get(temperature);
        if (!range) {
          throw new Error(`${name} in ${library} does not publish MT ${mt} at ${temperature}`);
        }
        const got = await fetchSpliced(entry, 'reactions', [range]);
        if (got.whole) {
          for (const batch of decoder.readBatches(got.bytes)) {
            const t = decoder.scalarList(batch, 'xs_temperatures')[0];
            const g = entry.grids.get(t) ?? (t === temperature ? grid : null);
            if (!g) continue;
            const s = reactionSeries(decoder, batch, g);
            entry.series.set(`${s.mt}@${s.temperature}`, s);
          }
          entry.wholeLoaded = true;
        } else {
          const [batch] = decoder.readBatches(got.bytes);
          const s = reactionSeries(decoder, batch, grid);
          entry.series.set(`${s.mt}@${s.temperature}`, s);
        }
      });
    }
    const s = entry.series.get(key);
    if (!s) throw new Error(`${name} in ${library} does not publish MT ${mt} at ${temperature}`);
    return s;
  }

  // --- photon --------------------------------------------------------------

  function ensureElement(library, element) {
    checkLibrary(library);
    const key = `${library}/${element}`;
    if (!elements.has(key)) {
      elements.set(key, loadElement(library, element).catch((err) => {
        elements.delete(key);
        throw err;
      }));
    }
    return elements.get(key);
  }

  async function loadElement(library, element) {
    const release = await ensureRelease(library);
    const [version, got] = await Promise.all([
      fetchVersion(library, release, 'photon', element),
      fetchBytes(url(library, release, 'photon', element, 'element.arrow')),
    ]);
    const [batch] = decoder.readBatches(got.bytes);
    const energy = decoder.f64List(batch, 'ln_energy').map(Math.exp);
    const xs = {};
    for (const [mt, { column }] of Object.entries(PHOTON_MTS)) {
      const values = decoder.f64List(batch, column);
      xs[mt] = values.length ? values : null;
    }
    return { library, element, dataVersion: version.data_version ?? null, energy, xs };
  }

  /// One photon reaction of one element: `{mt, energy, xs}`, or an error if
  /// the evaluation has no such reaction.
  async function photonSeries(library, element, mt) {
    const data = await ensureElement(library, element);
    const xs = data.xs[mt];
    if (!xs) throw new Error(`${element} in ${library} has no photon MT ${mt}`);
    return { mt: Number(mt), energy: data.energy, xs, dataVersion: data.dataVersion };
  }

  // --- index ---------------------------------------------------------------

  /// The published index.json of one library and particle, parsed.
  async function loadIndex(library, particle) {
    const release = await ensureRelease(library);
    const target = `${origin}/${library}/${release}/${particle}/index.json`;
    const resp = await fetchImpl(target);
    if (resp.status === 404) throw new Error(`${library} publishes no ${particle} index`);
    if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText} fetching ${target}`);
    return resp.json();
  }

  return {
    series, photonSeries, loadIndex, ensureNuclide, ensureRelease, temperaturesOf,
    get rangesStripped() { return rangesStripped; },
  };
}
