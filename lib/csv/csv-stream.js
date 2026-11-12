// CSV parse/format streams with the option names and behaviour of fast-csv 4, which exceljs used to depend on:
// `parserOptions` / `formatterOptions` passed by callers keep meaning the same thing.
const {Transform} = require('stream');
const {StringDecoder} = require('string_decoder');

const isRowDelimiter = token => token === '\r' || token === '\n' || token === '\r\n';
const escapeRegExp = text => text.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');

function parserOptionsOf(opts = {}) {
  const options = {
    delimiter: ',',
    ignoreEmpty: false,
    quote: '"',
    escape: null,
    comment: null,
    ltrim: false,
    rtrim: false,
    trim: false,
    encoding: 'utf8',
    maxRows: 0,
    skipLines: 0,
    skipRows: 0,
    objectMode: true,
    headers: null,
    renameHeaders: false,
    strictColumnHandling: false,
    discardUnmappedColumns: false,
    ...opts,
  };
  if (options.delimiter.length > 1) throw new Error('delimiter option must be one character long');
  options.escapeChar = options.escape !== null && options.escape !== undefined ? options.escape : options.quote;
  options.escapedDelimiter = escapeRegExp(options.delimiter);
  options.supportsComments = options.comment !== null && options.comment !== undefined;
  options.nextToken = new RegExp(`([^\\s]|\\r\\n|\\n|\\r|${options.escapedDelimiter})`);
  options.format = options.trim
    ? col => col.trim()
    : options.ltrim
    ? col => col.trimStart()
    : options.rtrim
    ? col => col.trimEnd()
    : col => col;
  return options;
}

// Parses as many complete rows as `text` holds; returns them with the unparsed remainder.
function parseText(text, hasMoreData, options) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const length = text.length;
  let cursor = 0;
  let lineStart = 0;
  const rows = [];

  const nextNonSpace = () => {
    const match = options.nextToken.exec(text.slice(cursor));
    if (!match) return null;
    const start = cursor + match.index;
    return {token: match[1], start, end: start + match[1].length};
  };
  const charAt = index => (index < length ? text[index] : null);

  function parseQuoted() {
    if (cursor >= length) return null;
    const original = cursor;
    let foundStart = false;
    let foundClose = false;
    const characters = [];
    while (!foundClose && cursor < length) {
      let token = text[cursor];
      const isQuote = token === options.quote;
      if (!foundStart && isQuote) {
        foundStart = true;
      } else if (foundStart) {
        if (token === options.escapeChar) {
          cursor += 1;
          const following = charAt(cursor);
          if (following !== null && (following === options.quote || following === options.escapeChar)) {
            characters.push(following);
            token = following;
          } else if (isQuote) {
            foundClose = true;
            continue;
          } else {
            characters.push(token);
            continue;
          }
        } else if (isQuote) {
          foundClose = true;
        } else {
          characters.push(token);
        }
      }
      cursor += 1;
    }
    if (!foundClose) {
      cursor = original;
      if (!hasMoreData) {
        throw new Error(
          `Parse Error: missing closing: '${options.quote || ''}' in line: at '${text.slice(cursor).replace(/[\r\n]/g, "\\n'")}'`
        );
      }
      return null;
    }
    const next = nextNonSpace();
    if (next) {
      if (!(next.token === options.delimiter || isRowDelimiter(next.token))) {
        const preview = text.substr(cursor, 10).replace(/[\r\n]/g, "\\n'");
        throw new Error(`Parse Error: expected: '${options.escapedDelimiter}' OR new line got: '${next.token}'. at '${preview}`);
      }
      cursor = next.start;
    } else if (!hasMoreData) {
      cursor = length;
    }
    return options.format(characters.join(''));
  }

  function parseNonQuoted() {
    if (cursor >= length) return null;
    const start = cursor;
    while (cursor < length) {
      const token = text[cursor];
      if (token === options.delimiter || token === '\r' || token === '\n') break;
      cursor += 1;
    }
    return options.format(text.slice(start, cursor));
  }

  function parseColumn() {
    const next = nextNonSpace();
    if (next && options.quote !== null && options.quote !== '' && next.token === options.quote) {
      cursor = next.start;
      return parseQuoted();
    }
    return parseNonQuoted();
  }

  // Returns the row's columns, or null when the row is incomplete and more data is needed.
  function parseRow() {
    const columns = [];
    let token = nextNonSpace();
    if (token && token.token === options.delimiter) columns.push('');
    while (token) {
      if (isRowDelimiter(token.token)) {
        cursor = token.end;
        if (cursor >= length && token.token === '\r' && hasMoreData) return null;
        return columns;
      }
      let skip = false;
      if (token.token === options.delimiter) {
        cursor = token.end;
        const next = charAt(cursor);
        if (next === null || isRowDelimiter(next) || next === options.delimiter) {
          columns.push('');
          skip = true;
        }
      }
      if (!skip) {
        const item = parseColumn();
        if (item === null) return null;
        columns.push(item);
      }
      token = nextNonSpace();
    }
    if (!hasMoreData) {
      cursor = length;
      return columns;
    }
    return null;
  }

  for (;;) {
    cursor = lineStart;
    if (options.supportsComments && charAt(cursor) === options.comment) {
      const match = /\r\n|\n|\r/.exec(text.slice(cursor));
      if (!match) {
        if (hasMoreData) break;
        lineStart = length;
        break;
      }
      lineStart = cursor + match.index + match[0].length;
      if (lineStart >= length) break;
      continue;
    }
    if (!nextNonSpace()) break;
    const row = parseRow();
    if (row === null) break;
    lineStart = cursor;
    if (options.ignoreEmpty && row.join('').replace(/\s+/g, '') === '') continue;
    rows.push(row);
  }
  return {rows, rest: text.slice(lineStart)};
}

// The `headers` family of options, as fast-csv's HeaderTransformer applies them. Returns
// {header: true} for a row consumed as headers, {row} for a row to emit, or {invalid, row}.
function headerMapper(options) {
  let headers = null;
  let headersLength = 0;
  let processedFirstRow = false;
  const transform = typeof options.headers === 'function' ? options.headers : null;
  const useFirstRow = options.headers === true;

  const setHeaders = list => {
    const named = list.filter(h => !!h);
    const duplicates = [...new Set(named.filter((h, i) => named.indexOf(h) !== i))];
    if (duplicates.length) throw new Error(`Duplicate headers found ${JSON.stringify(duplicates)}`);
    headers = list;
    headersLength = (headers && headers.length) || 0;
  };
  if (Array.isArray(options.headers)) setHeaders(options.headers);

  return {
    get headers() {
      return headers;
    },
    map(row) {
      if (!transform && options.renameHeaders && !processedFirstRow) {
        if (!headers) throw new Error('Error renaming headers: new headers must be provided in an array');
        processedFirstRow = true;
        return {header: true};
      }
      if (!headers && (transform || useFirstRow)) {
        setHeaders(transform ? transform(row) : row);
        return {header: true};
      }
      if (!headers) return {row};
      if (!options.discardUnmappedColumns && row.length > headersLength) {
        if (!options.strictColumnHandling) {
          throw new Error(`Unexpected Error: column header mismatch expected: ${headersLength} columns got: ${row.length}`);
        }
        return {invalid: true, row};
      }
      if (options.strictColumnHandling && row.length < headersLength) return {invalid: true, row};
      const mapped = {};
      for (let i = 0; i < headersLength; i += 1) {
        if (headers[i] !== undefined) mapped[headers[i]] = row[i] === undefined ? '' : row[i];
      }
      return {row: mapped};
    },
  };
}

function parse(opts) {
  const options = parserOptionsOf(opts);
  const decoder = new StringDecoder(options.encoding);
  const mapper = headerMapper(options);
  let buffered = '';
  let rowCount = 0;
  let parsedRowCount = 0;
  let lineCount = 0;
  let headersEmitted = false;
  const limitReached = () => options.maxRows > 0 && rowCount >= options.maxRows;

  const stream = new Transform({
    readableObjectMode: options.objectMode,
    transform(chunk, encoding, done) {
      try {
        if (limitReached()) return done();
        const {rows, rest} = parseText(buffered + (typeof chunk === 'string' ? chunk : decoder.write(chunk)), true, options);
        buffered = rest;
        push(rows);
        return done();
      } catch (error) {
        return done(error);
      }
    },
    flush(done) {
      try {
        if (limitReached()) return done();
        const text = buffered + decoder.end();
        if (text) push(parseText(text, false, options).rows);
        return done();
      } catch (error) {
        return done(error);
      }
    },
  });

  const emitHeaders = () => {
    if (!headersEmitted && mapper.headers) {
      headersEmitted = true;
      stream.emit('headers', mapper.headers);
    }
  };

  // skipLines rows are dropped outright; skipRows rows are parsed but neither emitted nor counted towards maxRows;
  // header rows count towards neither.
  function push(rows) {
    for (const row of rows) {
      emitHeaders();
      if (limitReached()) return;
      lineCount += 1;
      if (lineCount <= options.skipLines) continue;
      rowCount += 1;
      parsedRowCount += 1;
      const result = mapper.map(row);
      if (result.header) {
        rowCount -= 1;
        parsedRowCount -= 1;
      } else if (parsedRowCount <= options.skipRows) {
        rowCount -= 1;
      } else if (result.invalid) {
        stream.emit('data-invalid', result.row, rowCount);
      } else {
        stream.push(options.objectMode ? result.row : JSON.stringify(result.row));
      }
    }
    emitHeaders();
  }
  return stream;
}

function formatterOptionsOf(opts = {}) {
  const options = {
    delimiter: ',',
    rowDelimiter: '\n',
    quote: '"',
    quoteColumns: false,
    headers: null,
    includeEndRowDelimiter: false,
    writeBOM: false,
    BOM: '﻿',
    alwaysWriteHeaders: false,
    transform: null,
    ...opts,
  };
  if (opts.quoteHeaders === undefined) options.quoteHeaders = options.quoteColumns;
  if (opts.quote === true) options.quote = '"';
  else if (opts.quote === false) options.quote = '';
  if (typeof opts.escape !== 'string') options.escape = options.quote;
  options.shouldWriteHeaders = !!options.headers && (opts.writeHeaders !== undefined && opts.writeHeaders !== null ? opts.writeHeaders : true);
  options.headers = Array.isArray(options.headers) ? options.headers : null;
  options.escapedQuote = `${options.escape}${options.quote}`;
  options.replaceQuote = options.quote ? new RegExp(escapeRegExp(options.quote), 'g') : null;
  options.needsQuotes = new RegExp(`[${escapeRegExp(options.delimiter)}${escapeRegExp(options.rowDelimiter)}|\r|\n]`);
  return options;
}

function format(opts) {
  const options = formatterOptionsOf(opts);
  let rowCount = 0;
  let bomWritten = !options.writeBOM;
  let headersWritten = false;

  let {headers} = options;
  const shouldQuote = (index, isHeader) => {
    const config = isHeader ? options.quoteHeaders : options.quoteColumns;
    if (typeof config === 'boolean') return config;
    if (Array.isArray(config)) return !!config[index];
    if (config && headers) return !!config[headers[index]];
    return false;
  };
  const formatField = (field, index, isHeader) => {
    const prepared = `${field === null || field === undefined ? '' : field}`.replace(/\0/g, '');
    if (options.quote !== '' && prepared.indexOf(options.quote) !== -1) {
      return `${options.quote}${prepared.replace(options.replaceQuote, options.escapedQuote)}${options.quote}`;
    }
    if (prepared.search(options.needsQuotes) !== -1 || shouldQuote(index, isHeader)) {
      return `${options.quote}${prepared}${options.quote}`;
    }
    return prepared;
  };
  const formatRow = (row, isHeader) => {
    const line = row.map((field, index) => formatField(field, index, isHeader)).join(options.delimiter);
    const out = rowCount ? `${options.rowDelimiter}${line}` : line;
    rowCount += 1;
    return out;
  };
  // A "hash array" row is [[header, value], ...].
  const isHashArray = row => Array.isArray(row) && Array.isArray(row[0]) && row[0].length === 2;
  const gatherHeaders = row => (isHashArray(row) ? row.map(item => item[0]) : Array.isArray(row) ? row : Object.keys(row));
  const gatherColumns = row => {
    if (!Array.isArray(row)) return headers.map(header => row[header]);
    if (isHashArray(row)) return headers.map((header, i) => (row[i] ? row[i][1] : ''));
    if (!options.shouldWriteHeaders) return row;
    return headers.map((header, i) => row[i]);
  };

  return new Transform({
    writableObjectMode: true,
    transform(row, encoding, done) {
      try {
        if (!bomWritten) {
          bomWritten = true;
          this.push(options.BOM);
        }
        const transformed = options.transform ? options.transform(row) : row;
        if (row && transformed) {
          let formatColumns = true;
          let headerRow = headers;
          if (!headers) {
            headers = gatherHeaders(transformed);
            headerRow = options.shouldWriteHeaders ? headers : null;
            // a plain array row given as the first row is the header row itself
            formatColumns = !options.shouldWriteHeaders || !(Array.isArray(transformed) && !isHashArray(transformed));
          }
          if (options.shouldWriteHeaders && headerRow && !headersWritten) {
            headersWritten = true;
            this.push(formatRow(headerRow, true));
          }
          if (formatColumns) this.push(formatRow(gatherColumns(transformed), false));
        }
        return done();
      } catch (error) {
        return done(error);
      }
    },
    flush(done) {
      if (options.alwaysWriteHeaders && rowCount === 0) {
        if (!headers) return done(new Error('`alwaysWriteHeaders` option is set to true but `headers` option not provided.'));
        this.push(formatRow(headers, true));
      }
      if (options.includeEndRowDelimiter) this.push(options.rowDelimiter);
      return done();
    },
  });
}

module.exports = {parse, format, parseText, parserOptionsOf};
