// Reads a GeoJSON FeatureCollection written by build-vector-section.js's
// incremental writer without ever materializing the whole file as one JS
// string - fs.readFileSync(file,'utf8') on a dense tile's objects.geojson
// can exceed V8's ~536M-character string limit and throw ERR_STRING_TOO_LONG,
// exactly the failure the streaming writer was built to avoid on the write
// side. This mirrors that fix for reads: stream the file in chunks and
// split out each top-level feature (and the small properties object) by
// tracking brace/bracket depth and string-escaping state, so no single
// string ever grows past one feature's size.
const fs = require('fs');

function readLargeFeatureCollection(filePath) {
  const fd = fs.openSync(filePath, 'r');
  const CHUNK = 8 * 1024 * 1024;
  const buf = Buffer.alloc(CHUNK);
  let pending = '';
  let done = false;
  function nextChunk() {
    if (done) return null;
    const bytesRead = fs.readSync(fd, buf, 0, CHUNK, null);
    if (bytesRead === 0) { done = true; return null; }
    return buf.toString('utf8', 0, bytesRead);
  }
  function fill() {
    const chunk = nextChunk();
    if (chunk === null) return false;
    pending += chunk;
    return true;
  }
  // Advance past a fixed literal, refilling the buffer as needed. The
  // literal is always short (structural JSON punctuation), so this never
  // needs to hold more than a small multiple of CHUNK in `pending`.
  function expectLiteral(literal) {
    while (pending.length < literal.length) if (!fill()) throw new Error(`Unexpected end of file expecting "${literal}"`);
    if (!pending.startsWith(literal)) throw new Error(`Malformed feature collection: expected "${literal}" at "${pending.slice(0, 40)}"`);
    pending = pending.slice(literal.length);
  }
  // Reads one complete JSON value starting at the current position of
  // `pending` (a string starting with '{' or '['), tracking brace/bracket
  // depth and string-escape state so nested structures and strings
  // containing punctuation don't confuse the boundary detection. Returns
  // the raw JSON text of just that value - safely small for one feature,
  // regardless of how many other features are in the file.
  function readOneValue() {
    let depth = 0, inString = false, escapeNext = false, start = 0, i = 0, started = false;
    for (;;) {
      while (i < pending.length) {
        const c = pending[i];
        if (inString) {
          if (escapeNext) escapeNext = false;
          else if (c === '\\') escapeNext = true;
          else if (c === '"') inString = false;
        } else if (c === '"') inString = true;
        else if (c === '{' || c === '[') { depth++; started = true; }
        else if (c === '}' || c === ']') {
          depth--;
          if (started && depth === 0) {
            const value = pending.slice(start, i + 1);
            pending = pending.slice(i + 1);
            return value;
          }
        }
        i++;
      }
      if (!fill()) throw new Error('Unexpected end of file while reading a JSON value');
    }
  }
  expectLiteral('{"type":"FeatureCollection","properties":');
  const properties = JSON.parse(readOneValue());
  expectLiteral(',"features":[');
  const features = [];
  for (;;) {
    while (pending.length === 0) if (!fill()) throw new Error('Unexpected end of file in features array');
    if (pending[0] === ']') { pending = pending.slice(1); break; }
    if (pending[0] === ',') { pending = pending.slice(1); continue; }
    features.push(JSON.parse(readOneValue()));
  }
  fs.closeSync(fd);
  return { type: 'FeatureCollection', properties, features };
}

module.exports = { readLargeFeatureCollection };
