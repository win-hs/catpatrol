/* ---------- 驗證 ---------- */

export function clearErrors(scope) {
  scope.querySelectorAll('.invalid').forEach(el => el.classList.remove('invalid'));
  scope.querySelectorAll('.field-err').forEach(el => el.remove());
}

export function markError(el, msg) {
  el.classList.add('invalid');
  const note = document.createElement('p');
  note.className = 'field-err';
  note.textContent = msg;
  el.insertAdjacentElement('afterend', note);
}

export function require(el, msg) {
  if (String(el.value).trim()) return true;
  markError(el, msg);
  return false;
}

/* ---------- 專案自訂欄位 ---------- */

export function renderCustomFields(container, defs, values = {}) {
  container.innerHTML = '';
  if (!defs.length) {
    container.innerHTML = '<p class="sec-note" style="margin:0;">此專案尚未設定自訂欄位。</p>';
    return;
  }

  for (const def of defs) {
    const value = values[def.name];
    const req = def.required ? ' <span class="req">*</span>' : '';

    if (def.type === '勾選') {
      const row = document.createElement('div');
      row.className = 'tgl-row';
      row.innerHTML = `<span>${def.name}</span>`;
      const tgl = document.createElement('button');
      tgl.type = 'button';
      tgl.className = 'tgl' + (value ? ' on' : '');
      tgl.dataset.tgl = '';
      tgl.dataset.fieldId = def.id;
      row.append(tgl);
      container.append(row);
      continue;
    }

    const label = document.createElement('label');
    label.className = 'f';
    label.innerHTML = def.name + req;
    container.append(label);

    let input;
    if (def.type === '單選') {
      input = document.createElement('select');
      input.innerHTML = '<option value="">請選擇…</option>'
        + def.options.map(o => `<option${o === value ? ' selected' : ''}>${o}</option>`).join('');
    } else {
      input = document.createElement('input');
      input.type = def.type === '數字' ? 'number' : 'text';
      if (value != null) input.value = value;
    }
    input.dataset.fieldId = def.id;
    container.append(input);
  }
}

export function collectCustomFields(container, defs) {
  const values = {};
  for (const def of defs) {
    const el = container.querySelector(`[data-field-id="${def.id}"]`);
    if (!el) continue;
    if (def.type === '勾選') values[def.name] = el.classList.contains('on');
    else if (def.type === '數字') values[def.name] = el.value === '' ? null : Number(el.value);
    else values[def.name] = el.value.trim();
  }
  return values;
}

export function validateCustomFields(container, defs) {
  let ok = true;
  for (const def of defs) {
    if (!def.required || def.type === '勾選') continue;
    const el = container.querySelector(`[data-field-id="${def.id}"]`);
    if (el && !String(el.value).trim()) {
      markError(el, `請填寫${def.name}`);
      ok = false;
    }
  }
  return ok;
}
