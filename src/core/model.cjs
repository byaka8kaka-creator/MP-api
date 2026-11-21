const { Headers } = globalThis;
const { InputError, clone, get, integer, isLosslessNumber, object, pathParts, scalarText, set, stringify } = require('./json.cjs');

const DAY = 86_400_000;
const methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'];
const types = ['string', 'integer', 'number', 'date', 'datetime', 'boolean', 'array', 'object'];
const safeHeader = /^[!#$%&'*+.^_\x60|~0-9A-Za-z-]+$/;
const protectedHeaders = /^(?:host|connection|content-length|transfer-encoding|cookie|proxy-.+)$/i;

function demand(valid, message) {
  if (!valid) throw new InputError(message);
}

function text(value, label, max = 160) {
  demand(typeof value === 'string' && value.trim() && value.length <= max, `Укажите ${label} (до ${max} символов).`);
  return value.trim();
}

function folder(value = '') {
  demand(typeof value === 'string' && value.length <= 250, 'Недопустимый путь папки.');
  return value.split('/').map(part => part.trim()).filter(Boolean).join('/');
}

function id(value) {
  demand(typeof value === 'string' && /^[a-zA-Z0-9_-]{1,90}$/.test(value) &&
    !['__proto__', 'constructor', 'prototype'].includes(value), 'Недопустимый идентификатор настройки.');
  return value;
}

function positive(value, label, max = Number.MAX_SAFE_INTEGER) {
  demand(Number.isSafeInteger(value) && value > 0 && value <= max, `Недопустимое значение «${label}».`);
  return value;
}

function optionalList(value, label) {
  demand(value === undefined || Array.isArray(value), `«${label}» должен быть массивом.`);
  return value ?? [];
}

function distinct(list, key, label) {
  demand(new Set(list.map(value => value[key])).size === list.length, `Повторяющиеся ${label}.`);
  return list;
}

function baseUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new InputError('Проверьте базовый адрес API.'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  demand((url.protocol === 'https:' || (local && url.protocol === 'http:')) &&
    !url.username && !url.password && !url.search && !url.hash,
  'Используйте HTTPS без логина, пароля и параметров в базовом адресе. HTTP доступен только на localhost.');
  return url;
}

function headerName(name) {
  demand(typeof name === 'string' && safeHeader.test(name) && !protectedHeaders.test(name), 'Недопустимое имя HTTP-заголовка.');
  return name;
}

function limitRules(value) {
  return distinct(optionalList(value, 'Ограничения').map(rule => {
    demand(object(rule) && ['bucket', 'window', 'concurrency', 'resource'].includes(rule.type), 'Выберите тип ограничения.');
    const result = { id: id(rule.id), type: rule.type };
    if (rule.environment !== undefined) {
      demand(['production', 'sandbox'].includes(rule.environment), 'Укажите среду ограничения.');
      result.environment = rule.environment;
    }
    if (rule.scopeParam !== undefined) result.scopeParam = optionalList(rule.scopeParam, 'Параметры области').map(id);
    if (rule.credential !== undefined) result.credential = id(rule.credential);
    if (rule.type === 'bucket') {
      result.refillMs = positive(rule.refillMs, 'Интервал пополнения');
      result.burst = positive(rule.burst ?? 1, 'Размер всплеска');
      result.badRequestCost = positive(rule.badRequestCost ?? 1, 'Стоимость 4XX');
    }
    if (rule.type === 'window' || rule.type === 'concurrency') result.max = positive(rule.max, 'Максимум запросов');
    if (rule.type === 'window') result.windowMs = positive(rule.windowMs, 'Длительность окна');
    if (rule.type === 'resource' && rule.costParam !== undefined) result.costParam = id(rule.costParam);
    return result;
  }), 'id', 'идентификаторы ограничений');
}

function validateConnection(value) {
  demand(object(value), 'Подключение должно быть объектом.');
  const profiles = distinct(optionalList(value.profiles, 'Авторизация').map(profile => {
    demand(object(profile), 'Профиль авторизации должен быть объектом.');
    const headers = distinct(optionalList(profile.headers, 'Заголовки авторизации').map(header => {
      demand(object(header), 'Опишите заголовок авторизации.');
      const prefix = header.prefix ?? '';
      demand(typeof prefix === 'string' && prefix.length <= 40 && !/[\r\n]/.test(prefix), 'Недопустимый префикс заголовка.');
      return { key: id(header.key), name: headerName(header.name), prefix };
    }), 'key', 'поля профиля');
    demand(new Set(headers.map(header => header.name.toLowerCase())).size === headers.length, 'Заголовки авторизации повторяются.');
    return { id: id(profile.id), name: text(profile.name, 'имя профиля'), headers };
  }), 'id', 'профили авторизации');
  const endpoints = distinct(optionalList(value.endpoints, 'Адреса').map(endpoint => {
    demand(object(endpoint), 'Адрес должен быть объектом.');
    const item = { id: id(endpoint.id), name: text(endpoint.name, 'имя адреса'), url: baseUrl(endpoint.url).href };
    if (endpoint.sandbox) item.sandbox = baseUrl(endpoint.sandbox).href;
    for (const field of ['profileId', 'sandboxProfileId']) {
      if (endpoint[field] === undefined) continue;
      demand(profiles.some(profile => profile.id === endpoint[field]), 'Адрес ссылается на неизвестный профиль авторизации.');
      item[field] = endpoint[field];
    }
    return item;
  }), 'id', 'адреса');
  demand(endpoints.length > 0, 'Добавьте хотя бы один адрес API.');
  const policyId = value.policyId === undefined ? id(value.id) : id(value.policyId);
  return { id: id(value.id), policyId, name: text(value.name, 'имя подключения'), account: text(value.account ?? 'seller', 'область лимитов'),
    endpoints, profiles, limits: limitRules(value.limits) };
}

function dateMs(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return NaN;
  const time = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value ? time : NaN;
}

function parameter(value, depth = 0) {
  demand(depth < 8 && object(value) && types.includes(value.type), 'Укажите поддерживаемый тип параметра.');
  const copy = { type: value.type, nullable: value.nullable === true, required: value.required === true };
  if (value.enum !== undefined) copy.enum = optionalList(value.enum, 'Возможные значения');
  if (value.default !== undefined) copy.default = value.default;
  for (const bound of ['min', 'max']) {
    if (value[bound] === undefined) continue;
    demand(typeof value[bound] === 'number' || isLosslessNumber(value[bound]), 'Числовая граница должна быть числом.');
    copy[bound] = value[bound];
  }
  if (value.type === 'array') {
    copy.items = parameter(value.items ?? { type: 'string' }, depth + 1);
    for (const bound of ['minItems', 'maxItems', 'batchSize']) {
      if (value[bound] !== undefined) copy[bound] = positive(value[bound], bound);
    }
    copy.unique = value.unique === true;
    copy.splitForBody = value.splitForBody === true;
  }
  if (value.type === 'object' && value.properties !== undefined) {
    demand(object(value.properties), 'Свойства объекта должны быть перечислены по именам.');
    copy.properties = Object.fromEntries(Object.entries(value.properties).map(([key, spec]) =>
      [id(key), parameter(spec, depth + 1)]));
  }
  if (copy.default !== undefined) checkValue(copy.default, copy, 'Значение по умолчанию');
  return copy;
}

function parameterList(value, profiles, template) {
  const specs = optionalList(value, 'Параметры');
  return distinct(specs.map(spec => {
    const result = parameter(spec);
    result.name = id(spec.name);
    result.label = text(spec.label ?? spec.name, 'имя поля');
    demand(['path', 'query', 'body', 'header', 'input'].includes(spec.where), 'Укажите расположение каждого параметра.');
    result.where = spec.where;
    result.key = spec.key ?? spec.name;
    if (spec.where === 'body') {
      demand(!['GET', 'HEAD'].includes(template.method), 'GET и HEAD не поддерживают JSON-тело.');
      if (result.key === '$') {
        demand(result.type === 'array' && !result.nullable, 'Для корня JSON-тела задайте массив.');
      } else {
        demand(pathParts(result.key).length > 0, 'Укажите поле тела запроса.');
      }
    } else {
      text(result.key, 'имя HTTP-параметра');
    }
    if (spec.where === 'path') {
      demand(template.path.includes(`{${result.key}}`), 'Для параметра пути нужен плейсхолдер в адресе.');
      result.required = true;
      result.nullable = false;
    }
    if (spec.where === 'header') {
      headerName(result.key);
      const credentialNames = profiles.flatMap(profile => profile.headers.map(header => header.name.toLowerCase()));
      demand(!['authorization', 'api-key', 'client-id', ...credentialNames].includes(result.key.toLowerCase()),
        'Заголовок авторизации настраивается в подключении.');
    }
    if (spec.format !== undefined) {
      demand(result.type === 'date' && ['unix-start', 'unix-end'].includes(spec.format), 'Недопустимый формат даты.');
      result.format = spec.format;
    }
    if (spec.encoding !== undefined) {
      demand(result.type === 'array' && ['repeat', 'csv', 'json'].includes(spec.encoding), 'Недопустимый формат списка.');
      result.encoding = spec.encoding;
    }
    if (spec.reference !== undefined) {
      demand(spec.where !== 'input', 'Параметр формы заполняется пользователем или значением по умолчанию.');
      const reference = spec.reference;
      demand(object(reference) && ['one', 'many', 'all'].includes(reference.mode), 'Укажите режим зависимости.');
      demand(reference.mode === 'one' || result.type === 'array', 'Для нескольких значений зависимости нужен массив.');
      result.reference = { templateId: id(reference.templateId), mode: reference.mode };
      if (reference.refresh !== undefined) {
        demand(['manual', 'run'].includes(reference.refresh), 'Выберите ручное обновление или обновление при запуске.');
        demand(reference.refresh !== 'run' || reference.mode === 'all', 'Обновление при запуске требует режима all.');
        result.reference.refresh = reference.refresh;
      }
      if (reference.expand !== undefined) {
        pathParts(reference.expand);
        result.reference.expand = reference.expand;
      }
      if (reference.fields === undefined) {
        pathParts(reference.path);
        result.reference.path = reference.path;
      } else {
        demand(reference.path === undefined && result.type === 'array' && result.items.type === 'object' &&
          object(reference.fields) && Object.keys(reference.fields).length > 0,
        'Для сборки объектов укажите поля объекта вместо одного пути.');
        result.reference.fields = Object.fromEntries(Object.entries(reference.fields).map(([name, path]) => {
          demand(typeof path === 'string', 'Укажите путь каждого поля объекта.');
          if (path.startsWith('$input.')) {
            const [input] = pathParts(path.slice(7));
            demand(reference.refresh === 'run' && specs.some(spec => spec?.where === 'input' && spec.name === input),
              'Для ссылки $input укажите параметр формы и обновление при запуске.');
          } else {
            pathParts(path.replace(/^\$parent\./, ''));
          }
          return [id(name), path];
        }));
      }
    }
    return result;
  }), 'name', 'имена параметров');
}

function paginationConfig(value, method) {
  if (!value || value.type === 'none') return { type: 'none' };
  demand(object(value) && ['integer-cursor', 'flag-cursor', 'token', 'page', 'offset', 'link'].includes(value.type),
    'Выберите поддерживаемый вид пагинации.');
  const result = { type: value.type, maxPages: positive(value.maxPages ?? 10_000, 'Максимум страниц', 100_000) };
  if (value.type !== 'link') {
    demand(['query', 'body', 'header'].includes(value.target), 'Укажите расположение параметра пагинации.');
    result.target = value.target;
    result.parameter = text(value.parameter, 'имя параметра пагинации');
    if (value.target === 'body') {
      demand(!['GET', 'HEAD'].includes(method), 'Параметр пагинации нельзя поместить в тело GET или HEAD.');
      pathParts(result.parameter);
    }
    if (value.target === 'header') headerName(result.parameter);
  } else {
    demand(method === 'GET', 'Пагинация по ссылке доступна для GET.');
  }
  if (['page', 'offset'].includes(value.type)) {
    demand(Number.isSafeInteger(value.initial ?? 0) && (value.initial ?? 0) >= 0, 'Начальная позиция должна быть целой.');
    result.initial = value.initial ?? (value.type === 'offset' ? 0 : 1);
    result.end = value.end ?? 'empty';
    demand(['empty', 'short', 'flag', 'total'].includes(result.end), 'Укажите условие завершения пагинации.');
    if (value.type === 'offset' || result.end === 'short') result.sizeParameter = id(value.sizeParameter);
    if (result.end === 'flag' || result.end === 'total') {
      pathParts(value.endPath);
      result.endPath = value.endPath;
    }
  } else {
    pathParts(value.cursor);
    result.cursor = value.cursor;
  }
  if (value.type === 'integer-cursor') {
    result.initial = value.initial ?? 0;
    demand(integer(result.initial) !== null, 'Начальный курсор должен быть целым числом.');
  }
  if (value.type === 'flag-cursor') {
    pathParts(value.flag);
    result.flag = value.flag;
  }
  return result;
}

function columns(value) {
  return optionalList(value, 'Колонки').map(column => {
    demand(object(column), 'Опишите колонку.');
    const path = column.path;
    demand(typeof path === 'string', 'Укажите путь колонки.');
    pathParts(path.replace(/^\$(item|parent)(\.|$)/, ''));
    return { path, name: text(column.name, 'название колонки') };
  });
}

function validateTemplate(value, connection) {
  demand(object(value), 'Шаблон должен быть объектом.');
  demand(connection && value.connectionId === connection.id, 'Выберите подключение.');
  const endpoint = connection.endpoints.find(item => item.id === value.endpointId);
  demand(endpoint, 'Выберите адрес подключения.');
  if (value.profileId !== undefined) {
    demand(connection.profiles.some(profile => profile.id === value.profileId), 'Профиль авторизации отсутствует.');
  }
  demand(methods.includes(value.method), 'Выберите HTTP-метод.');
  demand(typeof value.path === 'string' && /^\/(?!\/)/.test(value.path) &&
    !/[\\?#\s]/.test(value.path) && value.path.length <= 2048, 'Путь запроса должен быть относительным и начинаться с /.');
  const result = {
    id: id(value.id), connectionId: connection.id, endpointId: endpoint.id, profileId: value.profileId,
    name: text(value.name, 'название шаблона'), folder: folder(value.folder), available: value.available === true,
    method: value.method, path: value.path, safeToRetry: value.safeToRetry === true,
    recovery: value.recovery ?? 'decision', parameters: parameterList(value.parameters, connection.profiles, value),
    pagination: paginationConfig(value.pagination, value.method), limits: limitRules(value.limits),
    maxBodyBytes: positive(value.maxBodyBytes ?? 4 * 1024 * 1024, 'Максимум байт в запросе'),
    maxResponseBytes: positive(value.maxResponseBytes ?? 32 * 1024 * 1024, 'Максимум байт в ответе', 256 * 1024 * 1024),
    timeoutMs: positive(value.timeoutMs ?? 30_000, 'Тайм-аут запроса', 600_000),
  };
  if (result.parameters.some(parameter => parameter.where === 'body' && parameter.key === '$')) {
    demand(result.parameters.filter(parameter => parameter.where === 'body').length === 1 && result.pagination.target !== 'body',
      'Массив в корне JSON должен быть единственным параметром тела.');
  }
  demand(['resume', 'restart', 'decision'].includes(result.recovery), 'Неподдерживаемый режим восстановления.');
  demand(result.recovery === 'decision' || result.safeToRetry, 'Восстановление разрешено только для безопасно повторяемых запросов.');
  for (const match of result.path.matchAll(/\{([^}]+)\}/g)) {
    demand(result.parameters.some(param => param.where === 'path' && param.key === match[1]), 'Укажите тип каждого параметра пути.');
  }
  if (result.pagination.target === 'header') {
    demand(!connection.profiles.some(profile => profile.headers.some(header =>
      header.name.toLowerCase() === result.pagination.parameter.toLowerCase())), 'Пагинация конфликтует с заголовком авторизации.');
  }
  if (value.period !== undefined) {
    const period = value.period;
    demand(object(period) && period.from !== period.to && [period.from, period.to].every(name =>
      result.parameters.some(param => param.name === name && param.type === 'date')), 'Для периода укажите два параметра даты.');
    result.period = { from: period.from, to: period.to };
    for (const field of ['daysPerRequest', 'historyMonths', 'maxDays']) {
      if (period[field] !== undefined) result.period[field] = positive(period[field], field, 36_600);
    }
  }
  const response = value.response;
  demand(object(response), 'Настройте извлечение ответа.');
  pathParts(response.rows);
  result.response = { rows: response.rows, columns: columns(response.columns), allowNoContent: response.allowNoContent === true };
  if (response.singleObject !== undefined) {
    demand(typeof response.singleObject === 'boolean', 'Значение singleObject должно быть логическим.');
    result.response.singleObject = response.singleObject;
  }
  if (response.requestFields !== undefined) {
    demand(object(response.requestFields), 'Укажите поля из параметров запуска как объект.');
    result.response.requestFields = Object.fromEntries(Object.entries(response.requestFields).map(([name, path]) => {
      const [parameter, element] = pathParts(path);
      const spec = result.parameters.find(spec => spec.name === parameter);
      demand(spec, 'Укажите путь к существующему параметру запуска.');
      if (spec.type === 'array' && element !== undefined) {
        demand(spec.batchSize === 1 && element === '0', 'Для поля элемента массива в ответе укажите batchSize 1 и путь к элементу 0.');
      }
      return [id(name), path];
    }));
  }
  if (response.success !== undefined) {
    demand(object(response.success) && Object.hasOwn(response.success, 'equals'), 'Укажите ожидаемое значение поля успеха.');
    pathParts(response.success.path);
    result.response.success = { path: response.success.path, equals: response.success.equals };
  }
  for (const field of ['expand', 'deduplicateBy']) {
    if (response[field] !== undefined) {
      pathParts(response[field]);
      result.response[field] = response[field];
    }
  }
  result.response.tables = optionalList(response.tables, 'Таблицы').map(table => {
    demand(object(table), 'Опишите отдельную таблицу.');
    pathParts(table.path);
    return { name: text(table.name, 'имя таблицы'), path: table.path, columns: columns(table.columns) };
  });
  return result;
}

function numberCompare(value, bound) {
  const a = integer(value);
  const b = integer(bound);
  if (a !== null && b !== null) return a < b ? -1 : a > b ? 1 : 0;
  return Number(scalarText(value)) - Number(scalarText(bound));
}

function checkValue(value, spec, label) {
  if (value === undefined) {
    demand(!spec.required, `Заполните «${label}».`);
    return;
  }
  if (value === null) {
    demand(spec.nullable, `«${label}» не принимает null.`);
    return;
  }
  const checks = {
    string: typeof value === 'string' && (!spec.required || value.trim().length > 0),
    integer: integer(value) !== null,
    number: (typeof value === 'number' && Number.isFinite(value)) || isLosslessNumber(value),
    boolean: typeof value === 'boolean',
    date: Number.isFinite(dateMs(value)),
    datetime: typeof value === 'string' && /T.*(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value)),
    array: Array.isArray(value),
    object: object(value),
  };
  demand(checks[spec.type], `«${label}»: ожидается тип ${spec.type}.`);
  if (spec.enum) demand(spec.enum.some(option => stringify(option) === stringify(value)), `«${label}»: значение вне списка.`);
  if (spec.min !== undefined) demand(numberCompare(value, spec.min) >= 0, `«${label}»: значение меньше минимума.`);
  if (spec.max !== undefined) demand(numberCompare(value, spec.max) <= 0, `«${label}»: значение больше максимума.`);
  if (spec.type === 'array') {
    demand(value.length >= (spec.minItems ?? 0), `«${label}»: слишком мало элементов.`);
    demand(value.length <= (spec.maxItems ?? Infinity), `«${label}»: слишком много элементов для запуска.`);
    if (spec.unique) demand(new Set(value.map(item => stringify(item))).size === value.length, `«${label}»: элементы должны быть уникальны.`);
    for (const item of value) checkValue(item, spec.items, label);
  }
  if (spec.type === 'object' && spec.properties) {
    for (const [key, property] of Object.entries(spec.properties)) {
      checkValue(Object.hasOwn(value, key) ? value[key] : undefined, property, `${label}.${key}`);
    }
  }
}

function resolveDates(value, spec, runDay) {
  if (['date', 'datetime'].includes(spec.type) && object(value) && Object.hasOwn(value, 'daysFromRun')) {
    const timed = spec.type === 'datetime';
    demand(Number.isSafeInteger(value.daysFromRun) && Object.keys(value).every(key =>
      key === 'daysFromRun' || (timed && key === 'time')), 'Введите целое смещение даты в днях.');
    const calendar = new Date(0);
    calendar.setUTCFullYear(runDay.getFullYear(), runDay.getMonth(), runDay.getDate() + value.daysFromRun);
    demand(Number.isFinite(calendar.getTime()) && calendar.getUTCFullYear() >= 1 && calendar.getUTCFullYear() <= 9999,
      'Смещение выводит дату за допустимый диапазон.');
    if (!timed) return calendar.toISOString().slice(0, 10);
    demand(typeof value.time === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(value.time),
      'Укажите время динамической даты в формате ЧЧ:ММ.');
    const [hours, minutes, seconds = 0] = value.time.split(':').map(Number);
    const local = new Date(runDay);
    local.setFullYear(calendar.getUTCFullYear(), calendar.getUTCMonth(), calendar.getUTCDate());
    local.setHours(hours, minutes, seconds, 0);
    return local.toISOString();
  }
  if (spec.type === 'array' && Array.isArray(value)) {
    return value.map(item => resolveDates(item, spec.items, runDay));
  }
  if (spec.type === 'object' && spec.properties && object(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key, Object.hasOwn(spec.properties, key) ? resolveDates(item, spec.properties[key], runDay) : item,
    ]));
  }
  return value;
}

function inputValues(template, supplied, allowUnresolved = false, runDay = null) {
  demand(object(supplied), 'Значения параметров должны быть объектом.');
  demand(Object.keys(supplied).every(name => template.parameters.some(param => param.name === name)), 'Передан неизвестный параметр.');
  const result = {};
  for (const spec of template.parameters) {
    if (spec.reference?.mode === 'all' && allowUnresolved) continue;
    const entered = Object.hasOwn(supplied, spec.name) ? supplied[spec.name] : spec.default;
    const value = runDay ? resolveDates(entered, spec, runDay) : entered;
    checkValue(value, spec, spec.label);
    if (value !== undefined) result[spec.name] = value;
  }
  const period = template.period;
  if (period && result[period.from] && result[period.to]) {
    const days = (dateMs(result[period.to]) - dateMs(result[period.from])) / DAY + 1;
    demand(days > 0, 'Дата окончания не может быть раньше начала.');
    demand(days <= (period.maxDays ?? Infinity), 'Период превышает ограничение всего запуска.');
  }
  return result;
}

function profileFor(source) {
  const endpoint = source.connection.endpoints.find(item => item.id === source.template.endpointId);
  const profileId = source.environment === 'sandbox'
    ? endpoint.sandboxProfileId ?? source.template.profileId ?? endpoint.profileId ?? 'default'
    : source.template.profileId ?? endpoint.profileId ?? 'default';
  return { endpoint, profile: source.connection.profiles.find(item => item.id === profileId) };
}

function initialPosition(pagination) {
  return pagination.initial === undefined ? {} : { value: pagination.initial };
}

function requestFor(source, values, position, credentials = null) {
  const { template, environment } = source;
  const { endpoint, profile } = profileFor(source);
  const base = environment === 'sandbox' ? endpoint.sandbox : endpoint.url;
  demand(base, 'Для адреса не настроена песочница.');
  let relative = template.path;
  const query = new URLSearchParams();
  const headers = new Headers({ accept: 'application/json' });
  let body = {};
  const add = (where, key, value, encoding) => {
    if (where === 'body') set(body, key, value);
    if (where === 'header') headers.set(key, scalarText(value));
    if (where === 'query') {
      if (Array.isArray(value) && encoding === 'repeat') {
        for (const item of value) query.append(key, scalarText(item));
      } else {
        const encoded = Array.isArray(value) && encoding === 'csv' ? value.map(scalarText).join(',') : scalarText(value);
        query.set(key, value === null ? 'null' : encoded);
      }
    }
    if (where === 'path') {
      const encoded = scalarText(value);
      demand(encoded && encoded !== '.' && encoded !== '..', 'Недопустимое значение параметра пути.');
      relative = relative.replaceAll(`{${key}}`, encodeURIComponent(encoded));
    }
  };
  for (const spec of template.parameters) {
    let value = values[spec.name];
    if (value === undefined || spec.where === 'input') continue;
    if (value !== null && spec.format === 'unix-start') value = dateMs(value) / 1000;
    if (value !== null && spec.format === 'unix-end') value = (dateMs(value) + DAY) / 1000 - 1;
    if (spec.where === 'body' && spec.key === '$') body = value;
    else add(spec.where, spec.key, value, spec.encoding);
  }
  if (position.value !== undefined) add(template.pagination.target, template.pagination.parameter, position.value);
  const origin = baseUrl(base);
  const basePath = origin.href.replace(/\/?$/, '/');
  const url = position.link ? new URL(position.link, origin) : new URL(relative.slice(1), basePath);
  demand(url.origin === origin.origin && !url.username && !url.password && !url.hash, 'Ссылка следующей страницы ведёт за пределы подключения.');
  if (!position.link) url.search = query.toString();
  if (credentials !== null) {
    for (const header of profile?.headers ?? []) {
      const secret = credentials[header.key];
      demand(typeof secret === 'string' && secret.trim() && !/[\r\n]/.test(secret),
        'Заполните авторизацию для выбранного подключения и среды.');
      headers.set(header.name, `${header.prefix}${secret}`);
    }
  }
  let serialized;
  const bodyFields = Array.isArray(body) ? ['$'] : Object.keys(body);
  if (bodyFields.length || template.parameters.some(spec => spec.where === 'body' && spec.key !== '$')) {
    headers.set('content-type', 'application/json');
    serialized = stringify(body);
  }
  const logPath = position.link ? '/[next-page-path]' : new URL(template.path.slice(1), basePath).pathname;
  return { url, method: template.method, headers, body: serialized, logPath, bodyFields };
}

function* batches(source, values) {
  const period = source.template.period;
  const spec = source.template.parameters;
  const limits = spec.filter(item => item.batchSize && Array.isArray(values[item.name]));
  const listParts = function* (current, index = 0) {
    if (index === limits.length) { yield current; return; }
    const { name, batchSize } = limits[index];
    const list = current[name];
    if (!list.length) yield* listParts(current, index + 1);
    for (let offset = 0; offset < list.length; offset += batchSize) {
      yield* listParts({ ...current, [name]: list.slice(offset, offset + batchSize) }, index + 1);
    }
  };
  const periods = function* (current) {
    if (!period?.daysPerRequest || !current[period.from] || !current[period.to]) { yield current; return; }
    const size = period.daysPerRequest * DAY;
    const end = dateMs(current[period.to]);
    const date = timestamp => new Date(timestamp).toISOString().slice(0, 10);
    for (let start = dateMs(current[period.from]); start <= end; start += size) {
      yield { ...current, [period.from]: date(start), [period.to]: date(Math.min(start + size - DAY, end)) };
    }
  };
  const fitBody = function* (current) {
    const request = requestFor(source, current, initialPosition(source.template.pagination));
    if (!request.body || Buffer.byteLength(request.body) <= source.template.maxBodyBytes) { yield current; return; }
    const splitter = spec.find(item => (item.splitForBody || item.batchSize) &&
      Array.isArray(current[item.name]) && current[item.name].length > 1);
    demand(splitter, 'JSON-тело превышает лимит, и настроенного списка для разбиения нет.');
    const list = current[splitter.name];
    const middle = Math.ceil(list.length / 2);
    yield* fitBody({ ...current, [splitter.name]: list.slice(0, middle) });
    yield* fitBody({ ...current, [splitter.name]: list.slice(middle) });
  };
  let count = 0;
  for (const list of listParts(values)) {
    for (const dates of periods(list)) {
      for (const batch of fitBody(dates)) {
        demand(++count <= 10_000, 'Превышено защитное ограничение на число частей запуска.');
        yield batch;
      }
    }
  }
}

function responseRows(response, payload, httpStatus, values) {
  if (httpStatus === 204 && response.allowNoContent) return [];
  if (response.success) {
    const success = get(payload, response.success.path);
    demand(success !== undefined && stringify(success) === stringify(response.success.equals), 'API сообщил об ошибке в теле ответа.');
  }
  const records = get(payload, response.rows);
  let rows = records;
  if (response.singleObject) {
    demand(object(records), 'В ответе отсутствует настроенный объект записи.');
    rows = [records];
  } else {
    demand(Array.isArray(records), 'В ответе отсутствует настроенный массив записей.');
  }
  if (!response.requestFields || !rows.length) return rows;
  const request = Object.fromEntries(Object.entries(response.requestFields).map(([name, path]) => {
    const value = get(values, path);
    demand(value !== undefined, `В параметрах запроса отсутствует поле «${path}».`);
    return [name, value];
  }));
  return rows.map(row => {
    demand(object(row) && !Object.hasOwn(row, 'request'), 'Для сохранения параметров запроса нужна запись со свободным полем request.');
    return { ...row, request };
  });
}

function nextPosition(pagination, payload, rows, position, values, rowCount, currentUrl) {
  const type = pagination.type;
  if (type === 'none') return null;
  if (type === 'integer-cursor') {
    if (!rows.length) return null;
    const next = get(payload, pagination.cursor);
    const converted = integer(next);
    demand(converted !== null && converted > integer(position.value), 'Числовой курсор не продвинулся. Полученные строки сохранены.');
    return { value: next };
  }
  if (type === 'flag-cursor') {
    const flag = get(payload, pagination.flag);
    demand(typeof flag === 'boolean', 'Флаг следующей страницы должен быть boolean.');
    if (!flag) return null;
  }
  if (['flag-cursor', 'token', 'link'].includes(type)) {
    const token = get(payload, pagination.cursor);
    if (type !== 'flag-cursor' && (token === undefined || token === '')) return null;
    demand(typeof token === 'string' && token.trim(), 'Сервер не передал действительный курсор следующей страницы.');
    if (type === 'link') {
      let link;
      try { link = new URL(token, currentUrl); } catch { throw new InputError('Недопустимая ссылка следующей страницы.'); }
      demand(link.origin === currentUrl.origin && !link.username && !link.password && !link.hash, 'Ссылка следующей страницы ведёт за пределы подключения.');
      return { link: link.href };
    }
    return { value: token };
  }
  const size = values[pagination.sizeParameter];
  if (pagination.end === 'short' || type === 'offset') positive(size, 'Размер страницы');
  if (pagination.end === 'empty' && rows.length === 0) return null;
  if (pagination.end === 'short' && rows.length < size) return null;
  if (pagination.end === 'total') {
    const total = integer(get(payload, pagination.endPath));
    demand(total !== null && total >= 0n, 'В ответе нет корректного общего количества строк.');
    if (BigInt(rowCount) >= total) return null;
  }
  if (pagination.end === 'flag') {
    const flag = get(payload, pagination.endPath);
    demand(typeof flag === 'boolean', 'Флаг следующей страницы должен быть boolean.');
    if (!flag) return null;
  }
  return { value: positive(position.value + (type === 'page' ? 1 : size), 'Следующая позиция') };
}

function historyWarning(template, values, now = new Date()) {
  const period = template.period;
  if (!period?.historyMonths || !values[period.from]) return null;
  const boundary = new Date(now);
  const day = boundary.getUTCDate();
  boundary.setUTCDate(1);
  boundary.setUTCMonth(boundary.getUTCMonth() - period.historyMonths + 1, 0);
  boundary.setUTCDate(Math.min(day, boundary.getUTCDate()));
  boundary.setUTCHours(0, 0, 0, 0);
  return dateMs(values[period.from]) < boundary.valueOf()
    ? `Начало периода выходит за доступную историю API (${period.historyMonths} мес.).`
    : null;
}

module.exports = { batches, clone, columns, dateMs, demand, folder, historyWarning, id, initialPosition, inputValues, methods,
  nextPosition, positive, profileFor, requestFor, responseRows, text, validateConnection, validateTemplate };
