const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const monthsGrid = document.getElementById('months-grid');
MONTH_NAMES.forEach((name, idx) => {
  const label = document.createElement('label');
  label.innerHTML = `<input type="checkbox" name="months" value="${idx}" /> ${name}`;
  monthsGrid.appendChild(label);
});

const yearInput = document.getElementById('year-input');
yearInput.value = new Date().getFullYear();

const form = document.getElementById('run-form');
const submitBtn = document.getElementById('submit-btn');
const progressCard = document.getElementById('progress-card');
const summaryLine = document.getElementById('summary-line');
const entityTableBody = document.querySelector('#entity-table tbody');
const logConsole = document.getElementById('log-console');
const downloadLink = document.getElementById('download-link');

const entityRows = new Map(); // entityName -> <tr>

function appendLog(text) {
  logConsole.textContent += text + '\n';
  logConsole.scrollTop = logConsole.scrollHeight;
}

function getOrCreateRow(entityName) {
  if (entityRows.has(entityName)) return entityRows.get(entityName);
  const tr = document.createElement('tr');
  tr.innerHTML = `<td>${entityName}</td><td><span class="badge PENDING">PENDING</span></td><td class="detail"></td>`;
  entityTableBody.appendChild(tr);
  entityRows.set(entityName, tr);
  return tr;
}

function setEntityStatus(entityName, status, detail) {
  const tr = getOrCreateRow(entityName);
  const badge = tr.querySelector('.badge');
  badge.textContent = status;
  badge.className = `badge ${status}`;
  if (detail) tr.querySelector('.detail').textContent = detail;
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  submitBtn.disabled = true;
  submitBtn.textContent = 'Running...';
  progressCard.hidden = false;
  entityTableBody.innerHTML = '';
  entityRows.clear();
  logConsole.textContent = '';
  summaryLine.textContent = '';
  downloadLink.hidden = true;

  const formData = new FormData(form);

  let runId;
  try {
    const res = await fetch('/api/run', { method: 'POST', body: formData });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to start run.');
    runId = data.runId;
  } catch (err) {
    appendLog(`ERROR: ${err.message}`);
    resetSubmitButton();
    return;
  }

  const source = new EventSource(`/api/stream/${runId}`);

  source.onmessage = (evt) => {
    const event = JSON.parse(evt.data);

    if (event.type === 'info') {
      appendLog(event.message);
    } else if (event.type === 'log') {
      appendLog(event.message);
    } else if (event.type === 'entity-status') {
      setEntityStatus(event.entityName, event.status, event.error || '');
      if (event.status === 'RUNNING') {
        appendLog(`\n=== ${event.entityName} ===`);
      } else if (event.status === 'SUCCESS') {
        appendLog(`SUCCESS: ${event.entityName}`);
      } else if (event.status === 'FAILED') {
        appendLog(`FAILED: ${event.entityName} - ${event.error}`);
      }
    } else if (event.type === 'fatal') {
      appendLog(`\nFATAL: ${event.message}`);
      summaryLine.textContent = `Run failed: ${event.message}`;
    } else if (event.type === 'done') {
      summaryLine.textContent = `${event.successCount}/${event.total} succeeded.`;
      downloadLink.href = `/api/download/${runId}`;
      downloadLink.hidden = false;
    } else if (event.type === 'stream-end') {
      source.close();
      resetSubmitButton();
    }
  };

  source.onerror = () => {
    source.close();
    resetSubmitButton();
  };
});

function resetSubmitButton() {
  submitBtn.disabled = false;
  submitBtn.textContent = 'Start Import';
}
