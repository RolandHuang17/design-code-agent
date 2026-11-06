'use strict';

/**
 * Shared Prometheus text-format metrics registry for the Space Fractions
 * gateway (and reusable by other services if they adopt the same no-dependency
 * counter conventions).
 *
 * No external client is required for the core counters; the gateway exposes
 * this registry verbatim on GET /metrics as the Prometheus `text/plain;
 * version=0.0.4` scrape format (space-fractions.md lines 30-31: Prometheus
 * metrics must have real clients, not placeholder responses).
 *
 * Supported metric kinds:
 *   - Counter: monotonic, rendered as `<name>{labels} value`.
 *   - Gauge:   set-able, rendered the same way but with setValue/add semantics.
 *
 * Labels are rendered in sorted key order so a given logical series always
 * produces a stable line (important for scrape idempotency).
 */

/** Escape a Prometheus label value. */
function escapeLabel(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

/** Serialize a label map into a Prometheus label set suffix. */
function renderLabels(labels) {
  const entries = Object.entries(labels || {})
    .filter(([, v]) => v !== undefined && v !== null)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}="${escapeLabel(v)}"`);
  return `{${entries.join(',')}}`;
}

function seriesKey(name, labels) {
  return `${name}${renderLabels(labels)}`;
}

/**
 * Create a metrics registry.
 *
 * @returns {{
 *   inc: (name: string, labels?: object, by?: number) => void,
 *   set: (name: string, value: number, labels?: object) => void,
 *   get: (name: string, labels?: object) => number,
 *   render: () => string,
 * }}
 */
function createMetrics() {
  const counters = new Map();
  const gauges = new Map();

  return {
    /** Increment a counter (default +1). */
    inc(name, labels, by) {
      const key = seriesKey(name, labels);
      counters.set(key, (counters.get(key) || 0) + (by === undefined ? 1 : by));
    },

    /** Set a gauge to an absolute value. */
    set(name, value, labels) {
      const key = seriesKey(name, labels);
      gauges.set(key, value);
    },

    /** Read the current value of a counter or gauge (0 when absent). */
    get(name, labels) {
      const key = seriesKey(name, labels);
      const counter = counters.get(key);
      if (counter !== undefined) return counter;
      const gauge = gauges.get(key);
      if (gauge !== undefined) return gauge;
      return 0;
    },

    /** Render all registered series to the Prometheus text exposition format. */
    render() {
      const lines = [];
      for (const [key, value] of counters.entries()) {
        lines.push(`${key} ${value}`);
      }
      for (const [key, value] of gauges.entries()) {
        lines.push(`${key} ${value}`);
      }
      return `${lines.join('\n')}${lines.length ? '\n' : ''}`;
    },
  };
}

module.exports = {
  createMetrics,
  escapeLabel,
  renderLabels,
  seriesKey,
};