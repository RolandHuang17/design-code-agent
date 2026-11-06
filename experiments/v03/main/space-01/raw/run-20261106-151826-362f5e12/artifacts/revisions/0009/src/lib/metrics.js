'use strict';

/**
 * Observability metrics: a small Prometheus text-exposition registry.
 *
 * The architecture requires per-component and business metrics
 * (Architecture_Documentation.md "G. Observability & SRE — Key per-component
 * & business metrics"): game start rate, game completion rate, user
 * engagement, question response rate, and question accuracy rate.
 *
 * This module keeps a dependency-free registry so that the default npm test
 * runs without a live Prometheus server. The registry exposes `register()`
 * which conforms to the Prometheus text format and can be mounted behind a
 * scraping endpoint in the operational deployment.
 */

const METRIC_TYPES = new Set(['counter', 'gauge', 'histogram', 'summary']);

class Metric {
  constructor(name, help, type, labelNames = []) {
    this.name = name;
    this.help = help;
    this.type = type;
    this.labelNames = labelNames;
    this.samples = new Map(); // key -> number | number[] (histogram/summary buckets)
  }

  _key(labels) {
    const parts = this.labelNames.map((n) => {
      if (labels[n] === undefined) {
        throw new TypeError(`missing label "${n}" for metric ${this.name}`);
      }
      return String(labels[n]);
    });
    return parts.join('\u0000');
  }

  _validateLabels(labels) {
    const extra = Object.keys(labels).filter((n) => !this.labelNames.includes(n));
    if (extra.length > 0) {
      throw new TypeError(`unexpected label(s) ${extra.join(',')} for metric ${this.name}`);
    }
  }

  inc(labels = {}, value = 1) {
    this._validateLabels(labels);
    const key = this._key(labels);
    const current = this.samples.get(key) || 0;
    this.samples.set(key, current + value);
  }

  set(labels = {}, value) {
    this._validateLabels(labels);
    if (typeof value !== 'number') {
      throw new TypeError(`set() requires a numeric value for metric ${this.name}`);
    }
    this.samples.set(this._key(labels), value);
  }

  observe(labels = {}, value) {
    this._validateLabels(labels);
    if (typeof value !== 'number') {
      throw new TypeError(`observe() requires a numeric value for metric ${this.name}`);
    }
    const key = this._key(labels);
    const current = this.samples.get(key);
    if (!Array.isArray(current)) {
      throw new TypeError(`observe() is only valid for histogram metrics (${this.name})`);
    }
    // Bucket boundaries are defined by caller; simplest supported shape is a
    // fixed linear arrangement handled by histogram-specific subclass below.
    current.push(value);
  }

  _hasValue() {
    return this.samples.size === 0;
  }

  textLines() {
    const lines = [];
    const header = [];
    if (this.help) header.push(`# HELP ${this.name} ${this.help}`);
    header.push(`# TYPE ${this.name} ${this.type}`);
    lines.push(...header);
    if (this.samples.size === 0) {
      lines.push(`${this.name} 0`);
      return lines;
    }
    for (const [key, value] of this.samples) {
      const labelStr =
        this.labelNames.length === 0
          ? ''
          : `{${this.labelNames
              .map((n, i) => `${n}="${key.split('\u0000')[i]}"`)
              .join(',')}}`;
      const v = Array.isArray(value)
        ? this._aggregate(value)
        : value;
      lines.push(`${this.name}${labelStr} ${v}`);
    }
    return lines;
  }

  _aggregate(values) {
    // Default histogram aggregation: sum + count.
    const count = values.length;
    const sum = values.reduce((a, b) => a + b, 0);
    return `${count} ${sum}`;
  }
}

class Counter extends Metric {
  constructor(name, help, labelNames = []) {
    super(name, help, 'counter', labelNames);
  }
}

class Gauge extends Metric {
  constructor(name, help, labelNames = []) {
    super(name, help, 'gauge', labelNames);
  }
}

class Histogram extends Metric {
  constructor(name, help, buckets, labelNames = []) {
    super(name, help, 'histogram', labelNames);
    this.buckets = buckets || [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
    this.counts = new Map(); // key -> number
    this.sums = new Map(); // key -> number
  }

  observe(labels = {}, value) {
    this._validateLabels(labels);
    if (typeof value !== 'number') {
      throw new TypeError(`observe() requires a numeric value for metric ${this.name}`);
    }
    const key = this._key(labels);
    this.counts.set(key, (this.counts.get(key) || 0) + 1);
    this.sums.set(key, (this.sums.get(key) || 0) + value);
    if (!this.samples.has(key)) this.samples.set(key, []);
    // Track per-bucket cumulative counts using a parallel structure.
    if (!this.bucketCounts) this.bucketCounts = new Map();
    if (!this.bucketCounts.has(key)) {
      this.bucketCounts.set(key, this.buckets.map(() => 0));
    }
    const bucketVals = this.bucketCounts.get(key);
    for (let i = 0; i < this.buckets.length; i++) {
      if (value <= this.buckets[i]) bucketVals[i] += 1;
    }
  }

  textLines() {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    const keys = new Set([...this.counts.keys(), ...this.sums.keys(), ...(this.bucketCounts ? this.bucketCounts.keys() : [])]);
    if (keys.size === 0) {
      lines.push(`${this.name}_count 0`, `${this.name}_sum 0`);
      return lines;
    }
    for (const key of keys) {
      const labelStr =
        this.labelNames.length === 0
          ? ''
          : `{${this.labelNames.map((n, i) => `${n}="${key.split('\u0000')[i]}"`).join(',')}}`;
      const bucketVals = (this.bucketCounts && this.bucketCounts.get(key)) || [];
      let cumulative = 0;
      for (let i = 0; i < this.buckets.length; i++) {
        cumulative += bucketVals[i] || 0;
        lines.push(`${this.name}_bucket${labelStr ? `${labelStr}`.replace('}', `,le="${this.buckets[i]}"}`) : `{le="${this.buckets[i]}"}`} ${cumulative}`);
      }
      const total = cumulative + ((this.bucketCounts && this.bucketCounts.get(key)) ? 0 : 0);
      lines.push(`${this.name}_bucket${labelStr ? `${labelStr}`.replace('}', ',le="+Inf"') : '{le="+Inf"}'} ${total}`);
      lines.push(`${this.name}_sum${labelStr} ${this.sums.get(key) || 0}`);
      lines.push(`${this.name}_count${labelStr} ${this.counts.get(key) || 0}`);
    }
    return lines;
  }
}

class Registry {
  constructor() {
    this.metrics = new Map();
  }

  counter(name, help = '', labelNames = []) {
    return this._register(new Counter(name, help, labelNames));
  }

  gauge(name, help = '', labelNames = []) {
    return this._register(new Gauge(name, help, labelNames));
  }

  histogram(name, help = '', options = {}) {
    const buckets = options.buckets;
    const labelNames = options.labelNames || [];
    return this._register(new Histogram(name, help, buckets, labelNames));
  }

  _register(metric) {
    if (this.metrics.has(metric.name)) {
      throw new Error(`metric "${metric.name}" already registered`);
    }
    if (!METRIC_TYPES.has(metric.type)) {
      throw new Error(`unknown metric type "${metric.type}"`);
    }
    this.metrics.set(metric.name, metric);
    return metric;
  }

  /**
   * Returns Prometheus text exposition format.
   * @returns {string}
   */
  register() {
    const lines = [];
    for (const metric of this.metrics.values()) {
      lines.push(...metric.textLines());
    }
    return lines.join('\n') + (lines.length ? '\n' : '');
  }
}

// ---------------------------------------------------------------------------
// Default process-wide registry pre-seeded with the business metrics the
// architecture names: game start rate, game completion rate, user engagement,
// question response rate, and question accuracy rate.
// ---------------------------------------------------------------------------

const registry = new Registry();

const gameStartRate = registry.counter(
  'space_fractions_game_starts_total',
  'Total number of games started',
  ['game']
);
const gameCompletionRate = registry.counter(
  'space_fractions_game_completions_total',
  'Total number of games completed',
  ['game']
);
const userEngagement = registry.gauge(
  'space_fractions_active_users',
  'Number of currently engaged users',
  []
);
const questionResponseRate = registry.counter(
  'space_fractions_question_responses_total',
  'Total number of question responses submitted',
  ['question']
);
const questionAccuracyRate = registry.counter(
  'space_fractions_question_correct_total',
  'Total number of correct question responses',
  ['question']
);

// HTTP-level operational metrics (bounded downstream calls).
const httpRequestsTotal = registry.counter(
  'space_fractions_http_requests_total',
  'Total HTTP requests observed by the gateway',
  ['method', 'path', 'status']
);
const httpRequestDuration = registry.histogram(
  'space_fractions_http_request_duration_seconds',
  'HTTP request duration in seconds',
  { labelNames: ['method', 'path'] }
);

module.exports = {
  Registry,
  Counter,
  Gauge,
  Histogram,
  registry,
  gameStartRate,
  gameCompletionRate,
  userEngagement,
  questionResponseRate,
  questionAccuracyRate,
  httpRequestsTotal,
  httpRequestDuration,
};