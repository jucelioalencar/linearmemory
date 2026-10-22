/* Optional decision filtering and immutable search audit. */
(() => {
  const style = document.createElement('style');
  style.textContent = '.decision-audit{padding:12px;overflow-wrap:anywhere}.decision-audit p{font-size:12px;line-height:1.5}.decision-audit .result-item{margin-top:12px}.decision-audit .result-item strong{font-size:14px}.decision-audit .result-item p,.decision-audit .result-item small,.decision-audit summary{font-size:12px;line-height:1.5}.decision-audit pre{font-size:12px}.decision-audit::backdrop{background:#0007}';
  document.head.append(style);
  const words = {
    en: ['Search relevance filter','Enable optional filter','Minimum relevance (%)','Model','API credential (blank keeps saved key)','Save filter','Remove credential','Estimated relevance is not measured accuracy. Query and candidate memories are sent to the selected provider.','Timeout (ms)','Search audit','Kept','Removed','Reason','Estimated tokens saved','Before / after','Provider input / output','Net estimate','Unknown','Close','Filter disabled','Meets threshold','Below threshold','Kept without a valid decision','Saved','Loading…'],
    pt: ['Filtro de relevância da busca','Ativar filtro opcional','Relevância mínima (%)','Modelo','Credencial da API (vazio mantém a chave)','Salvar filtro','Remover credencial','Relevância estimada não é acurácia medida. A consulta e as memórias candidatas são enviadas ao provedor selecionado.','Tempo limite (ms)','Auditoria da busca','Mantido','Eliminado','Motivo','Estimativa de tokens poupados','Antes / depois','Entrada / saída do provedor','Estimativa líquida','Desconhecido','Fechar','Filtro desativado','Atinge o limite','Abaixo do limite','Mantido sem decisão válida','Salvo','Carregando…'],
    es: ['Filtro de relevancia','Activar filtro opcional','Relevancia mínima (%)','Modelo','Credencial API (vacío conserva la clave)','Guardar filtro','Eliminar credencial','La relevancia estimada no es precisión medida. La consulta y las memorias se envían al proveedor seleccionado.','Tiempo límite (ms)','Auditoría de búsqueda','Conservado','Eliminado','Motivo','Tokens ahorrados estimados','Antes / después','Entrada / salida del proveedor','Estimación neta','Desconocido','Cerrar','Filtro desactivado','Cumple el umbral','Debajo del umbral','Conservado sin decisión válida','Guardado','Cargando…']
  };
  const w = i => (words[String(S.language).slice(0,2)] || words.en)[i];
  const panel = document.createElement('section');
  panel.className = 'settings-section';
  document.getElementById('embeddingSettings').append(panel);
  let saved;
  function form() {
    panel.innerHTML = `<h3>${w(0)}</h3><p>${w(7)}</p><form id="decisionForm"><label><input type="checkbox" name="enabled"> ${w(1)}</label><div class="config-grid"><label class="config-field">Provider<select name="provider"><option value="openai">OpenAI Decisions</option><option value="jev">TypeSafe Jev</option></select></label><label class="config-field">${w(2)}<input name="thresholdPercent" type="number" min="0" max="100" step="0.1" required></label><label class="config-field">${w(3)}<input name="model" required maxlength="100"></label><label class="config-field">${w(8)}<input name="timeoutMs" type="number" min="250" max="30000" required></label><label class="config-field">${w(4)}<input name="apiKey" type="password" autocomplete="new-password"></label><label><input name="clearCredential" type="checkbox"> ${w(6)}</label></div><button class="settings-reset" type="submit">${w(5)}</button><p role="status"></p></form>`;
    const f = panel.querySelector('form'), status = panel.querySelector('[role=status]');
    if (saved) { for (const key of ['provider','model','thresholdPercent','timeoutMs']) f.elements[key].value = saved[key]; f.elements.enabled.checked = saved.enabled; f.elements.apiKey.placeholder = saved.hasCredential ? '••••••••' : ''; }
    f.elements.provider.onchange = () => { f.elements.model.value = f.elements.provider.value === 'jev' ? 'jev-latest' : 'gpt-6-luna'; f.elements.apiKey.value = ''; f.elements.apiKey.placeholder = ''; };
    f.onsubmit = async e => {
      e.preventDefault(); const button = f.querySelector('button'); button.disabled = true;
      try {
        const body = { enabled: f.elements.enabled.checked, provider: f.elements.provider.value, model: f.elements.model.value, thresholdPercent: Number(f.elements.thresholdPercent.value), timeoutMs: Number(f.elements.timeoutMs.value), apiKey: f.elements.apiKey.value, clearCredential: f.elements.clearCredential.checked };
        const response = await fetch('/api/settings/search-filter', { method: 'PUT', headers: { 'content-type':'application/json' }, body: JSON.stringify(body) });
        const data = await response.json(); if (!response.ok) throw Error(data.error); saved = data; form(); panel.querySelector('[role=status]').textContent = w(23);
      } catch (error) { status.textContent = error.message; } finally { button.disabled = false; }
    };
  }
  form();
  fetch('/api/settings/search-filter').then(async response => { const data = await response.json(); if (!response.ok) throw Error(data.error); saved = data; form(); }).catch(error => { panel.querySelector('[role=status]').textContent = error.message; });
  const reason = item => item.reason === 'disabled' ? w(19) : item.reason === 'meets_threshold' ? w(20) : item.reason === 'below_threshold' ? w(21) : `${w(22)} (${item.reason})`;
  function auditHtml(search) {
    const a = search.payload?.filter; if (!a) return '';
    const tokens = a.tokens;
    return `<p>${esc(a.provider)} · ${esc(a.model)} · ≥ ${a.thresholdPercent}% · ${a.durationMs} ms</p><p>${w(10)}: ${a.keptCount} · ${w(11)}: ${a.removedCount}</p><p>${w(13)}: ~${tokens.saved} (${tokens.savedPercent.toFixed(1)}%) · ${w(14)}: ~${tokens.before} / ~${tokens.after}</p><p>${w(15)}: ${tokens.providerInput} / ${tokens.providerOutput}${tokens.usageComplete?'':` (${w(17)})`} · ${w(16)}: ${tokens.netEstimated ?? w(17)}</p><p>UTF-8 bytes ÷ 4 · ${esc(a.criterion)}</p>${a.decisions.map(item => `<article class="result-item"><strong>${w(item.kept?10:11)} — ${esc(item.memory.title)}</strong><p>${esc(item.memory.summary)}</p><p>${w(12)}: ${esc(reason(item))} · ${item.probability===null?'—':`${(item.probability*100).toFixed(1)}%`} / ${a.thresholdPercent}%</p><small>Lexical: ${Number(item.memory.lexical_relevance||0).toFixed(3)} · Semantic: ${Number(item.memory.semantic_relevance||0).toFixed(3)}</small><details><summary>${esc(item.memory.id)}</summary><pre style="white-space:pre-wrap;overflow-wrap:anywhere">${esc(JSON.stringify(item.memory,null,2))}</pre></details></article>`).join('')}`;
  }
  const dialog = document.createElement('dialog');
  dialog.className = 'decision-audit';
  dialog.style.cssText = 'width:min(900px,90vw);max-height:85vh;overflow:auto;background:var(--surface,#18231e);color:var(--text,#e8f1eb);border:1px solid #63756a;border-radius:16px;padding:24px';
  document.body.append(dialog);
  const baseRender = renderSearchFlowLogs;
  renderSearchFlowLogs = function () {
    baseRender();
    document.querySelectorAll('.search-card-v2').forEach(card => {
      const id = card.querySelector('[data-focus-search]')?.dataset.focusSearch;
      const search = S.data.events.find(e => e.id === id), audit = search?.payload?.filter;
      if (!audit) return;
      const extra = document.createElement('div');
      extra.className = 'decision-audit';
      extra.innerHTML = `<p>${w(10)} ${audit.keptCount} · ${w(11)} ${audit.removedCount} · ${w(13)} ~${audit.tokens.saved}</p><button type="button" class="settings-reset">${w(9)}</button><details><summary>${w(9)} — ${audit.candidateCount}</summary>${auditHtml(search)}</details>`;
      extra.querySelector('button').onclick = () => { dialog.innerHTML = `<button type="button" class="settings-reset">${w(18)}</button><h2>${w(9)}</h2><p>${esc(eventSummary(search))}</p><p>${esc(search.agent_key || 'agent_default')} · ${date(search.occurred_at)} · ${esc(search.payload.scope || '')}</p>${auditHtml(search)}`; dialog.querySelector('button').onclick = () => dialog.close(); dialog.showModal(); };
      card.append(extra);
    });
  };
  const baseLanguage = applyLanguage;
  applyLanguage = function (...args) { baseLanguage(...args); form(); if (S.data) renderSearchFlowLogs(); };
  if (S.data) renderSearchFlowLogs();
})();
