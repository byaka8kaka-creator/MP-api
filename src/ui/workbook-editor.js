const workbookStepNames = {
  join: 'Соединение наборов',
  collect: 'Список значений в одной ячейке',
  distinct: 'Удаление дублей',
  allocate: 'Распределение показателей по детализации',
  group: 'Группировка и итоги',
};

const keyTypes = [['exact', 'По значению и типу'], ['integer', 'Как целое число'], ['text', 'Как текст']];
const groupOperations = [['sum', 'Сумма'], ['count', 'Количество строк'], ['countDistinct', 'Количество разных значений'],
  ['min', 'Минимум'], ['max', 'Максимум']];

function workbookFields(value, definitions) {
  const controls = Object.fromEntries(definitions.map(([key, , placeholder]) => [key, input(value[key] ?? '', { placeholder })]));
  return { node: fields(definitions.map(([key, label, , load]) => load
    ? processingPathField(label, controls[key], () => load(controls)) : field(label, controls[key]))),
    inputs: controls,
    value: () => Object.fromEntries(Object.entries(controls).map(([key, control]) => [key, control.value])) };
}

function workbookStepControls(step, dataset, lookup) {
  const pick = (label, control, hint) => processingPathField(label, control, () => lookup(), hint);
  switch (step.type) {
    case 'join': {
      const right = dataset(step.right);
      const as = input(step.as ?? 'match');
      const matches = select([['list', 'Вложить все строки списком'], ['expand', 'Создать строку на каждое совпадение'],
        ['first', 'Взять первое совпадение'], ['unique', 'Взять одно, если совпадения одинаковые']], step.matches ?? 'list');
      const missing = select([['keep', 'Оставить строку'], ['drop', 'Убрать строку'], ['error', 'Считать ошибкой']], step.missing ?? 'keep');
      const keys = processingList(step.keys ?? [{}], key => {
        const paths = workbookFields(key, [['left', 'Ключ во входном наборе', 'advertId', () => lookup()],
          ['right', 'Ключ в справочнике', 'advertId', () => lookup({}, right.value)]]);
        const type = select(keyTypes, key.type ?? 'exact');
        return { node: stack(paths.node, field('Сравнение ключей', type)), value: () => ({ ...paths.value(), type: type.value }) };
      }, () => ({}), 'Добавить ключ');
      return { node: stack(fields(field('Набор-справочник', right), field('Поле для совпадений', as)), keys.node,
        fields(field('Если совпадений несколько', matches), field('Если совпадения нет', missing))),
      value: () => ({ right: right.value, keys: keys.value(), as: as.value, matches: matches.value, missing: missing.value }) };
    }
    case 'collect': {
      const controls = workbookFields({ as: 'list', separator: ', ', ...step }, [['path', 'Путь к массиву', 'items', () => lookup({ kind: 'array' })],
        ['value', 'Путь к значению внутри элемента', 'item.nmId', fields => lookup({ kind: 'item', path: fields.path.value })],
        ['as', 'Имя выходного поля'], ['separator', 'Разделитель'],
        ['missing', 'Подпись для пустого значения']]);
      const unique = checkbox('Оставить только разные значения', step.unique !== false);
      return { node: stack(controls.node, unique.label), value: () => ({ ...controls.value(), unique: unique.control.checked }) };
    }
    case 'distinct': {
      const keys = processingList(step.keys ?? [{}], key => {
        const path = input(key.path ?? '', { placeholder: 'advertId' });
        const type = select(keyTypes, key.type ?? 'exact');
        return { node: fields(pick('Путь к полю', path), field('Сравнение ключей', type)),
          value: () => ({ path: path.value, type: type.value }) };
      }, () => ({}), 'Добавить ключ');
      return { node: keys.node, value: () => ({ keys: keys.value() }) };
    }
    case 'allocate': {
      const itemFields = fields => lookup({ kind: 'item', path: fields.items.value });
      const controls = workbookFields({ as: 'allocated', unknown: 'Группа не определена', mixed: 'Несколько групп', ...step }, [
        ['items', 'Путь к массиву объектов', 'items', () => lookup({ kind: 'array' })], ['itemKey', 'Ключ объекта', 'item.nmId', itemFields],
        ['label', 'Поле с группой объекта', 'product.brand', itemFields],
        ['details', 'Путь к детализации показателей', 'days.apps.nms', () => lookup({ kind: 'details' })],
        ['detailKey', 'Ключ в детализации', 'nmId', fields => lookup({ kind: 'detail', path: fields.details.value })],
        ['as', 'Имя поля с результатом'],
        ['unknown', 'Подпись при неизвестной группе'], ['mixed', 'Подпись при нескольких группах'],
      ]);
      const multiple = select([['reconcile', 'Распределить, если детализация сходится с итогом'],
        ['combine', 'Отнести всю сумму в общую группу']], step.multiple ?? 'reconcile');
      const metrics = processingList(step.metrics ?? [{}], metric => workbookFields(metric, [
        ['total', 'Поле с общим показателем', 'views', () => lookup()],
        ['detail', 'Поле показателя в детализации', 'views', () => lookup({ kind: 'detail', path: controls.inputs.details.value })],
        ['name', 'Имя показателя результата'],
      ]), () => ({}), 'Добавить показатель');
      return { node: stack(controls.node, field('Если групп несколько', multiple), metrics.node),
        value: () => ({ ...controls.value(), multiple: multiple.value, metrics: metrics.value() }) };
    }
    case 'group': {
      const keys = processingList(step.keys ?? [], key => workbookFields(key, [['path', 'Путь к полю', 'brand', () => lookup()], ['name', 'Имя поля результата']]),
        () => ({}), 'Добавить поле группировки');
      const metrics = processingList(step.metrics ?? [{}], metric => {
        const op = select(groupOperations, metric.op ?? 'sum');
        const path = input(metric.path ?? '', { placeholder: 'allocated.views' });
        const name = input(metric.name ?? '');
        const pathField = pick('Путь к показателю', path);
        const displayPath = () => { pathField.hidden = op.value === 'count'; };
        displayPath();
        op.addEventListener('change', displayPath);
        return { node: fields(field('Операция', op), field('Имя поля результата', name), pathField),
          value: () => ({ op: op.value, name: name.value, ...(op.value !== 'count' ? { path: path.value } : {}) }) };
      }, () => ({}), 'Добавить показатель');
      const uniform = input(step.uniform ?? '', { placeholder: 'currency' });
      return { node: stack(h('strong', {}, 'Группировать по'), keys.node, h('strong', {}, 'Рассчитать'), metrics.node,
        pick('Поле, значение которого должно совпадать во всех строках', uniform, 'Например, валюта. Оставьте пустым, если проверка не нужна.')),
      value: () => ({ keys: keys.value(), metrics: metrics.value(), ...(uniform.value ? { uniform: uniform.value } : {}) }) };
    }
  }
}

function workbookBuilder(recipe, choices) {
  const datasetOptions = h('datalist', { id: `dataset-names-${++fieldCount}` });
  const dataset = value => input(value, { list: datasetOptions.id, placeholder: 'source1' });
  const datasetName = (value = '') => input(value, { 'data-dataset-name': '', placeholder: 'brandMetrics' });
  const choicesList = choices.map(item => [item.id, [item.connection, item.folder, item.name].filter(Boolean).join(' · ')]);
  const load = (before, selection, alias) => call('processingFields', {
    sources: sources.value(), steps: steps.value({ before, fieldsOnly: true }), selection, alias,
  });

  const sheets = processingList(recipe.sheets, (sheet, open) => {
    const name = input(sheet.name);
    const from = dataset(sheet.input);
    const expand = checkbox('Развернуть массив на листе', sheet.expand !== undefined);
    const path = input(sheet.expand ?? '', { placeholder: 'days' });
    const separate = checkbox('Использовать поля элемента и $parent для исходной строки', sheet.separate);
    const expansion = stack(processingPathField('Путь к массиву', path, () => load(undefined, { kind: 'array' }, from.value),
      'Для массива в корне оставьте пустым или укажите $.'), separate.label);
    const displayExpansion = () => { expansion.hidden = !expand.control.checked; };
    displayExpansion();
    expand.control.addEventListener('change', displayExpansion);
    const columns = processingColumns(sheet.columns ?? [], () => load(undefined,
      { kind: 'column', path: expand.control.checked ? path.value : undefined }, from.value));
    const summary = h('summary');
    const suffix = h('span', { class: 'caption recipe-output' }, name.value);
    name.addEventListener('input', () => { suffix.textContent = name.value; });
    return { title: 'Лист', summary, summarySuffix: suffix,
      node: h('details', { open }, summary, stack(fields(field('Название листа', name), field('Набор для листа', from)),
        expand.label, expansion, h('details', { class: 'fold recipe-columns' }, h('summary', {}, 'Колонки листа'), columns.node))),
      value: () => ({ name: name.value, input: from.value, columns: columns.value(),
        ...(expand.control.checked ? { expand: path.value, separate: separate.control.checked } : {}) }) };
  }, () => ({ name: 'Результат', columns: [{ path: '$', name: 'Запись' }] }), 'Добавить лист');
  const sheetsFold = h('details', { class: 'fold' }, h('summary', {}, 'Листы результата'), sheets.node);

  const sources = processingList(recipe.sources, source => {
    const alias = datasetName(source.alias);
    const template = select([['', 'Выберите шаблон'], ...choicesList], source.templateId ?? '');
    const occurrence = input(source.occurrence === undefined ? '' : JSON.stringify(source.occurrence), { type: 'number', min: 1, max: 30 });
    const allRows = checkbox('Читать все строки, включая дубли из разных ответов', source.allRows);
    const request = processingList(source.requestFields ?? [], item => workbookFields(item, [
      ['path', 'Имя или путь к параметру формы', 'beginDate'], ['name', 'Имя поля внутри request', 'beginDate'],
    ]), () => ({}), 'Добавить поле запроса');
    const importSheets = btn('Добавить листы этого шаблона', () => {
      const selected = choices.find(item => item.id === template.value);
      if (!selected || !alias.value) throw new Error('Выберите шаблон и введите имя набора.');
      const response = selected.sheetDefaults;
      const columns = items => items.length ? items : [{ path: '$', name: 'Запись' }];
      sheets.append([{ name: selected.name, input: alias.value, columns: columns(response.columns), expand: response.expand },
        ...response.tables.map(table => ({ name: table.name, input: alias.value, columns: columns(table.columns), expand: table.path, separate: true }))], false);
      sheetsFold.open = true;
    }, 'compact');
    return { node: stack(fields(field('Имя набора', alias), field('Опубликованный шаблон', template)),
      field('Номер источника с этим шаблоном', occurrence, 'Заполните, если один шаблон используется в выгрузке несколько раз.'),
      allRows.label, h('details', { class: 'fold' }, h('summary', {}, 'Поля из параметров запроса'), request.node), cluster(importSheets)),
    value: () => ({ alias: alias.value, templateId: template.value, allRows: allRows.control.checked,
      requestFields: request.value(), ...(occurrence.value ? { occurrence: occurrence.valueAsNumber } : {}) }) };
  }, () => ({}), 'Добавить источник');

  const stepType = select(Object.entries({ ...stepNames, ...workbookStepNames }));
  const workbook = {
    names: workbookStepNames,
    controls: (step, lookup) => workbookStepControls(step, dataset, lookup),
    datasets: step => {
      const from = dataset(step.input);
      const output = datasetName(step.output);
      const suffix = h('span', { class: 'caption recipe-output' }, output.value);
      output.addEventListener('input', () => { suffix.textContent = output.value; });
      return { node: fields(field('Набор на входе', from), field('Имя результата', output)), suffix, from,
        value: () => ({ input: from.value, output: output.value }) };
    },
  };
  const steps = processingList(recipe.steps, (step, open) => editProcessingStep(step, open, load, workbook), () => ({ type: stepType.value }),
    'Добавить шаг', field('Новый шаг', stepType));
  const node = stack(h('details', { class: 'fold', open: true }, h('summary', {}, 'Источники обработки'), sources.node),
    h('details', { class: 'fold' }, h('summary', {}, 'Шаги обработки'), steps.node), sheetsFold, datasetOptions);
  node.addEventListener('focusin', event => {
    if (event.target.list !== datasetOptions) return;
    const names = new Set([...node.querySelectorAll('[data-dataset-name]')].map(control => control.value).filter(Boolean));
    datasetOptions.replaceChildren(...[...names].map(value => h('option', { value })));
  });
  return { node, value: () => ({ sources: sources.value(), steps: steps.value(), sheets: sheets.value() }) };
}

function showWorkbookPreview(result) {
  const stages = result.stages.map(stage => ({ ...stage, title: `${stage.alias} · ${stage.type === 'source' ? 'Источник' :
    (workbookStepNames[stage.type] ?? stepNames[stage.type])}` }));
  return stack(result.error && h('p', { class: 'notice error' }, result.error),
    table(['Набор и шаг', 'На входе', 'На выходе', 'Без совпадения', 'Конфликты', 'Ошибки'], stages.map(stage => h('tr', {},
      h('td', {}, stage.title), ...[stage.input, stage.rows, stage.unmatched, stage.conflicts, stage.errors]
        .map(value => h('td', {}, stage.used && value !== undefined ? number.format(value) : '—'))))),
    result.sheets.length > 0 && table(['Лист результата', 'Строк'], result.sheets.map(sheet => h('tr', {},
      h('td', {}, sheet.name), h('td', {}, number.format(sheet.rows))))),
    [...stages, ...result.sheets.map(sheet => ({ ...sheet, title: sheet.name }))].filter(item => item.samples.length)
      .map(item => h('details', { class: 'fold' }, h('summary', {}, `${item.title} · образец`), h('pre', { class: 'pre mono' }, item.samples.join('\n\n')))));
}
