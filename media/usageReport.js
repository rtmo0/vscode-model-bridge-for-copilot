// Model Bridge usage report webview. Data arrives from the extension with postMessage; every string from
// the data (model and endpoint names) is inserted with textContent, never as HTML.
(function () {
  'use strict';

  const vscode = acquireVsCodeApi();
  const SVG = 'http://www.w3.org/2000/svg';
  const SERIES = [
    { key: 'uncachedInputTokens', name: 'Input, not cached', color: 'var(--series-1)' },
    { key: 'cachedInputTokens', name: 'Input from cache', color: 'var(--series-2)' },
    { key: 'outputTokens', name: 'Output', color: 'var(--series-3)' }
  ];
  const PROVIDER_LABELS = { claude: 'Claude', codex: 'Codex', lmstudio: 'LM Studio', openaiCompatible: 'OpenAI-Compatible' };
  const MISS_HELP = 'Agent tool steps with at least 8K input where less than half was read from the prompt cache. '
    + 'The conversation prefix changed, so the whole history was billed again.';

  const state = vscode.getState() || {};
  let report;
  let detail;
  let selectedConversation = state.selectedConversation;

  const $ = (id) => document.getElementById(id);
  const rangeSelect = $('range');
  const providerSelect = $('provider');
  const tooltip = $('tooltip');

  rangeSelect.value = String(state.range || '30');
  rangeSelect.addEventListener('change', requestReport);
  providerSelect.addEventListener('change', requestReport);
  $('refresh').addEventListener('click', requestReport);
  $('export').addEventListener('click', () => vscode.postMessage({ type: 'exportCsv', filter: currentFilter() }));
  $('clear').addEventListener('click', () => vscode.postMessage({ type: 'clear' }));
  $('settings').addEventListener('click', () => vscode.postMessage({ type: 'openSettings' }));
  $('detail-close').addEventListener('click', () => selectConversation(undefined));

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (message.type === 'report') {
      report = message.report;
      $('recording-off').hidden = message.recording !== false;
      document.body.classList.remove('loading');
      renderReport();
      if (selectedConversation) vscode.postMessage({ type: 'openConversation', id: selectedConversation });
    } else if (message.type === 'conversation') {
      detail = message.detail;
      renderDetail();
    }
  });

  let resizeFrame;
  new ResizeObserver(() => {
    cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(() => {
      if (report) renderCharts();
      if (detail && selectedConversation) renderDetailChart();
    });
  }).observe(document.body);

  vscode.postMessage({ type: 'ready', filter: currentFilter() });

  function currentFilter() {
    const range = rangeSelect.value === 'all' ? 'all' : Number(rangeSelect.value);
    return { range, provider: providerSelect.value || 'all' };
  }

  function requestReport() {
    const filter = currentFilter();
    saveState({ range: rangeSelect.value, provider: filter.provider });
    // Keep the previous render at reduced opacity while the new data loads.
    document.body.classList.add('loading');
    vscode.postMessage({ type: 'setFilter', filter });
  }

  function saveState(patch) {
    Object.assign(state, patch);
    vscode.setState(state);
  }

  // ---------------------------------------------------------------- report

  function renderReport() {
    renderProviderOptions();
    const empty = report.totals.requests === 0;
    $('empty').hidden = !empty;
    $('content').hidden = empty;
    if (empty) return;
    renderKpis();
    renderCharts();
    renderDailyTable();
    renderModelTable();
    renderConversations();
    renderRequests();
  }

  function renderProviderOptions() {
    const selected = state.provider || report.filter.provider || 'all';
    providerSelect.replaceChildren(option('all', 'All providers'));
    for (const provider of report.providers) providerSelect.append(option(provider, PROVIDER_LABELS[provider] || provider));
    providerSelect.value = report.providers.includes(selected) ? selected : 'all';
  }

  function option(value, label) {
    const element = document.createElement('option');
    element.value = value;
    element.textContent = label;
    return element;
  }

  function renderKpis() {
    const totals = report.totals;
    const container = $('kpis');
    container.replaceChildren();
    container.append(
      kpi('Requests', formatInteger(totals.requests), `${formatInteger(totals.conversations)} conversations · ${formatInteger(totals.toolSteps)} tool steps`),
      kpi('Input tokens', formatCompact(totals.inputTokens),
        totals.cacheHitRatio === undefined ? 'no prompt-cache data' : `${formatPercent(totals.cacheHitRatio)} read from cache`),
      kpi('Output tokens', formatCompact(totals.outputTokens),
        totals.reasoningTokens > 0 ? `${formatCompact(totals.reasoningTokens)} reasoning` : 'reasoning not reported'),
      missKpi(totals)
    );
    if (totals.costUsd !== undefined) {
      container.append(kpi('API-equivalent cost', formatUsd(totals.costUsd), 'estimate; subscriptions are not billed per token'));
    }
  }

  function kpi(label, value, sub) {
    const element = div('kpi');
    element.append(div('kpi-label', label), div('kpi-value', value), div('kpi-sub', sub));
    return element;
  }

  function missKpi(totals) {
    const element = kpi('Cache misses', formatInteger(totals.cacheMisses),
      totals.cacheMisses > 0 ? `${formatCompact(totals.cacheMissInputTokens)} input tokens re-read` : 'tool steps reused the cache');
    element.title = MISS_HELP;
    if (totals.cacheMisses > 0) {
      const label = element.querySelector('.kpi-label');
      label.replaceChildren();
      const status = document.createElement('span');
      status.className = 'status';
      const icon = document.createElement('span');
      icon.className = 'status-icon';
      icon.setAttribute('aria-hidden', 'true');
      status.append(icon, document.createTextNode('Cache misses'));
      label.append(status);
    }
    return element;
  }

  function renderCharts() {
    renderLegend($('daily-legend'));
    renderLegend($('model-legend'));
    columnChart($('daily-chart'), report.daily, {
      label: (item) => formatDay(item.day),
      title: (item) => formatDay(item.day, true),
      note: (item) => `${formatInteger(item.requests)} request${item.requests === 1 ? '' : 's'}`
    });
    barChart($('model-chart'), report.byModel);
  }

  function renderLegend(container) {
    container.replaceChildren(...SERIES.map((series) => {
      const item = document.createElement('span');
      item.className = 'legend-item';
      const swatch = document.createElement('span');
      swatch.className = 'legend-swatch';
      swatch.style.background = series.color;
      item.append(swatch, document.createTextNode(series.name));
      return item;
    }));
  }

  function renderDailyTable() {
    table($('daily-table'), [
      { key: 'day', label: 'Day', format: (row) => formatDay(row.day, true) },
      { key: 'requests', label: 'Requests', numeric: true, format: (row) => formatInteger(row.requests) },
      ...tokenColumns()
    ], report.daily.filter((row) => row.requests > 0).reverse());
  }

  function renderModelTable() {
    table($('model-table'), [
      { key: 'label', label: 'Model' },
      { key: 'requests', label: 'Requests', numeric: true, format: (row) => formatInteger(row.requests) },
      ...tokenColumns(),
      costColumn()
    ], report.byModel);
  }

  function tokenColumns() {
    return [
      { key: 'uncachedInputTokens', label: 'Input, not cached', numeric: true, format: (row) => formatInteger(row.uncachedInputTokens) },
      { key: 'cachedInputTokens', label: 'Input from cache', numeric: true, format: (row) => formatInteger(row.cachedInputTokens) },
      { key: 'outputTokens', label: 'Output', numeric: true, format: (row) => formatInteger(row.outputTokens) }
    ];
  }

  function costColumn() {
    return { key: 'costUsd', label: 'Cost (est.)', numeric: true, format: (row) => row.costUsd === undefined ? '—' : formatUsd(row.costUsd) };
  }

  function renderConversations() {
    table($('conversations-table'), [
      { key: 'lastTs', label: 'Last activity', format: (row) => formatTime(row.lastTs) },
      { key: 'models', label: 'Models', wrap: true, format: (row) => row.models.join(', '), sortValue: (row) => row.models.join(',') },
      { key: 'requests', label: 'Requests', numeric: true, format: (row) => formatInteger(row.requests) },
      { key: 'toolSteps', label: 'Tool steps', numeric: true, format: (row) => formatInteger(row.toolSteps) },
      { key: 'inputTokens', label: 'Input', numeric: true, format: (row) => formatCompact(row.inputTokens) },
      { key: 'cachedShare', label: 'From cache', numeric: true, format: (row) => cachedShare(row), sortValue: (row) => share(row) },
      { key: 'outputTokens', label: 'Output', numeric: true, format: (row) => formatCompact(row.outputTokens) },
      { key: 'maxInputTokens', label: 'Largest step', numeric: true, format: (row) => formatCompact(row.maxInputTokens) },
      { key: 'cacheMisses', label: 'Cache misses', numeric: true, format: (row) => missText(row.cacheMisses) },
      costColumn()
    ], report.conversations, {
      onSelect: (row) => selectConversation(row.id),
      isSelected: (row) => row.id === selectedConversation
    });
  }

  function renderRequests() {
    table($('requests-table'), requestColumns(), report.topRequests, {
      onSelect: (row) => selectConversation(row.conversation)
    });
  }

  function requestColumns() {
    return [
      { key: 'ts', label: 'Time', format: (row) => formatTime(row.ts) },
      { key: 'label', label: 'Model', wrap: true },
      { key: 'step', label: 'Step', numeric: true, format: (row) => `${row.step}${row.kind === 'tool' ? ' · tool' : ''}` },
      { key: 'inputTokens', label: 'Input', numeric: true, format: (row) => formatInteger(row.inputTokens) },
      { key: 'cachedShare', label: 'From cache', numeric: true, format: (row) => cachedShare(row), sortValue: (row) => share(row) },
      { key: 'cacheWriteTokens', label: 'Cache writes', numeric: true, format: (row) => row.cacheWriteTokens ? formatInteger(row.cacheWriteTokens) : '—' },
      { key: 'outputTokens', label: 'Output', numeric: true, format: (row) => formatInteger(row.outputTokens) },
      { key: 'durationMs', label: 'Duration', numeric: true, format: (row) => row.durationMs === undefined ? '—' : formatDuration(row.durationMs) },
      { key: 'cacheMiss', label: 'Cache miss', format: (row) => row.cacheMiss ? 'Yes' : '', sortValue: (row) => row.cacheMiss ? 1 : 0, icon: (row) => row.cacheMiss },
      costColumn()
    ];
  }

  // ---------------------------------------------------------------- conversation detail

  function selectConversation(id) {
    selectedConversation = id;
    saveState({ selectedConversation: id });
    detail = undefined;
    $('detail').hidden = !id;
    if (report) renderConversations();
    if (id) {
      $('detail-id').textContent = id;
      vscode.postMessage({ type: 'openConversation', id });
      $('detail').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  function renderDetail() {
    if (!detail || detail.id !== selectedConversation) return;
    $('detail').hidden = false;
    $('detail-id').textContent = detail.id;
    const rows = detail.rows;
    const misses = rows.filter((row) => row.cacheMiss).length;
    $('detail-summary').textContent = rows.length === 0
      ? 'No requests from this conversation are inside the retention period.'
      : `${rows.length} request${rows.length === 1 ? '' : 's'} · ${formatCompact(sum(rows, 'inputTokens'))} input · `
        + `${formatCompact(sum(rows, 'outputTokens'))} output${misses ? ` · ${misses} cache miss${misses === 1 ? '' : 'es'} (marked)` : ''}`
        + (detail.truncated ? ' · showing the latest 1,000' : '');
    renderLegend($('detail-legend'));
    renderDetailChart();
    table($('detail-table'), requestColumns(), rows);
  }

  function renderDetailChart() {
    if (!detail) return;
    columnChart($('detail-chart'), detail.rows, {
      label: (item) => `#${item.step}`,
      title: (item) => `Step ${item.step}${item.kind === 'tool' ? ' (tool results)' : ''} · ${formatTime(item.ts)}`,
      note: (item) => [item.label, item.cacheMiss ? 'Cache miss: the history was not read from the cache' : ''].filter(Boolean).join(' · '),
      marker: (item) => item.cacheMiss
    });
  }

  // ---------------------------------------------------------------- charts

  /** Stacked columns of the three token series, one column per item. */
  function columnChart(container, items, options) {
    const width = Math.max(280, container.clientWidth);
    const height = 220;
    const margin = { top: 14, right: 8, bottom: 26, left: 52 };
    const plotWidth = width - margin.left - margin.right;
    const plotHeight = height - margin.top - margin.bottom;
    const totals = items.map(stackTotal);
    const max = niceMax(Math.max(1, ...totals));
    const band = plotWidth / Math.max(1, items.length);
    const barWidth = Math.max(2, Math.min(24, band * 0.68));
    const y = (value) => margin.top + plotHeight - (value / max) * plotHeight;

    const svg = svgElement('svg', { viewBox: `0 0 ${width} ${height}`, height, role: 'img' });
    svg.setAttribute('aria-label', 'Token usage chart; the table below lists every value.');
    for (const tick of ticks(max)) {
      svg.append(svgElement('line', { class: tick === 0 ? 'baseline' : 'grid', x1: margin.left, x2: width - margin.right, y1: y(tick), y2: y(tick) }));
      const label = svgElement('text', { x: margin.left - 8, y: y(tick) + 4, 'text-anchor': 'end' });
      label.textContent = formatCompact(tick);
      svg.append(label);
    }

    const labelEvery = Math.max(1, Math.ceil(items.length / Math.max(2, Math.floor(plotWidth / 64))));
    // Hit areas cover the whole band and sit above the marks, so hovering a bar itself shows the tooltip.
    const hits = [];
    items.forEach((item, index) => {
      const center = margin.left + band * index + band / 2;
      const x = center - barWidth / 2;
      let base = 0;
      const segments = SERIES.map((series) => ({ series, value: item[series.key] || 0 })).filter((segment) => segment.value > 0);
      segments.forEach((segment, segmentIndex) => {
        const top = y(base + segment.value);
        const bottom = y(base);
        // A 2px surface gap separates stacked segments; the topmost segment gets the rounded data end.
        const gap = segmentIndex > 0 ? 2 : 0;
        const segmentHeight = Math.max(0, bottom - top - gap);
        if (segmentHeight > 0) {
          const isTop = segmentIndex === segments.length - 1;
          svg.append(svgElement('path', { d: barPath(x, top, barWidth, segmentHeight, isTop ? 4 : 0, 'top'), fill: segment.series.color }));
        }
        base += segment.value;
      });
      if (options.marker && options.marker(item)) {
        svg.append(svgElement('circle', { class: 'miss-marker', cx: center, cy: y(totals[index]) - 9, r: 4 }));
      }
      if (index % labelEvery === 0) {
        const label = svgElement('text', { x: center, y: height - 8, 'text-anchor': 'middle' });
        label.textContent = options.label(item);
        svg.append(label);
      }
      const hit = svgElement('rect', {
        class: 'hit', x: margin.left + band * index, y: margin.top, width: band, height: plotHeight, tabindex: 0
      });
      hit.setAttribute('aria-label', `${options.title(item)}: ${formatInteger(totals[index])} tokens`);
      bindTooltip(hit, () => tooltipContent(options.title(item), item, options.note && options.note(item)));
      hits.push(hit);
    });
    svg.append(...hits);
    container.replaceChildren(svg);
  }

  /** Horizontal stacked bars, one per model, with the model name above and the total at the bar end. */
  function barChart(container, items) {
    const width = Math.max(280, container.clientWidth);
    const rowHeight = 40;
    const valueSpace = 64;
    const height = items.length * rowHeight + 4;
    const max = Math.max(1, ...items.map(stackTotal));
    const scale = (width - valueSpace) / max;
    const svg = svgElement('svg', { viewBox: `0 0 ${width} ${height}`, height, role: 'img' });
    svg.setAttribute('aria-label', 'Tokens by model; the table below lists every value.');
    const hits = [];
    items.forEach((item, index) => {
      const top = index * rowHeight;
      const hit = svgElement('rect', { class: 'hit', x: 0, y: top, width, height: rowHeight, tabindex: 0 });
      hit.setAttribute('aria-label', `${item.label}: ${formatInteger(stackTotal(item))} tokens`);
      bindTooltip(hit, () => tooltipContent(item.label, item, `${formatInteger(item.requests)} requests`));
      hits.push(hit);
      const name = svgElement('text', { x: 0, y: top + 13, class: 'value-label' });
      name.textContent = item.label;
      svg.append(name);
      let x = 0;
      const segments = SERIES.map((series) => ({ series, value: item[series.key] || 0 })).filter((segment) => segment.value > 0);
      segments.forEach((segment, segmentIndex) => {
        const gap = segmentIndex > 0 ? 2 : 0;
        const segmentWidth = Math.max(0, segment.value * scale - gap);
        if (segmentWidth > 0) {
          const isEnd = segmentIndex === segments.length - 1;
          svg.append(svgElement('path', { d: barPath(x + gap, top + 19, segmentWidth, 14, isEnd ? 4 : 0, 'right'), fill: segment.series.color }));
        }
        x += segment.value * scale;
      });
      const total = svgElement('text', { x: x + 8, y: top + 30 });
      total.textContent = formatCompact(stackTotal(item));
      svg.append(total);
    });
    svg.append(...hits);
    container.replaceChildren(svg);
  }

  /** A bar rectangle with a rounded data end (`top` for columns, `right` for bars) and a square base. */
  function barPath(x, y, width, height, radius, end) {
    if (end === 'top') {
      const r = Math.min(radius, width / 2, height);
      return `M${x},${y + height}V${y + r}Q${x},${y} ${x + r},${y}H${x + width - r}Q${x + width},${y} ${x + width},${y + r}V${y + height}Z`;
    }
    const r = Math.min(radius, height / 2, width);
    return `M${x},${y}H${x + width - r}Q${x + width},${y} ${x + width},${y + r}V${y + height - r}Q${x + width},${y + height} ${x + width - r},${y + height}H${x}Z`;
  }

  function tooltipContent(title, item, note) {
    const fragment = document.createDocumentFragment();
    fragment.append(div('tooltip-title', title));
    for (const series of [...SERIES].reverse()) {
      const row = div('tooltip-row');
      const value = document.createElement('strong');
      value.textContent = formatInteger(item[series.key] || 0);
      const key = document.createElement('span');
      key.className = 'tooltip-key';
      key.style.background = series.color;
      const name = document.createElement('span');
      name.textContent = series.name;
      row.append(value, key, name);
      fragment.append(row);
    }
    if (note) fragment.append(div('tooltip-note', note));
    return fragment;
  }

  function bindTooltip(target, content) {
    const show = (clientX, clientY) => {
      tooltip.replaceChildren(content());
      tooltip.hidden = false;
      const box = tooltip.getBoundingClientRect();
      const left = Math.min(window.innerWidth - box.width - 8, clientX + 14);
      const top = clientY + box.height + 18 > window.innerHeight ? clientY - box.height - 12 : clientY + 14;
      tooltip.style.left = `${Math.max(8, left)}px`;
      tooltip.style.top = `${Math.max(8, top)}px`;
    };
    target.addEventListener('pointermove', (event) => show(event.clientX, event.clientY));
    target.addEventListener('pointerleave', hideTooltip);
    target.addEventListener('focus', () => {
      const box = target.getBoundingClientRect();
      show(box.left + box.width / 2, box.top + 8);
    });
    target.addEventListener('blur', hideTooltip);
  }

  function hideTooltip() {
    tooltip.hidden = true;
  }

  function stackTotal(item) {
    return SERIES.reduce((total, series) => total + (item[series.key] || 0), 0);
  }

  function niceMax(value) {
    const exponent = Math.pow(10, Math.floor(Math.log10(value)));
    for (const step of [1, 2, 2.5, 4, 5, 6, 8, 10]) {
      if (step * exponent >= value) return step * exponent;
    }
    return 10 * exponent;
  }

  function ticks(max) {
    return [0, 0.25, 0.5, 0.75, 1].map((fraction) => max * fraction);
  }

  function svgElement(name, attributes) {
    const element = document.createElementNS(SVG, name);
    for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
    return element;
  }

  // ---------------------------------------------------------------- tables

  const sortState = new Map();

  function table(container, columns, rows, options = {}) {
    const id = container.id;
    const sort = sortState.get(id);
    const sorted = sort ? [...rows].sort(compareBy(columns.find((column) => column.key === sort.key), sort.asc)) : rows;
    const element = document.createElement('table');
    const head = document.createElement('tr');
    for (const column of columns) {
      const th = document.createElement('th');
      th.textContent = column.label;
      th.className = ['sortable', column.numeric ? 'num' : '', sort && sort.key === column.key ? 'sorted' : '', sort && sort.key === column.key && sort.asc ? 'asc' : '']
        .filter(Boolean).join(' ');
      th.addEventListener('click', () => {
        const current = sortState.get(id);
        sortState.set(id, { key: column.key, asc: current && current.key === column.key ? !current.asc : false });
        table(container, columns, rows, options);
      });
      head.append(th);
    }
    const thead = document.createElement('thead');
    thead.append(head);
    const tbody = document.createElement('tbody');
    for (const row of sorted) {
      const tr = document.createElement('tr');
      if (options.onSelect) {
        tr.className = 'clickable';
        tr.tabIndex = 0;
        tr.addEventListener('click', () => options.onSelect(row));
        tr.addEventListener('keydown', (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            options.onSelect(row);
          }
        });
      }
      if (options.isSelected && options.isSelected(row)) tr.classList.add('selected');
      for (const column of columns) {
        const td = document.createElement('td');
        if (column.numeric) td.className = 'num';
        if (column.wrap) td.className = 'wrap';
        const text = column.format ? column.format(row) : String(row[column.key] ?? '');
        if (column.icon && column.icon(row)) {
          const span = document.createElement('span');
          span.className = 'miss';
          const icon = document.createElement('span');
          icon.className = 'status-icon';
          icon.setAttribute('aria-hidden', 'true');
          span.append(icon, document.createTextNode(text));
          td.append(span);
        } else {
          td.textContent = text;
        }
        tr.append(td);
      }
      tbody.append(tr);
    }
    element.append(thead, tbody);
    const wrap = div('table-wrap');
    wrap.append(element);
    container.replaceChildren(wrap);
  }

  function compareBy(column, asc) {
    const value = (row) => column.sortValue ? column.sortValue(row) : row[column.key];
    return (left, right) => {
      const a = value(left);
      const b = value(right);
      const result = typeof a === 'number' && typeof b === 'number' ? a - b : String(a ?? '').localeCompare(String(b ?? ''));
      return asc ? result : -result;
    };
  }

  // ---------------------------------------------------------------- formatting

  function div(className, text) {
    const element = document.createElement('div');
    element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function sum(rows, key) {
    return rows.reduce((total, row) => total + (row[key] || 0), 0);
  }

  function share(row) {
    return row.inputTokens > 0 ? row.cachedInputTokens / row.inputTokens : -1;
  }

  function cachedShare(row) {
    return row.inputTokens > 0 ? formatPercent(row.cachedInputTokens / row.inputTokens) : '—';
  }

  function missText(count) {
    return count > 0 ? formatInteger(count) : '—';
  }

  function formatInteger(value) {
    return Math.round(value).toLocaleString();
  }

  function formatCompact(value) {
    const abs = Math.abs(value);
    if (abs >= 1e9) return `${trim(value / 1e9)}B`;
    if (abs >= 1e6) return `${trim(value / 1e6)}M`;
    if (abs >= 1e3) return `${trim(value / 1e3)}K`;
    return String(Math.round(value));
  }

  function trim(value) {
    return value >= 100 ? value.toFixed(0) : value >= 10 ? value.toFixed(1).replace(/\.0$/, '') : value.toFixed(2).replace(/\.?0+$/, '');
  }

  function formatPercent(value) {
    return `${Math.round(value * 100)}%`;
  }

  function formatUsd(value) {
    return value > 0 && value < 0.01 ? '<$0.01' : `$${value.toFixed(2)}`;
  }

  function formatDuration(ms) {
    return ms >= 60_000 ? `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s` : `${(ms / 1000).toFixed(1)}s`;
  }

  function formatDay(day, long) {
    const [year, month, date] = day.split('-').map(Number);
    return new Date(year, month - 1, date).toLocaleDateString(undefined, long
      ? { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }
      : { month: 'short', day: 'numeric' });
  }

  function formatTime(ts) {
    return new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
})();
