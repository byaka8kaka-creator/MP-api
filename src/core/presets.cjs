const marketplace = 'wildberries';
const ozon = 'ozon';
const market = 'yandex-market';

const connections = [
  {
    id: marketplace,
    name: 'Wildberries',
    account: 'seller',
    endpoints: [
      { id: 'marketplace', name: 'Маркетплейс', url: 'https://marketplace-api.wildberries.ru',
        sandbox: 'https://marketplace-api-sandbox.wildberries.ru' },
      { id: 'analytics', name: 'Аналитика продавца', url: 'https://seller-analytics-api.wildberries.ru' },
      { id: 'statistics', name: 'Статистика', url: 'https://statistics-api.wildberries.ru' },
    ],
    profiles: [{ id: 'default', name: 'Токен Wildberries', headers: [{ key: 'token', name: 'Authorization' }] }],
    limits: [],
  },
  {
    id: ozon,
    name: 'Ozon Seller',
    account: 'seller',
    endpoints: [{ id: 'seller', name: 'Seller API', url: 'https://api-seller.ozon.ru' }],
    profiles: [
      { id: 'default', name: 'Ключ Ozon', headers: [{ key: 'clientId', name: 'Client-Id' }, { key: 'key', name: 'Api-Key' }] },
      { id: 'oauth', name: 'OAuth', headers: [{ key: 'token', name: 'Authorization', prefix: 'Bearer ' }] },
    ],
    limits: [{ id: 'client-requests', type: 'bucket', refillMs: 20, burst: 1, credential: 'clientId' }],
  },
  {
    id: market,
    name: 'Яндекс Маркет',
    account: 'seller',
    endpoints: [{ id: 'partner', name: 'Partner API', url: 'https://api.partner.market.yandex.ru' }],
    profiles: [{ id: 'default', name: 'Ключ Маркета', headers: [{ key: 'key', name: 'Api-Key' }] }],
    limits: [{ id: 'parallel', type: 'concurrency', max: 4, scopeParam: ['campaignId', 'businessId'] }],
  },
];

const templates = [
  {
    id: 'wb-orders', connectionId: marketplace, endpointId: 'marketplace',
    name: 'Сборочные задания FBS', folder: 'Заказы', available: true,
    method: 'GET', path: '/api/v3/orders', safeToRetry: true, recovery: 'resume',
    parameters: [
      { name: 'limit', where: 'query', type: 'integer', min: 1, max: 1000, required: true, default: 1000 },
      { name: 'dateFrom', label: 'Дата начала (UTC)', where: 'query', type: 'date', format: 'unix-start' },
      { name: 'dateTo', label: 'Дата окончания (UTC)', where: 'query', type: 'date', format: 'unix-end' },
    ],
    period: { from: 'dateFrom', to: 'dateTo', daysPerRequest: 30, historyMonths: 3 },
    pagination: { type: 'integer-cursor', target: 'query', parameter: 'next', cursor: 'next', initial: 0 },
    limits: [
      { id: 'fbs-marketplace', type: 'bucket', refillMs: 200, burst: 20, badRequestCost: 10, environment: 'production' },
      { id: 'sandbox-marketplace', type: 'bucket', refillMs: 1000, burst: 1, environment: 'sandbox' },
    ],
    response: { rows: 'orders', columns: [
      { path: 'id', name: 'ID заказа' },
      { path: 'createdAt', name: 'Создан' },
      { path: 'article', name: 'Артикул' },
      { path: 'price', name: 'Цена' },
      { path: 'address.fullAddress', name: 'Адрес' },
      { path: 'skus', name: 'Штрихкоды' },
    ] },
  },
  {
    id: 'ozon-warehouses', connectionId: ozon, endpointId: 'seller', profileId: 'default',
    name: 'Склады FBS / rFBS', folder: 'Склады', available: true,
    method: 'POST', path: '/v2/warehouse/list', safeToRetry: true, recovery: 'decision',
    parameters: [
      { name: 'limit', where: 'body', type: 'integer', min: 1, max: 200, required: true, default: 200 },
      { name: 'warehouse_ids', where: 'body', type: 'array', items: { type: 'integer' }, batchSize: 200 },
    ],
    pagination: { type: 'flag-cursor', target: 'body', parameter: 'cursor', cursor: 'cursor', flag: 'has_next' },
    response: { rows: 'warehouses', columns: [
      { path: 'warehouse_id', name: 'ID склада' }, { path: 'name', name: 'Название' },
      { path: 'status', name: 'Статус' }, { path: 'working_days', name: 'Рабочие дни' },
    ] },
  },
  {
    id: 'yandex-shipments', connectionId: market, endpointId: 'partner',
    name: 'Отгрузки первой мили', folder: 'Отгрузки', available: true,
    method: 'PUT', path: '/v2/campaigns/{campaignId}/first-mile/shipments',
    safeToRetry: true, recovery: 'decision', maxBodyBytes: 512 * 1024,
    parameters: [
      { name: 'campaignId', label: 'ID магазина', where: 'path', type: 'integer', min: 1, required: true },
      { name: 'limit', where: 'query', type: 'integer', min: 1, max: 30, default: 30 },
      { name: 'dateFrom', label: 'Дата начала', where: 'body', type: 'date' },
      { name: 'dateTo', label: 'Дата окончания', where: 'body', type: 'date' },
      { name: 'cancelledOrders', label: 'Включать отменённые', where: 'body', type: 'boolean' },
      { name: 'orderIds', where: 'body', type: 'array', nullable: true, items: { type: 'integer', min: 1 },
        minItems: 1, unique: true, splitForBody: true },
      { name: 'statuses', where: 'body', type: 'array', nullable: true, items: { type: 'string' }, minItems: 1, unique: true },
    ],
    period: { from: 'dateFrom', to: 'dateTo' },
    pagination: { type: 'token', target: 'query', parameter: 'pageToken', cursor: 'result.paging.nextPageToken' },
    limits: [
      { id: 'first-mile-shipments', type: 'window', max: 200, windowMs: 3600000, scopeParam: ['campaignId'] },
      { id: 'first-mile-resource', type: 'resource', scopeParam: ['campaignId'] },
    ],
    response: { rows: 'result.shipments', success: { path: 'status', equals: 'OK' },
      columns: [{ path: '$', name: 'Отгрузка' }] },
  },
];

module.exports = { connections, templates };
