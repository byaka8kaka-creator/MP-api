const { net } = require('electron');
const { Store } = require('./core/store.cjs');
const { LimitScheduler } = require('./core/limits.cjs');
const { executeRun, problem } = require('./core/runner.cjs');
const { exportRun, previewProcessing, prune } = require('./core/datasets.cjs');
const { parseJson } = require('./core/json.cjs');

const root = process.argv.at(-1);
const port = process.parentPort;
const store = new Store(root, { seed: false });
const limiter = new LimitScheduler();
const active = new Map();
const fetcher = (url, options) => net.fetch(url.href, options);

port.on('message', async ({ data }) => {
  const { action, runId, requestId } = data;
  if (action === 'cancel') {
    active.get(runId)?.abort();
    return;
  }
  if (action === 'prune') {
    await prune(store).catch(() => port.postMessage({ event: 'maintenance-error' }));
    return;
  }
  if (action === 'export' || action === 'processingPreview') {
    try {
      const { processingJson, sourceIndex } = data;
      const processing = processingJson ? parseJson(processingJson) : null;
      if (action === 'processingPreview') {
        const value = await previewProcessing(store, store.run(runId), sourceIndex, processing);
        port.postMessage({ event: 'result', requestId, value });
        return;
      }
      const output = await exportRun(store, store.run(runId), data.format, { processing: processing ?? undefined, sourceIndex });
      const latest = store.run(runId);
      if (processing) {
        latest.progress.processingExports ??= {};
        latest.progress.processingExports[`${sourceIndex}:${processing.id}`] = {
          name: processing.name, path: output, format: data.format, finishedAt: Date.now(),
        };
      } else {
        latest.progress.exportPath = output;
        delete latest.progress.exportError;
      }
      store.updateRun(runId, latest.state, latest.progress);
      port.postMessage({ event: 'result', requestId });
    } catch (error) {
      port.postMessage({ event: 'result', requestId, error: problem(error) });
    }
    return;
  }
  if (action !== 'run' || active.has(runId)) return;
  const controller = new AbortController();
  active.set(runId, controller);
  try {
    await executeRun(store, runId, data.credentials, { limiter, fetcher, signal: controller.signal });
  } catch (error) {
    const run = store.run(runId);
    store.updateRun(runId, 'interrupted', { ...run.progress, error: problem(error) });
  } finally {
    active.delete(runId);
    port.postMessage({ event: 'finished', runId });
  }
});
port.postMessage({ event: 'ready' });
