const fs = require('fs');
const {EventEmitter} = require('events');
const {PassThrough} = require('stream');
const {Inflate, Zip, ZipDeflate, Unzip, UnzipInflate, zipSync} = require('fflate');

const toU8 = chunk => {
  if (chunk instanceof Uint8Array) return chunk;
  if (typeof chunk === 'string') return Buffer.from(chunk, 'utf8');
  if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
  return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
};

const entryName = name => name.replace(/^\/+/, '');

let zlib = null;
try {
  zlib = process.browser ? null : require('zlib');
} catch (error) {
  zlib = null;
}

let crcTable;
function crc32(data, crc = 0) {
  if (zlib && zlib.crc32) return zlib.crc32(data, crc);
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let c = ~crc;
  for (let i = 0; i < data.length; i++) c = crcTable[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

// A zip entry compressed by Node's native zlib; fflate's own deflate is pure JS and much slower.
class NativeDeflateFile {
  constructor(filename, level) {
    this.filename = filename;
    this.compression = 8;
    this.size = 0;
    this.crc = 0;
    this.pending = [];
    this.pendingLength = 0;
    this.deflate = zlib.createDeflateRaw({level});
    this.deflate.on('data', chunk => this.ondata(null, new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength), false));
    this.done = new Promise((resolve, reject) => {
      this.deflate.on('end', () => {
        this.ondata(null, new Uint8Array(0), true);
        resolve();
      });
      this.deflate.on('error', reject);
    });
    // the error reaches the archive through push(); this only prevents an unhandled rejection
    this.done.catch(() => {});
  }

  // Small chunks are batched: each write to a native zlib stream costs a thread-pool round trip.
  async push(chunk, final) {
    if (chunk.length) {
      this.size += chunk.length;
      this.crc = crc32(chunk, this.crc);
      this.pending.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
      this.pendingLength += chunk.length;
    }
    if (this.pendingLength >= 65536 || (final && this.pendingLength)) {
      const batch = this.pending.length === 1 ? this.pending[0] : Buffer.concat(this.pending, this.pendingLength);
      this.pending = [];
      this.pendingLength = 0;
      if (!this.deflate.write(batch)) await Promise.race([writable(this.deflate), this.done]);
    }
    if (final) {
      this.deflate.end();
      await this.done;
    }
  }
}

// Resolves when a writable can take more data or has closed; leaves no listeners behind.
const writable = stream =>
  new Promise(resolve => {
    const done = () => {
      stream.off('drain', done);
      stream.off('close', done);
      resolve();
    };
    stream.on('drain', done);
    stream.on('close', done);
  });

const levelOf = options => {
  const level = options && options.zlib && options.zlib.level;
  return Number.isInteger(level) ? level : 6;
};

class ZipLimitError extends Error {
  constructor() {
    super('zip entry exceeds the uncompressed size limit');
  }
}

const invalid = () => new Error('invalid zip data');

const decodeName = (bytes, utf8) => (utf8 ? new TextDecoder('utf-8') : new TextDecoder('latin1')).decode(bytes);

const MAX32 = 0xffffffff;

function uint64(view, at) {
  const high = view.getUint32(at + 4, true);
  if (high > 0x1fffff) throw invalid();
  return high * 0x100000000 + view.getUint32(at, true);
}

// Entry count and central directory offset; zip64 archives keep them in a separate record.
function directoryLocation(view, bytes, end) {
  const count = view.getUint16(end + 10, true);
  const offset = view.getUint32(end + 16, true);
  if (count !== 0xffff && offset !== MAX32) return {count, offset};
  const locator = end - 20;
  if (locator < 0 || view.getUint32(locator, true) !== 0x07064b50) throw invalid();
  const record = uint64(view, locator + 8);
  if (record + 56 > bytes.length || view.getUint32(record, true) !== 0x06064b50) throw invalid();
  return {count: uint64(view, record + 32), offset: uint64(view, record + 48)};
}

// Replaces 0xffffffff sizes and offsets with their 64-bit values from the zip64 extra field.
function zip64Fields(view, start, length, entry) {
  for (let q = start; q + 4 <= start + length; ) {
    const id = view.getUint16(q, true);
    const size = view.getUint16(q + 2, true);
    if (id === 1) {
      let r = q + 4;
      const next = () => {
        if (r + 8 > q + 4 + size) throw invalid();
        const value = uint64(view, r);
        r += 8;
        return value;
      };
      if (entry.size === MAX32) entry.size = next();
      if (entry.compressedSize === MAX32) entry.compressedSize = next();
      if (entry.local === MAX32) entry.local = next();
      return;
    }
    q += 4 + size;
  }
  throw invalid();
}

// Name, method, sizes and data of every entry, from the central directory.
function centralDirectory(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw invalid();
  const {count, offset} = directoryLocation(view, bytes, end);
  let p = offset;
  const entries = [];
  for (let n = 0; n < count; n++) {
    if (p + 46 > bytes.length || view.getUint32(p, true) !== 0x02014b50) throw invalid();
    const flags = view.getUint16(p + 8, true);
    const nameLength = view.getUint16(p + 28, true);
    const extraLength = view.getUint16(p + 30, true);
    const commentLength = view.getUint16(p + 32, true);
    if (p + 46 + nameLength + extraLength > bytes.length) throw invalid();
    const entry = {
      name: decodeName(bytes.subarray(p + 46, p + 46 + nameLength), flags & 0x800),
      method: view.getUint16(p + 10, true),
      compressedSize: view.getUint32(p + 20, true),
      size: view.getUint32(p + 24, true),
      local: view.getUint32(p + 42, true),
    };
    if (entry.compressedSize === MAX32 || entry.size === MAX32 || entry.local === MAX32) {
      zip64Fields(view, p + 46 + nameLength, extraLength, entry);
    }
    entries.push(entry);
    p += 46 + nameLength + extraLength + commentLength;
  }
  return entries.map(entry => {
    const h = entry.local;
    if (h + 30 > bytes.length || view.getUint32(h, true) !== 0x04034b50) throw invalid();
    const start = h + 30 + view.getUint16(h + 26, true) + view.getUint16(h + 28, true);
    if (start + entry.compressedSize > bytes.length) throw invalid();
    return {...entry, data: bytes.subarray(start, start + entry.compressedSize)};
  });
}

function inflateLimited(data, limit) {
  if (zlib) {
    const {kMaxLength} = require('buffer');
    const options = Number.isFinite(limit) && limit < kMaxLength ? {maxOutputLength: Math.max(1, limit + 1)} : {};
    let out;
    try {
      out = zlib.inflateRawSync(data, options);
    } catch (error) {
      if (error.code === 'ERR_BUFFER_TOO_LARGE') throw new ZipLimitError();
      throw error;
    }
    if (out.length > limit) throw new ZipLimitError();
    return out;
  }
  const chunks = [];
  let total = 0;
  let ended = false;
  const inflate = new Inflate((chunk, final) => {
    total += chunk.length;
    if (total > limit) throw new ZipLimitError();
    chunks.push(chunk);
    if (final) ended = true;
  });
  for (let i = 0; i < data.length; i += 65536) inflate.push(data.subarray(i, i + 65536), i + 65536 >= data.length);
  if (!data.length) inflate.push(data, true);
  if (!ended) throw new Error('invalid zip data: truncated entry');
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

// Whole-buffer read. Entries inflate lazily, one at a time, so a parse that bails early never inflates the rest.
// `size` is the size the archive declares; read(limit) stops inflating once the real output passes `limit` bytes.
function unzipBuffer(buffer) {
  return centralDirectory(toU8(buffer)).map(entry => ({
    name: entry.name,
    size: entry.size,
    read: (limit = Infinity) => {
      if (entry.method === 0) {
        if (entry.data.length > limit) throw new ZipLimitError();
        return entry.data;
      }
      if (entry.method !== 8) throw new Error(`unsupported zip compression method ${entry.method} for ${entry.name}`);
      return inflateLimited(entry.data, limit);
    },
  }));
}

// Whole-buffer write.
function zipBuffer(files, options) {
  const level = levelOf(options);
  const entries = Object.entries(files).map(([name, data]) => [entryName(name), toU8(data)]);
  if (!zlib) return Buffer.from(zipSync(Object.fromEntries(entries), {level}));
  const chunks = [];
  const zip = new Zip((error, chunk) => {
    if (error) throw error;
    chunks.push(chunk);
  });
  for (const [filename, bytes] of entries) {
    const file = {filename, compression: 8, size: bytes.length, crc: crc32(bytes)};
    zip.add(file);
    file.ondata(null, zlib.deflateRawSync(bytes, {level}), true);
  }
  zip.end();
  return Buffer.concat(chunks);
}

// Streaming writer with the slice of the archiver API that exceljs uses: append, file, pipe, finalize.
class ZipArchive extends EventEmitter {
  constructor(options) {
    super();
    this.level = levelOf(options);
    this.queue = [];
    this.running = false;
    this.finalizing = false;
    this.outputDrain = null;
    this.zip = new Zip((error, chunk, final) => {
      if (error) {
        this._fail(error);
        return;
      }
      if (chunk.length && !this.output.write(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength))) {
        this.outputDrain = this.outputDrain || writable(this.output);
      }
      if (final) this.output.end();
    });
  }

  pipe(destination) {
    this.output = destination;
    return destination;
  }

  append(source, {name, base64}) {
    if (base64) source = Buffer.from(source, 'base64');
    else if (typeof source === 'object' && !(source instanceof Uint8Array) && !(source instanceof ArrayBuffer)) source = readChunks(source);
    if (this.failure) return this;
    this.queue.push({source, name: entryName(name)});
    this._pump();
    return this;
  }

  file(filename, {name}) {
    return this.append(fs.createReadStream(filename), {name});
  }

  finalize() {
    this.finalizing = true;
    this._pump();
  }

  // Errors are kept until someone listens: the workbook writer only subscribes when it commits.
  _fail(error) {
    if (this.failure) return;
    this.failure = error;
    this.queue.length = 0;
    if (this.listenerCount('error')) {
      this.emit('error', error);
      return;
    }
    const onListener = event => {
      if (event !== 'error') return;
      this.off('newListener', onListener);
      process.nextTick(() => this.emit('error', error));
    };
    this.on('newListener', onListener);
  }

  async _waitForOutput() {
    if (!this.outputDrain) return;
    const drain = this.outputDrain;
    await drain;
    if (this.outputDrain === drain) this.outputDrain = null;
  }

  async _pump() {
    if (this.running || this.failure) return;
    this.running = true;
    try {
      while (this.queue.length) {
        const {source, name} = this.queue.shift();
        const file = zlib ? new NativeDeflateFile(name, this.level) : new ZipDeflate(name, {level: this.level});
        this.zip.add(file);
        if (typeof source === 'string' || source instanceof Uint8Array || source instanceof ArrayBuffer) {
          await file.push(toU8(source), true);
        } else {
          for await (const chunk of source) {
            await file.push(toU8(chunk));
            await this._waitForOutput();
          }
          await file.push(new Uint8Array(0), true);
        }
        await this._waitForOutput();
      }
      if (this.finalizing && !this.ended) {
        this.ended = true;
        this.zip.end();
      }
    } catch (error) {
      this._fail(error);
    } finally {
      this.running = false;
    }
    if (!this.failure && (this.queue.length || (this.finalizing && !this.ended))) this._pump();
  }
}

// exceljs' StreamBuf is not a real Readable; piping it into a PassThrough gives a proper one.
function readChunks(stream) {
  const StreamBuf = require('./stream-buf');
  if (!(stream instanceof StreamBuf)) return stream;
  const out = new PassThrough();
  stream.pipe(out);
  return out;
}

// Resolves once an entry has been read to its end; rejects if it errored (corrupt data, size limit).
function drainEntry(entry) {
  return new Promise((resolve, reject) => {
    if (entry.readableEnded) {
      resolve();
      return;
    }
    if (entry.errored) {
      reject(entry.errored);
      return;
    }
    if (entry.destroyed) {
      resolve();
      return;
    }
    entry.once('end', resolve);
    entry.once('close', resolve);
    entry.once('error', reject);
    entry.resume();
  });
}

const ZIP_MAGIC = [0x504b0304, 0x504b0506];
const TAIL_LENGTH = 65557;

function keepTail(tail, bytes) {
  if (bytes.length >= TAIL_LENGTH) return bytes.slice(bytes.length - TAIL_LENGTH);
  const out = new Uint8Array(Math.min(TAIL_LENGTH, tail.length + bytes.length));
  const kept = out.length - bytes.length;
  out.set(tail.subarray(tail.length - kept), 0);
  out.set(bytes, kept);
  return out;
}

const hasEndRecord = tail => {
  const view = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  for (let i = tail.length - 22; i >= 0; i--) if (view.getUint32(i, true) === 0x06054b50) return true;
  return false;
};

// Streaming reader: yields one PassThrough per archive entry, in archive order, with `path` and `autodrain()`.
async function* zipEntries(input) {
  const entries = [];
  const open = new Set();
  const blocked = new Set();
  let finished = false;
  let failure;
  let wake;
  const notify = () => wake && wake();
  const fail = error => {
    if (!failure) failure = error;
    for (const entry of open) entry.destroy(failure);
    open.clear();
    notify();
  };

  const unzip = new Unzip(file => {
    const entry = new PassThrough();
    entry.path = file.name;
    entry.autodrain = () => drainEntry(entry);
    // without a listener a corrupt entry would surface as an uncaught exception
    entry.on('error', () => {});
    open.add(entry);
    file.ondata = (error, chunk, final) => {
      if (error) {
        fail(error);
        return;
      }
      if (chunk.length && !entry.write(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength))) blocked.add(entry);
      if (final) {
        open.delete(entry);
        entry.end();
      }
    };
    file.start();
    entries.push(entry);
    notify();
  });
  unzip.register(UnzipInflate);

  let stopped = false;
  (async () => {
    let head = new Uint8Array(0);
    let tail = new Uint8Array(0);
    try {
      for await (const chunk of input) {
        if (stopped) break;
        const bytes = toU8(chunk);
        if (head && head.length + bytes.length >= 4) {
          const first = new Uint8Array([...head, ...bytes.subarray(0, 4 - head.length)]);
          const magic = new DataView(first.buffer).getUint32(0);
          if (!ZIP_MAGIC.includes(magic)) throw new Error('invalid zip data: not an xlsx (zip) file');
          head = null;
        } else if (head) {
          head = new Uint8Array([...head, ...bytes]);
        }
        tail = keepTail(tail, bytes);
        unzip.push(bytes);
        for (const entry of blocked) {
          blocked.delete(entry);
          if (entry.writableNeedDrain) await writable(entry);
        }
      }
      if (!stopped) {
        if (head) throw new Error('invalid zip data: not an xlsx (zip) file');
        unzip.push(new Uint8Array(0), true);
        if (open.size || !hasEndRecord(tail)) throw new Error('invalid zip data: unexpected end of file');
      }
    } catch (error) {
      fail(error);
    }
    finished = true;
    notify();
  })();

  try {
    for (;;) {
      if (failure) throw failure;
      if (entries.length) {
        yield entries.shift();
        continue;
      }
      if (finished) return;
      await new Promise(resolve => (wake = resolve));
      wake = null;
    }
  } finally {
    // The consumer stopped early (row limit, error, break): stop reading and decompressing the rest.
    if (!finished) {
      stopped = true;
      for (const entry of entries) entry.destroy();
      for (const entry of open) entry.destroy();
      if (typeof input.destroy === 'function') input.destroy();
    }
  }
}

module.exports = {unzipBuffer, zipBuffer, ZipArchive, zipEntries, drainEntry, ZipLimitError};
