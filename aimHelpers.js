// Shared steps for driving the AIM Ledger import flow with Playwright.
// Used by both importLedgerBatch.js and runBatch.js (the dashboard engine).

const NAV_TIMEOUT = 120000; // page navigations (goto / waitForURL) - the slowest step on a loaded site
const ACTION_TIMEOUT = 90000; // waiting for/interacting with an element once the page has loaded

async function login(page, { url, user, pass }) {
  await page.goto(url, { waitUntil: 'load', timeout: NAV_TIMEOUT });
  // Let the login screen actually be visible on screen for a moment before
  // typing starts, rather than filling the instant the fields exist in the DOM.
  await page.waitForTimeout(3000);
  await page.fill('#Username', user, { timeout: ACTION_TIMEOUT });
  await page.fill('#Password', pass, { timeout: ACTION_TIMEOUT });
  await page.waitForTimeout(1000);
  await Promise.all([
    page.waitForURL(/AIMUI\/portfolio/i, { timeout: NAV_TIMEOUT }).catch(() => {}),
    page.click('button.login-button, button[value="login"]', { timeout: ACTION_TIMEOUT }),
  ]);
}

// Navigates back to the Portfolio page with a full (non-SPA) browser
// navigation and a short settle pause, so every entity starts from an
// identical, freshly-loaded state instead of whatever the app's in-memory
// state happens to be after the previous entity's ledger import.
async function resetToPortfolio(page, url) {
  await page.goto(`${url.replace(/\/$/, '')}/AIMUI/portfolio`, { waitUntil: 'load', timeout: NAV_TIMEOUT });
  await page.waitForTimeout(2000);
}

// The omnibar is a Stencil web component; typing must be done key-by-key
// for its autocomplete to fire (a plain .fill() does not trigger it).
async function searchAndOpenEntity(page, entityName) {
  const searchBox = page.getByRole('searchbox', { name: 'Type a property or entity name' });
  await searchBox.waitFor({ state: 'visible', timeout: ACTION_TIMEOUT });
  await searchBox.click({ timeout: ACTION_TIMEOUT });
  await searchBox.fill('');
  await searchBox.pressSequentially(entityName, { delay: 100 });

  const suggestion = page.getByText(entityName, { exact: true }).first();
  await suggestion.waitFor({ state: 'visible', timeout: ACTION_TIMEOUT });
  await suggestion.click({ timeout: ACTION_TIMEOUT });

  // The entity detail page (left sub-nav: Summary/Ledger/etc.) takes a moment
  // to load after the click before it's safe to click "Ledger" - give it
  // real time to settle rather than clicking the instant the nav item exists.
  await page.waitForTimeout(6000);
}

async function openLedgerTab(page) {
  const ledgerTab = page.getByText('Ledger', { exact: true }).first();
  await ledgerTab.waitFor({ state: 'visible', timeout: ACTION_TIMEOUT });
  await ledgerTab.click({ timeout: ACTION_TIMEOUT });
  await page.waitForURL(/entityDetails\/\d+\/ledger/i, { timeout: NAV_TIMEOUT });

  // The URL changing doesn't mean the ledger content has actually rendered -
  // the "Actuals" grid loads asynchronously afterwards, and clicking the
  // three-dot menu before it's ready leaves the app stuck behind a blank
  // modal backdrop. Wait for real content ("Actuals" heading) instead of a
  // fixed sleep, so a genuinely slow-loading entity gets more time rather
  // than a premature click.
  await page.getByText('Actuals', { exact: true }).first().waitFor({ state: 'visible', timeout: ACTION_TIMEOUT });
  await page.waitForTimeout(1000);
}

async function openImportLedgerPanel(page) {
  const ellipsis = page.locator('div.ddn-options a[data-toggle="dropdown"]').first();
  await ellipsis.waitFor({ state: 'visible', timeout: ACTION_TIMEOUT });
  await ellipsis.click({ timeout: ACTION_TIMEOUT });

  const importLedgerMenuItem = page.getByText('Import Ledger', { exact: true });
  await importLedgerMenuItem.waitFor({ state: 'visible', timeout: ACTION_TIMEOUT });
  await importLedgerMenuItem.click({ timeout: ACTION_TIMEOUT });

  // The slide-over panel opens with a brief animation before its actual
  // content (the drag-and-drop area) is there to interact with.
  await page.getByText('Import Financial Data', { exact: true }).waitFor({ state: 'visible', timeout: ACTION_TIMEOUT });
}

async function uploadFile(page, filePath) {
  const [fileChooser] = await Promise.all([
    page.waitForEvent('filechooser', { timeout: ACTION_TIMEOUT }),
    page.getByText('Choose File', { exact: true }).click({ timeout: ACTION_TIMEOUT }),
  ]);
  await fileChooser.setFiles(filePath);
}

// Selects the Profile from the native <select> inside ".ledgerProfileDropDownContainer".
// Tries an exact label match first (e.g. "Default"); falls back to a prefix match
// only if no exact option exists (some environments only have "Default (deprecated)").
async function selectProfile(page, profileName) {
  const profileSelect = page.locator('.ledgerProfileDropDownContainer select');
  await profileSelect.waitFor({ state: 'visible', timeout: ACTION_TIMEOUT });
  const optionLabels = await profileSelect.locator('option').allTextContents();
  const trimmed = optionLabels.map((l) => l.trim());

  const exactMatch = trimmed.find((label) => label === profileName);
  const matchedLabel = exactMatch || trimmed.find((label) => label.startsWith(profileName));

  if (!matchedLabel) {
    throw new Error(`No Profile option matching "${profileName}" found. Available: ${trimmed.join(', ')}`);
  }
  await profileSelect.selectOption({ label: matchedLabel }, { timeout: ACTION_TIMEOUT });
  return matchedLabel;
}

async function clickImport(page) {
  await page.getByRole('button', { name: 'Import', exact: true }).click({ timeout: ACTION_TIMEOUT });
}

// After clicking Import, the app shows an "Importing... X%" progress panel and
// then, once the backend finishes, swaps it for a green "Success! Your data
// was imported from <file>" banner - with no click needed in between. We wait
// for that banner rather than a fixed sleep, since import time varies with file size.
async function waitForImportSuccess(page, { timeoutMs = 5 * 60 * 1000 } = {}) {
  await page.getByText(/Your data was imported/i).first().waitFor({ state: 'visible', timeout: timeoutMs });
}

module.exports = {
  NAV_TIMEOUT,
  ACTION_TIMEOUT,
  login,
  resetToPortfolio,
  searchAndOpenEntity,
  openLedgerTab,
  openImportLedgerPanel,
  uploadFile,
  selectProfile,
  clickImport,
  waitForImportSuccess,
};
