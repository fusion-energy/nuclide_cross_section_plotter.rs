// Fetching one temperature of a nuclide's cross sections out of Arrow files
// that hold every temperature.
//
// The published `reactions.arrow` is written one Arrow record batch per
// (MT, temperature) and `energy.arrow` one batch per temperature, so every
// cross section and every union energy grid is already a contiguous byte range
// in its object. Each nuclide's `version.json` names those ranges
// (`reaction_ranges` keyed by MT then temperature label, `energy_ranges` keyed
// by temperature label, both as `[offset, length, sha256]`). This page draws one
// reaction at one temperature, so it asks for the schema plus the batches it
// needs as HTTP range requests and splices them into an Arrow IPC stream the
// wasm reader accepts. Fe56 at 294 K is about 340 kB for the total cross
// section against a 39 MB file.
//
// Nothing here touches the DOM or the network, so the arithmetic can be run
// under Node against the fixture files as well as in the worker.

/// The 8-byte end-of-stream marker: a continuation marker followed by a zero
/// metadata length. Without it a decoder treats the stream as truncated rather
/// than merely finished.
export const EOS = new Uint8Array([0xff, 0xff, 0xff, 0xff, 0, 0, 0, 0]);

/// Merge two wanted ranges into one request when the gap between them is under
/// this. Batches for one temperature sit far apart in the file (the writer
/// groups by MT, then temperature), so most plans here are one request per
/// wanted MT; the threshold matters when several MTs are fetched together.
export const COALESCE_GAP = 16 * 1024;

/// One index entry, `[offset, length, sha256]` (the sha256 of exactly those
/// bytes), as `{off, len, sha256}`.
function range(entry) {
  if (!Array.isArray(entry) || entry.length !== 3) return null;
  const [off, len, sha256] = entry;
  if (!Number.isInteger(off) || !Number.isInteger(len) || typeof sha256 !== 'string') return null;
  return { off, len, sha256 };
}

/// The byte-range index of `reactions.arrow` from a parsed `version.json`.
///
/// Returns `{schema, mts: Map<mt, Map<temperature, {off, len}>>}`, or `null`
/// when the file carries no usable index. An index in the shape from before
/// the temperature split (`mt -> [off, len]`) is treated as no index at all,
/// the way core's reader does, rather than read as a half-index.
export function reactionRanges(version) {
  const index = version && version.reaction_ranges;
  if (!index || !index.mts) return null;
  const schema = range(index.schema);
  if (!schema) return null;
  const mts = new Map();
  for (const [mt, byTemperature] of Object.entries(index.mts)) {
    if (!byTemperature || typeof byTemperature !== 'object' || Array.isArray(byTemperature)) return null;
    const temperatures = new Map();
    for (const [temperature, pair] of Object.entries(byTemperature)) {
      const r = range(pair);
      if (!r) return null;
      temperatures.set(temperature, r);
    }
    if (temperatures.size) mts.set(Number(mt), temperatures);
  }
  if (!mts.size) return null;
  return { schema, mts };
}

/// The byte-range index of `energy.arrow`: `{schema, temperatures: Map}`, or
/// `null` when absent.
export function energyRanges(version) {
  const index = version && version.energy_ranges;
  if (!index || !index.temperatures) return null;
  const schema = range(index.schema);
  if (!schema) return null;
  const temperatures = new Map();
  for (const [temperature, pair] of Object.entries(index.temperatures)) {
    const r = range(pair);
    if (!r) return null;
    temperatures.set(temperature, r);
  }
  if (!temperatures.size) return null;
  return { schema, temperatures };
}

/// The MTs a nuclide publishes at `temperature`, from its reaction index.
export function publishedMts(ranges, temperature) {
  const mts = [];
  for (const [mt, byTemperature] of ranges.mts) {
    if (byTemperature.has(temperature)) mts.push(mt);
  }
  return mts.sort((a, b) => a - b);
}

/// Merge offset-sorted parts into the spans to actually request.
export function coalesce(parts, gap = COALESCE_GAP) {
  const spans = [];
  for (const { off, len } of [...parts].sort((a, b) => a.off - b.off)) {
    const last = spans[spans.length - 1];
    if (last && off - (last.off + last.len) <= gap) {
      last.len = Math.max(last.off + last.len, off + len) - last.off;
    } else {
      spans.push({ off, len });
    }
  }
  return spans;
}

/// What to request for one section: the schema first, then every wanted batch
/// in file order, and the coalesced spans that cover them.
///
/// `batches` are the `{off, len}` ranges of the record batches wanted. The
/// schema leads on offset alone but is placed first explicitly: a stream whose
/// schema is not first does not decode.
export function planFetch(schema, batches, gap = COALESCE_GAP) {
  const seen = new Set();
  const parts = [];
  for (const b of batches) {
    const key = `${b.off}+${b.len}`;
    if (seen.has(key)) continue;
    seen.add(key);
    parts.push(b);
  }
  parts.sort((a, b) => a.off - b.off);
  const all = [schema, ...parts];
  return { parts: all, spans: coalesce(all, gap) };
}

/// Splice fetched spans into a readable Arrow IPC stream: schema, batches, EOS.
///
/// `bodies[i]` is the bytes of `spans[i]`. Each part is cut back out of the
/// span that covers it, so coalescing never hands the decoder a batch that was
/// not asked for. This is a stream, not a file: no `ARROW1` magic and no
/// footer, which is the shape core's reader accepts alongside whole files.
export function spliceStream(parts, spans, bodies) {
  const total = parts.reduce((n, p) => n + p.len, 0) + EOS.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    const i = spans.findIndex((s) => part.off >= s.off && part.off + part.len <= s.off + s.len);
    if (i < 0) throw new Error(`no fetched span covers ${part.off}+${part.len}`);
    const body = bodies[i];
    if (!body) throw new Error(`span ${spans[i].off}+${spans[i].len} was not fetched`);
    if (body.length !== spans[i].len) {
      // A short span produces a stream that decodes into the wrong numbers,
      // because the framing still walks, so it is refused here.
      throw new Error(`span ${spans[i].off}+${spans[i].len} came back ${body.length} bytes`);
    }
    const from = part.off - spans[i].off;
    out.set(body.subarray(from, from + part.len), at);
    at += part.len;
  }
  out.set(EOS, at);
  return out;
}

/// The `Range` header for a span (inclusive end).
export const rangeHeader = ({ off, len }) => `bytes=${off}-${off + len - 1}`;
