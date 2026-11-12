const crypto = require('crypto');
const {PassThrough, Readable, Writable} = require('stream');
const {unzipBuffer, zipBuffer, ZipArchive, zipEntries, ZipLimitError} = require('../../../lib/utils/zip');

// A one-entry stored archive whose sizes and offset live only in zip64 records.
function zip64Archive(name, content) {
  const nameBytes = Buffer.from(name);
  const data = Buffer.from(content);
  const crc = require('zlib').crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(45, 4);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);
  const extra = Buffer.alloc(28);
  extra.writeUInt16LE(1, 0);
  extra.writeUInt16LE(24, 2);
  extra.writeBigUInt64LE(BigInt(data.length), 4);
  extra.writeBigUInt64LE(BigInt(data.length), 12);
  extra.writeBigUInt64LE(0n, 20);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(45, 4);
  central.writeUInt16LE(45, 6);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(0xffffffff, 20);
  central.writeUInt32LE(0xffffffff, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  central.writeUInt16LE(extra.length, 30);
  central.writeUInt32LE(0xffffffff, 42);
  const body = Buffer.concat([local, nameBytes, data]);
  const directory = Buffer.concat([central, nameBytes, extra]);
  const record = Buffer.alloc(56);
  record.writeUInt32LE(0x06064b50, 0);
  record.writeBigUInt64LE(44n, 4);
  record.writeUInt16LE(45, 12);
  record.writeUInt16LE(45, 14);
  record.writeBigUInt64LE(1n, 24);
  record.writeBigUInt64LE(1n, 32);
  record.writeBigUInt64LE(BigInt(directory.length), 40);
  record.writeBigUInt64LE(BigInt(body.length), 48);
  const locator = Buffer.alloc(20);
  locator.writeUInt32LE(0x07064b50, 0);
  locator.writeBigUInt64LE(BigInt(body.length + directory.length), 8);
  locator.writeUInt32LE(1, 16);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0xffff, 8);
  end.writeUInt16LE(0xffff, 10);
  end.writeUInt32LE(0xffffffff, 12);
  end.writeUInt32LE(0xffffffff, 16);
  return Buffer.concat([body, directory, record, locator, end]);
}

async function readAll(input) {
  const out = {};
  for await (const entry of zipEntries(input)) {
    const chunks = [];
    for await (const chunk of entry) chunks.push(chunk);
    out[entry.path] = Buffer.concat(chunks).toString();
  }
  return out;
}

describe('zip', () => {
  it('reads entries whose sizes are in zip64 records', () => {
    const [entry] = unzipBuffer(zip64Archive('a.txt', 'hello'));
    expect(entry.name).to.equal('a.txt');
    expect(entry.size).to.equal(5);
    expect(Buffer.from(entry.read(10)).toString()).to.equal('hello');
  });

  it('rejects a zip64 marker without zip64 records instead of inflating unchecked', () => {
    const archive = zipBuffer({'a.txt': Buffer.alloc(1000000), 'b.txt': 'hi'});
    const at = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), archive.length - 1);
    const first = archive.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    expect(at).to.be.greaterThan(first);
    archive.writeUInt32LE(0xffffffff, first + 24);
    expect(() => unzipBuffer(archive)).to.throw('invalid zip data');
  });

  it('reads without a limit, or with an infinite one', () => {
    const [entry] = unzipBuffer(zipBuffer({a: 'hi'}));
    expect(Buffer.from(entry.read()).toString()).to.equal('hi');
    expect(Buffer.from(entry.read(Infinity)).toString()).to.equal('hi');
    expect(() => entry.read(1)).to.throw(ZipLimitError, 'size limit');
  });

  it('strips leading slashes from names in zipBuffer', () => {
    expect(unzipBuffer(zipBuffer({'/x/y.xml': '<a/>'})).map(e => e.name)).to.deep.equal(['x/y.xml']);
  });

  it('streams entries back out', async () => {
    const archive = zipBuffer({'a.txt': 'one', 'b.txt': 'two'});
    expect(await readAll(Readable.from([archive.subarray(0, 7), archive.subarray(7)]))).to.deep.equal({'a.txt': 'one', 'b.txt': 'two'});
  });

  it('rejects a stream truncated inside an entry instead of hanging', async () => {
    const archive = zipBuffer({'a.txt': crypto.randomBytes(200000), 'b.txt': 'hello'});
    const result = await Promise.race([
      readAll(Readable.from([archive.subarray(0, 100000)])).then(() => 'resolved', error => error.message),
      new Promise(resolve => setTimeout(() => resolve('hang'), 3000)),
    ]);
    expect(result).to.match(/invalid zip data/);
  });

  it('rejects a stream truncated between entries', async () => {
    const archive = zipBuffer({'a.txt': 'one', 'b.txt': 'two'});
    const second = archive.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]), 4);
    let message = 'resolved';
    await readAll(Readable.from([archive.subarray(0, second)])).catch(error => (message = error.message));
    expect(message).to.match(/unexpected end/);
  });

  it('rejects when the input errors mid-entry', async () => {
    const archive = zipBuffer({'a.txt': crypto.randomBytes(200000)});
    const input = new PassThrough();
    input.write(archive.subarray(0, 50000));
    setTimeout(() => input.destroy(new Error('socket closed')), 20);
    let message = 'resolved';
    await readAll(input).catch(error => (message = error.message));
    expect(message).to.equal('socket closed');
  });

  it('holds a source error until an error listener is attached', async () => {
    const zip = new ZipArchive();
    zip.pipe(new PassThrough());
    const source = new PassThrough();
    zip.append(source, {name: 'a.txt'});
    source.destroy(new Error('boom'));
    await new Promise(resolve => setTimeout(resolve, 20));
    const error = await new Promise(resolve => zip.on('error', resolve));
    expect(error.message).to.equal('boom');
  });

  it('waits for a slow destination', async () => {
    let written = 0;
    let maxQueued = 0;
    const sink = new Writable({
      highWaterMark: 1024,
      write(chunk, encoding, callback) {
        written += chunk.length;
        maxQueued = Math.max(maxQueued, this.writableLength);
        setImmediate(callback);
      },
    });
    const zip = new ZipArchive({zlib: {level: 0}});
    zip.pipe(sink);
    const source = Readable.from(Array.from({length: 200}, () => crypto.randomBytes(16384)));
    zip.append(source, {name: 'big.bin'});
    zip.finalize();
    await new Promise(resolve => sink.on('finish', resolve));
    expect(written).to.be.greaterThan(200 * 16384);
    expect(maxQueued).to.be.lessThan(1024 * 1024);
  });
});
