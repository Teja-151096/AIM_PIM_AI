// Dashboard server: serves the UI and drives runBatch.js for whatever
// site/credentials/template/entities the user submits through the form.
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const { runBatch, cleanErrorMessage } = require('./runBatch');

const PORT = process.env.PORT || 4000;
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const LOGS_ROOT = path.join(__dirname, 'logs');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({ dest: UPLOADS_DIR });

// In-memory registry of runs. Fine for a single-machine internal tool; a run's
// state lives only as long as the server process.
const runs = new Map(); // runId -> { status, sseClients: Set<res>, log: [], csvPath }
let activeRunId = null;

function makeRun() {
  const runId = crypto.randomBytes(6).toString('hex');
  const run = { status: 'running', sseClients: new Set(), log: [], csvPath: null };
  runs.set(runId, run);
  return runId;
}

function emit(runId, event) {
  const run = runs.get(runId);
  if (!run) return;
  run.log.push(event);
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of run.sseClients) res.write(payload);
}

app.post(
  '/api/run',
  upload.fields([{ name: 'referenceTemplate', maxCount: 1 }, { name: 'entityNames', maxCount: 1 }]),
  async (req, res) => {
    if (activeRunId) {
      return res.status(409).json({ error: 'A run is already in progress. Wait for it to finish first.' });
    }

    const { url, username, password, year, fillMin, fillMax } = req.body;
    const months = [].concat(req.body.months || []).map(Number); // multi-value form field
    const templateFile = req.files?.referenceTemplate?.[0];
    const entityFile = req.files?.entityNames?.[0];

    if (!url || !username || !password || !templateFile || !entityFile || !year || !months.length) {
      return res.status(400).json({ error: 'Missing required field(s).' });
    }

    const runId = makeRun();
    activeRunId = runId;
    const logDir = path.join(LOGS_ROOT, runId);
    runs.get(runId).csvPath = path.join(logDir, 'results.csv');

    res.json({ runId });

    try {
      await runBatch({
        url,
        username,
        password,
        templatePath: templateFile.path,
        entityNamesPath: entityFile.path,
        year: Number(year),
        monthIndices: months,
        fillMin: fillMin ? Math.round(Number(fillMin)) : -1000,
        fillMax: fillMax ? Math.round(Number(fillMax)) : 250000,
        headless: false, // the browser always opens and stays visible for the whole run
        logDir,
        onProgress: (event) => emit(runId, event),
      });
      runs.get(runId).status = 'complete';
    } catch (err) {
      console.error(`[run ${runId}] fatal:`, err); // full detail, including Playwright's call log, for debugging
      runs.get(runId).status = 'error';
      emit(runId, { type: 'fatal', message: cleanErrorMessage(err.message) });
    } finally {
      activeRunId = null;
      // Uploaded source files only exist to kick off this one run.
      fs.rm(templateFile.path, { force: true }, () => {});
      fs.rm(entityFile.path, { force: true }, () => {});
      emit(runId, { type: 'stream-end' });
      for (const client of runs.get(runId).sseClients) client.end();
    }
  }
);

app.get('/api/stream/:runId', (req, res) => {
  const run = runs.get(req.params.runId);
  if (!run) return res.status(404).end();

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders();

  // Replay everything that already happened before this client connected.
  for (const event of run.log) res.write(`data: ${JSON.stringify(event)}\n\n`);
  if (run.status !== 'running') {
    res.end();
    return;
  }

  run.sseClients.add(res);
  req.on('close', () => run.sseClients.delete(res));
});

app.get('/api/download/:runId', (req, res) => {
  const run = runs.get(req.params.runId);
  if (!run || !run.csvPath || !fs.existsSync(run.csvPath)) return res.status(404).end();
  res.download(run.csvPath, `results-${req.params.runId}.csv`);
});

app.get('/api/status', (req, res) => {
  res.json({ busy: Boolean(activeRunId) });
});

app.listen(PORT, () => {
  console.log(`Ledger import dashboard running at http://localhost:${PORT}`);
});
