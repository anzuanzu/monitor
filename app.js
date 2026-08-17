(() => {
  const config = window.MONITOR_CONFIG || {};
  const configured = Boolean(config.supabaseUrl && config.supabaseAnonKey);
  const sb = configured ? window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey) : null;
  const $ = id => document.getElementById(id);
  const metricLabels = {
    valid_calls: '有效電訪', valid_meetings: '有效面訪', abay_progress: '亞灣進度',
    svip_progress: 'SVIP 進度', vip_progress: 'VIP 升等進度', hvip_progress: 'HVIP 進度',
    call_progress: '電訪進度', coverage_rate: '覆蓋率'
  };
  let currentUser = null;
  let role = 'viewer';
  let salespeople = [];
  let records = [];
  let chart = null;
  let selectedImportFile = null;

  const today = () => new Date().toISOString().slice(0, 10);
  const number = value => Number(value || 0);
  const percent = value => `${Math.round(number(value))}%`;
  const isManager = () => role === 'manager';
  const setMessage = (id, message = '', error = true) => {
    const el = $(id); if (!el) return;
    el.textContent = message; el.style.color = error ? 'var(--danger)' : 'var(--teal)';
  };
  const humanDate = value => value ? new Intl.DateTimeFormat('zh-TW', { year: 'numeric', month: 'short', day: 'numeric' }).format(new Date(`${value}T00:00:00`)) : '—';
  const escapeHtml = value => String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));

  function showSetup(message) {
    $('setupNotice').textContent = message;
    $('setupNotice').classList.remove('hidden');
  }

  function configureDateFilters() {
    const to = today(); const from = new Date(); from.setDate(from.getDate() - 29);
    $('toDate').value = to; $('fromDate').value = from.toISOString().slice(0, 10);
  }

  async function init() {
    configureDateFilters();
    bindEvents();
    if (!configured) {
      showSetup('尚未連接 Supabase。請依 README 建立雲端專案、套用權限腳本，並填寫 config.js。');
      setMessage('authMessage', '完成雲端設定後即可登入。');
      $('signInForm').querySelectorAll('input,button').forEach(el => el.disabled = true);
      return;
    }
    const { data: { session } } = await sb.auth.getSession();
    if (session) await startDashboard(session.user);
  }

  function bindEvents() {
    $('signInForm').addEventListener('submit', signIn);
    $('signOutButton').addEventListener('click', signOut);
    $('refreshButton').addEventListener('click', loadDashboardData);
    $('applyFilterButton').addEventListener('click', loadDashboardData);
    $('openEntryButton').addEventListener('click', () => openEntry());
    $('entryForm').addEventListener('submit', saveEntry);
    $('addProjectButton').addEventListener('click', () => addProjectField());
    $('importFile').addEventListener('change', handleLocalFile);
    $('aiExtractButton').addEventListener('click', extractWithGemini);
    $('chartDimension').addEventListener('change', renderChart);
    $('chartMetric').addEventListener('change', renderChart);
    document.querySelectorAll('[data-close-dialog]').forEach(button => button.addEventListener('click', () => $('entryDialog').close()));
    $('projectFields').addEventListener('click', event => { if (event.target.closest('.remove-project')) event.target.closest('.project-row').remove(); });
    $('entrySalesperson').addEventListener('change', handleSalespersonChange);
  }

  async function signIn(event) {
    event.preventDefault(); setMessage('authMessage');
    const { error } = await sb.auth.signInWithPassword({ email: $('emailInput').value.trim(), password: $('passwordInput').value });
    if (error) return setMessage('authMessage', error.message);
    const { data: { user } } = await sb.auth.getUser();
    await startDashboard(user);
  }

  async function signOut() {
    await sb.auth.signOut();
    currentUser = null; records = []; salespeople = [];
    $('dashboardView').classList.add('hidden'); $('authView').classList.remove('hidden');
  }

  async function startDashboard(user) {
    currentUser = user;
    const { data, error } = await sb.from('profiles').select('role').eq('id', user.id).maybeSingle();
    if (error || !data) {
      setMessage('authMessage', '此帳號尚未由管理者授權。請聯絡系統管理者。');
      await sb.auth.signOut(); return;
    }
    role = data.role;
    $('authView').classList.add('hidden'); $('dashboardView').classList.remove('hidden');
    $('userEmail').textContent = user.email || '';
    $('roleBadge').textContent = role === 'manager' ? '管理者' : '檢視者';
    $('roleBadge').classList.toggle('manager', isManager());
    document.querySelectorAll('.manager-only').forEach(el => el.setAttribute('aria-hidden', String(!isManager())));
    await loadDashboardData();
  }

  async function loadDashboardData() {
    if (!currentUser) return;
    const from = $('fromDate').value; const to = $('toDate').value; const salespersonId = $('salespersonFilter').value;
    let peopleQuery = sb.from('salespeople').select('*').eq('is_active', true).order('name');
    const peopleResponse = await peopleQuery;
    if (peopleResponse.error) return showSetup(`無法讀取雲端資料：${peopleResponse.error.message}`);
    salespeople = peopleResponse.data || [];
    let query = sb.from('performance_entries').select('*, salespeople(id,name,job_title)').gte('view_date', from).lte('view_date', to).order('view_date', { ascending: false });
    if (salespersonId) query = query.eq('salesperson_id', salespersonId);
    const response = await query;
    if (response.error) return showSetup(`無法讀取雲端資料：${response.error.message}`);
    records = response.data || [];
    populatePeopleSelects(); renderDashboard();
  }

  function populatePeopleSelects() {
    const current = $('salespersonFilter').value;
    const personOptions = salespeople.map(person => `<option value="${person.id}">${escapeHtml(person.name)}</option>`).join('');
    $('salespersonFilter').innerHTML = `<option value="">全部業務人員</option>${personOptions}`;
    $('salespersonFilter').value = current;
    $('entrySalesperson').innerHTML = `${personOptions}<option value="__new__">＋ 新增業務人員</option>`;
  }

  function renderDashboard() {
    const calls = records.reduce((sum, row) => sum + number(row.valid_calls), 0);
    const meetings = records.reduce((sum, row) => sum + number(row.valid_meetings), 0);
    const coverageRows = records.filter(row => row.coverage_rate !== null && row.coverage_rate !== undefined);
    $('callsKpi').textContent = calls.toLocaleString(); $('meetingsKpi').textContent = meetings.toLocaleString();
    $('coverageKpi').textContent = coverageRows.length ? percent(coverageRows.reduce((sum, row) => sum + number(row.coverage_rate), 0) / coverageRows.length) : '—';
    $('peopleKpi').textContent = new Set(records.map(row => row.salesperson_id)).size.toLocaleString();
    $('dateRangeLabel').textContent = `${humanDate($('fromDate').value)} 至 ${humanDate($('toDate').value)}`;
    $('recordCount').textContent = `${records.length} 筆`;
    renderChart(); renderProgressSummary(); renderRecords();
  }

  function renderChart() {
    const metric = $('chartMetric').value; const dimension = $('chartDimension').value;
    const groups = new Map();
    records.forEach(row => {
      const key = dimension === 'date' ? row.view_date : (row.salespeople?.name || '未指派');
      const item = groups.get(key) || { total: 0, count: 0 }; item.total += number(row[metric]); item.count += 1; groups.set(key, item);
    });
    const items = [...groups.entries()].sort((a, b) => dimension === 'date' ? a[0].localeCompare(b[0]) : b[1].total - a[1].total);
    const labels = items.map(([key]) => dimension === 'date' ? key.slice(5).replace('-', '/') : key);
    const values = items.map(([, value]) => value.total);
    if (chart) chart.destroy();
    chart = new Chart($('performanceChart'), { type: 'bar', data: { labels, datasets: [{ label: metricLabels[metric], data: values, backgroundColor: '#12776c', borderRadius: 6, maxBarThickness: 42 }] }, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { callbacks: { label: context => `${metricLabels[metric]}：${context.raw}${metric.includes('progress') || metric === 'coverage_rate' ? '%' : ''}` } } }, scales: { x: { grid: { display: false }, ticks: { color: '#6d7b78' } }, y: { beginAtZero: true, grid: { color: '#edf1ee' }, ticks: { color: '#6d7b78' } } } } });
  }

  function renderProgressSummary() {
    const keys = ['abay_progress', 'svip_progress', 'vip_progress', 'hvip_progress', 'call_progress', 'coverage_rate'];
    if (!records.length) { $('progressSummary').innerHTML = '<p class="empty-state">尚無資料</p>'; return; }
    $('progressSummary').innerHTML = keys.map((key, index) => {
      const average = records.reduce((sum, row) => sum + number(row[key]), 0) / records.length;
      const colors = ['#12776c','#6c5bb6','#c76d25','#3269a8','#3269a8','#12776c'];
      return `<div class="progress-item"><div class="progress-label"><span>${metricLabels[key]}</span><strong>${percent(average)}</strong></div><div class="progress-track"><i style="width:${Math.min(100, average)}%;background:${colors[index]}"></i></div></div>`;
    }).join('');
  }

  function renderRecords() {
    $('recordsBody').innerHTML = records.length ? records.map(row => `<tr><td>${humanDate(row.view_date)}</td><td class="name-cell">${escapeHtml(row.salespeople?.name || '—')}</td><td>${escapeHtml(row.job_title || row.salespeople?.job_title || '—')}</td><td>${number(row.valid_calls)}</td><td>${number(row.valid_meetings)}</td><td><span class="metric-pill">${percent(row.abay_progress)}</span></td><td>${percent(row.svip_progress)} / ${percent(row.vip_progress)} / ${percent(row.hvip_progress)}</td><td>${percent(row.coverage_rate)}</td><td class="manager-only" aria-hidden="${!isManager()}">${isManager() ? `<div class="row-actions"><button class="mini-btn" data-edit="${row.id}">編輯</button><button class="mini-btn danger" data-delete="${row.id}">刪除</button></div>` : ''}</td></tr>`).join('') : '<tr><td colspan="9"><p class="empty-state">此區間尚無紀錄</p></td></tr>';
    $('recordsBody').querySelectorAll('[data-edit]').forEach(button => button.addEventListener('click', () => openEntry(records.find(row => row.id === button.dataset.edit))));
    $('recordsBody').querySelectorAll('[data-delete]').forEach(button => button.addEventListener('click', () => deleteEntry(button.dataset.delete)));
  }

  function addProjectField(name = '', value = '') {
    const fragment = $('projectFieldTemplate').content.cloneNode(true);
    fragment.querySelector('.project-name').value = name; fragment.querySelector('.project-value').value = value;
    $('projectFields').append(fragment);
  }

  function openEntry(row = null) {
    if (!isManager()) return;
    $('entryForm').reset(); $('projectFields').innerHTML = ''; setMessage('entryMessage'); setMessage('importStatus'); selectedImportFile = null;
    $('entryDialogTitle').textContent = row ? '編輯追蹤紀錄' : '新增追蹤紀錄'; $('entryId').value = row?.id || '';
    $('viewDate').value = row?.view_date || today();
    $('entrySalesperson').value = row?.salesperson_id || salespeople[0]?.id || '';
    $('entryTitle').value = row?.job_title || row?.salespeople?.job_title || '';
    const fields = { validCalls: 'valid_calls', validMeetings: 'valid_meetings', abayProgress: 'abay_progress', svipProgress: 'svip_progress', vipProgress: 'vip_progress', hvipProgress: 'hvip_progress', callProgress: 'call_progress', coverageRate: 'coverage_rate' };
    Object.entries(fields).forEach(([id, key]) => { $(id).value = row ? number(row[key]) : 0; });
    Object.entries(row?.projects || {}).forEach(([name, value]) => addProjectField(name, value));
    $('entryDialog').showModal();
  }

  async function handleSalespersonChange() {
    if ($('entrySalesperson').value !== '__new__') {
      const person = salespeople.find(item => item.id === $('entrySalesperson').value); if (person) $('entryTitle').value = person.job_title || '';
      return;
    }
    const name = window.prompt('輸入新業務人員姓名');
    if (!name?.trim()) { $('entrySalesperson').value = salespeople[0]?.id || ''; return; }
    const jobTitle = window.prompt('輸入職級（可留白）') || '';
    const { data, error } = await sb.from('salespeople').insert({ name: name.trim(), job_title: jobTitle.trim() }).select().single();
    if (error) return setMessage('entryMessage', error.message);
    salespeople.push(data); populatePeopleSelects(); $('entrySalesperson').value = data.id; $('entryTitle').value = data.job_title || '';
  }

  function readProjects() {
    return [...$('projectFields').querySelectorAll('.project-row')].reduce((all, row) => {
      const name = row.querySelector('.project-name').value.trim(); const value = row.querySelector('.project-value').value;
      if (name) all[name] = Math.max(0, Math.min(100, number(value))); return all;
    }, {});
  }

  async function saveEntry(event) {
    event.preventDefault(); if (!isManager()) return;
    const payload = { view_date: $('viewDate').value, salesperson_id: $('entrySalesperson').value, job_title: $('entryTitle').value.trim(), valid_calls: number($('validCalls').value), valid_meetings: number($('validMeetings').value), abay_progress: number($('abayProgress').value), svip_progress: number($('svipProgress').value), vip_progress: number($('vipProgress').value), hvip_progress: number($('hvipProgress').value), call_progress: number($('callProgress').value), coverage_rate: number($('coverageRate').value), projects: readProjects(), updated_by: currentUser.id };
    if (!payload.salesperson_id || payload.salesperson_id === '__new__') return setMessage('entryMessage', '請先選擇業務人員');
    const id = $('entryId').value;
    const response = id ? await sb.from('performance_entries').update(payload).eq('id', id) : await sb.from('performance_entries').insert({ ...payload, created_by: currentUser.id });
    if (response.error) return setMessage('entryMessage', response.error.message);
    $('entryDialog').close(); await loadDashboardData();
  }

  async function deleteEntry(id) {
    if (!isManager() || !window.confirm('確定要刪除這筆紀錄？此動作無法復原。')) return;
    const { error } = await sb.from('performance_entries').delete().eq('id', id);
    if (error) return window.alert(error.message); await loadDashboardData();
  }

  function normalizeKey(key) { return String(key || '').replace(/[\s_（）()]/g, '').toLowerCase(); }
  function applyImportedValues(source) {
    const aliases = { viewdate: 'viewDate', '檢視日期': 'viewDate', '日期': 'viewDate', '業務人員': 'salespersonName', '姓名': 'salespersonName', '職級': 'entryTitle', '有效電訪': 'validCalls', '有效電訪紀錄': 'validCalls', '有效面訪': 'validMeetings', '有效面訪紀錄': 'validMeetings', '亞灣進度': 'abayProgress', 'svip進度': 'svipProgress', 'vip升等進度': 'vipProgress', 'hvip進度': 'hvipProgress', '電訪進度': 'callProgress', '覆蓋率': 'coverageRate' };
    const projects = {};
    Object.entries(source || {}).forEach(([rawKey, value]) => {
      const key = normalizeKey(rawKey); const target = aliases[key] || aliases[rawKey];
      if (target && $(target)) $(target).value = value ?? '';
      else if (target === 'salespersonName') {
        const person = salespeople.find(item => item.name === String(value).trim()); if (person) { $('entrySalesperson').value = person.id; $('entryTitle').value = person.job_title || ''; }
      } else if (rawKey && value !== undefined) projects[rawKey] = value;
    });
    if (source.projects && typeof source.projects === 'object') Object.assign(projects, source.projects);
    if (Object.keys(projects).length) { $('projectFields').innerHTML = ''; Object.entries(projects).forEach(([name, value]) => addProjectField(name, value)); }
  }

  async function handleLocalFile(event) {
    selectedImportFile = event.target.files?.[0] || null; if (!selectedImportFile) return;
    try {
      if (/image\//.test(selectedImportFile.type)) { setMessage('importStatus', `已選擇圖片：${selectedImportFile.name}；點擊「使用 Gemini 辨識」後才會上傳辨識。`, false); return; }
      let row = {};
      if (/\.xlsx$/i.test(selectedImportFile.name)) {
        const workbook = XLSX.read(await selectedImportFile.arrayBuffer(), { type: 'array' }); const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' }); row = rows[0] || {};
      } else {
        const text = await selectedImportFile.text();
        try { row = JSON.parse(text); } catch { const workbook = XLSX.read(text, { type: 'string' }); row = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { defval: '' })[0] || {}; }
      }
      applyImportedValues(row); setMessage('importStatus', `已在本機讀取 ${selectedImportFile.name} 的第一筆資料並帶入表單。`, false);
    } catch (error) { setMessage('importStatus', `無法讀取檔案：${error.message}`); }
  }

  async function extractWithGemini() {
    if (!selectedImportFile) return setMessage('importStatus', '請先選擇圖片或檔案。');
    if (!isManager()) return;
    if (!window.confirm(`即將把「${selectedImportFile.name}」的內容傳送到 Google Gemini 進行辨識，僅用於帶入目前表單。是否繼續？`)) return;
    try {
      const payload = await buildGeminiPayload(selectedImportFile);
      setMessage('importStatus', 'Gemini 正在辨識…', false);
      const { data, error } = await sb.functions.invoke('extract-progress', { body: { ...payload, filename: selectedImportFile.name } });
      if (error) throw error;
      applyImportedValues(data?.record || data); setMessage('importStatus', '辨識完成，請檢查數字後再儲存。', false);
    } catch (error) { setMessage('importStatus', `Gemini 辨識失敗：${error.message || error}`); }
  }

  function bytesToBase64(bytes) {
    let binary = ''; const chunkSize = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
    return btoa(binary);
  }

  async function buildGeminiPayload(file) {
    if (/image\//.test(file.type)) return { mimeType: file.type, contentBase64: bytesToBase64(new Uint8Array(await file.arrayBuffer())) };
    let text;
    if (/\.xlsx$/i.test(file.name)) {
      const workbook = XLSX.read(await file.arrayBuffer(), { type: 'array' });
      text = XLSX.utils.sheet_to_csv(workbook.Sheets[workbook.SheetNames[0]]);
    } else text = await file.text();
    return { mimeType: 'text/plain', contentBase64: bytesToBase64(new TextEncoder().encode(text)) };
  }

  init();
})();
