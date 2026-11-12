// Runs each browser bundle in a context with browser globals only (no require, Buffer or process)
// and round-trips a workbook through it.
const fs = require('fs');
const vm = require('vm');

function browserContext(file) {
  const context = {
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    TextDecoder,
    TextEncoder,
    crypto: globalThis.crypto,
  };
  context.window = context;
  context.self = context;
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(file, 'utf8'), context);
  return context;
}

const roundTrip = `(async () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('data');
  for (let i = 0; i < 500; i++) ws.addRow([i, 'name ' + i, new Date(Date.UTC(2020, 0, 1)), i % 2 === 0]);
  ws.getCell('F1').value = {formula: 'SUM(A1:A500)'};
  const buffer = await wb.xlsx.writeBuffer();
  const loaded = new ExcelJS.Workbook();
  await loaded.xlsx.load(buffer);
  const sheet = loaded.getWorksheet('data');
  return {rows: sheet.rowCount, last: sheet.getCell('B500').value, formula: sheet.getCell('F1').formula};
})()`;

describe('browser bundles', () => {
  ['exceljs.js', 'exceljs.min.js', 'exceljs.bare.js', 'exceljs.bare.min.js'].forEach(name => {
    it(`${name} writes and loads a workbook without Node built-ins`, async function() {
      this.timeout(30000);
      const result = await vm.runInContext(roundTrip, browserContext(`./dist/${name}`));
      expect(JSON.parse(JSON.stringify(result))).to.deep.equal({rows: 500, last: 'name 499', formula: 'SUM(A1:A500)'});
    });
  });
});
