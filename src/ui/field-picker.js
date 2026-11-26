const processingFieldTypes = {
  object: 'Объект', array: 'Массив', string: 'Текст', number: 'Число', int64: 'Целое int64',
  integer: 'Целое число', date: 'Дата', datetime: 'Дата и время', boolean: 'Да / нет', null: 'null', unknown: 'Тип неизвестен',
};

function processingPathField(label, control, load, hint) {
  const choose = btn('Выбрать поле', () => openFieldPicker(label, control, load), 'compact');
  choose.setAttribute('aria-haspopup', 'dialog');
  return field(label, control, hint, choose);
}

async function openFieldPicker(label, control, load) {
  const titleId = `field-picker-${++fieldCount}`;
  const search = input('', { type: 'search', autofocus: true, placeholder: 'Например, product.brandName' });
  const status = h('p', { class: 'caption', 'aria-live': 'polite' }, 'Читаем сохранённый образец…');
  const list = h('div', { class: 'field-options' });
  const notices = h('p', { class: 'caption', hidden: true });
  const panel = h('dialog', { class: 'field-picker', 'aria-labelledby': titleId });
  panel.append(
    h('div', { class: 'dialog-head' }, h('h2', { id: titleId }, 'Выбор поля'), btn('Закрыть', () => panel.close(), 'compact ghost')),
    h('div', { class: 'dialog-body' }, field(`Поиск · ${label}`, search), notices, list, status),
  );
  panel.addEventListener('close', () => {
    panel.remove();
    if (control.isConnected) control.focus({ preventScroll: true });
  }, { once: true });
  document.body.append(panel);
  panel.showModal();
  try {
    const result = await load();
    if (!panel.open) return;
    notices.textContent = result.notices.join(' ');
    notices.hidden = !result.notices.length;
    function show() {
      const query = search.value.trim().toLocaleLowerCase('ru');
      const matches = result.choices.filter(item => item.path.toLocaleLowerCase('ru').includes(query));
      list.replaceChildren(...matches.slice(0, 120).map(item => h('button', { type: 'button', class: 'field-option', onclick: () => {
        control.value = item.path;
        control.dispatchEvent(new Event('input', { bubbles: true }));
        panel.close();
      } }, h('span', { class: 'mono' }, item.path), h('small', { class: 'caption' },
        item.types.map(type => processingFieldTypes[type] ?? type).join(' / ')))));
      list.scrollTop = 0;
      let message = '';
      if (matches.length > 120) message = `Показано 120 из ${number.format(matches.length)}. Уточните поиск.`;
      if (!matches.length) message = query ? 'По этому запросу полей не найдено.' : 'Путь можно ввести вручную.';
      status.textContent = message;
    }
    search.addEventListener('input', show);
    show();
  } catch (error) {
    if (!panel.open) return;
    status.textContent = `${error.message} Путь можно ввести вручную.`;
  }
}
