function installPlayerVolumeControls(soundcloud) {
  const old = document.querySelector('.volumeControl'), group = document.createElement('section');
  group.className = 'volumeControl'; group.id = 'playerVolume'; group.setAttribute('aria-label', 'Player volume and output range');
  group.append(...old.childNodes); old.replaceWith(group);
  const range = document.createElement('div'); range.className = 'volumeRange';
  const floor = $('volumeFloor'), ceiling = $('volumeCeiling');
  floor.parentElement.firstChild.textContent = 'MIN OUTPUT %'; ceiling.parentElement.firstChild.textContent = 'MAX OUTPUT %';
  floor.required = ceiling.required = true;
  floor.title = 'Actual output when the volume slider is at zero'; ceiling.title = 'Actual output when the volume slider is at 100';
  const save = document.createElement('button'); save.id = 'applyVolumeRange'; save.type = 'button'; save.textContent = 'Apply range';
  range.append(floor.parentElement, ceiling.parentElement, save); group.append(range);
  const note = document.createElement('p'); note.id = 'volumeNotice'; note.setAttribute('role', 'status'); group.append(note);
  let busy = false, nativeAvailable = false, generation = 0;
  const selected = () => $('songPlayerProvider').value;
  async function native() {
    if (selected() !== 'tidal') return;
    if (!nativeAvailable) throw new Error('Update the TIDAL companion in Setup to enable native volume control.');
    const reply = await call('song.tidal.experimental.v1', 'volume', { percent: outputVolume() });
    if (!reply.ok) throw new Error(tidalErrorMessage(new Error(reply.error || 'TIDAL volume could not be confirmed.')));
  }
  function preview() {
    const output = outputVolume(); $('volumeOut').textContent = $('volume').value + ' // OUTPUT ' + output + '%';
    if (selected() === 'youtube') player?.setVolume?.(output);
    if (selected() === 'soundcloud') soundcloud.setVolume(output);
  }
  async function applyRange() {
    if (busy) return;
    if (!floor.reportValidity() || !ceiling.reportValidity()) return;
    if (Number(floor.value) > Number(ceiling.value)) { note.textContent = 'Minimum output cannot exceed maximum output.'; return; }
    const nextFloor = Number(floor.value), nextCeiling = Number(ceiling.value);
    busy = true; save.disabled = floor.disabled = ceiling.disabled = true;
    try {
      const reply = await call('song.queue.admin.v1', 'configure', { volumeFloorPercent: nextFloor, volumeCeilingPercent: nextCeiling });
      if (!reply.ok) throw new Error(reply.code || 'Output range could not be saved.');
      volumeFloorPercent = nextFloor; volumeCeilingPercent = nextCeiling; volumeDraftDirty = false;
      preview(); note.textContent = 'Output range saved.';
      if (selected() === 'tidal' && nativeAvailable) await native();
      await refreshState();
    } catch (error) { note.textContent = error.message; } finally { busy = false; save.disabled = floor.disabled = ceiling.disabled = false; }
  }
  for (const input of [floor, ceiling]) { input.oninput = () => { volumeDraftDirty = true; }; input.onchange = () => void applyRange(); input.onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); void applyRange(); } }; }
  save.onclick = () => void applyRange();
  $('volume').setAttribute('aria-label', 'Player volume'); $('volume').oninput = preview;
  $('volume').onchange = async () => {
    try { const reply = await call('song.queue.admin.v1', 'moderate', { action: 'volume', value: Number($('volume').value) }); if (!reply.ok) throw new Error(reply.code); await native(); note.textContent = 'Volume saved.'; await refreshState(); }
    catch (error) { note.textContent = error.message; }
  };
  async function select() {
    const current = ++generation; group.hidden = false; floor.parentElement.hidden = false; ceiling.parentElement.hidden = false;
    nativeAvailable = false; $('volume').disabled = selected() === 'tidal';
    note.textContent = selected() === 'tidal' ? 'Checking TIDAL volume control...' : 'The output range applies to YouTube and SoundCloud playback.';
    if (selected() !== 'tidal') return;
    try { const status = await call('song.tidal.experimental.v1', 'status', null); if (current !== generation) return;
      nativeAvailable = status.connected === true && status.volumeAvailable === true; $('volume').disabled = !nativeAvailable;
      note.textContent = nativeAvailable ? 'Controls TIDAL Desktop volume.' : 'Use TIDAL for volume until its companion is updated and connected. You can still edit the output range here.';
    } catch { if (current === generation) note.textContent = 'Connect TIDAL Desktop in Setup to control its volume.'; }
  }
  return { select, nativeStatus(status) { if (selected() !== 'tidal') return; const previous = nativeAvailable; nativeAvailable = status?.connected === true && status.volumeAvailable === true; $('volume').disabled = !nativeAvailable; if (nativeAvailable && !previous && !busy) note.textContent = 'Controls TIDAL Desktop volume.'; } };
}
