// Model Bridge combo editor webview. The extension sends the combos and the models the providers list now;
// every string (combo and model names) is inserted with textContent, never as HTML.
(function () {
  'use strict';

  const vscode = acquireVsCodeApi();
  const PROVIDER_LABELS = { claude: 'Claude', codex: 'Codex', deepseek: 'DeepSeek', lmstudio: 'LM Studio', openaiCompatible: 'OpenAI-Compatible' };
  const STRATEGY_HELP = {
    fallback: 'The conversation stays on the first model that answers; the next model is used only when one fails before answering (limit, quota, outage, sign-in).',
    planExecute: 'For each new prompt the planner writes a short plan without tools; the first executor carries it out with the tools, and the next executor takes over when one fails. When an executor looks stuck, the planner revises the plan once per turn.'
  };

  const $ = (id) => document.getElementById(id);
  let saved = [];
  let combos = [];
  let models = [];
  let dirty = false;
  let errors = [];

  $('add-fallback').addEventListener('click', () => addCombo('fallback'));
  $('add-plan').addEventListener('click', () => addCombo('planExecute'));
  $('refresh').addEventListener('click', () => {
    setStatus('Refreshing models…');
    vscode.postMessage({ type: 'refreshModels' });
  });
  $('doctor').addEventListener('click', () => vscode.postMessage({ type: 'doctor' }));
  $('json').addEventListener('click', () => vscode.postMessage({ type: 'openSettingsJson' }));
  $('reload').addEventListener('click', () => {
    $('external').hidden = true;
    combos = clone(saved);
    setDirty(false);
    render();
  });
  $('discard').addEventListener('click', () => {
    combos = clone(saved);
    errors = [];
    setDirty(false);
    render();
  });
  $('save').addEventListener('click', save);

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (message.type === 'state') {
      models = message.models || [];
      saved = message.combos || [];
      document.body.classList.remove('loading');
      if (message.external && dirty) {
        $('external').hidden = false;
      } else if (!dirty) {
        combos = clone(saved);
      }
      const invalid = $('invalid');
      invalid.hidden = !message.invalid || message.invalid.length === 0;
      invalid.textContent = invalid.hidden ? '' : `Skipped in the model picker: ${message.invalid.join('; ')}`;
      if (!dirty) setStatus('');
      render();
    } else if (message.type === 'saved') {
      if (message.ok) {
        errors = [];
        setDirty(false);
        setStatus('Saved. The Combos group in the model picker is updated.');
      } else {
        errors = message.errors || [];
        setStatus(`Not saved: ${errors.join('; ')}`, true);
      }
    }
  });

  vscode.postMessage({ type: 'ready' });

  function addCombo(strategy) {
    combos.push({ name: uniqueName(strategy === 'fallback' ? 'Fallback' : 'Plan and execute'), strategy, targets: [''], planner: '', executors: [''] });
    setDirty(true);
    render();
    const inputs = document.querySelectorAll('.combo-name');
    inputs[inputs.length - 1]?.focus();
  }

  function save() {
    const problems = validate();
    if (problems.length > 0) {
      errors = problems;
      setStatus(`Fix before saving: ${problems.join('; ')}`, true);
      return;
    }
    setStatus('Saving…');
    vscode.postMessage({
      type: 'save',
      combos: combos.map((combo) => ({
        name: combo.name.trim(),
        strategy: combo.strategy,
        targets: combo.targets.filter(Boolean),
        planner: combo.planner,
        executors: combo.executors.filter(Boolean)
      }))
    });
  }

  function validate() {
    const problems = [];
    const names = new Set();
    combos.forEach((combo, index) => {
      const label = combo.name.trim() || `Combo ${index + 1}`;
      if (!combo.name.trim()) problems.push(`${label} needs a name`);
      else if (names.has(combo.name.trim())) problems.push(`${label}: the name is used twice`);
      names.add(combo.name.trim());
      if (combo.strategy === 'fallback') {
        if (combo.targets.filter(Boolean).length === 0) problems.push(`${label} needs at least one model`);
      } else {
        if (!combo.planner) problems.push(`${label} needs a planner`);
        const executors = combo.executors.filter(Boolean);
        if (executors.length === 0) problems.push(`${label} needs at least one executor`);
        if (combo.planner && executors.includes(combo.planner)) problems.push(`${label}: the planner cannot also be an executor`);
      }
    });
    return problems;
  }

  function render() {
    const root = $('combos');
    root.replaceChildren(...combos.map(renderCombo));
    $('empty').hidden = combos.length > 0;
  }

  function renderCombo(combo, index) {
    const card = el('section', 'card');

    const head = el('div', 'combo-head');
    const nameLabel = el('label', 'field');
    nameLabel.append(el('span', 'field-label', 'Name in the model picker'));
    const name = el('input', 'combo-name');
    name.type = 'text';
    name.value = combo.name;
    name.maxLength = 200;
    name.addEventListener('input', () => { combo.name = name.value; setDirty(true); });
    nameLabel.append(name);

    const strategyLabel = el('label', 'field');
    strategyLabel.append(el('span', 'field-label', 'Strategy'));
    const strategy = el('select');
    for (const [value, text] of [['fallback', 'Fallback'], ['planExecute', 'Plan → execute']]) {
      const option = el('option', '', text);
      option.value = value;
      strategy.append(option);
    }
    strategy.value = combo.strategy;
    strategy.addEventListener('change', () => {
      combo.strategy = strategy.value;
      if (combo.strategy === 'planExecute' && !combo.planner && combo.executors.every((value) => !value)) {
        // Start from the fallback's models: the first plans, the rest execute.
        const [planner, ...executors] = combo.targets.filter(Boolean);
        combo.planner = planner || '';
        combo.executors = executors.length > 0 ? executors : [''];
      } else if (combo.strategy === 'fallback' && combo.targets.every((value) => !value)) {
        combo.targets = [...combo.executors.filter(Boolean), combo.planner].filter(Boolean);
        if (combo.targets.length === 0) combo.targets = [''];
      }
      setDirty(true);
      render();
    });
    strategyLabel.append(strategy);

    const remove = el('button', 'danger', 'Delete combo');
    remove.addEventListener('click', () => {
      combos.splice(index, 1);
      setDirty(true);
      render();
    });
    head.append(nameLabel, strategyLabel, remove);
    card.append(head, el('p', 'hint', STRATEGY_HELP[combo.strategy]));

    if (combo.strategy === 'fallback') {
      card.append(renderList(combo, 'targets', 'Models, tried in order', 'Add model'));
    } else {
      const plannerBlock = el('div', 'block');
      plannerBlock.append(el('h3', '', 'Planner'), el('p', 'hint', 'An expensive, capable model. It never gets tools.'));
      plannerBlock.append(renderRow(combo, 'planner', 0, false));
      card.append(plannerBlock, renderList(combo, 'executors', 'Executors, tried in order', 'Add executor',
        'Cheaper models that run every tool step. Agent mode needs tool calling on every model of the combo.'));
    }

    const summary = summarize(combo);
    if (summary) card.append(el('p', 'summary', summary));
    return card;
  }

  function renderList(combo, key, title, addLabel, help) {
    const block = el('div', 'block');
    block.append(el('h3', '', title));
    if (help) block.append(el('p', 'hint', help));
    const list = el('ol', 'targets');
    combo[key].forEach((_, position) => list.append(renderRow(combo, key, position, true)));
    block.append(list);
    const add = el('button', '', `+ ${addLabel}`);
    add.addEventListener('click', () => {
      combo[key].push('');
      setDirty(true);
      render();
    });
    block.append(add);
    return block;
  }

  function renderRow(combo, key, position, inList) {
    const row = el(inList ? 'li' : 'div', 'target');
    const current = inList ? combo[key][position] : combo[key];
    const select = modelSelect(current);
    select.setAttribute('aria-label', inList ? `${key === 'targets' ? 'Model' : 'Executor'} ${position + 1}` : 'Planner');
    select.addEventListener('change', () => {
      if (inList) combo[key][position] = select.value;
      else combo[key] = select.value;
      setDirty(true);
      render();
    });
    row.append(select);

    if (inList) {
      const list = combo[key];
      const up = iconButton('↑', 'Move up', position === 0, () => swap(list, position, position - 1));
      const down = iconButton('↓', 'Move down', position === list.length - 1, () => swap(list, position, position + 1));
      const remove = iconButton('✕', 'Remove', list.length === 1 && !current, () => {
        list.splice(position, 1);
        if (list.length === 0) list.push('');
        setDirty(true);
        render();
      });
      row.append(up, down, remove);
    }

    const warning = rowWarning(combo, key, current);
    if (warning) row.append(el('span', 'row-warning', warning));
    return row;
  }

  function modelSelect(value) {
    const select = el('select', 'model');
    const placeholder = el('option', '', 'Choose a model…');
    placeholder.value = '';
    select.append(placeholder);
    if (value && !models.some((model) => model.value === value)) {
      const missing = el('option', '', `${value} (not listed now)`);
      missing.value = value;
      select.append(missing);
    }
    for (const provider of Object.keys(PROVIDER_LABELS)) {
      const group = models.filter((model) => model.provider === provider);
      if (group.length === 0) continue;
      const optgroup = el('optgroup');
      optgroup.label = PROVIDER_LABELS[provider];
      for (const model of group) {
        const option = el('option', '', model.name);
        option.value = model.value;
        option.title = model.detail ? `${model.value} · ${model.detail}` : model.value;
        optgroup.append(option);
      }
      select.append(optgroup);
    }
    select.value = value || '';
    return select;
  }

  function rowWarning(combo, key, value) {
    if (!value) return '';
    const model = models.find((entry) => entry.value === value);
    if (!model) return 'Not listed by its provider now: signed out, unreachable, or renamed.';
    if (key === 'executors' && combo.planner === value) return 'Already the planner.';
    if (key !== 'planner' && !model.toolCalling) return 'No tool calling: Agent mode will be off for this combo.';
    return '';
  }

  // What the picker will show: models that are not listed now are skipped there, as here.
  function summarize(combo) {
    const listed = (values) => values.map((value) => models.find((model) => model.value === value)?.name).filter(Boolean);
    if (combo.strategy === 'fallback') {
      const targets = listed(combo.targets);
      return targets.length > 0 ? `In the picker: ${targets.join(' → ')}` : 'Not shown in the picker until one of its models is available.';
    }
    const [planner] = listed([combo.planner]);
    const executors = listed(combo.executors);
    const parts = [planner ? `Plan: ${planner}` : '', executors.length > 0 ? `Execute: ${executors.join(', ')}` : ''].filter(Boolean);
    return parts.length > 0 ? `In the picker: ${parts.join(' → ')}` : 'Not shown in the picker until one of its models is available.';
  }

  function iconButton(text, label, disabled, onClick) {
    const button = el('button', 'icon', text);
    button.title = label;
    button.setAttribute('aria-label', label);
    button.disabled = disabled;
    button.addEventListener('click', onClick);
    return button;
  }

  function swap(list, from, to) {
    [list[from], list[to]] = [list[to], list[from]];
    setDirty(true);
    render();
  }

  function uniqueName(base) {
    let candidate = base;
    for (let index = 2; combos.some((combo) => combo.name === candidate); index += 1) candidate = `${base} ${index}`;
    return candidate;
  }

  function setDirty(value) {
    dirty = value;
    $('save').disabled = !dirty;
    $('discard').disabled = !dirty;
    if (dirty) setStatus('Unsaved changes');
  }

  function setStatus(text, isError) {
    const status = $('status');
    status.textContent = text;
    status.classList.toggle('error', Boolean(isError));
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  setDirty(false);
})();
