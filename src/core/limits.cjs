const { createHash } = require('node:crypto');
const { setTimeout: sleep } = require('node:timers/promises');
const { parameterText } = require('./model.cjs');

function retryAfter(value, now) {
  if (!value) return null;
  if (/^\d+$/.test(value.trim())) return Math.min(Number(value) * 1000, 86_400_000);
  const time = Date.parse(value);
  return Number.isFinite(time) ? Math.max(0, time - now) : null;
}

function resourceUntil(headers) {
  const value = headers.get('x-ratelimit-resource-until');
  if (!value) return 0;
  const result = Date.parse(value);
  return Number.isFinite(result) ? result : 0;
}

class LimitScheduler {
  constructor({ now = Date.now, wait = (ms, signal) => sleep(ms, undefined, { signal }) } = {}) {
    this.now = now;
    this.wait = wait;
    this.states = new Map();
  }

  entries(source, values, credentials) {
    const { connection, template, environment } = source;
    const rules = [...connection.limits, ...template.limits];
    const entries = new Map();
    for (const rule of rules) {
      if (rule.environment && rule.environment !== environment) continue;
      const scope = rule.scopeParam?.find(name => values[name] !== undefined && values[name] !== null);
      const pathParameter = scope && template.parameters?.find(parameter => parameter.name === scope && parameter.where === 'path');
      const scopeValue = scope && parameterText(values[scope], pathParameter?.encoding);
      const credential = rule.credential && credentials[rule.credential];
      const identity = credential ? createHash('sha256').update(credential).digest('hex') : connection.account;
      const key = JSON.stringify([connection.policyId, environment, rule.id, rule.type, identity, scope, scopeValue]);
      let state = this.states.get(key);
      if (!state) {
        state = { tokens: rule.burst, time: this.now(), requests: [], running: 0, paused: 0, remaining: null, reserved: 0, until: 0 };
        this.states.set(key, state);
      }
      const value = rule.costParam && values[rule.costParam];
      const cost = Array.isArray(value) ? value.length : 1;
      entries.set(key, { rule, state, cost });
    }
    return [...entries.values()];
  }

  delay({ rule, state, cost }, now) {
    const paused = Math.max(0, state.paused - now);
    if (rule.type === 'bucket') {
      state.tokens = Math.min(rule.burst, state.tokens + Math.max(0, now - state.time) / rule.refillMs);
      state.time = now;
      return Math.max(paused, Math.ceil((1 - state.tokens) * rule.refillMs));
    }
    if (rule.type === 'window') {
      while (state.requests.length && state.requests[0] + rule.windowMs <= now) state.requests.shift();
      const readyAt = state.requests.length >= rule.max ? state.requests[state.requests.length - rule.max] + rule.windowMs : now;
      return Math.max(paused, readyAt - now);
    }
    if (rule.type === 'concurrency') return Math.max(paused, state.running >= rule.max ? 50 : 0);
    if (state.until <= now) {
      state.remaining = null;
      state.until = 0;
    }
    const quotaDelay = state.remaining !== null && state.remaining - state.reserved < cost
      ? (state.remaining < cost ? state.until - now : 50)
      : 0;
    return Math.max(paused, quotaDelay);
  }

  async acquire(source, values, credentials, signal, onWait = () => {}) {
    const entries = this.entries(source, values, credentials);
    while (true) {
      signal?.throwIfAborted();
      const now = this.now();
      const delay = Math.max(0, ...entries.map(entry => this.delay(entry, now)));
      if (delay > 0) {
        onWait(delay);
        await this.wait(Math.min(delay, 86_400_000), signal);
        continue;
      }
      for (const { rule, state, cost } of entries) {
        if (rule.type === 'bucket') state.tokens -= 1;
        if (rule.type === 'window') state.requests.push(now);
        if (rule.type === 'concurrency') state.running++;
        if (rule.type === 'resource') state.reserved += cost;
      }
      break;
    }
    return (status, headers = new Headers()) => this.finish(entries, status, headers);
  }

  finish(entries, status, headers) {
    const now = this.now();
    const remainingHeader = headers.get('x-ratelimit-resource-remaining');
    const remaining = remainingHeader !== null && /^\d+$/.test(remainingHeader) ? Number(remainingHeader) : null;
    const until = resourceUntil(headers);
    const exhausted = remaining === 0 && until > now;
    const retry = retryAfter(headers.get('retry-after'), now);
    for (const { rule, state, cost } of entries) {
      if (rule.type === 'concurrency') state.running--;
      if (rule.type === 'bucket' && status >= 400 && status < 500) state.tokens -= rule.badRequestCost - 1;
      if (rule.type === 'resource') {
        state.reserved -= cost;
        if (until >= state.until && until > now && Number.isSafeInteger(remaining)) {
          state.remaining = until === state.until && state.remaining !== null ? Math.min(state.remaining, remaining) : remaining;
          state.until = until;
        } else if (state.remaining !== null && status >= 200 && status < 500) {
          state.remaining = Math.max(0, state.remaining - cost);
        }
      }
      if (status === 429) state.paused = Math.max(state.paused, now + (retry ?? 1000));
      if (status === 420 && (rule.type === 'resource' && exhausted || rule.type === 'concurrency' && !exhausted)) {
        state.paused = Math.max(state.paused, exhausted ? until : now + (retry ?? 1000));
      }
    }
    if (status === 420 && exhausted) return Math.max(until - now, retry ?? 0);
    return retry;
  }
}

module.exports = { LimitScheduler, retryAfter };
