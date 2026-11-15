/* Controls: switches, limits, feature switches */
views.controls = async (arg, sub, silent) => {
  const paint = painter('controls');
  if (!silent) paint(loadingHtml());
  try {
    const items = (await api('GET', '/controls')).items;
    let h = '<h2>' + ico('sliders') + 'Controls</h2><div class="list">';
    items.forEach((c, i) => {
      const isSwitch = c.type === 'bool' || c.type === 'feature';
      const on_ = c.type === 'bool' ? c.value === 'true' : c.type === 'feature' ? c.value !== 'off' : false;
      h += '<div class="card"><div class="inline between nowrap"><span class="grow"><span class="t strong">' + esc(c.label) + '</span><br><span class="muted small">' + esc(c.hint || '') + (c.danger ? ' &middot; affects everyone' : '') + '</span></span>' +
        (isSwitch ? sw('c' + i, on_, c.label) : '<span class="ctl"><input type="' + (c.type === 'number' ? 'number' : 'text') + '" id="c' + i + '" value="' + esc(c.value == null ? '' : c.value) + '" placeholder="default"></span>') + '</div>' +
        (isSwitch ? '' : '<div class="inline" style="margin-top:8px"><button class="btn small" data-save="' + i + '">Save</button>' + (c.overridden ? '<button class="btn small" data-clear="' + i + '">Use default</button>' : '') + '</div>') + '</div>';
    });
    h += '</div><p class="muted small">Announcements moved to <a href="#schedule">their own page</a>.</p>';
    if (!paint(h, silent)) return;
    const again = (j) => { if (j) views.controls(); };
    onAll('input[type=checkbox][id^=c]', (x) => {
      const c = items[Number(x.id.slice(1))], v = x.checked;
      const body = { key: c.key, value: c.type === 'feature' ? (v ? 'on' : 'off') : v };
      if (c.danger) act('POST', '/controls', body, { title: c.label, msg: (v ? 'Turn on: ' : 'Turn off: ') + c.label + '? This affects everyone.', confirm: 'Confirm', danger: true }).then((j) => { if (!j) x.checked = !v; again(j); });
      else quick('POST', '/controls', body, 'Saved').then((j) => { if (!j) x.checked = !v; });
    }, 'change');
    onAll('[data-save]', (b) => { const c = items[Number(b.getAttribute('data-save'))]; act('POST', '/controls', { key: c.key, value: $('#c' + b.getAttribute('data-save')).value }, { title: c.label, msg: 'Save this setting?', confirm: 'Save', danger: !!c.danger }).then(again); });
    onAll('[data-clear]', (b) => { const c = items[Number(b.getAttribute('data-clear'))]; act('POST', '/controls', { key: c.key, clear: true }, { title: c.label, msg: 'Go back to the default?', confirm: 'Use default', danger: !!c.danger }).then(again); });
  } catch (e) { if (!silent) paint(errHtml(e)); }
};
