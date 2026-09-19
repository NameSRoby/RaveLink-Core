export function initTwitchLightProgram({ request, initialState, initialEffectState = null, getFixtures, changed = () => {} }) {
  const $ = id => document.getElementById(id);
  let state = initialState, draftRules = [], busy = false, selectedFixture = '', effectState = initialEffectState;
  const notice = text => { $('twitchProgramNotice').textContent = text; };
  const markDirty = () => notice('UNSAVED CHANGES // SELECT SAVE PROGRAM TO APPLY THIS ROUTING');
  const fixtureName = row => `${row.name || row.id}${row.missing ? ' (missing)' : !row.enabled || !row.twitchEnabled ? ' (Twitch disabled)' : ''}`;

  function normalizedRules(rules) {
    const claimed = new Set(), activeIds = [], groups = [];
    for (const row of rules) {
      const unique = row.fixtureIds.filter(id => !claimed.has(id) && (claimed.add(id), true));
      if (!row.prefix) activeIds.push(...unique);
      else groups.push({ ...structuredClone(row), fixtureIds: unique });
    }
    const activeRules = rules.filter(row => !row.prefix);
    return [{ id: 'active-fixtures', name: 'Active Fixtures', prefix: '', enabled: !activeRules.length || activeRules.some(row => row.enabled), fixtureIds: activeIds }, ...groups];
  }
  function allFixtures() {
    const fixtures = getFixtures(), known = new Set(fixtures.map(row => row.id));
    const missing = draftRules.flatMap(row => row.fixtureIds).filter(id => !known.has(id)).map(id => ({ id, missing: true }));
    return [...fixtures, ...missing];
  }
  function renderEffectRouteSummary() {
    const output = $('twitchEffectRouteSummary');
    if (!output) return;
    const allowed = effectState?.fixtureIds || [], prefixes = effectState?.prefixes || {};
    const prefixed = allowed.filter(id => prefixes[id]);
    output.textContent = `${allowed.length} IN DEFAULT ALL-FIXTURE ROUTE // ${prefixed.length} ALSO HAVE SUBSET PREFIXES // INDEPENDENT FROM NORMAL COLOR ROUTING.`;
    output.className = 'notice';
  }
  function renderEffectFixtures() {
    const container = $('twitchEffectFixtures');
    if (!container) return;
    const selected = new Set(effectState?.fixtureIds || []), prefixes = effectState?.prefixes || {};
    const rows = getFixtures().filter(row => row.enabled !== false && row.twitchEnabled === true && ['hue', 'wiz', 'govee'].includes(String(row.brand).toLowerCase()));
    container.replaceChildren(...rows.map(row => {
      const card = document.createElement('article'); card.className = 'effectFixtureRoute';
      const label = document.createElement('label'); label.className = 'switchLabel'; label.title = `Allow ${row.name || row.id} to run dynamic Twitch effects.`;
      const input = document.createElement('input'); input.type = 'checkbox'; input.checked = selected.has(row.id); input.dataset.effectFixtureId = row.id;
      const slider = document.createElement('span'); slider.className = 'toggleSwitch'; slider.setAttribute('aria-hidden', 'true');
      const text = document.createElement('span'); text.textContent = `${row.name || row.id} // ${String(row.brand).toUpperCase()}`;
      label.append(input, slider, text);
      const prefixLabel = document.createElement('label'); prefixLabel.className = 'switchLabel effectPrefixSwitch'; prefixLabel.title = 'Require this prefix for dynamic commands targeting the fixture.';
      const prefixToggle = document.createElement('input'); prefixToggle.type = 'checkbox'; prefixToggle.checked = Boolean(prefixes[row.id]); prefixToggle.dataset.effectPrefixToggle = row.id;
      const prefixSlider = document.createElement('span'); prefixSlider.className = 'toggleSwitch'; prefixSlider.setAttribute('aria-hidden', 'true');
      const prefixText = document.createElement('span'); prefixText.textContent = 'REQUIRE PREFIX'; prefixLabel.append(prefixToggle, prefixSlider, prefixText);
      const prefixField = document.createElement('label'); prefixField.className = 'effectPrefixField'; prefixField.append(document.createTextNode('PREFIX'));
      const prefixInput = document.createElement('input'); prefixInput.value = prefixes[row.id] || ''; prefixInput.maxLength = 32; prefixInput.placeholder = 'desk'; prefixInput.dataset.effectPrefixInput = row.id; prefixInput.setAttribute('aria-label', `${row.name || row.id} dynamic prefix`); prefixField.append(prefixInput);
      const dirtyEffect = () => { $('twitchEffectsNotice').textContent = 'UNSAVED DYNAMIC COMMAND CHANGES'; };
      const sync = () => { prefixToggle.disabled = !input.checked; prefixField.hidden = !input.checked || !prefixToggle.checked; if (!prefixToggle.checked) prefixInput.value = ''; };
      input.onchange = () => { if (!input.checked) prefixToggle.checked = false; sync(); dirtyEffect(); };
      prefixToggle.onchange = () => { sync(); if (prefixToggle.checked) prefixInput.focus(); dirtyEffect(); };
      prefixInput.oninput = dirtyEffect; sync(); card.append(label, prefixLabel, prefixField); return card;
    }));
    if (!rows.length) { const empty = document.createElement('span'); empty.className = 'emptyDropZone'; empty.textContent = 'NO TWITCH-ENABLED FIXTURES'; container.append(empty); }
    renderEffectRouteSummary();
  }
  async function loadEffects() {
    try {
      effectState = await request('/twitch/light-effects');
      $('twitchEffectsEnabled').checked = effectState.enabled === true;
      $('twitchEffectsReturn').checked = effectState.returnEffect === true;
      renderEffectFixtures();
    } catch (error) { $('twitchEffectsNotice').textContent = error.message; }
  }
  async function saveEffects() {
    if (!effectState) return;
    const fixtureIds = [...$('twitchEffectFixtures').querySelectorAll('[data-effect-fixture-id]:checked')].map(item => item.dataset.effectFixtureId);
    const prefixes = {};
    for (const id of fixtureIds) {
      const toggle = $('twitchEffectFixtures').querySelector(`[data-effect-prefix-toggle="${CSS.escape(id)}"]`);
      if (!toggle?.checked) continue;
      const value = $('twitchEffectFixtures').querySelector(`[data-effect-prefix-input="${CSS.escape(id)}"]`)?.value.trim().toLowerCase() || '';
      if (value === 'all' || !/^[a-z][a-z0-9_-]{0,31}$/.test(value)) { $('twitchEffectsNotice').textContent = 'Every enabled dynamic prefix must begin with a letter and use only letters, numbers, underscores, or hyphens. ALL is reserved for every fixture.'; return; }
      prefixes[id] = value;
    }
    try {
      effectState = await request('/twitch/light-effects', { method: 'POST', body: JSON.stringify({ revision: effectState.revision, enabled: $('twitchEffectsEnabled').checked, returnEffect: $('twitchEffectsReturn').checked, fixtureIds, prefixes }) });
      renderEffectFixtures();
      $('twitchEffectsNotice').textContent = effectState.enabled ? `DYNAMIC COMMANDS ENABLED FOR ${effectState.fixtureIds.length} FIXTURE${effectState.fixtureIds.length === 1 ? '' : 'S'}.` : 'DYNAMIC COMMANDS ARE OFF.';
    } catch (error) { $('twitchEffectsNotice').textContent = error.message === 'twitch_effects_conflict' ? 'Dynamic command settings changed in another window. Refresh the page.' : error.message; }
  }
  function ownerOf(id) { return draftRules.find(row => row.fixtureIds.includes(id)); }
  function moveFixture(id, destination) {
    if (!id) return;
    draftRules.forEach(row => { row.fixtureIds = row.fixtureIds.filter(value => value !== id); });
    if (destination !== 'available') draftRules.find(row => row.id === destination)?.fixtureIds.push(id);
    selectedFixture = ''; renderBoard(); markDirty();
  }
  function fixtureChip(row) {
    const chip = document.createElement('button');
    chip.type = 'button'; chip.className = `fixtureChip${selectedFixture === row.id ? ' selected' : ''}`;
    chip.draggable = true; chip.dataset.fixtureId = row.id; chip.textContent = fixtureName(row);
    chip.title = 'Drag to another box, or select then choose a destination';
    chip.ondragstart = event => { event.dataTransfer.setData('text/plain', row.id); event.dataTransfer.effectAllowed = 'move'; };
    chip.onclick = event => { event.stopPropagation(); selectedFixture = selectedFixture === row.id ? '' : row.id; renderBoard(); };
    return chip;
  }
  function dropZone(id, title, fixtures, controls) {
    const zone = document.createElement('section'); zone.className = 'fixtureDropZone'; zone.dataset.dropZone = id;
    const head = document.createElement('div'); head.className = 'fixtureZoneHead';
    const heading = document.createElement('h4'); heading.textContent = `${title} (${fixtures.length})`; head.append(heading);
    if (controls) head.append(controls); zone.append(head);
    const list = document.createElement('div'); list.className = 'fixtureChipList'; list.append(...fixtures.map(fixtureChip));
    if (!fixtures.length) { const empty = document.createElement('span'); empty.className = 'emptyDropZone'; empty.textContent = 'DROP FIXTURES HERE'; list.append(empty); }
    zone.append(list);
    const receive = event => { event.preventDefault(); zone.classList.add('dragOver'); };
    zone.ondragenter = receive; zone.ondragover = receive; zone.ondragleave = () => zone.classList.remove('dragOver');
    zone.ondrop = event => { event.preventDefault(); zone.classList.remove('dragOver'); moveFixture(event.dataTransfer.getData('text/plain'), id); };
    zone.onclick = () => { if (selectedFixture) moveFixture(selectedFixture, id); };
    return zone;
  }
  function groupControls(rule, active = false) {
    const controls = document.createElement('div'); controls.className = 'fixtureZoneSettings';
    const enabled = document.createElement('label'), check = document.createElement('input'); enabled.className = 'checkLabel'; enabled.title = 'Include this fixture group when Twitch color commands are routed.'; check.type = 'checkbox'; check.checked = rule.enabled;
    check.onchange = () => { rule.enabled = check.checked; markDirty(); }; enabled.append(check, document.createTextNode(' ENABLED')); controls.append(enabled);
    if (!active) {
      const nameLabel = document.createElement('label'); nameLabel.className = 'fixtureZoneField'; nameLabel.append(document.createTextNode('NAME'));
      const name = document.createElement('input'); name.value = rule.name; name.maxLength = 64; name.setAttribute('aria-label', 'Group name');
      name.oninput = () => { rule.name = name.value; markDirty(); };
      nameLabel.append(name);
      const prefixLabel = document.createElement('label'); prefixLabel.className = 'fixtureZoneField'; prefixLabel.append(document.createTextNode('PREFIX'));
      const prefix = document.createElement('input'); prefix.value = rule.prefix; prefix.maxLength = 32; prefix.placeholder = 'prefix'; prefix.setAttribute('aria-label', 'Group prefix');
      prefix.oninput = () => { rule.prefix = prefix.value.trim().toLowerCase(); markDirty(); };
      prefixLabel.append(prefix);
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'danger iconButton'; remove.textContent = 'X'; remove.title = 'Delete group';
      remove.onclick = event => { event.stopPropagation(); if (!confirm(`Delete ${rule.name || 'this group'}? Its fixtures will become available.`)) return; draftRules = draftRules.filter(row => row.id !== rule.id); renderBoard(); markDirty(); };
      controls.prepend(nameLabel, prefixLabel); controls.append(remove);
    }
    controls.onclick = event => event.stopPropagation(); return controls;
  }
  function renderBoard() {
    const fixtures = allFixtures(), active = draftRules[0], owned = new Set(draftRules.flatMap(row => row.fixtureIds));
    const byIds = ids => ids.map(id => fixtures.find(row => row.id === id)).filter(Boolean);
    $('twitchFixtureBoard').replaceChildren(
      dropZone('available', 'AVAILABLE FIXTURES', fixtures.filter(row => !owned.has(row.id))),
      dropZone(active.id, 'ACTIVE FIXTURES // NO PREFIX', byIds(active.fixtureIds), groupControls(active, true)),
      ...draftRules.slice(1).map(row => dropZone(row.id, row.name || 'UNTITLED GROUP', byIds(row.fixtureIds), groupControls(row)))
    );
    $('selectedFixtureMove').hidden = !selectedFixture;
    if (selectedFixture) {
      const currentOwner = ownerOf(selectedFixture);
      $('selectedFixtureLabel').textContent = fixtureName(fixtures.find(row => row.id === selectedFixture) || { id: selectedFixture });
      const destinations = [['available', 'AVAILABLE FIXTURES'], [active.id, 'ACTIVE FIXTURES'], ...draftRules.slice(1).map(row => [row.id, row.name || 'UNTITLED GROUP'])];
      $('fixtureDestination').replaceChildren(...destinations.filter(([id]) => id !== (currentOwner?.id || 'available')).map(([id, name]) => { const item = document.createElement('option'); item.value = id; item.textContent = name; return item; }));
    }
  }
  function accept(value) {
    state = value; draftRules = normalizedRules(state.rules);
    $('twitchRoutingMode').value = state.mode === 'off' ? 'off' : 'assignments'; $('parserFuzzy').checked = state.parser.allowFuzzy;
    $('parserDescriptors').checked = state.parser.allowDescriptors; $('parserDefaultBrightness').value = state.parser.defaultBrightness;
    selectedFixture = ''; renderBoard(); changed(structuredClone(state.rules));
  }
  function payloadRules() {
    return draftRules.filter(row => row.id !== 'active-fixtures' || row.fixtureIds.length).map(row => ({ ...row, name: row.id === 'active-fixtures' ? 'Active Fixtures' : row.name.trim(), prefix: row.id === 'active-fixtures' ? '' : row.prefix.trim().toLowerCase(), fixtureIds: [...row.fixtureIds] }));
  }
  function dirty() {
    const original = normalizedRules(state.rules).filter(row => row.id !== 'active-fixtures' || row.fixtureIds.length);
    return JSON.stringify(payloadRules()) !== JSON.stringify(original) || $('twitchRoutingMode').value !== state.mode || $('parserFuzzy').checked !== state.parser.allowFuzzy || $('parserDescriptors').checked !== state.parser.allowDescriptors || Number($('parserDefaultBrightness').value) !== state.parser.defaultBrightness;
  }
  async function save() {
    if (busy) return;
    const rules = payloadRules();
    if (rules.some(row => !row.name || row.id !== 'active-fixtures' && !row.prefix)) { notice('Every created group needs a name and prefix.'); return; }
    const payload = { revision: state.revision, mode: $('twitchRoutingMode').value, parser: { allowFuzzy: $('parserFuzzy').checked, allowDescriptors: $('parserDescriptors').checked, defaultBrightness: Number($('parserDefaultBrightness').value) }, rules };
    busy = true; $('twitchProgramControls').disabled = true;
    try { const result = await request('/twitch/lights', { method: 'POST', body: JSON.stringify(payload) }); accept(result); notice(result.mode === 'assignments' ? 'Fixture assignments saved. Redemption colors will be sent only to these active fixtures and prefix groups.' : 'Channel-point lighting is off.'); }
    catch (error) { notice(error.message === 'twitch_routing_conflict' ? 'The program changed in another window. Refresh before saving.' : error.message); }
    finally { busy = false; $('twitchProgramControls').disabled = false; }
  }
  $('addTwitchFixtureGroup').onclick = () => { draftRules.push({ id: crypto.randomUUID(), name: 'New group', prefix: '', enabled: true, fixtureIds: [] }); renderBoard(); markDirty(); };
  for (const id of ['twitchRoutingMode', 'parserFuzzy', 'parserDescriptors', 'parserDefaultBrightness']) $(id).addEventListener('change', markDirty);
  $('saveTwitchProgram').onclick = save;
  $('saveTwitchEffects').onclick = saveEffects;
  for (const id of ['twitchEffectsEnabled', 'twitchEffectsReturn']) $(id).onchange = () => { $('twitchEffectsNotice').textContent = 'UNSAVED DYNAMIC COMMAND CHANGES'; };
  $('moveSelectedFixture').onclick = () => moveFixture(selectedFixture, $('fixtureDestination').value);
  $('refreshTwitchProgram').onclick = async () => { if (dirty() && !confirm('Discard unsaved Twitch fixture layout edits?')) return; try { accept(await request('/twitch/lights')); notice('Program refreshed.'); } catch (error) { notice(error.message); } };
  $('previewTwitchColor').onclick = async () => {
    try { const result = await request('/twitch/lights/preview', { method: 'POST', body: JSON.stringify({ text: $('twitchColorExample').value }) }); $('twitchPreviewSwatch').style.backgroundColor = /^#[0-9a-f]{6}$/i.test(result.hex) ? result.hex : 'transparent'; $('twitchPreviewResult').textContent = result.effect ? `${String(result.effect).toUpperCase()}${result.speed ? ` // ${String(result.speed).toUpperCase()}` : ''} // ${result.targets.length} effect targets\n${result.targets.join(', ')}` : `${result.hex || 'Brightness only'} // ${result.brightnessPercent}% // ${result.targets.length} targets, ${result.skippedTargets} skipped\n${result.targets.join(', ')}${dirty() ? '\nSaved program preview; unsaved edits are not applied.' : ''}`; }
    catch (error) { $('twitchPreviewSwatch').style.backgroundColor = 'transparent'; $('twitchPreviewResult').textContent = error.message; }
  };
  if (state?.ok) accept(state); else { notice(state?.error || 'Twitch program unavailable.'); $('twitchProgramControls').disabled = true; }
  if (effectState?.ok) { $('twitchEffectsEnabled').checked = effectState.enabled === true; $('twitchEffectsReturn').checked = effectState.returnEffect === true; renderEffectFixtures(); }
  else void loadEffects();
  return { refreshFixtures: () => { renderBoard(); renderEffectFixtures(); } };
}
