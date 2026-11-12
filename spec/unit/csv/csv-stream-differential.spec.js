// Differential test: the built-in CSV streams must behave exactly like fast-csv 4 (the old dependency).
const {PassThrough} = require('stream');
const fastCsv = require('fast-csv');
const csvStream = require('../../../lib/csv/csv-stream');

let seed = 12345;
const random = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};
const pick = list => list[Math.floor(random() * list.length)];

function randomCsv(delimiter, quote) {
  const atoms = ['a', 'bc', ' ', '  x ', '1', '-2.5', '', delimiter, '\n', '\r\n', '\r', quote || '"', `${quote || '"'}${quote || '"'}`, '\\', '#', 'é', '\t', 'z z'];
  let text = random() < 0.1 ? '﻿' : '';
  const length = Math.floor(random() * 40);
  for (let i = 0; i < length; i++) {
    if (quote && random() < 0.15) text += `${quote}${pick(atoms)}${pick(atoms)}${quote}`;
    else text += pick(atoms);
  }
  return text;
}

function collect(stream, input, chunks) {
  return new Promise(resolve => {
    const rows = [];
    const events = [];
    const result = () => ({rows: rows.some(row => Buffer.isBuffer(row)) ? Buffer.concat(rows).toString() : rows, events});
    stream.on('data', row => rows.push(row));
    stream.on('headers', headers => events.push(['headers', headers]));
    stream.on('data-invalid', (row, count, reason) => events.push(['invalid', row, count, reason]));
    stream.on('error', error => resolve({...result(), error: error.message}));
    stream.on('end', () => resolve(result()));
    const source = new PassThrough();
    source.pipe(stream);
    const bytes = Buffer.from(input, 'utf8');
    let offset = 0;
    for (const size of chunks) {
      if (offset >= bytes.length) break;
      source.write(bytes.subarray(offset, offset + size));
      offset += size;
    }
    if (offset < bytes.length) source.write(bytes.subarray(offset));
    source.end();
  });
}

describe('csv-stream matches fast-csv', () => {
  it('parses 3000 random inputs identically', async function() {
    this.timeout(120000);
    const mismatches = [];
    for (let n = 0; n < 3000; n++) {
      const delimiter = pick([',', ';', '\t', '|']);
      const quote = pick(['"', "'", null]);
      const options = {delimiter, quote};
      if (random() < 0.3) options.escape = pick(['\\', '"']);
      if (random() < 0.2) options.trim = true;
      else if (random() < 0.15) options.ltrim = true;
      else if (random() < 0.15) options.rtrim = true;
      if (random() < 0.25) options.ignoreEmpty = true;
      if (random() < 0.2) options.comment = '#';
      if (random() < 0.15) options.maxRows = 1 + Math.floor(random() * 3);
      if (random() < 0.15) options.skipRows = Math.floor(random() * 3);
      if (random() < 0.15) options.skipLines = Math.floor(random() * 3);
      const headerMode = random();
      if (headerMode < 0.15) options.headers = true;
      else if (headerMode < 0.25) options.headers = pick([['h1', 'h2'], ['h1', undefined, 'h3'], ['a', 'b', 'c', 'd'], ['x', 'x']]);
      else if (headerMode < 0.3) options.headers = row => row.map((h, i) => `${h}_${i}`);
      if (options.headers && random() < 0.3) options.renameHeaders = true;
      if (options.headers && random() < 0.3) options.discardUnmappedColumns = true;
      if (options.headers && random() < 0.3) options.strictColumnHandling = true;
      if (random() < 0.1) options.objectMode = false;
      const input = randomCsv(delimiter, quote);
      const chunks = Array.from({length: 8}, () => 1 + Math.floor(random() * 7));
      const run = factory => {
        try {
          return collect(factory(options), input, chunks);
        } catch (error) {
          return {constructError: error.message};
        }
      };
      const expected = await run(fastCsv.parse);
      const actual = await run(csvStream.parse);
      if (JSON.stringify(expected) !== JSON.stringify(actual)) mismatches.push({input, options, chunks, expected, actual});
    }
    expect(mismatches.slice(0, 3)).to.deep.equal([]);
  });

  it('formats 3000 random row sets identically', async function() {
    this.timeout(120000);
    const values = ['a', '', null, undefined, 1, -2.5, true, 'x,y', 'say "hi"', 'l1\nl2', 'cr\r', 'pipe|', '\0nul', "it's", ' sp '];
    const mismatches = [];
    for (let n = 0; n < 3000; n++) {
      const options = {};
      if (random() < 0.3) options.delimiter = pick([';', '\t', '|']);
      if (random() < 0.2) options.rowDelimiter = pick(['\r\n', '\n\n']);
      if (random() < 0.2) options.quote = pick(["'", true, false]);
      if (random() < 0.15) options.escape = '\\';
      if (random() < 0.2) options.quoteColumns = pick([true, [true, false, true]]);
      if (random() < 0.2) options.includeEndRowDelimiter = true;
      if (random() < 0.2) options.writeBOM = true;
      if (random() < 0.15) options.headers = ['h1', 'h,2', 'h3'];
      if (options.headers && random() < 0.5) options.quoteHeaders = true;
      if (options.headers && random() < 0.3) options.alwaysWriteHeaders = true;
      const rows = Array.from({length: Math.floor(random() * 5)}, () => Array.from({length: Math.floor(random() * 4)}, () => pick(values)));
      const run = async stream => {
        const out = [];
        stream.on('data', chunk => out.push(chunk.toString()));
        const done = new Promise(resolve => stream.on('end', resolve));
        rows.forEach(row => stream.write(row));
        stream.end();
        await done;
        return out.join('');
      };
      const expected = await run(fastCsv.format(options));
      const actual = await run(csvStream.format(options));
      if (expected !== actual) mismatches.push({options, rows, expected, actual});
    }
    expect(mismatches.slice(0, 3)).to.deep.equal([]);
  });
});
