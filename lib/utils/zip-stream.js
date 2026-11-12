const events = require('events');
const {zipBuffer} = require('./zip');

const StreamBuf = require('./stream-buf');
const {stringToBuffer} = require('./browser-buffer-encode');

// =============================================================================
// The ZipWriter class
// Packs streamed data into an output zip stream
class ZipWriter extends events.EventEmitter {
  constructor(options) {
    super();
    this.options = Object.assign(
      {
        type: 'nodebuffer',
        compression: 'DEFLATE',
      },
      options
    );

    this.files = {};
    this.stream = new StreamBuf();
  }

  append(data, options) {
    const name = options.name.replace(/^\/+/, '');
    if (options.base64) {
      data = Buffer.from(data, 'base64');
    } else if (typeof data === 'string') {
      data = process.browser ? stringToBuffer(data) : Buffer.from(data, 'utf8');
    } else if (data instanceof ArrayBuffer) {
      data = new Uint8Array(data);
    }
    this.files[name] = data;
  }

  async finalize() {
    const {compression, compressionOptions} = this.options;
    const level = compression === 'STORE' ? 0 : compressionOptions && compressionOptions.level;
    this.stream.end(zipBuffer(this.files, {zlib: {level}}));
    this.emit('finish');
  }

  // ==========================================================================
  // Stream.Readable interface
  read(size) {
    return this.stream.read(size);
  }

  setEncoding(encoding) {
    return this.stream.setEncoding(encoding);
  }

  pause() {
    return this.stream.pause();
  }

  resume() {
    return this.stream.resume();
  }

  isPaused() {
    return this.stream.isPaused();
  }

  pipe(destination, options) {
    return this.stream.pipe(destination, options);
  }

  unpipe(destination) {
    return this.stream.unpipe(destination);
  }

  unshift(chunk) {
    return this.stream.unshift(chunk);
  }

  wrap(stream) {
    return this.stream.wrap(stream);
  }
}

// =============================================================================

module.exports = {
  ZipWriter,
};
