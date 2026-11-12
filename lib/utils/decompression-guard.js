'use strict';

const {ZipLimitError, drainEntry} = require('./zip');

// Decompression bombs (adapted from exceljs-hardened, MIT).
// Workbook#load() decompresses entries into memory, so a few hundred KB of crafted input could expand
// to gigabytes. Each entry's size as declared in the zip's central directory is checked before it is
// inflated, and the real output is capped while inflating (declared sizes can lie).
// The defaults sit at what load() can handle anyway (V8 cannot hold a string much over 512 MiB), so
// they only reject files that would have failed regardless. Pass Infinity to disable a limit.

const DEFAULT_MAX_ENTRY_UNCOMPRESSED_SIZE = 512 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_UNCOMPRESSED_SIZE = 2 * 1024 * 1024 * 1024;

function createDecompressionBudget(options) {
  return {
    bytes: 0,
    actualBytes: 0,
    maxEntry: (options && options.maxEntryUncompressedSize) || DEFAULT_MAX_ENTRY_UNCOMPRESSED_SIZE,
    maxTotal: (options && options.maxTotalUncompressedSize) || DEFAULT_MAX_TOTAL_UNCOMPRESSED_SIZE,
  };
}

function assertSafeZipEntry(entry, entryName, budget) {
  const declaredSize = typeof entry.size === 'number' ? entry.size : undefined;
  if (declaredSize === undefined) {
    return;
  }

  if (declaredSize > budget.maxEntry) {
    throw new Error(
      `Refusing to decompress "${entryName}": declared uncompressed size (${declaredSize} bytes) ` +
        `exceeds the per-entry limit (${budget.maxEntry} bytes). This may be a decompression bomb. ` +
        'Raise options.maxEntryUncompressedSize to override.'
    );
  }

  budget.bytes += declaredSize;
  if (budget.bytes > budget.maxTotal) {
    throw new Error(
      `Refusing to decompress "${entryName}": cumulative declared uncompressed size ` +
        `(${budget.bytes} bytes) exceeds the archive-wide limit (${budget.maxTotal} bytes). ` +
        'This may be a decompression bomb. Raise options.maxTotalUncompressedSize to override.'
    );
  }
}

// The declared size is attacker-controlled, so entry.read(limit) stops inflating as soon as the real
// output passes the remaining budget. Resolves with a Buffer (type 'nodebuffer') or a utf-8 string.
function readZipEntry(entry, type, entryName, budget) {
  const remaining = budget.maxTotal - budget.actualBytes;
  let data;
  try {
    data = entry.read(Math.min(budget.maxEntry, remaining));
  } catch (error) {
    if (!(error instanceof ZipLimitError)) throw error;
    if (budget.maxEntry <= remaining) {
      throw new Error(
        `Refusing to decompress "${entryName}": actual uncompressed size exceeds the per-entry ` +
          `limit (${budget.maxEntry} bytes) although the archive declared ${entry.size} bytes. ` +
          'This may be a decompression bomb. Raise options.maxEntryUncompressedSize to override.'
      );
    }
    throw new Error(
      `Refusing to decompress "${entryName}": cumulative actual uncompressed size exceeds the ` +
        `archive-wide limit (${budget.maxTotal} bytes). This may be a decompression bomb. ` +
        'Raise options.maxTotalUncompressedSize to override.'
    );
  }
  budget.actualBytes += data.length;
  const buffer = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return Promise.resolve(type === 'string' ? buffer.toString('utf8') : buffer);
}

// [exceljs-hardened] VULN-07: opt-in limits for the streaming reader. There is NO default limit
// here on purpose: the streaming reader exists to process files of several GB, so a default would
// break its main use case. Returns `undefined` (nothing is wrapped, behaviour unchanged) unless
// options.maxEntryUncompressedSize or options.maxTotalUncompressedSize is set.
// Otherwise returns limit(entry, abort) -> a stream carrying the entry's data (and `path`) that
// errors out as soon as the REAL number of bytes produced exceeds a limit.
function createStreamLimiter(options) {
  const maxEntry = options && options.maxEntryUncompressedSize;
  const maxTotal = options && options.maxTotalUncompressedSize;
  if (!maxEntry && !maxTotal) {
    return undefined;
  }
  // lazy: keeps this module free of stream imports for the non-streaming code paths
  const {Transform} = require('stream');
  let total = 0;
  return function limit(entry, abort) {
    let entryBytes = 0;
    const counter = new Transform({
      transform(chunk, encoding, callback) {
        entryBytes += chunk.length;
        total += chunk.length;
        let message;
        if (maxEntry && entryBytes > maxEntry) {
          message =
            `exceeds the per-entry limit (${maxEntry} bytes). ` +
            'Raise options.maxEntryUncompressedSize to override.';
        } else if (maxTotal && total > maxTotal) {
          message =
            `makes the archive exceed the total limit (${maxTotal} bytes). ` +
            'Raise options.maxTotalUncompressedSize to override.';
        }
        if (message) {
          const error = new Error(
            `Refusing to read "${entry.path}": its actual uncompressed size ${message} ` +
              'This may be a decompression bomb.'
          );
          abort(error);
          callback(error);
        } else {
          callback(null, chunk);
        }
      },
    });
    counter.path = entry.path;
    counter.autodrain = () => drainEntry(counter);
    // the limit error reaches the caller through `abort`; this only prevents an unhandled 'error' event
    counter.on('error', () => {});
    entry.on('error', error => counter.destroy(error));
    entry.pipe(counter);
    return counter;
  };
}

module.exports = {
  createStreamLimiter,
  createDecompressionBudget,
  assertSafeZipEntry,
  readZipEntry,
  DEFAULT_MAX_ENTRY_UNCOMPRESSED_SIZE,
  DEFAULT_MAX_TOTAL_UNCOMPRESSED_SIZE,
};
