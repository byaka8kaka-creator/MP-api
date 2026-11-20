const { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, safeStorage, shell, Tray, utilityProcess } = require('electron');
const { randomUUID } = require('node:crypto');
const { mkdirSync } = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { Store } = require('./core/store.cjs');
const { Service } = require('./core/service.cjs');
const { InputError, readJson, stringify } = require('./core/json.cjs');
const { demand, id } = require('./core/model.cjs');
const { logEvent } = require('./core/datasets.cjs');

const root = process.env.MP_API_HOME ? path.resolve(process.env.MP_API_HOME)
  : app.isPackaged ? path.dirname(process.execPath) : path.resolve(__dirname, '..');
const pageFile = path.join(__dirname, 'ui', 'index.html');
const rendererUrl = pathToFileURL(pageFile).href;
const iconFile = path.join(__dirname, 'ui', 'icon.png');
const activeStates = new Set(['queued', 'running', 'waiting']);

let store;
let service;
let window;
let tray;
let worker;
let workerReady = false;
let recoveryFailures = 0;
let currentUser = null;
let nextLogin = 0;
let quitting = false;
let exiting = false;
let scheduling = false;
let scheduleTimer;
let retentionTimer;
let workerIssue;

const queued = new Set();
const running = new Set();
const workerRequests = new Map();

function requestWorker(action, data) {
  demand(workerReady && !quitting, 'Рабочий процесс сейчас недоступен.');
  return new Promise((resolve, reject) => {
    const requestId = randomUUID();
    workerRequests.set(requestId, { resolve, reject });
    try { worker.postMessage({ action, requestId, ...data }); }
    catch {
      workerRequests.delete(requestId);
      reject(new InputError('Рабочий процесс недоступен.'));
    }
  });
}

function pump() {
  if (!workerReady || quitting) return;
  while (queued.size && running.size < 4) {
    const id = queued.values().next().value;
    queued.delete(id);
    if (store.run(id)?.state !== 'queued') continue;
    try {
      worker.postMessage({ action: 'run', runId: id, credentials: service.credentials(id) });
      running.add(id);
    } catch {
      const run = store.run(id);
      store.updateRun(id, 'interrupted', { ...run.progress, error: 'Рабочий процесс недоступен.' });
    }
  }
}

function dispatch(id) {
  if (!running.has(id)) queued.add(id);
  pump();
}

function finishExit() {
  if (!quitting || running.size || workerRequests.size || exiting) return;
  exiting = true;
  worker?.kill();
  tray?.destroy();
  app.quit();
}

function startWorker() {
  workerReady = false;
  const child = utilityProcess.fork(path.join(__dirname, 'worker.cjs'), [root], {
    serviceName: 'MP API Worker', stdio: 'ignore',
  });
  worker = child;
  child.on('message', async message => {
    if (message.event === 'ready') {
      workerIssue = null;
      workerReady = true;
      try {
        await service.recover(dispatch);
        if (!quitting) child.postMessage({ action: 'prune' });
        await tick();
      } catch {
        workerIssue = 'Не удалось восстановить очередь. Проверьте папку данных.';
      }
      pump();
    }
    if (message.event === 'finished') {
      running.delete(message.runId);
      recoveryFailures = 0;
      pump();
      finishExit();
    }
    if (message.event === 'result') {
      const pending = workerRequests.get(message.requestId);
      workerRequests.delete(message.requestId);
      if (message.error) pending?.reject(new InputError(message.error));
      else pending?.resolve(message.value);
      finishExit();
    }
    if (message.event === 'maintenance-error') workerIssue = 'Не удалось очистить часть старых файлов.';
  });
  child.on('exit', () => {
    workerReady = false;
    running.clear();
    for (const task of workerRequests.values()) task.reject(new InputError('Рабочий процесс завершился.'));
    workerRequests.clear();
    if (quitting) { finishExit(); return; }
    workerIssue = 'Рабочий процесс завершился.';
    if (recoveryFailures++ === 0) startWorker();
    else {
      for (const { id, state } of store.activeRuns()) {
        if (state !== 'queued') {
          const run = store.run(id);
          store.updateRun(id, 'interrupted', { ...run.progress, error: workerIssue });
        }
      }
    }
  });
}

async function tick() {
  if (scheduling || quitting || !workerReady) return;
  scheduling = true;
  try {
    await service.startScheduled(Date.now(), dispatch);
  } catch {
    workerIssue = 'Не удалось проверить расписание.';
  } finally {
    scheduling = false;
  }
}

function openWindow() {
  if (!window) return;
  window.show();
  window.focus();
}

function beginExit() {
  if (quitting) return;
  quitting = true;
  clearInterval(scheduleTimer);
  clearInterval(retentionTimer);
  tray?.setToolTip('MP API • завершение заданий');
  if (running.size || workerRequests.size) openWindow();
  finishExit();
}

function setupWindow() {
  window = new BrowserWindow({
    title: 'MP API', width: 1320, height: 860, minWidth: 820, minHeight: 600,
    backgroundColor: '#f5f7f6', show: false, icon: iconFile, autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.once('ready-to-show', openWindow);
  window.on('close', event => {
    if (exiting) return;
    event.preventDefault();
    if (tray) window.hide();
    else beginExit();
  });
  window.loadFile(pageFile);
  const icon = nativeImage.createFromPath(iconFile);
  try {
    tray = new Tray(icon);
    tray.setToolTip('MP API');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Открыть MP API', click: openWindow },
      { label: 'Выйти после завершения задач', click: beginExit },
    ]));
    tray.on('double-click', openWindow);
  } catch {
    tray = null;
  }
}

function vault() {
  return {
    encrypt(value) {
      demand(safeStorage.isEncryptionAvailable() && safeStorage.getSelectedStorageBackend?.() !== 'basic_text',
        'Защищённое хранилище ключей недоступно. В Windows оно работает от имени пользователя, запустившего приложение.');
      return safeStorage.encryptString(value).toString('base64');
    },
    decrypt(value) { return safeStorage.decryptString(Buffer.from(value, 'base64')); },
  };
}

async function actions(action, value) {
  if (action === 'session') return currentUser && store.user(currentUser);
  if (action === 'login') {
    demand(Date.now() >= nextLogin, 'Подождите перед следующей попыткой входа.');
    nextLogin = Date.now() + 600;
    const user = store.authenticate(value.username, value.password);
    demand(user, 'Неверный логин или пароль.');
    currentUser = user.id;
    return user;
  }
  if (action === 'logout') { currentUser = null; return null; }
  const user = currentUser && store.user(currentUser);
  demand(user, 'Сначала войдите в аккаунт.');
  if (action === 'changePassword') return store.changePassword(user.id, value.current, value.password);
  demand(!user.must_change, 'Смените стартовый пароль.');
  switch (action) {
    case 'workspace':
      return { ...service.workspace(user), workerIssue, quitting };
    case 'connection':
      return service.saveConnection(user, value.json);
    case 'credentials':
      return service.credentialSettings(user, value, value.save);
    case 'draft':
      return service.saveDraft(user, value.json);
    case 'publish':
      return service.publish(user, value.templateId);
    case 'templateUsage':
      return service.templateUsage(user, value.templateId);
    case 'archiveTemplate':
      return service.archiveTemplate(user, value.templateId, value.archived);
    case 'deleteTemplate':
      return service.deleteTemplate(user, value.templateId);
    case 'versions':
      demand(user.role !== 'user', 'Версии доступны настройщику.');
      return store.versions(id(value.templateId)).map(({ version, published, value }) =>
        ({ version, published, json: stringify(value, null, 2) }));
    case 'sample':
      return service.testSample(user, value.templateId);
    case 'dictionaryOptions':
      return service.dictionaryOptions(user, value);
    case 'folder':
      return service.saveFolder(user, value);
    case 'job':
      return service.saveJob(user, value);
    case 'deleteJob':
      return service.deleteJob(user, value.jobId);
    case 'processing':
      return service.saveProcessing(user, readJson(value.json, 'Обработка'));
    case 'deleteProcessing':
      return service.deleteProcessing(user, value.processingId);
    case 'processingRuns':
      return service.processingRuns(user, value.templateId);
    case 'processingPreview': {
      const { runId, sourceIndex, processing } = service.processingPreview(user, {
        ...readJson(value.json, 'Обработка'), runId: value.runId, source: value.source,
      });
      return requestWorker('processingPreview', { runId, sourceIndex, processingJson: stringify(processing) });
    }
    case 'run': {
      demand(!quitting && workerReady, 'Рабочий процесс сейчас недоступен.');
      const id = service.createRun(user, value);
      dispatch(id);
      return id;
    }
    case 'cancel': {
      const run = service.getRun(user, value.runId);
      demand(activeStates.has(run.state), 'Запуск уже завершён.');
      if (queued.delete(run.id) || !running.has(run.id)) {
        store.updateRun(run.id, 'cancelled', run.progress);
        await logEvent(store, run.id, 'cancelled', {}, true);
      } else {
        worker.postMessage({ action: 'cancel', runId: run.id });
      }
      return null;
    }
    case 'runInfo':
      return service.runSummary(user, value.runId);
    case 'preview':
      return service.result(user, value);
    case 'export': {
      const run = service.getRun(user, value.runId);
      demand(!activeStates.has(run.state) && workerReady && !quitting, 'Дождитесь завершения задания.');
      demand(['csv', 'xlsx'].includes(value.format), 'Выберите CSV или XLSX.');
      const { processing, sourceIndex } = value.processingId ? service.processingFromRun(user, run, value) : {};
      return requestWorker('export', { runId: run.id, format: value.format, sourceIndex,
        processingJson: processing && stringify(processing) });
    }
    case 'openOutput': {
      const run = service.getRun(user, value.runId);
      const output = value.processingId
        ? run.progress.processingExports?.[`${value.source}:${id(value.processingId)}`]?.path
        : run.progress.exportPath;
      demand(output, 'Для этого результата ещё нет файлов экспорта.');
      demand(!await shell.openPath(output), 'Не удалось открыть папку экспорта.');
      return null;
    }
    case 'pin': {
      const run = service.getRun(user, value.runId);
      store.pinRun(run.id, value.pinned);
      return null;
    }
    case 'logs':
      return service.logs(user, value);
    case 'saveLog': {
      const source = service.logPath(user, value);
      demand(await fs.stat(source).then(info => info.isFile(), () => false), 'За выбранный период журнал пуст.');
      const save = await dialog.showSaveDialog(window, { defaultPath: path.basename(source), filters: [{ name: 'Журнал NDJSON', extensions: ['ndjson'] }] });
      if (!save.canceled) await fs.copyFile(source, save.filePath);
      return !save.canceled;
    }
    case 'pack': {
      const content = service.pack(user, value);
      const save = await dialog.showSaveDialog(window, { defaultPath: 'mp-api-templates.json', filters: [{ name: 'JSON', extensions: ['json'] }] });
      if (!save.canceled) await fs.writeFile(save.filePath, content, 'utf8');
      return !save.canceled;
    }
    case 'import': {
      demand(user.role !== 'user', 'Импорт доступен настройщику.');
      const opened = await dialog.showOpenDialog(window, { properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] });
      if (opened.canceled) return null;
      const [filename] = opened.filePaths;
      demand((await fs.stat(filename)).size <= 5 * 1024 * 1024, 'Пакет настроек слишком большой.');
      return service.import(user, await fs.readFile(filename, 'utf8'));
    }
    case 'createUser':
      demand(user.role === 'admin', 'Управление аккаунтами доступно администратору.');
      return store.createUser(value.username, value.password, value.role);
    case 'setRole':
      demand(user.role === 'admin' && value.id !== user.id, 'Выберите другой аккаунт для смены роли.');
      store.setRole(value.id, value.role);
      return null;
    case 'retention':
      demand(user.role === 'admin', 'Срок хранения настраивает администратор.');
      return store.saveRetention(value);
    case 'exit':
      beginExit();
      return null;
    default:
      throw new InputError('Неизвестное действие.');
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  mkdirSync(path.join(root, 'data', 'ui'), { recursive: true, mode: 0o700 });
  app.setPath('userData', path.join(root, 'data', 'ui'));
  app.on('second-instance', openWindow);
  app.on('activate', openWindow);
  app.on('before-quit', event => {
    if (!exiting) { event.preventDefault(); beginExit(); }
  });
  app.whenReady().then(() => {
    store = new Store(root);
    service = new Service(store, vault());
    ipcMain.handle('mp:invoke', async (event, action, value = {}) => {
      if (event.sender !== window?.webContents || event.senderFrame?.url !== rendererUrl) {
        return { ok: false, error: 'Операция недоступна.' };
      }
      try { return { ok: true, value: await actions(action, value) }; }
      catch (error) {
        return { ok: false, error: error instanceof InputError ? error.message : 'Не удалось выполнить действие. Проверьте настройки и папку приложения.' };
      }
    });
    setupWindow();
    startWorker();
    scheduleTimer = setInterval(tick, 15_000);
    retentionTimer = setInterval(() => { if (workerReady && !quitting) worker.postMessage({ action: 'prune' }); }, 3_600_000);
  }).catch(() => {
    dialog.showErrorBox('MP API', 'Не удалось подготовить папку данных. Запустите приложение из доступного для записи каталога.');
    exiting = true;
    app.quit();
  });
}
