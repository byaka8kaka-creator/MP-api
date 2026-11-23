const stepNames = {
  filter: 'Фильтр',
  validate: 'Проверка полей',
  expandArray: 'Разворот массива',
  expandObjects: 'Разворот объектов',
  copy: 'Перенос полей',
};

function processingList(items, make, blank, addLabel, chooser) {
  if (!Array.isArray(items)) throw new Error('Проверьте список в настройках обработки.');
  const list = h('div', { class: 'recipe-list' });
  const rows = items.map(item => make(item));
  function move(index, offset) {
    const [row] = rows.splice(index, 1);
    rows.splice(index + offset, 0, row);
    render();
  }
  function render() {
    list.replaceChildren(...rows.map((row, index) => {
      const actions = cluster(btn('Выше', () => move(index, -1), 'compact ghost', index === 0),
        btn('Ниже', () => move(index, 1), 'compact ghost', index === rows.length - 1),
        btn('Убрать', () => { rows.splice(index, 1); render(); }, 'compact ghost'));
      if (row.summary) {
        row.summary.replaceChildren(`${index + 1}. ${row.title}`, row.summarySuffix ?? '');
        return h('section', { class: 'recipe-item recipe-step' }, row.node, actions);
      }
      return h('section', { class: 'recipe-item' },
        h('div', { class: 'recipe-item-head' }, h('strong', {}, index + 1), actions), row.node);
    }));
  }
  render();
  function append(items, open = true) {
    rows.push(...items.map(item => make(item, open)));
    render();
  }
  return {
    node: stack(list, h('div', { class: 'recipe-add' }, chooser, btn(addLabel, () => append([blank()]), 'compact'))),
    append,
    value: () => rows.map(row => row.value()),
  };
}

function editProcessingStep(step, open = false, workbook) {
  const isRowStep = step && Object.hasOwn(stepNames, step.type);
  if (!isRowStep && (!workbook || !step || !Object.hasOwn(workbook.names, step.type))) {
    throw new Error('Укажите поддерживаемый тип шага.');
  }
  const onError = select([['stop', 'Остановить обработку'], ['skip', 'Пропустить запись']], step.onError ?? 'stop');
  const controls = isRowStep ? stepControls(step) : workbook.controls(step);
  const names = workbook?.datasets(step);
  const summary = h('summary');
  return {
    title: isRowStep ? stepNames[step.type] : workbook.names[step.type],
    summary,
    summarySuffix: names?.suffix,
    node: h('details', { open }, summary, stack(names?.node, controls.node, field('При ошибке', onError))),
    value: () => ({ type: step.type, ...names?.value(), ...controls.value(), onError: onError.value }),
  };
}

function stepControls(step) {
  switch (step.type) {
    case 'filter': {
      const path = input(step.path ?? '', { placeholder: 'dailyStats' });
      const operator = select([['present', 'Поле присутствует'], ['arrayNotEmpty', 'Массив содержит элементы'],
        ['notBlank', 'Текст заполнен'], ['equals', 'Равно'], ['notEquals', 'Не равно']], step.operator ?? 'present');
      const compare = () => ['equals', 'notEquals'].includes(operator.value);
      const target = textarea(pretty(step.value ?? null), 2, 'Значение для сравнения');
      const comparison = field('Значение (JSON)', target);
      comparison.hidden = !compare();
      operator.addEventListener('change', () => { comparison.hidden = !compare(); });
      return { node: stack(fields(field('Путь к полю', path), field('Условие', operator)), comparison),
        value: () => ({ path: path.value, operator: operator.value,
          ...(compare() ? { value: editedJson(target.value, 'Значение для сравнения') } : {}) }) };
    }
    case 'validate': {
      const checks = processingList(step.checks ?? [{}], check => {
        const path = input(check.path ?? '', { placeholder: 'statistic.period.start' });
        const kind = select([['present', 'Поле присутствует'], ['object', 'Объект'], ['array', 'Массив'],
          ['date', 'Дата YYYY-MM-DD'], ['dateInterval', 'Начало периода не позже конца']], check.kind ?? 'present');
        const endPath = input(check.endPath ?? '', { placeholder: 'statistic.period.end' });
        const end = field('Путь к концу периода', endPath);
        end.hidden = kind.value !== 'dateInterval';
        kind.addEventListener('change', () => { end.hidden = kind.value !== 'dateInterval'; });
        return { node: stack(fields(field('Путь к полю', path), field('Проверка', kind)), end),
          value: () => ({ path: path.value, kind: kind.value,
            ...(kind.value === 'dateInterval' ? { endPath: endPath.value } : {}) }) };
      }, () => ({}), 'Добавить проверку');
      return { node: checks.node, value: () => ({ checks: checks.value() }) };
    }
    case 'expandArray': {
      const path = input(step.path ?? '', { placeholder: 'dailyStats' });
      const as = input(step.as ?? 'item');
      const keepEmpty = checkbox('Сохранять строку при пустом массиве', step.keepEmpty);
      return { node: stack(fields(field('Путь к массиву', path), field('Имя поля для элемента', as)), keepEmpty.label),
        value: () => ({ path: path.value, as: as.value, keepEmpty: keepEmpty.control.checked }) };
    }
    case 'expandObjects': {
      const as = input(step.as ?? 'item');
      const labelAs = input(step.labelAs ?? '', { placeholder: 'periodType' });
      const variants = processingList(step.variants ?? [{}], variant => {
        const path = input(variant.path ?? '', { placeholder: 'statistic.selected' });
        const label = input(variant.label ?? '');
        const optional = checkbox('Пропустить отсутствующий объект', variant.optional);
        const ifPresent = input(variant.ifPresent ?? '', { placeholder: 'period' });
        return { node: stack(fields(field('Путь к объекту', path), field('Подпись', label)),
          optional.label, field('Создать строку, если внутри объекта есть поле', ifPresent)),
        value: () => ({ path: path.value, label: label.value, optional: optional.control.checked, ifPresent: ifPresent.value }) };
      }, () => ({}), 'Добавить объект');
      return { node: stack(fields(field('Имя поля для объекта', as), field('Имя поля для подписи', labelAs)), variants.node),
        value: () => ({ as: as.value, labelAs: labelAs.value, variants: variants.value() }) };
    }
    case 'copy': {
      const mapped = processingList(step.fields ?? [{}], item => {
        const from = input(item.from ?? '', { placeholder: 'day.stat' });
        const to = input(item.to ?? '', { placeholder: 'stat' });
        const trim = checkbox('Убрать пробелы по краям текста', item.trim);
        return { node: stack(fields(field('Откуда взять значение', from), field('Имя выходного поля', to)), trim.label),
          value: () => ({ from: from.value, to: to.value, ...(trim.control.checked ? { trim: true } : {}) }) };
      }, () => ({}), 'Добавить поле');
      const keepOriginal = checkbox('Сохранить остальные поля строки', step.keepOriginal);
      return { node: stack(keepOriginal.label, mapped.node),
        value: () => ({ fields: mapped.value(), keepOriginal: keepOriginal.control.checked }) };
    }
  }
}

function processingColumns(items) {
  return processingList(items, item => {
    const path = input(item.path, { placeholder: 'stat.normQuery' });
    const name = input(item.name);
    return { node: fields(field('Путь к полю', path), field('Название колонки', name)),
      value: () => ({ path: path.value, name: name.value }) };
  }, () => ({ path: '$', name: '' }), 'Добавить колонку');
}

function processingBuilder(recipe) {
  const stepType = select(Object.entries(stepNames));
  const steps = processingList(recipe.steps, editProcessingStep, () => ({ type: stepType.value }),
    'Добавить шаг', field('Новый шаг', stepType));
  const columns = processingColumns(recipe.columns);
  return {
    node: stack(h('h3', {}, 'Шаги обработки'), steps.node,
      h('details', { class: 'fold recipe-columns' }, h('summary', {}, 'Колонки результата'), columns.node)),
    value: () => ({ steps: steps.value(), columns: columns.value() }),
  };
}

function showProcessingPreview(result) {
  const stages = [
    { ...result.input, title: 'Сохранённые строки API' },
    ...result.stages.map((stage, index) => ({ ...stage, title: `${index + 1}. ${stepNames[stage.type]}` })),
    { ...result.output, title: 'Колонки результата' },
  ];
  return stack(result.error && h('p', { class: 'notice error' }, result.error),
    table(['Шаг', 'На входе', 'На выходе', 'Ошибки'], stages.map(stage => h('tr', {},
      h('td', {}, stage.title), h('td', {}, stage.input === undefined ? '—' : number.format(stage.input)),
      h('td', {}, number.format(stage.rows)), h('td', {}, stage.errors ? number.format(stage.errors) : '—')))),
    stages.filter(stage => stage.samples.length).map(stage => h('details', { class: 'fold' },
      h('summary', {}, `${stage.title} · образец`), h('pre', { class: 'pre mono' }, stage.samples.join('\n\n')))));
}

function processingEditor(saved) {
  const existingTemplates = new Set(saved?.sources?.map(source => source.templateId) ?? [saved?.templateId]);
  const choices = state.workspace.options.filter(item => !item.archived || existingTemplates.has(item.id));
  const scope = select([['source', 'Один источник'], ['workbook', 'Вся выгрузка']], saved?.scope ?? 'source');
  scope.disabled = Boolean(saved);
  const isWorkbook = () => scope.value === 'workbook';
  const template = select(choices.map(item => [item.id, `${item.connection} · ${item.name}`]), saved?.templateId);
  template.disabled = Boolean(saved);
  const templateField = field('Шаблон запроса', template);
  const getDefaults = () => choices.find(item => item.id === template.value).processingDefaults;
  let defaults = getDefaults();
  const name = input(saved?.name ?? defaults.name, { required: true, maxlength: 160 });
  const raw = textarea('', 18, 'Шаги и колонки JSON');
  const editorError = h('p', { class: 'notice error', hidden: true, role: 'alert' });
  const pane = stack();
  const result = stack();
  let builder;
  let mode = 'steps';
  const useSteps = value => {
    builder = isWorkbook() ? workbookBuilder(value, choices) : processingBuilder(value);
    mode = 'steps';
    pane.replaceChildren(builder.node);
  };
  const recipe = () => {
    const value = mode === 'json' ? editedJson(raw.value, isWorkbook() ? 'Обработка выгрузки' : 'Шаги и колонки') : builder.value();
    if (isWorkbook()) {
      if (![value?.sources, value?.steps, value?.sheets].every(Array.isArray)) throw new Error('Укажите массивы sources, steps и sheets.');
    } else if (![value?.steps, value?.columns].every(Array.isArray)) throw new Error('Укажите массивы steps и columns.');
    return value;
  };
  const payload = () => {
    const { sources, steps, sheets, columns } = recipe();
    return pretty({ id: saved?.id, name: name.value, scope: scope.value, steps,
      ...(isWorkbook() ? { sources, sheets } : { templateId: template.value, columns }) });
  };

  const modeChoice = select([['steps', 'Конструктор шагов'], ['json', 'JSON']]);
  modeChoice.addEventListener('change', () => {
    editorError.hidden = true;
    try {
      if (modeChoice.value === 'json') {
        raw.value = pretty(builder.value());
        mode = 'json';
        pane.replaceChildren(raw);
      } else {
        useSteps(recipe());
        if (isWorkbook()) loadRuns();
      }
    } catch (error) {
      editorError.textContent = error.message;
      editorError.hidden = false;
      modeChoice.value = mode;
    }
  });

  const runSelect = select([['', 'Выберите запуск']]);
  const available = h('p', { class: 'caption', 'aria-live': 'polite' });
  let candidates = [];
  let loadRequest = 0;
  let previewRequest = 0;
  let busy = false;
  const preview = h('button', { type: 'button', class: 'button', disabled: true, onclick: async () => {
    const selected = candidates[Number(runSelect.value) - 1];
    if (!selected) return;
    busy = true;
    preview.disabled = true;
    result.replaceChildren(h('p', { class: 'caption' }, 'Читаем сохранённые строки…'));
    const generation = ++previewRequest;
    try {
      const data = await call('processingPreview', { json: payload(), runId: selected.runId, source: selected.source });
      if (generation === previewRequest) result.replaceChildren(data.scope === 'workbook' ? showWorkbookPreview(data) : showProcessingPreview(data));
    } catch (error) {
      if (generation === previewRequest) result.replaceChildren(h('p', { class: 'notice error' }, error.message));
    } finally {
      busy = false;
      preview.disabled = !runSelect.value;
    }
  } }, 'Предпросмотр');
  async function loadRuns() {
    const generation = ++loadRequest;
    previewRequest++;
    runSelect.replaceChildren(h('option', { value: '' }, 'Выберите запуск'));
    preview.disabled = true;
    available.textContent = 'Загружаем список запусков…';
    result.replaceChildren();
    try {
      const workbook = isWorkbook();
      const runs = await call('processingRuns', workbook ? { sourcesJson: pretty(recipe().sources) } : { templateId: template.value });
      if (generation !== loadRequest) return;
      candidates = runs;
      runSelect.append(...runs.map((run, index) => h('option', { value: index + 1 },
        [time(run.created), run.name, workbook ? '' : `источник ${run.source + 1}`, `${number.format(run.rows)} строк`].filter(Boolean).join(' · '))));
      runSelect.value = runs.length ? '1' : '';
      available.textContent = runs.length ? '' : workbook ? 'Пока нет сохранённого запуска со всеми выбранными источниками.'
        : 'Для этого шаблона пока нет сохранённых запусков.';
      preview.disabled = busy || !runSelect.value;
    } catch (error) {
      if (generation === loadRequest) available.textContent = error.message;
    }
  }
  runSelect.addEventListener('change', () => {
    previewRequest++;
    preview.disabled = busy || !runSelect.value;
    result.replaceChildren();
  });
  const reload = btn('Обновить список запусков', loadRuns, 'compact');
  const preset = state.workspace.campaignPreset ? parseEditable(state.workspace.campaignPreset) : null;
  const loadPreset = btn('Загрузить пример «Свод РК»', () => {
    name.value = preset.name;
    openRecipe(preset);
    loadRuns();
  });
  function openRecipe(value) {
    useSteps(value);
    modeChoice.value = 'steps';
    editorError.hidden = true;
    templateField.hidden = isWorkbook();
    reload.hidden = !isWorkbook();
    loadPreset.hidden = !isWorkbook() || !preset || Boolean(saved);
    raw.setAttribute('aria-label', isWorkbook() ? 'Источники, шаги и листы JSON' : 'Шаги и колонки JSON');
  }
  scope.addEventListener('change', () => {
    const workbook = { sources: [{ alias: 'source1', templateId: template.value }], steps: [],
      sheets: [{ name: 'Результат', input: 'source1', columns: [{ path: '$', name: 'Запись' }] }] };
    openRecipe(isWorkbook() ? workbook : defaults);
    loadRuns();
  });
  template.addEventListener('change', () => {
    const next = getDefaults();
    if (!name.value.trim() || name.value === defaults.name) name.value = next.name;
    defaults = next;
    openRecipe(next);
    loadRuns();
  });
  openRecipe(saved ? parseEditable(saved.recipeJson) : defaults);
  formModal(saved ? 'Изменить обработку' : 'Новая обработка', [
    fields(field('Название', name), field('Область обработки', scope)), templateField,
    fields(field('Режим редактирования', modeChoice), cluster(loadPreset)), editorError, pane,
    h('details', { class: 'fold', open: true }, h('summary', {}, 'Проверка на сохранённом запуске'),
      stack(field('Запуск для предпросмотра', runSelect), available, cluster(preview, reload), result)),
  ], 'Сохранить', async () => {
    await call('processing', { json: payload() });
    await done('Обработка сохранена.');
  });
  loadRuns();
}
