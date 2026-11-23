const root = document.querySelector('#app');
const editor = document.querySelector('#editor');
const notification = document.querySelector('#notification');
const active = new Set(['queued', 'running', 'waiting']);
const states = {
  queued: 'В очереди', running: 'Выгружается', waiting: 'Ожидает лимита', completed: 'Готово',
  partial: 'Частичный результат', failed: 'Ошибка', interrupted: 'Прервано', cancelled: 'Отменено',
};
const roles = { admin: 'Администратор', configurator: 'Настройщик', user: 'Пользователь' };
const week = [[1, 'Пн'], [2, 'Вт'], [3, 'Ср'], [4, 'Чт'], [5, 'Пт'], [6, 'Сб'], [0, 'Вс']];
const datetime = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'short', timeStyle: 'short' });
const runDatetime = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'short', timeStyle: 'medium' });
const number = new Intl.NumberFormat('ru-RU');
const state = { user: null, workspace: null, page: 'jobs', connectionId: null, refreshKey: '', refreshing: false };
let toastTimeout;
let fieldCount = 0;
let liveRunDetails;

function h(tag, attributes = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (['value', 'checked', 'selected', 'disabled'].includes(key)) node[key] = value;
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat(Infinity)) {
    if (child !== undefined && child !== null && child !== false) node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

async function call(action, value) {
  if (!window.mpApi) throw new Error('Запустите MP API как настольное приложение.');
  const response = await window.mpApi.invoke(action, value);
  if (!response.ok) throw new Error(response.error);
  return response.value;
}

function showToast(message, isError = false) {
  notification.textContent = message;
  notification.className = isError ? 'error' : '';
  notification.hidden = false;
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => { notification.hidden = true; }, 5500);
}

function btn(label, action, variant = '', disabled = false) {
  const node = h('button', { type: 'button', class: `button ${variant}`, disabled }, label);
  node.addEventListener('click', async () => {
    node.disabled = true;
    try { await action(); }
    catch (error) { showToast(error.message, true); }
    finally { node.disabled = disabled; }
  });
  return node;
}

function select(options, value, onChange) {
  const control = h('select', { onchange: onChange }, options.map(option => h('option', {
    value: String(option[0]), disabled: option[2],
  }, option[1])));
  control.value = value ?? (options[0] && String(options[0][0])) ?? '';
  return control;
}

function input(value = '', attrs = {}) {
  return h('input', { value, ...attrs });
}

function field(label, control, hint) {
  const key = `field-${++fieldCount}`;
  control.setAttribute('aria-labelledby', key);
  if (hint) control.setAttribute('aria-describedby', `${key}-hint`);
  return h('label', { class: 'field' }, h('span', { id: key }, label), control,
    hint && h('small', { class: 'caption', id: `${key}-hint` }, hint));
}

function checkbox(label, checked = false) {
  const control = input('', { type: 'checkbox', checked });
  return { control, label: h('label', { class: 'check' }, control, label) };
}

function textarea(value, rows = 6, label = 'JSON') {
  return h('textarea', { class: 'code', value, rows, spellcheck: 'false', 'aria-label': label });
}

function cluster(...items) { return h('div', { class: 'cluster' }, items); }
function fields(...items) { return h('div', { class: 'fields' }, items); }
function stack(...items) { return h('div', { class: 'stack' }, items); }
function pretty(value) { return JSON.stringify(value, null, 2); }

function parseEditable(raw) {
  return JSON.parse(raw, (_key, value, context) =>
    typeof value === 'number' && context?.source && JSON.rawJSON ? JSON.rawJSON(context.source) : value);
}

function editedJson(raw, label) {
  try { return parseEditable(raw); }
  catch { throw new Error(`Проверьте JSON в разделе «${label}».`); }
}

function time(value) { return value ? datetime.format(value) : '—'; }

function runTime(value) { return value == null ? '—' : runDatetime.format(value); }

function runDuration(run) {
  if (run.finished_at == null) return '';
  const seconds = Math.floor(Math.max(0, run.finished_at - run.created) / 1000);
  const parts = [[Math.floor(seconds / 86400), 'д'], [Math.floor(seconds / 3600) % 24, 'ч'],
    [Math.floor(seconds / 60) % 60, 'мин'], [seconds % 60, 'с']];
  return parts.filter(([value]) => value > 0).map(([value, unit]) => `${number.format(value)} ${unit}`).join(' ') || 'менее 1 с';
}

function brand() {
  return h('div', { class: 'brand' }, h('img', { src: 'icon.png', alt: '' }), h('span', {}, 'MP API'));
}

function header(title, description, actions) {
  return h('header', { class: 'page-heading' }, h('div', {}, h('h1', {}, title), description && h('p', {}, description)), actions);
}

function section(title, action, ...body) {
  return h('section', { class: 'card' }, h('div', { class: 'section-head' }, h('h2', {}, title), action), body);
}

function table(headers, rows) {
  return h('div', { class: 'data-scroll' }, h('table', { class: 'table' },
    h('thead', {}, h('tr', {}, headers.map(label => h('th', { scope: 'col' }, label)))),
    h('tbody', {}, rows)));
}

function pill(key) {
  return h('span', { class: `status ${key}` }, states[key] ?? key);
}

function sourcePending(source) {
  return !source.state || active.has(source.state) || source.state === 'interrupted';
}

function runRequests(run) {
  const sources = Object.values(run.progress.sources ?? {});
  if (!sources.some(source => source.requests)) return null;
  const total = { done: 0, failed: 0, remaining: 0, skipped: 0, exact: true };
  const running = active.has(run.state);
  for (const source of sources) {
    const counts = source.requests;
    total.exact &&= counts?.exact === true;
    if (!counts) continue;
    total.done += counts.done;
    total.failed += counts.failed;
    const pending = running && sourcePending(source) ? 'remaining' : 'skipped';
    total[pending] += counts.remaining;
  }
  return total;
}

function requestProgress(counts, running) {
  if (!counts) return running ? 'Количество запросов рассчитывается…' : '';
  const { done, remaining, exact, failed, skipped = 0 } = counts;
  const completed = exact ? `Запросы ${number.format(done)} из ${number.format(done + remaining + skipped)}`
    : `Выполнено запросов ${number.format(done)}`;
  const estimate = value => `${exact ? '' : 'не менее '}${number.format(value)}`;
  const omitted = skipped + (running ? 0 : remaining);
  const pending = running && (exact || remaining ? `осталось ${estimate(remaining)}` : 'число оставшихся уточняется');
  return [completed, pending, omitted && `не выполнено ${estimate(omitted)}`, failed && `с ошибкой ${number.format(failed)}`]
    .filter(Boolean).join(' · ');
}

function runStatus(run) {
  const running = active.has(run.state);
  const progress = requestProgress(runRequests(run), running);
  return h('div', { class: 'run-status' }, pill(run.state),
    progress && h('div', { class: 'caption' }, progress),
    running && run.progress.waiting && h('div', { class: 'caption' }, `Пауза до ${runTime(run.progress.waiting.until)}`),
    running && run.progress.exporting && h('div', { class: 'caption' }, 'Обработка и запись файлов'),
    run.progress.exportError && h('div', { class: 'caption' }, 'Ошибка экспорта'));
}

function modal(title, body, footer) {
  liveRunDetails = null;
  editor.replaceChildren(
    h('div', { class: 'dialog-head' }, h('h2', { id: 'dialog-title' }, title), btn('Закрыть', () => editor.close(), 'ghost compact')),
    h('div', { class: 'dialog-body' }, body),
  );
  if (footer) editor.append(h('div', { class: 'dialog-footer' }, footer));
  if (!editor.open) editor.showModal();
}

editor.addEventListener('close', () => {
  liveRunDetails = null;
  editor.replaceChildren();
});

function formModal(title, content, label, submit) {
  const error = h('div', { class: 'notice error', role: 'alert', hidden: true });
  const button = h('button', { type: 'submit', class: 'button primary' }, label);
  const form = h('form', { onsubmit: async event => {
    event.preventDefault();
    error.hidden = true;
    button.disabled = true;
    try { await submit(); }
    catch (failure) {
      error.textContent = failure.message;
      error.hidden = false;
      error.scrollIntoView({ block: 'nearest' });
    } finally { button.disabled = false; }
  } }, stack(content, error, cluster(button, btn('Отмена', () => editor.close(), 'ghost'))));
  modal(title, form);
}

async function refresh(force = false) {
  if (!state.user || state.user.must_change || state.refreshing) return;
  state.refreshing = true;
  try {
    const workspace = await call('workspace');
    const key = JSON.stringify(workspace);
    if (state.user && (force || key !== state.refreshKey)) {
      state.workspace = workspace;
      state.refreshKey = key;
      state.user = workspace.user;
      if (state.user.role === 'user' && ['api', 'templates'].includes(state.page)) state.page = 'jobs';
      render();
      if (liveRunDetails && editor.open) {
        const run = workspace.runs.find(item => item.id === liveRunDetails.id);
        if (run) liveRunDetails.update(run);
      }
    }
  } finally {
    state.refreshing = false;
  }
}

async function done(message) {
  editor.close();
  await refresh(true);
  showToast(message);
}

function loginPage() {
  const first = Boolean(state.user?.must_change);
  const username = input('', { required: true, autocomplete: 'username', autofocus: true });
  const password = input('', { required: true, type: 'password', autocomplete: 'current-password', autofocus: first });
  const newPassword = input('', { required: true, type: 'password', minlength: 10, autocomplete: 'new-password' });
  const error = h('div', { class: 'notice error', hidden: true, role: 'alert' });
  const submit = h('button', { type: 'submit', class: 'button primary' }, first ? 'Сменить пароль' : 'Войти');
  const form = h('form', { class: 'login-form', onsubmit: async event => {
    event.preventDefault();
    submit.disabled = true;
    error.hidden = true;
    try {
      state.user = first
        ? await call('changePassword', { current: password.value, password: newPassword.value })
        : await call('login', { username: username.value, password: password.value });
      render();
      await refresh(true);
    } catch (failure) {
      error.textContent = failure.message;
      error.hidden = false;
    } finally { submit.disabled = false; }
  } },
  h('div', {}, h('h2', {}, first ? 'Смените стартовый пароль' : 'Вход в приложение'),
    h('p', { class: 'caption' }, first ? `Аккаунт ${state.user.username}` : 'Локальный аккаунт на этом компьютере')),
  !first && field('Логин', username),
  field(first ? 'Текущий пароль' : 'Пароль', password),
  first && field('Новый пароль', newPassword, 'Не менее 10 символов'),
  error, submit,
  first && btn('Другой аккаунт', logout, 'ghost'));
  return h('div', { class: 'login-layout' }, h('div', { class: 'login-brand' }, brand(),
    h('div', {}, h('h1', {}, 'Выгрузки из API маркетплейсов'), h('p', {}, 'Wildberries, Ozon и Яндекс Маркет')),
    h('small', {}, 'Локальное приложение для Windows')), form);
}

async function logout() {
  await call('logout');
  if (editor.open) editor.close();
  Object.assign(state, { user: null, workspace: null, page: 'jobs', refreshKey: '' });
  render();
}

function render() {
  if (!state.user || state.user.must_change || !state.workspace) { root.replaceChildren(loginPage()); return; }
  const workspace = state.workspace;
  const nav = [['jobs', 'Выгрузки'], ['api', 'Подключения'], ['templates', 'Шаблоны запросов'],
    ['processings', 'Обработки'], ['logs', 'Журнал'], ['settings', 'Настройки']];
  const route = { jobs: jobPage, api: apiPage, templates: templatePage, processings: processingPage, logs: logPage, settings: settingsPage };
  const sidebar = h('aside', { class: 'sidebar' }, brand(),
    h('nav', { class: 'navigation', 'aria-label': 'Разделы' }, nav.filter(([id]) =>
      state.user.role !== 'user' || !['api', 'templates'].includes(id)).map(([id, label]) =>
      h('button', { type: 'button', 'aria-current': state.page === id ? 'page' : undefined, onclick: () => {
        state.page = id;
        render();
      } }, label))),
    h('div', { class: 'sidebar-bottom' }, h('strong', {}, state.user.username), h('small', {}, roles[state.user.role]),
      btn('Выйти из аккаунта', logout, 'compact')));
  const appBody = h('main', { class: 'workspace' },
    h('div', { class: 'topline' }, h('span', {}, 'Локальное рабочее пространство'),
      h('span', { class: 'online' }, workspace.quitting ? 'Ожидание завершения задач' : 'Расписание работает')),
    workspace.workerIssue && h('p', { class: 'notice error' }, workspace.workerIssue),
    route[state.page](workspace));
  root.replaceChildren(h('div', { class: 'layout' }, sidebar, appBody));
}

function folderTree(items, folders, pathFor) {
  const tree = { items: [], children: new Map() };
  const add = folderPath => folderPath.split('/').filter(Boolean).reduce((node, name) => {
    if (!node.children.has(name)) node.children.set(name, { items: [], children: new Map() });
    return node.children.get(name);
  }, tree);
  for (const folder of folders) add(folder.path);
  for (const item of items) add(pathFor(item)).items.push(item);
  return tree;
}

function groupFolders(items, folders, pathFor, renderItems) {
  const tree = folderTree(items, folders, pathFor);
  const draw = node => [
    node.items.length > 0 && renderItems(node.items),
    [...node.children].map(([name, child]) => h('details', { class: 'folder', open: true },
      h('summary', {}, name), draw(child))),
  ];
  return draw(tree);
}

function createFolder(kind, scope) {
  const name = input('', { required: true, placeholder: 'Заказы / Текущие', maxlength: 250 });
  formModal('Новая папка', field('Название или путь папки', name, 'Для подпапки разделите названия символом /'), 'Создать', async () => {
    await call('folder', { kind, scope, path: name.value });
    await done('Папка создана.');
  });
}

function scheduleLabel(value) {
  if (!value) return 'Вручную';
  return `${week.filter(([day]) => value.days.includes(day)).map(([, label]) => label).join(', ')} · ${value.time}`;
}

function jobPage(workspace) {
  const { jobs, runs, folders, options } = workspace;
  const hasTemplates = options.some(option => !option.archived);
  const jobIds = new Set(jobs.map(job => job.id));
  const shownRuns = runs.filter(run => !run.job_id || jobIds.has(run.job_id));
  const jobsTable = entries => table(['Выгрузка', 'Расписание', 'Статус', 'Действия'], entries.map(job => {
    const last = runs.find(run => run.job_id === job.id);
    return h('tr', {},
      h('td', { class: 'title-cell' }, h('strong', {}, job.value.name),
        h('small', {}, `${job.value.format.toUpperCase()} · Источников ${job.value.entries.length}`)),
      h('td', {}, scheduleLabel(job.value.schedule), job.pending_at && h('div', { class: 'caption' }, `Проверка ${time(job.pending_at)}`)),
      h('td', {}, last ? runStatus(last) : h('span', { class: 'caption' }, 'Ожидает запуска')),
      h('td', {}, cluster(
        btn('Запустить', () => start({ kind: 'job', jobId: job.id }), 'primary compact', job.active || workspace.quitting),
        btn('Изменить', () => jobEditor(job.value), 'compact'),
        btn('Удалить', () => deleteJobDialog(job), 'danger compact'),
      )));
  }));
  return [
    header('Выгрузки', 'Запускайте сохранённые наборы запросов и получайте результаты в XLSX или CSV.',
      cluster(btn('Новая папка', () => createFolder('job')), btn('Создать выгрузку', () => jobEditor(), 'primary', !hasTemplates))),
    h('div', { class: 'metrics' }, [
      ['Сохранено', jobs.length],
      ['В работе', shownRuns.filter(run => active.has(run.state)).length],
      ['С расписанием', jobs.filter(job => job.value.schedule).length],
    ].map(([label, value]) => h('div', { class: 'metric' }, h('small', {}, label), h('strong', {}, number.format(value))))),
    stack(
      section('Мои выгрузки', null, jobs.length || folders.some(item => item.kind === 'job')
        ? groupFolders(jobs, folders.filter(item => item.kind === 'job'), job => job.value.folder, jobsTable)
        : h('div', { class: 'empty' }, hasTemplates ? 'Создайте выгрузку и выберите источники данных.' : 'Настройщик ещё не открыл доступ к шаблонам.')),
      section('Последние запуски', btn('Журнал', () => { state.page = 'logs'; render(); }, 'ghost compact'),
        shownRuns.length ? runsTable(shownRuns.slice(0, 12)) : h('div', { class: 'empty' }, 'Здесь появится история запусков.')),
    ),
  ];
}

function deleteJobDialog(job) {
  formModal('Удалить выгрузку', [
    h('p', {}, `Удалить «${job.value.name}» из списка выгрузок?`),
    job.value.schedule && h('p', { class: 'caption' }, 'Новые запуски по её расписанию прекратятся.'),
    h('p', { class: 'caption' }, 'Историю и файлы запусков можно открыть в журнале.'),
  ], 'Удалить', async () => {
    await call('deleteJob', { jobId: job.id });
    await done('Выгрузка удалена.');
  });
}

function runsTable(runs) {
  return table(['Запуск', 'Состояние', 'Завершение', 'Получено строк', 'Действия'], runs.map(run => {
    const rows = Object.values(run.progress.sources ?? {}).reduce((sum, source) => sum + (source.isDependency ? 0 : source.rows), 0);
    const kind = { job: 'Выгрузка', test: 'Проверка черновика', dictionary: 'Справочник' }[run.kind];
    return h('tr', {}, h('td', { class: 'title-cell' }, h('strong', {}, run.name), h('small', {}, `${kind} · ${runTime(run.created)}`)),
      h('td', {}, runStatus(run)),
      h('td', { class: 'nowrap' }, runTime(run.finished_at), run.finished_at != null && h('div', { class: 'caption' }, runDuration(run))),
      h('td', {}, number.format(rows)),
      h('td', {}, cluster(btn('Подробнее', () => runDetails(run.id), 'compact'),
        active.has(run.state) && btn('Отменить', async () => {
          await call('cancel', { runId: run.id });
          await refresh(true);
        }, 'compact danger'))));
  }));
}

async function start(value, close = false) {
  await call('run', value);
  if (close) editor.close();
  await refresh(true);
  showToast('Запуск добавлен в очередь.');
}

function defaults(template) {
  return '{\n' + template.parameters.filter(item => item.defaultJson).map(item =>
    `  ${JSON.stringify(item.name)}: ${item.defaultJson}`).join(',\n') + '\n}';
}

function dateValue(param, update) {
  const timed = param.type === 'datetime';
  const mode = select([['fixed', 'Фиксированная'], ['relative', 'Относительно дня запуска']]);
  const fixed = input('', timed ? { placeholder: '2026-05-12T09:00:00+03:00' } : { type: 'date' });
  const days = input('0', { type: 'number', step: 1 });
  const clock = input('00:00', { type: 'time', step: 1 });
  const fixedField = field(param.label, fixed);
  const movingFields = stack(field('Смещение в днях', days, '−1 — вчера, 0 — сегодня, 1 — завтра'),
    timed && field('Время по часам компьютера', clock));
  function showMode() {
    fixedField.hidden = mode.value === 'relative';
    movingFields.hidden = !fixedField.hidden;
  }
  function save() {
    if (mode.value === 'relative') {
      update(JSON.stringify({ daysFromRun: days.valueAsNumber, ...(timed ? { time: clock.value } : {}) }));
    } else {
      update(fixed.value ? JSON.stringify(fixed.value) : '');
    }
  }
  mode.addEventListener('change', () => {
    if (mode.value === 'relative' && fixed.value) {
      const now = new Date();
      const picked = timed ? new Date(fixed.value) : new Date(`${fixed.value}T00:00:00Z`);
      if (Number.isFinite(picked.valueOf())) {
        const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
        const chosen = timed ? Date.UTC(picked.getFullYear(), picked.getMonth(), picked.getDate()) : picked.valueOf();
        days.value = String((chosen - today) / 86_400_000);
        if (timed) clock.value = [picked.getHours(), picked.getMinutes(), picked.getSeconds()]
          .map(part => String(part).padStart(2, '0')).join(':');
      }
    }
    showMode();
    save();
  });
  for (const control of [fixed, days, clock]) control.addEventListener('input', save);
  return {
    node: stack(field(`Тип даты — ${param.label}`, mode), fixedField, movingFields),
    set(fragment) {
      let value;
      try { value = fragment && JSON.parse(fragment); } catch { value = undefined; }
      const relative = value && typeof value === 'object' && Object.hasOwn(value, 'daysFromRun');
      mode.value = relative ? 'relative' : 'fixed';
      fixed.value = typeof value === 'string' ? value : '';
      days.value = relative ? value.daysFromRun ?? '' : '0';
      if (timed) clock.value = relative ? value.time ?? '' : '00:00';
      showMode();
    },
  };
}

function parameterValues(template, json, draft = false, onChange = () => {}) {
  const raw = textarea(json || defaults(template), 7, 'Параметры запуска JSON');
  let fragments;
  const setters = new Map();
  function sync() {
    const value = parseEditable(raw.value);
    if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('Ожидается объект параметров.');
    fragments = new Map(Object.entries(value).map(([key, child]) => [key, JSON.stringify(child)]));
    for (const [name, set] of setters) set(fragments.get(name));
  }
  try { sync(); } catch { fragments = new Map(); }
  function update(name, value) {
    if (value === '') fragments.delete(name);
    else fragments.set(name, value);
    raw.value = '{\n' + [...fragments].map(([key, child]) => `  ${JSON.stringify(key)}: ${child}`).join(',\n') + '\n}';
    onChange(raw.value);
  }
  raw.addEventListener('change', () => {
    try { sync(); } catch { /* Исполнитель покажет ошибку при сохранении. */ }
    onChange(raw.value);
  });
  const controls = template.parameters.map(param => {
    const reference = param.reference;
    if (reference?.mode === 'all') {
      const origin = state.workspace?.options.find(item => item.id === reference.templateId)?.name;
      const hint = reference.refresh === 'run'
        ? origin ? `Обновляется из запроса «${origin}» при каждом запуске` : 'Загружается при каждом запуске'
        : 'Все значения из сохранённого справочника';
      return h('div', { class: 'field' }, h('span', {}, param.label), h('small', { class: 'caption' }, hint));
    }
    if (['date', 'datetime'].includes(param.type)) {
      const date = dateValue(param, value => update(param.name, value));
      setters.set(param.name, date.set);
      date.set(fragments.get(param.name));
      return stack(date.node, reference && dictionaryPicker(template.id, param, draft, fragment => {
        update(param.name, fragment);
        date.set(fragment);
      }));
    }
    if (param.type === 'object' && param.properties && !reference) {
      const properties = Object.entries(param.properties).map(([name, spec]) => ({ name, label: name, ...spec }));
      const nested = parameterValues({ parameters: properties }, fragments.get(param.name), draft,
        value => update(param.name, /^\{\s*\}$/.test(value) ? '' : value));
      setters.set(param.name, nested.set);
      return h('details', { class: 'fold' }, h('summary', {}, param.label), nested.node);
    }
    let control;
    if (param.type === 'boolean') {
      const options = [['', 'Не передавать'], ['true', 'Да'], ['false', 'Нет']];
      if (param.nullable) options.push(['null', 'null']);
      control = select(options);
    } else if (['array', 'object'].includes(param.type)) {
      control = textarea('', 2, param.label);
      control.placeholder = param.type === 'array' ? '[]' : '{}';
    } else {
      control = input('', { type: 'text', placeholder: param.defaultJson || '',
        inputmode: ['integer', 'number'].includes(param.type) ? 'decimal' : null });
    }
    const stringType = param.type === 'string';
    const setControl = fragment => {
      if (stringType) {
        try { control.value = fragment && fragment !== 'null' ? JSON.parse(fragment) : ''; }
        catch { control.value = ''; }
      } else control.value = fragment ?? '';
    };
    setters.set(param.name, setControl);
    setControl(fragments.get(param.name));
    control.addEventListener('input', () => update(param.name,
      control.value && stringType ? JSON.stringify(control.value) : control.value));
    const required = param.required ? ' · обязательно' : '';
    const hint = `${param.type}${required}${param.batchSize ? ` · по ${param.batchSize} за запрос` : ''}`;
    return stack(field(param.label, control, hint), reference && dictionaryPicker(template.id, param, draft, fragment => {
      let next = fragment;
      if (reference.mode === 'many') {
        const current = fragments.get(param.name) ? editedJson(fragments.get(param.name), param.label) : [];
        if (!Array.isArray(current)) throw new Error('Выбор нескольких значений требует массива.');
        const item = parseEditable(fragment);
        if (!current.some(value => JSON.stringify(value) === fragment)) current.push(item);
        next = JSON.stringify(current);
      }
      update(param.name, next);
      setControl(next);
    }));
  });
  return {
    node: stack(controls.length ? fields(controls) : h('small', { class: 'caption' }, 'У запроса нет входных параметров.'),
      h('details', { class: 'fold' }, h('summary', {}, 'Ввод параметров в JSON'), raw)),
    value: () => raw.value,
    set(value) {
      raw.value = value ?? '{}';
      try { sync(); } catch {
        fragments = new Map();
        for (const set of setters.values()) set();
      }
    },
  };
}

function dictionaryPicker(templateId, param, draft, pick) {
  let offset = 0;
  const body = h('div', { class: 'stack' });
  const element = h('details', { class: 'fold' }, h('summary', {}, 'Справочник'), body);
  async function load() {
    const result = await call('dictionaryOptions', { templateId, parameter: param.name, draft, offset });
    body.replaceChildren(result.updated ? stack(
      h('small', { class: 'caption' }, `Обновлён ${time(result.updated)} · Строк ${number.format(result.rows)}`),
      h('div', { class: 'dictionary-list' }, result.values.map(value => btn(value.slice(0, 180), () => pick(value), 'compact'))),
      cluster(btn('Назад', () => { offset -= 100; return load(); }, 'compact', offset === 0),
        btn('Далее', () => { offset += 100; return load(); }, 'compact', !result.more)),
    ) : h('small', { class: 'caption' }, 'Справочник ещё не обновлён.'));
  }
  element.addEventListener('toggle', () => {
    if (element.open) load().catch(error => { body.textContent = error.message; });
  });
  return element;
}

function jobTemplatePicker(options, folders, initial, onSelect) {
  const connections = new Map(options.map(option => [option.connectionId, option.connection]));
  const connection = select([['', 'Выберите подключение'], ...connections], initial?.connectionId ?? '');
  const browser = stack();
  let chosen = initial;
  let path = initial?.folder ? initial.folder.split('/') : [];
  function navigate(nextPath) {
    path = nextPath;
    draw();
  }
  function draw() {
    if (!connection.value) { browser.replaceChildren(); return; }
    const tree = folderTree(options.filter(option => option.connectionId === connection.value),
      folders.filter(folder => folder.kind === 'template' && folder.scope === connection.value), option => option.folder);
    const current = path.reduce((node, name) => node.children.get(name), tree);
    const breadcrumbs = h('nav', { class: 'cluster', 'aria-label': 'Текущая папка' },
      path.length ? btn('Корневая папка', () => navigate([]), 'ghost compact') : h('strong', {}, 'Корневая папка'),
      path.map((part, index) => [
        h('span', { 'aria-hidden': 'true' }, '›'),
        index === path.length - 1 ? h('strong', { 'aria-current': 'location' }, part)
          : btn(part, () => navigate(path.slice(0, index + 1)), 'ghost compact'),
      ]));
    const entries = [...current.children.keys()].map(name => btn(`${name} ›`, () => navigate([...path, name]), 'compact'));
    const selectedHere = current.items.some(item => item.id === chosen?.id);
    const templates = select([['', 'Выберите шаблон', true], ...current.items.map(option =>
      [option.id, option.archived ? `${option.name} (архив)` : option.name])],
      selectedHere ? chosen.id : '', event => {
        chosen = current.items.find(item => item.id === event.target.value);
        onSelect(chosen);
        browser.querySelector('[data-selected-template]')?.remove();
      });
    browser.replaceChildren(stack(
      breadcrumbs,
      entries.length > 0 && h('nav', { class: 'cluster', 'aria-label': 'Подпапки шаблонов' }, entries),
      current.items.length ? field('Шаблон запроса', templates) : h('p', { class: 'caption' }, 'В этой папке нет доступных шаблонов.'),
      chosen && !selectedHere && h('small', { class: 'caption', 'data-selected-template': true }, `Выбран шаблон «${chosen.name}»`),
    ));
  }
  connection.addEventListener('change', () => {
    chosen = undefined;
    onSelect();
    navigate([]);
  });
  draw();
  return stack(field('Подключение', connection), browser);
}

function jobEditor(job) {
  const { options, processings, folders } = state.workspace;
  const name = input(job?.name, { required: true, maxlength: 160 });
  const folder = input(job?.folder, { maxlength: 250, placeholder: 'Рабочие / Заказы' });
  const format = select([['xlsx', 'Excel (.xlsx)'], ['csv', 'CSV']], job?.format ?? 'xlsx');
  const campaignReport = checkbox('Свод РК по брендам', job?.campaignReport);
  const enabled = checkbox('Запуск по расписанию', Boolean(job?.schedule));
  const days = week.map(([day, label]) => [day, checkbox(label, job?.schedule?.days.includes(day) ?? false)]);
  const scheduledTime = input(job?.schedule?.time ?? '09:00', { type: 'time' });
  const schedule = stack(h('div', { class: 'days' }, days.map(([, item]) => item.label)), field('Время компьютера', scheduledTime));
  schedule.hidden = !enabled.control.checked;
  enabled.control.addEventListener('change', () => { schedule.hidden = !enabled.control.checked; });
  const sourceList = stack();
  const sources = [];
  function add(entry) {
    const initial = options.find(option => option.id === entry?.templateId);
    const settings = stack();
    const item = {};
    const card = h('div', { class: 'source-card' },
      cluster(h('h3', {}, 'Источник'), btn('Убрать', () => { sources.splice(sources.indexOf(item), 1); card.remove(); }, 'compact ghost')),
      jobTemplatePicker(options.filter(option => !option.archived || option.id === initial?.id),
        folders, initial, template => bind(template)), settings);
    function bind(template, previous) {
      if (!template) {
        settings.replaceChildren();
        if (previous) settings.append(h('p', { class: 'notice error' }, 'Шаблон недоступен. Выберите другой источник.'));
        item.value = () => { throw new Error('Выберите доступный шаблон.'); };
        return;
      }
      const env = select([['production', 'Рабочая'], ['sandbox', 'Песочница', !template.sandbox]], previous?.environment ?? 'production');
      const params = parameterValues(template, previous?.values);
      const available = processings.filter(item => item.templateId === template.id);
      const modes = [['', 'Без обработки'], ...available.map(item => [item.id, item.name])];
      if (previous?.processingId && !available.some(item => item.id === previous.processingId)) {
        modes.push([previous.processingId, 'Сохранённая обработка недоступна', true]);
      }
      const processing = select(modes, previous?.processingId ?? '');
      settings.replaceChildren(template.sandbox ? field('Среда API', env) : '',
        modes.length > 1 ? field('Обработка', processing) : '', params.node);
      item.value = () => ({ templateId: template.id, environment: env.value, values: params.value(),
        processingId: processing.value || undefined });
    }
    bind(initial, entry);
    sources.push(item);
    sourceList.append(card);
  }
  for (const entry of job?.entries ?? [null]) add(entry);
  formModal(job ? 'Настройка выгрузки' : 'Новая выгрузка', [
    fields(field('Название', name), field('Папка', folder), field('Формат файлов', format)),
    campaignReport.label, enabled.label, schedule, h('h3', {}, 'Источники'), sourceList,
    cluster(btn('Добавить источник', () => add(), 'compact')),
  ], 'Сохранить', async () => {
    await call('job', { id: job?.id, name: name.value, folder: folder.value, format: format.value,
      campaignReport: campaignReport.control.checked,
      entries: sources.map(item => item.value()),
      schedule: enabled.control.checked ? { days: days.filter(([, item]) => item.control.checked).map(([day]) => day), time: scheduledTime.value } : null,
    });
    await done('Выгрузка сохранена.');
  });
}

function processingPage(workspace) {
  const editor = state.user.role !== 'user';
  const supported = workspace.options.some(option => !option.archived);
  return [
    header('Обработки', 'Подготовьте данные для Excel или CSV. Обработку можно добавить в новую выгрузку или применить к результату в журнале.',
      editor && btn('Новая обработка', () => processingEditor(), 'primary', !supported)),
    section('Сохранённые обработки', null,
      workspace.processings.length
        ? table(['Обработка', 'Шаблон запроса', 'Шаги', 'Действия'], workspace.processings.map(processing => {
          const template = workspace.options.find(option => option.id === processing.templateId);
          return h('tr', {}, h('td', { class: 'title-cell' }, h('strong', {}, processing.name)),
          h('td', {}, template?.name),
          h('td', {}, number.format(processing.steps.length + 1)),
          h('td', {}, cluster(editor && btn('Изменить', () => processingEditor(processing), 'compact'),
            editor && btn('Удалить', () => formModal('Удалить обработку', h('p', {}, processing.name), 'Удалить', async () => {
              await call('deleteProcessing', { processingId: processing.id });
              await done('Обработка удалена.');
            }), 'compact danger'),
            btn('История запусков', () => { state.page = 'logs'; render(); }, 'compact'))));
        }))
        : h('div', { class: 'empty' }, editor && !supported
          ? 'Опубликуйте шаблон запроса, чтобы создать обработку.'
          : 'Сохранённых обработок пока нет.')),
  ];
}

function selectConnection(connections) {
  const selected = connections.find(connection => connection.id === state.connectionId) ?? connections[0];
  state.connectionId = selected?.id;
  return selected;
}

function connectionMenu(connections, selected) {
  return h('div', { class: 'card connections' }, connections.map(connection =>
    h('button', { type: 'button', class: 'connection-choice', 'aria-pressed': String(connection.id === selected?.id), onclick: () => {
      state.connectionId = connection.id;
      render();
    } }, connection.name)));
}

function apiPage({ connections }) {
  const selected = selectConnection(connections);
  return [
    header('Подключения', 'Адреса API, ключи и общие лимиты.', btn('Новое подключение', () => connectionEditor(), 'primary')),
    h('div', { class: 'split' }, connectionMenu(connections, selected), selected &&
      section(selected.name, cluster(btn('Авторизация', () => credentialsEditor(selected), 'compact', !selected.profiles.length),
        btn('Подключение', () => connectionEditor(selected), 'compact'),
        btn('Открыть шаблоны', () => { state.page = 'templates'; render(); }, 'compact')),
      h('div', { class: 'card-body stack' }, selected.endpoints.map(endpoint =>
        h('div', {}, h('strong', {}, endpoint.name), h('div', { class: 'mono' }, endpoint.url),
          endpoint.sandbox && h('div', { class: 'mono caption' }, 'Песочница · ', endpoint.sandbox)))))),
  ];
}

function templatePage({ connections, templates, folders }) {
  const selected = selectConnection(connections);
  const archived = Boolean(state.showArchivedTemplates);
  const records = templates.filter(record => record.draft.connectionId === selected?.id && record.archived === archived);
  const entries = list => list.map(record => h('div', { class: 'template-entry' },
    h('div', {}, h('h3', {}, record.draft.name),
      h('p', { class: 'mono' }, h('span', { class: 'tag' }, record.draft.method), ' ', record.draft.path),
      h('small', { class: 'caption' }, record.version ? `Версия ${record.version}` : 'Черновик'),
      record.dictionary && h('small', { class: 'caption' }, ` · Справочник обновлён ${time(record.dictionary.updated)}`)),
    cluster(
      record.archived ? btn('Восстановить', () => archiveTemplate(record, false), 'compact')
        : btn('Настроить', () => templateEditor(selected, record), 'compact'),
      !record.archived && btn('Тест', () => singleRun(record, 'test'), 'compact'),
      btn('Где используется', () => templateUsageDialog(record), 'compact'),
      h('details', { class: 'fold' }, h('summary', {}, 'Ещё'),
        cluster(
          btn('Образец ответа', () => showSample(record.id), 'compact', !record.sampleRunId),
          btn('Версии', () => showVersions(record.id), 'compact', !record.version),
          !record.archived && btn('Обновить справочник', () => singleRun(record, 'dictionary'), 'compact', !record.version),
          btn('Экспорт шаблона', () => call('pack', { templateId: record.id }), 'compact'),
          !record.archived && btn('Архивировать', () => archiveTemplate(record, true), 'compact'),
          btn('Удалить', () => templateUsageDialog(record, true), 'compact danger'),
        )),
    )));
  const visibleFolders = archived ? [] : folders.filter(item => item.kind === 'template' && item.scope === selected?.id);
  return [
    header('Шаблоны запросов', null,
      cluster(btn('Импорт пакета', async () => {
        const result = await call('import');
        if (result) {
          state.showArchivedTemplates = false;
          await refresh(true);
          showToast(`Импортировано шаблонов: ${result.templates}.`);
        }
      }), !archived && btn('Новый шаблон', () => templateEditor(selected), 'primary', !selected))),
    h('div', { class: 'split' }, connectionMenu(connections, selected), selected &&
      section(archived ? `Архив · ${selected.name}` : selected.name, cluster(
        btn(archived ? 'Действующие шаблоны' : 'Архив', () => {
          state.showArchivedTemplates = !archived;
          render();
        }, 'compact'),
        !archived && btn('Папка', () => createFolder('template', selected.id), 'compact'),
        !archived && btn('Экспорт', () => call('pack', { connectionId: selected.id }), 'compact')),
      records.length || visibleFolders.length
        ? groupFolders(records, visibleFolders, item => item.draft.folder, entries)
        : h('div', { class: 'empty' }, archived ? 'Архив пуст.' : 'Создайте шаблон для этого подключения.'))),
  ];
}

async function archiveTemplate(record, archived) {
  await call('archiveTemplate', { templateId: record.id, archived });
  if (editor.open) {
    await done(archived ? 'Шаблон в архиве.' : 'Шаблон восстановлен.');
  } else {
    await refresh(true);
    showToast(archived ? 'Шаблон в архиве.' : 'Шаблон восстановлен.');
  }
}

async function templateUsageDialog(record, deleting = false) {
  const usage = await call('templateUsage', { templateId: record.id });
  const groups = [['Выгрузки', usage.jobs], ['Обработки', usage.processings],
    ['Зависимые шаблоны', usage.templates], ['Текущие запуски', usage.runs]];
  const used = groups.some(([, entries]) => entries.length);
  modal(deleting ? 'Удалить шаблон' : 'Где используется', [
    h('h3', {}, record.draft.name),
    used ? groups.filter(([, entries]) => entries.length).map(([label, entries]) => stack(
      h('strong', {}, label),
      h('ul', {}, entries.map(entry => h('li', {},
        [entry.connection, entry.folder, entry.name].filter(Boolean).join(' / '),
        entry.indirect && ' · через зависимый запрос',
        entry.draftOnly && ' · связь в черновике'))),
    )) : h('p', { class: 'caption' }, 'У шаблона нет действующих ссылок.'),
    deleting && used && h('p', { class: 'notice' }, 'Для удаления снимите ссылки или перенесите шаблон в архив.'),
  ], [
    !record.archived && btn('Архивировать', () => archiveTemplate(record, true)),
    deleting ? btn('Удалить', async () => {
      await call('deleteTemplate', { templateId: record.id });
      await done('Шаблон удалён.');
    }, 'danger', used) : btn('Удалить…', () => templateUsageDialog(record, true), 'danger'),
  ]);
}

function connectionEditor(connection) {
  const name = input(connection?.name, { required: true, maxlength: 160 });
  const account = input(connection?.account ?? 'seller', { required: true });
  const endpoints = textarea(pretty(connection?.endpoints ?? [{ id: 'primary', name: 'Основной', url: 'https://api.example.com' }]),
    8, 'Адреса подключения');
  const profiles = textarea(pretty(connection?.profiles ?? []), 7, 'Профили авторизации');
  const limits = textarea(pretty(connection?.limits ?? []), 5, 'Общие лимиты');
  formModal(connection ? 'Подключение к API' : 'Новое подключение', [
    fields(field('Название', name), field('Учётная область лимитов', account, 'Одинаковое имя для одного кабинета')),
    field('Именованные адреса (JSON)', endpoints, 'Для тестового адреса используйте поле sandbox.'),
    field('Профили авторизации (JSON)', profiles, 'Здесь задаются имена заголовков. Значения вводятся в разделе «Авторизация».'),
    field('Общие ограничения (JSON)', limits),
  ], 'Сохранить', async () => {
    state.connectionId = await call('connection', { json: pretty({
      id: connection?.id, policyId: connection?.policyId, name: name.value, account: account.value,
      endpoints: editedJson(endpoints.value, 'Адреса'),
      profiles: editedJson(profiles.value, 'Профили авторизации'),
      limits: editedJson(limits.value, 'Ограничения'),
    }) });
    await done('Подключение сохранено.');
  });
}

function credentialsEditor(connection) {
  const address = select(connection.endpoints.map(endpoint => [endpoint.id, endpoint.name]));
  const profile = select(connection.profiles.map(item => [item.id, item.name]));
  const environment = select([['production', 'Рабочая'], ['sandbox', 'Песочница']]);
  const expiration = input('', { type: 'date' });
  const context = () => ({ connectionId: connection.id, endpointId: address.value, profileId: profile.value, environment: environment.value });
  const keys = stack();
  const status = h('p', { class: 'caption', 'aria-live': 'polite' });
  let controls;
  let version = 0;
  async function bind() {
    const current = ++version;
    environment.options[1].disabled = !connection.endpoints.find(item => item.id === address.value).sandbox;
    if (environment.options[1].disabled) environment.value = 'production';
    const definition = connection.profiles.find(item => item.id === profile.value);
    controls = definition.headers.map(header => [header.key, input('', { type: 'password', autocomplete: 'new-password', required: true }), header.name]);
    keys.replaceChildren(...controls.map(([, control, name]) => field(name, control)));
    expiration.value = '';
    status.textContent = 'Проверяем сохранённую авторизацию…';
    try {
      const value = await call('credentials', context());
      if (current !== version) return;
      status.textContent = value.configured ? `Авторизация сохранена${value.expires ? ` · действует до ${time(value.expires)}` : ''}.` : 'Авторизация ещё не настроена.';
      expiration.value = value.expires ? new Date(value.expires).toISOString().slice(0, 10) : '';
    } catch (error) {
      if (current === version) status.textContent = error.message;
    }
  }
  for (const item of [address, environment, profile]) item.addEventListener('change', bind);
  formModal(`Авторизация · ${connection.name}`, [
    fields(field('Адрес', address), field('Профиль', profile), field('Среда', environment)),
    status, keys, field('Дата окончания действия', expiration, 'Оставьте пустой, если дата неизвестна или токен бессрочный.'),
    cluster(btn('Очистить сохранённые значения', async () => {
      await call('credentials', { ...context(), save: true, clear: true });
      await bind();
    }, 'ghost compact')),
  ], 'Сохранить ключи', async () => {
    await call('credentials', { ...context(), save: true, expires: expiration.value,
      values: Object.fromEntries(controls.map(([key, control]) => [key, control.value])) });
    await done('Авторизация обновлена.');
  });
  bind();
}

function templateEditor(connection, record) {
  const draft = record ? parseEditable(record.draftJson) : {
    method: 'GET', path: '/', parameters: [], pagination: { type: 'none' }, response: { rows: '$', columns: [] }, limits: [],
  };
  const name = input(draft.name, { required: true, maxlength: 160 });
  const folder = input(draft.folder, { placeholder: 'Заказы / FBS' });
  const endpoint = select(connection.endpoints.map(item => [item.id, item.name]), draft.endpointId);
  const profile = select([['', 'По умолчанию'], ...connection.profiles.map(item => [item.id, item.name])], draft.profileId ?? '');
  const method = select(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].map(value => [value, value]), draft.method);
  const path = input(draft.path, { required: true, placeholder: '/v2/campaigns/{campaignId}/…' });
  const available = checkbox('Доступен пользователям в выгрузках', draft.available);
  const safe = checkbox('Безопасно повторять при временной ошибке', draft.safeToRetry);
  const recovery = select([['decision', 'Решение пользователя'], ['resume', 'Продолжить с контрольной точки'], ['restart', 'Начать источник заново']],
    draft.recovery ?? 'decision');
  const parameters = textarea(pretty(draft.parameters), 9, 'Определения параметров');
  const rows = input(draft.response.rows, { placeholder: 'result.items или $ для корня' });
  const columnMap = textarea(pretty(draft.response.columns ?? []), 5, 'Колонки');
  const { columns: ignoredColumns, rows: ignoredRows, ...responseOptions } = draft.response;
  const response = textarea(pretty(responseOptions), 6, 'Дополнительные правила ответа');
  const pagination = textarea(pretty(draft.pagination), 7, 'Правила пагинации');
  const mode = select([
    ['none', 'Без пагинации'], ['integer-cursor', 'Числовой курсор'], ['flag-cursor', 'Курсор и флаг'],
    ['token', 'Строковый токен'], ['page', 'Номер страницы'], ['offset', 'Смещение'], ['link', 'Ссылка на страницу'],
  ], draft.pagination?.type);
  mode.addEventListener('change', () => {
    const examples = {
      'integer-cursor': { target: 'query', parameter: 'next', cursor: 'next', initial: 0 },
      'flag-cursor': { target: 'body', parameter: 'cursor', cursor: 'cursor', flag: 'has_next' },
      token: { target: 'query', parameter: 'pageToken', cursor: 'result.paging.nextPageToken' },
      page: { target: 'query', parameter: 'page', initial: 1, end: 'empty' },
      offset: { target: 'body', parameter: 'offset', initial: 0, end: 'short', sizeParameter: 'limit' },
      link: { cursor: 'next' },
    };
    pagination.value = pretty({ type: mode.value, ...examples[mode.value] });
  });
  const rules = textarea(pretty(draft.limits ?? []), 5, 'Лимиты запроса');
  const period = textarea(pretty(draft.period ?? null), 4, 'Разбиение периода');
  const advanced = textarea(pretty({ maxBodyBytes: draft.maxBodyBytes, maxResponseBytes: draft.maxResponseBytes, timeoutMs: draft.timeoutMs }),
    4, 'Размеры и тайм-аут');
  const parameterName = input('', { placeholder: 'Имя' });
  const parameterLocation = select([['query', 'Строка запроса'], ['body', 'JSON-тело'], ['path', 'Путь'],
    ['header', 'Заголовок'], ['input', 'Форма запуска']]);
  const parameterType = select(['string', 'integer', 'number', 'boolean', 'date', 'datetime', 'array', 'object'].map(value => [value, value]));
  const parameterRequired = checkbox('Обязательный');
  const columnPath = input('', { placeholder: 'address.fullAddress' });
  const columnLabel = input('', { placeholder: 'Адрес' });
  const sampleBox = h('pre', { class: 'pre mono', hidden: true });
  const fold = (label, ...children) => h('details', { class: 'fold' }, h('summary', {}, label), stack(children));
  async function save() {
    const result = {
      ...draft,
      ...editedJson(advanced.value, 'Размеры и тайм-аут'),
      id: record?.id, name: name.value, folder: folder.value, connectionId: connection.id, endpointId: endpoint.value,
      profileId: profile.value || undefined, method: method.value, path: path.value, available: available.control.checked,
      safeToRetry: safe.control.checked, recovery: recovery.value,
      parameters: editedJson(parameters.value, 'Параметры'),
      pagination: editedJson(pagination.value, 'Пагинация'),
      limits: editedJson(rules.value, 'Лимиты'),
      period: editedJson(period.value, 'Период') ?? undefined,
      response: { ...editedJson(response.value, 'Ответ'), rows: rows.value, columns: editedJson(columnMap.value, 'Колонки') },
    };
    return call('draft', { json: pretty(result) });
  }
  formModal(record ? 'Черновик шаблона' : 'Новый шаблон', [
    fields(field('Название', name), field('Папка', folder), field('Адрес подключения', endpoint), field('Авторизация', profile),
      field('Метод', method), field('Путь запроса', path)),
    available.label,
    fold('Параметры запроса', fields(field('Имя', parameterName), field('Расположение', parameterLocation), field('Тип', parameterType)),
      cluster(parameterRequired.label, btn('Добавить параметр', () => {
        if (!parameterName.value.trim()) throw new Error('Введите имя параметра.');
        const current = editedJson(parameters.value, 'Параметры');
        current.push({ name: parameterName.value.trim(), where: parameterLocation.value, type: parameterType.value,
          required: parameterRequired.control.checked });
        parameters.value = pretty(current);
        parameterName.value = '';
      }, 'compact')), parameters),
    fold('Пагинация и период', field('Механизм', mode), pagination, field('Разбиение периода (JSON)', period)),
    fold('Ответ и колонки', field('Путь к массиву строк', rows,
      'Путь $ выбирает корень ответа. Для одиночного объекта включите singleObject в правилах ниже.'),
      fields(field('Путь поля', columnPath), field('Имя колонки', columnLabel)),
      cluster(btn('Добавить колонку', () => {
        if (!columnLabel.value.trim()) throw new Error('Введите имя колонки.');
        const current = editedJson(columnMap.value, 'Колонки');
        current.push({ path: columnPath.value.trim() || '$', name: columnLabel.value.trim() });
        columnMap.value = pretty(current);
        columnPath.value = '';
        columnLabel.value = '';
      }, 'compact'), record?.sampleRunId && btn('Посмотреть образец', async () => {
        const result = await call('sample', { templateId: record.id });
        sampleBox.hidden = !result;
        sampleBox.textContent = result ? pretty(result.shape) : '';
      }, 'compact')),
      sampleBox, columnMap, field('Проверка успеха, массивы и дедупликация (JSON)', response)),
    fold('Лимиты и восстановление', safe.label, field('После прерывания', recovery),
      field('Дополнительные ограничения (JSON)', rules), field('Размеры и тайм-аут (JSON)', advanced)),
    cluster(btn('Сохранить и опубликовать версию', async () => {
      const templateId = await save();
      const version = await call('publish', { templateId });
      await done(`Версия ${version} опубликована.`);
    }), btn('Сохранить и протестировать', async () => {
      const id = await save();
      await refresh(true);
      const next = state.workspace.templates.find(item => item.id === id);
      if (next) singleRun(next, 'test');
    })),
  ], 'Сохранить черновик', async () => {
    await save();
    await done('Черновик сохранён.');
  });

}

function singleRun(record, kind) {
  const draft = kind === 'test';
  const definition = draft ? record.draft : record.published;
  if (!definition) throw new Error('Опубликуйте версию шаблона.');
  const raw = draft ? parseEditable(record.draftJson) : definition;
  const template = { ...definition, parameters: definition.parameters.map((item, index) => ({
    ...item, defaultJson: raw.parameters[index].default === undefined ? '' : JSON.stringify(raw.parameters[index].default),
  })) };
  const connection = state.workspace.connections.find(item => item.id === definition.connectionId);
  const sandbox = Boolean(connection?.endpoints.find(item => item.id === definition.endpointId)?.sandbox);
  const environment = select([['production', 'Рабочая'], ['sandbox', 'Песочница', !sandbox]], sandbox && draft ? 'sandbox' : 'production');
  const params = parameterValues(template, undefined, draft);
  const hasDependencies = template.parameters.some(parameter => parameter.reference?.refresh === 'run');
  formModal(draft ? 'Проверка черновика' : 'Обновление справочника', [
    h('p', { class: 'caption' }, draft
      ? hasDependencies ? 'Сначала загрузятся все зависимые данные. Тест основного запроса сохранит образец первой страницы.' :
        'Исполнитель получит первую страницу и сохранит образец ответа.'
      : 'После успешной загрузки новые значения станут доступны в зависимых параметрах.'),
    field('Среда API', environment), params.node,
  ], draft ? 'Выполнить запрос' : 'Обновить', () => start({ kind, entry: {
    templateId: record.id, environment: environment.value, values: params.value(),
  } }, true));
}

async function showSample(templateId) {
  const result = await call('sample', { templateId });
  if (!result) throw new Error('Сначала выполните тест черновика.');
  modal('Образец ответа', [
    h('h3', {}, 'Обнаруженная структура'),
    h('pre', { class: 'pre mono' }, pretty(result.shape)),
    h('h3', {}, 'Ответ API'),
    result.truncated && h('small', { class: 'caption' }, 'Показаны первые 25 000 символов. Полный образец сохранён на диске.'),
    h('pre', { class: 'pre mono' }, result.text),
  ]);
}

async function showVersions(templateId) {
  const versions = await call('versions', { templateId });
  modal('Версии шаблона', versions.map(version => h('details', { class: 'fold' },
    h('summary', {}, `Версия ${version.version} · ${time(version.published)}`), h('pre', { class: 'pre mono' }, version.json))));
}

async function runDetails(runId, expectedView) {
  const run = await call('runInfo', { runId });
  if (expectedView && (liveRunDetails !== expectedView || !editor.open)) return;
  const logs = btn('Открыть журнал', () => showLogs({ runId }));
  const overview = stack();
  const sourceHeaders = run.sources.map(() => h('div'));
  const results = run.sources.map((source, index) => {
    const progress = run.progress.sources?.[index] ?? {};
    const available = state.workspace.processings.filter(item => item.templateId === source.templateId);
    const ready = !active.has(run.state) && (progress.rows > 0 || progress.state === 'completed');
    const saved = Object.entries(run.progress.processingExports ?? {}).filter(([key]) => key.startsWith(`${index}:`));
    return h('div', { class: 'source-card' }, sourceHeaders[index],
      source.processingName && h('small', { class: 'caption' }, `Обработка · ${source.processingName}`),
      source.values && h('details', { class: 'fold' }, h('summary', {}, 'Параметры запуска'), h('pre', { class: 'pre mono' }, source.values)),
      cluster(progress.rows > 0 && btn('Просмотр строк', () => showPreview(runId, index, 0), 'compact'),
        ready && available.length > 0 &&
          btn('Применить обработку', () => processSavedRun(runId, index, available), 'compact')),
      saved.map(([key, output]) => cluster(h('small', { class: 'caption' },
        [output.name, output.format.toUpperCase(), output.finishedAt && `Готово ${runTime(output.finishedAt)}`].filter(Boolean).join(' · ')),
        btn('Открыть обработанные файлы', () => call('openOutput', {
          runId, source: index, processingId: key.split(':')[1],
        }), 'compact'))));
  });
  const hasResults = run.sources.some((source, index) => {
    const progress = run.progress.sources?.[index];
    return !source.isDependency && (progress?.rows > 0 || progress?.state === 'completed');
  });
  async function exportFile(format) {
    await call('export', { runId, format });
    await refresh(true);
    await runDetails(runId);
    showToast('Файлы экспорта готовы.');
  }
  function paintProgress(summary) {
    overview.replaceChildren(runStatus(summary), cluster(
      h('small', { class: 'caption' }, `Запуск ${runTime(summary.created)}`),
      summary.finished_at != null && h('small', { class: 'caption' }, `Завершение ${runTime(summary.finished_at)}`),
      summary.finished_at != null && h('small', { class: 'caption' }, `Длительность ${runDuration(summary)}`),
    ));
    run.sources.forEach((source, index) => {
      const progress = summary.progress.sources?.[index] ?? {};
      const requests = requestProgress(progress.requests, active.has(summary.state) && sourcePending(progress));
      const version = source.version ? `Версия ${source.version}` : 'Черновик';
      const environment = source.environment === 'sandbox' ? 'Песочница' : 'Рабочая среда';
      sourceHeaders[index].replaceChildren(h('div', { class: 'run-status source-status' },
        cluster(h('h3', {}, source.name), progress.state && pill(progress.state)),
        source.isDependency && h('small', { class: 'caption' }, 'Зависимый запрос'),
        h('p', { class: 'caption' }, `${version} · ${environment} · Строк ${number.format(progress.rows ?? 0)}`),
        requests && h('div', { class: 'caption' }, requests),
        progress.error && h('p', { class: 'notice error' }, progress.error),
        progress.warning && h('p', { class: 'notice' }, progress.warning)));
    });
  }
  paintProgress(run);
  modal(run.name, [
    overview,
    run.progress.error && h('p', { class: 'notice error' }, run.progress.error),
    run.progress.exportError && h('p', { class: 'notice error' }, run.progress.exportError),
    results,
  ], [
    logs,
    btn(run.pinned ? 'Открепить' : 'Закрепить результат', async () => {
      await call('pin', { runId, pinned: !run.pinned });
      await runDetails(runId);
    }),
    hasResults && !active.has(run.state) && btn('XLSX', () => exportFile('xlsx')),
    hasResults && !active.has(run.state) && btn('CSV', () => exportFile('csv')),
    run.progress.exportPath && btn('Открыть папку файлов', () => call('openOutput', { runId }), 'primary'),
  ]);
  if (active.has(run.state)) {
    const view = { id: runId, loading: false, update(summary) {
      paintProgress(summary);
      if (active.has(summary.state) || view.loading) return;
      view.loading = true;
      runDetails(runId, view).catch(error => {
        if (liveRunDetails === view) showToast(error.message, true);
      }).finally(() => { view.loading = false; });
    } };
    liveRunDetails = view;
  }
}

function processSavedRun(runId, source, choices) {
  const processing = select(choices.map(item => [item.id, item.name]));
  const format = select([['xlsx', 'Excel (.xlsx)'], ['csv', 'CSV']]);
  formModal('Обработать сохранённый результат', fields(field('Обработка', processing), field('Формат результата', format)),
    'Создать файл', async () => {
      await call('export', { runId, source, processingId: processing.value, format: format.value });
      await runDetails(runId);
      showToast('Файл обработки готов.');
    });
}

async function showPreview(runId, source, offset) {
  const result = await call('preview', { runId, source, offset });
  modal('Данные запуска', [
    h('p', { class: 'caption' }, result.rows.length ? `Строки ${offset + 1}–${offset + result.rows.length}` : 'Нет строк для просмотра.'),
    h('pre', { class: 'pre mono' }, pretty(result.rows)),
  ], [
    btn('К запуску', () => runDetails(runId)),
    btn('Предыдущая страница', () => showPreview(runId, source, Math.max(0, offset - 30)), '', offset === 0),
    btn('Следующая страница', () => showPreview(runId, source, offset + 30), 'primary', !result.more),
  ]);
}

async function showLogs(context) {
  const content = await call('logs', context);
  modal(context.runId ? 'Подробный журнал запуска' : 'Общий журнал', [
    h('pre', { class: 'pre mono' }, content || 'За выбранный период журнал пуст.'),
  ], [
    context.runId && btn('К запуску', () => runDetails(context.runId)),
    btn('Сохранить журнал', () => call('saveLog', context), 'primary', !content),
  ]);
}

function logPage(workspace) {
  const day = input('', { type: 'date' });
  return [
    header('Журнал', 'Статусы запусков, HTTP-ответы и повторные попытки.'),
    stack(state.user.role !== 'user' && section('Общий журнал', null,
      h('div', { class: 'card-body cluster' }, field('Дата (по умолчанию сегодня)', day),
        btn('Открыть записи', () => showLogs({ day: day.value }), 'primary'))),
    section('История запусков', null, workspace.runs.length ? runsTable(workspace.runs) : h('div', { class: 'empty' }, 'Запусков пока нет.'))),
  ];
}

function settingsPage(workspace) {
  const admin = state.user.role === 'admin';
  const roleChoices = Object.entries(roles);
  return [
    header('Настройки', 'Аккаунты и хранение данных на этом компьютере.'),
    stack(
      section('Аккаунт', btn('Изменить пароль', passwordEditor, 'compact'),
        h('div', { class: 'card-body' }, h('strong', {}, state.user.username), ' · ', roles[state.user.role])),
      admin && section('Срок хранения', btn('Изменить', () => retentionEditor(workspace.retention), 'compact'),
        h('div', { class: 'card-body' }, `Данные — ${workspace.retention.dataDays} дн. · Журналы — ${workspace.retention.logsDays} дн.`)),
      admin && section('Локальные аккаунты', btn('Создать аккаунт', userEditor, 'compact primary'),
        table(['Логин', 'Роль', 'Действия'], workspace.users.map(user => {
          const selected = select(roleChoices, user.role);
          selected.disabled = user.id === state.user.id;
          return h('tr', {}, h('td', {}, user.username), h('td', {}, selected),
            h('td', {}, btn('Сохранить роль', async () => {
              await call('setRole', { id: user.id, role: selected.value });
              await refresh(true);
              showToast('Роль обновлена.');
            }, 'compact', user.id === state.user.id)));
        }))),
      section('Приложение', btn('Выйти после выполнения задач', () => call('exit'), 'compact', workspace.quitting),
        h('div', { class: 'card-body caption' }, 'Закрытие окна оставляет расписание активным в системном трее.')),
    ),
  ];
}

function passwordEditor() {
  const current = input('', { type: 'password', required: true, autocomplete: 'current-password' });
  const password = input('', { type: 'password', required: true, minlength: 10, autocomplete: 'new-password' });
  formModal('Смена пароля', [field('Текущий пароль', current), field('Новый пароль', password)], 'Сменить', async () => {
    await call('changePassword', { current: current.value, password: password.value });
    await done('Пароль изменён.');
  });
}

function retentionEditor(retention) {
  const data = input(retention.dataDays, { type: 'number', min: 1, max: 3650, required: true });
  const logs = input(retention.logsDays, { type: 'number', min: 1, max: 3650, required: true });
  formModal('Срок хранения', [
    fields(field('Результаты, дней', data), field('Журналы, дней', logs)),
    h('p', { class: 'caption' }, 'Закреплённые результаты и текущие справочники сохраняются до открепления или обновления.'),
  ], 'Сохранить', async () => {
    await call('retention', { dataDays: data.valueAsNumber, logsDays: logs.valueAsNumber });
    await done('Срок хранения обновлён.');
  });
}

function userEditor() {
  const username = input('', { required: true, maxlength: 48 });
  const password = input('', { type: 'password', required: true, minlength: 10, autocomplete: 'new-password' });
  const role = select(Object.entries(roles), 'user');
  formModal('Локальный аккаунт', [
    field('Логин', username), field('Стартовый пароль', password, 'Пользователь сменит пароль при первом входе.'), field('Роль', role),
  ], 'Создать', async () => {
    await call('createUser', { username: username.value, password: password.value, role: role.value });
    await done('Аккаунт создан.');
  });
}

render();
call('session').then(user => {
  state.user = user;
  render();
  return refresh(true);
}).catch(error => showToast(error.message, true));
setInterval(() => refresh().catch(() => {}), 2000);
