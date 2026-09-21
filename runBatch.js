// Core engine behind the dashboard: given a site URL, credentials, a reference
// ledger template, a list of entity names, and a year/months selection, it
// randomizes the selected month column(s) per entity and drives the AIM
// Ledger import flow for each one. Emits progress via onProgress so a caller
// (the dashboard server, or a CLI script) can show live status.
const path = require('path');
const fs = require('fs');
const ExcelJS = require('exceljs');
const { chromium } = require('playwright');
const aim = require('./aimHelpers');
const { createYearRemappedRandomizedCopy, findMonthColumns, MONTH_ABBR } = require('./ledgerRandomizer');

const PROFILE_NAME = 'Default'; // Always Default, regardless of site/entity - hardcoded per team decision.

// Playwright timeout errors include a multi-line "Call log:" trace with ANSI
// color codes, which reads as garbled control characters once dropped into
// an HTML <pre> block. Keep just the human-readable first line for display.
function cleanErrorMessage(message) {
  return String(message)
    .replace(/\x1b\[[0-9;]*m/g, '')
    .split('\nCall log:')[0]
    .trim();
}

// Reads a spreadsheet that contains nothing but entity names (optionally with
// a header cell like "Entity Name" in row 1, which is auto-detected and skipped).
async function loadEntityNames(filePath) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const sheet = workbook.worksheets[0];

  const names = [];
  sheet.eachRow((row) => {
    const text = row.getCell(1).text.trim();
    if (text) names.push(text);
  });

  if (names.length && /^(entity( name)?|name)$/i.test(names[0])) {
    names.shift(); // drop a header cell if present
  }
  return names;
}

/**
 * @param {object} opts
 * @param {string} opts.url - AIM site URL
 * @param {string} opts.username
 * @param {string} opts.password
 * @param {string} opts.templatePath - reference ledger template (.xlsx)
 * @param {string} opts.entityNamesPath - spreadsheet of entity names
 * @param {number} opts.year
 * @param {number[]} opts.monthIndices - 0-11 (Jan=0 ... Dec=11)
 * @param {number} [opts.fillMin=-1000] - lower bound for the randomized fill
 * @param {number} [opts.fillMax=250000] - upper bound for the randomized fill
 * @param {boolean} [opts.headless=true]
 * @param {string} opts.logDir - where per-run screenshots/CSV get written
 * @param {(event: object) => void} [opts.onProgress]
 */
async function runBatch(opts) {
  const {
    url, username, password, templatePath, entityNamesPath,
    year, monthIndices, fillMin = -1000, fillMax = 250000, headless = true,
    logDir, onProgress = () => {},
  } = opts;

  fs.mkdirSync(logDir, { recursive: true });

  // The template's own year is irrelevant - we only match by month name, then
  // rewrite every month column's header to the selected year. So a template
  // built for 2026 works unchanged when the user asks for 2024.
  const monthColumns = await findMonthColumns(templatePath);
  const monthsInTemplate = new Set(monthColumns.map((c) => c.monthIndex));
  const missingMonths = monthIndices.filter((m) => !monthsInTemplate.has(Number(m)));
  if (!monthColumns.length) {
    throw new Error('The reference template has no month columns (expected headers like "Mar 2026").');
  }
  if (missingMonths.length) {
    throw new Error(
      `The reference template has no column for: ${missingMonths.map((m) => MONTH_ABBR[m]).join(', ')}.`
    );
  }
  const selectedSet = new Set(monthIndices.map(Number));
  const randomizedLabels = monthColumns.filter((c) => selectedSet.has(c.monthIndex)).map((c) => `${MONTH_ABBR[c.monthIndex]} ${year}`);
  const clearedLabels = monthColumns.filter((c) => !selectedSet.has(c.monthIndex)).map((c) => `${MONTH_ABBR[c.monthIndex]} ${year}`);
  onProgress({
    type: 'info',
    message: `Headers rewritten to ${year}. Randomizing: ${randomizedLabels.join(', ') || '(none)'}. Cleared: ${clearedLabels.join(', ') || '(none)'}.`,
  });

  const entityNames = await loadEntityNames(entityNamesPath);
  if (!entityNames.length) {
    throw new Error('No entity names found in the uploaded file.');
  }
  onProgress({ type: 'info', message: `Loaded ${entityNames.length} entit${entityNames.length === 1 ? 'y' : 'ies'}.` });

  const generatedDir = path.join(logDir, 'generated');
  const results = [];

  const browser = await chromium.launch({
    headless,
    slowMo: headless ? 0 : 400, // slows every action so a human watching can actually follow each step
    args: headless ? [] : ['--start-maximized'],
  });
  const context = await browser.newContext(headless ? {} : { viewport: null });
  const page = await context.newPage();

  try {
    onProgress({ type: 'info', message: `Logging in to ${url}...` });
    await aim.login(page, { url, user: username, pass: password });
    onProgress({ type: 'info', message: 'Logged in.' });

    for (const entityName of entityNames) {
      onProgress({ type: 'entity-status', entityName, status: 'RUNNING' });

      let randomizedFilePath = null;
      try {
        randomizedFilePath = await createYearRemappedRandomizedCopy(
          templatePath, generatedDir, entityName, { fillMin, fillMax }, year, monthIndices
        );

        // Full page refresh before every entity (including the first), so
        // leftover app state from the previous entity's ledger/import screen
        // can never bleed into this one.
        await aim.resetToPortfolio(page, url);

        await aim.searchAndOpenEntity(page, entityName);
        onProgress({ type: 'log', entityName, message: 'Opened entity.' });

        await aim.openLedgerTab(page);
        onProgress({ type: 'log', entityName, message: 'Ledger tab opened.' });

        await aim.openImportLedgerPanel(page);
        onProgress({ type: 'log', entityName, message: 'Import Ledger panel opened.' });

        await aim.uploadFile(page, randomizedFilePath);
        onProgress({ type: 'log', entityName, message: 'File uploaded.' });

        await aim.selectProfile(page, PROFILE_NAME);
        onProgress({ type: 'log', entityName, message: 'Profile set to Default.' });

        await aim.clickImport(page);
        onProgress({ type: 'log', entityName, message: 'Import clicked, waiting for confirmation...' });
        await aim.waitForImportSuccess(page, { timeoutMs: 5 * 60 * 1000 });
        onProgress({ type: 'log', entityName, message: 'Success banner confirmed.' });

        results.push({ entityName, status: 'SUCCESS', error: '' });
        onProgress({ type: 'entity-status', entityName, status: 'SUCCESS' });
      } catch (err) {
        const cleanMessage = cleanErrorMessage(err.message);
        const safeName = entityName.replace(/[^a-z0-9]+/gi, '_');
        const shotPath = path.join(logDir, `error-${safeName}-${Date.now()}.png`);
        await page.screenshot({ path: shotPath, fullPage: true }).catch(() => {});
        results.push({ entityName, status: 'FAILED', error: cleanMessage });
        onProgress({ type: 'entity-status', entityName, status: 'FAILED', error: cleanMessage, screenshot: shotPath });
      } finally {
        if (randomizedFilePath) fs.rm(randomizedFilePath, { force: true }, () => {});
      }
    }
  } finally {
    await context.close();
    await browser.close();
    fs.rm(generatedDir, { recursive: true, force: true }, () => {});
  }

  const csvPath = path.join(logDir, 'results.csv');
  const escape = (s) => `"${String(s).replace(/"/g, '""')}"`;
  const csvLines = ['Entity Name,Status,Error', ...results.map((r) => [r.entityName, r.status, r.error].map(escape).join(','))];
  fs.writeFileSync(csvPath, csvLines.join('\n'));

  const successCount = results.filter((r) => r.status === 'SUCCESS').length;
  onProgress({ type: 'done', successCount, total: results.length, csvPath });

  return { results, csvPath };
}

module.exports = { runBatch, loadEntityNames, cleanErrorMessage };
