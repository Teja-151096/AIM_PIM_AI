// Produces a per-entity copy of a ledger template with one or more month
// columns randomized, so we're not uploading identical numbers for every
// entity in a batch.
const path = require('path');
const fs = require('fs');
const ExcelJS = require('exceljs');

const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];
const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Parses a header cell like "Mar 2026", "March 2026", or "mar. 2026" into
// { monthIndex (0-11), year }. Returns null if it doesn't look like a month/year.
function parseMonthYearHeader(headerText) {
  const text = String(headerText || '').trim().toLowerCase();
  const match = text.match(/^([a-z]+)\.?\s+(\d{4})$/);
  if (!match) return null;
  const [, monthPart, yearPart] = match;
  const monthIndex = MONTHS.findIndex(
    (m) => m === monthPart || m.startsWith(monthPart) || monthPart.startsWith(m.slice(0, 3))
  );
  if (monthIndex === -1) return null;
  return { monthIndex, year: Number(yearPart) };
}

// Scans the header row and returns every month-shaped column found, regardless
// of what year is in its label - e.g. a template's "Jan 2026" column is
// reported as monthIndex 0 no matter what year the dashboard user picks.
async function findMonthColumns(templatePath) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(templatePath);
  const sheet = workbook.worksheets[0];
  const headerRow = sheet.getRow(1);

  const columns = [];
  headerRow.eachCell({ includeEmpty: false }, (cell, colNumber) => {
    const parsed = parseMonthYearHeader(cell.value);
    if (parsed) columns.push({ column: colNumber, monthIndex: parsed.monthIndex, label: String(cell.value).trim() });
  });
  return columns;
}

// Dashboard flow: every month column in the template gets its header rewritten
// to "<Mon> <targetYear>" - the template's own year is irrelevant and is
// simply overwritten. The real-world template has no existing numbers at all
// (just Account/Name, with the account list varying per upload) - so every
// row in a column whose month is in `selectedMonthIndices` gets a fresh
// random value between fillMin and fillMax (rounded to the nearest 10),
// regardless of whatever was there before. Every other month column's values
// are cleared to blank, since we're only asked to produce data for the
// selected months.
async function createYearRemappedRandomizedCopy(templatePath, outDir, entityName, { fillMin = -1000, fillMax = 250000 } = {}, targetYear, selectedMonthIndices) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(templatePath);
  const sheet = workbook.worksheets[0];
  const headerRow = sheet.getRow(1);
  const selected = new Set(selectedMonthIndices.map(Number));

  const monthColumns = [];
  headerRow.eachCell({ includeEmpty: false }, (cell, colNumber) => {
    const parsed = parseMonthYearHeader(cell.value);
    if (!parsed) return;
    monthColumns.push({ column: colNumber, monthIndex: parsed.monthIndex });
    cell.value = `${MONTH_ABBR[parsed.monthIndex]} ${targetYear}`;
  });

  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return; // header, already rewritten above
    for (const { column, monthIndex } of monthColumns) {
      const cell = row.getCell(column);
      if (!selected.has(monthIndex)) {
        cell.value = null;
        continue;
      }
      const fresh = fillMin + Math.random() * (fillMax - fillMin);
      cell.value = Math.round(fresh / 10) * 10;
    }
  });

  fs.mkdirSync(outDir, { recursive: true });
  const safeName = entityName.replace(/[^a-z0-9]+/gi, '_');
  const timestamp = Date.now();
  const outPath = path.join(outDir, `${safeName}-${timestamp}.xlsx`);
  await workbook.xlsx.writeFile(outPath);
  return outPath;
}

module.exports = {
  createYearRemappedRandomizedCopy,
  findMonthColumns,
  parseMonthYearHeader,
  MONTHS,
  MONTH_ABBR,
};
