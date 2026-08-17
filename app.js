(() => {
  const config = window.MONITOR_CONFIG || {};
  const configured = Boolean(config.supabaseUrl && config.supabaseAnonKey);
  const sb = configured ? window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey) : null;
  const $ = id => document.getElementById(id);
  const metricLabels = {
    valid_calls: '有效電訪', valid_meetings: '有效面訪', abay_progress: '亞灣進度紀錄',
    svip_progress: 'SVIP 升等進度', vip_progress: 'VIP 升等進度', hvip_progress: 'HVIP 進度',
    call_progress: '電訪進度', coverage_rate: '覆蓋率紀錄'
  };
  const numericMetricKeys = ['valid_calls', 'valid_meetings'];
  const noteMetricKeys = ['abay_progress', 'svip_progress', 'vip_progress', 'hvip_progress', 'call_progress', 'coverage_rate'];
  const importMetricKeys = [...numericMetricKeys, ...noteMetricKeys];
  let currentUser = null;
  let role = 'viewer';
  let salespeople = [];
  let records = [];
  let chart = null;
  let selectedImportFile = null;
  let recoveryMode = false;

  const today = () => new Date().toISOString().slice(0, 10);
  const number = value => Number(value || 0);
  const hasText = value => String(value ?? '').trim().length > 0;
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

  function isRecoveryLink() {
    return /(?:[?#&]type=recovery(?:&|$))/.test(window.location.href);
  }

  function hasAuthorizationCode() {
    return new URLSearchParams(window.location.search).has('code');
  }

  function showPasswordReset() {
    recoveryMode = true;
    $('authView').classList.add('hidden');
    $('dashboardView').classList.add('hidden');
    $('passwordResetView').classList.remove('hidden');
    setMessage('passwordResetMessage');
    $('newPasswordInput').focus();
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
    sb.auth.onAuthStateChange((event) => {
      if (event === 'PASSWORD_RECOVERY') showPasswordReset();
    });
    const { data: { session } } = await sb.auth.getSession();
    if (hasAuthorizationCode()) {
      const code = new URLSearchParams(window.location.search).get('code');
      const { error } = await sb.auth.exchangeCodeForSession(code);
      if (error) return setMessage('authMessage', '密碼設定連結已失效，請重新申請。');
      return showPasswordReset();
    }
    if (isRecoveryLink()) return showPasswordReset();
    if (session) await startDashboard(session.user);
  }

  function bindEvents() {
    $('signInForm').addEventListener('submit', signIn);
    $('passwordResetForm').addEventListener('submit', setNewPassword);
    $('openPasswordResetRequest').addEventListener('click', openPasswordResetRequest);
    $('cancelPasswordResetRequest').addEventListener('click', closePasswordResetRequest);
    $('passwordResetRequestForm').addEventListener('submit', requestPasswordReset);
    $('signOutButton').addEventListener('click', signOut);
    $('refreshButton').addEventListener('click', loadDashboardData);
    $('applyFilterButton').addEventListener('click', loadDashboardData);
    $('openPeopleButton').addEventListener('click', openPeopleDirectory);
    $('openEntryButton').addEventListener('click', () => openEntry());
    $('entryForm').addEventListener('submit', saveEntry);
    $('peopleForm').addEventListener('submit', savePerson);
    $('addProjectButton').addEventListener('click', () => addProjectField());
    $('importFile').addEventListener('change', handleLocalFile);
    $('aiExtractButton').addEventListener('click', extractWithGemini);
    $('importMetric').addEventListener('change', handleImportMetricChange);
    $('chartDimension').addEventListener('change', renderChart);
    $('chartMetric').addEventListener('change', renderChart);
    document.querySelectorAll('[data-close-dialog]').forEach(button => button.addEventListener('click', () => $('entryDialog').close()));
    document.querySelectorAll('[data-close-people-dialog]').forEach(button => button.addEventListener('click', () => $('peopleDialog').close()));
    $('projectFields').addEventListener('click', event => { if (event.target.closest('.remove-project')) event.target.closest('.project-row').remove(); });
    $('entrySalesperson').addEventListener('change', handleSalespersonChange);
    $('peopleBody').addEventListener('click', handlePeopleDirectoryAction);
  }

  async function signIn(event) {
    event.preventDefault(); setMessage('authMessage');
    const { error } = await sb.auth.signInWithPassword({ email: $('emailInput').value.trim(), password: $('passwordInput').value });
    if (error) return setMessage('authMessage', error.message);
    const { data: { user } } = await sb.auth.getUser();
    await startDashboard(user);
  }

  function openPasswordResetRequest() {
    $('passwordResetRequestForm').classList.remove('hidden');
    $('openPasswordResetRequest').classList.add('hidden');
    $('resetEmailInput').value = $('emailInput').value.trim();
    setMessage('passwordResetRequestMessage');
    $('resetEmailInput').focus();
  }

  function closePasswordResetRequest() {
    $('passwordResetRequestForm').classList.add('hidden');
    $('openPasswordResetRequest').classList.remove('hidden');
    setMessage('passwordResetRequestMessage');
  }

  async function requestPasswordReset(event) {
    event.preventDefault();
    const email = $('resetEmailInput').value.trim();
    if (!email) return setMessage('passwordResetRequestMessage', '請輸入電子郵件。');
    const { error } = await sb.auth.resetPasswordForEmail(email);
    if (error) return setMessage('passwordResetRequestMessage', `無法寄送連結：${error.message}`);
    setMessage('passwordResetRequestMessage', '若帳號存在，設定密碼連結已寄出。請查看收件匣與垃圾郵件。', false);
  }

  async function setNewPassword(event) {
    event.preventDefault();
    const password = $('newPasswordInput').value;
    const confirmation = $('confirmPasswordInput').value;
    setMessage('passwordResetMessage');
    if (password.length < 8) return setMessage('passwordResetMessage', '密碼至少需要 8 個字元。');
    if (password !== confirmation) return setMessage('passwordResetMessage', '兩次輸入的密碼不一致。');
    const { data, error } = await sb.auth.updateUser({ password });
    if (error) return setMessage('passwordResetMessage', `無法設定密碼：${error.message}`);
    $('passwordResetForm').reset();
    window.history.replaceState({}, document.title, window.location.pathname);
    recoveryMode = false;
    setMessage('passwordResetMessage', '密碼設定完成，正在登入…', false);
    await startDashboard(data.user);
  }

  async function signOut() {
    await sb.auth.signOut();
    currentUser = null; records = []; salespeople = [];
    $('dashboardView').classList.add('hidden'); $('passwordResetView').classList.add('hidden'); $('authView').classList.remove('hidden');
  }

  async function startDashboard(user) {
    if (recoveryMode) return;
    currentUser = user;
    const { data, error } = await sb.from('profiles').select('role').eq('id', user.id).maybeSingle();
    if (error) {
      setMessage('authMessage', `暫時無法連線至雲端資料庫，請稍候重新登入。${error.message}`);
      return;
    }
    if (!data) {
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
    $('entrySalesperson').innerHTML = personOptions || '<option value="">請先建立業務人員名單</option>';
  }

  function renderDashboard() {
    const calls = records.reduce((sum, row) => sum + number(row.valid_calls), 0);
    const meetings = records.reduce((sum, row) => sum + number(row.valid_meetings), 0);
    const noteRows = records.filter(row => noteMetricKeys.some(key => hasText(row[key])) || Object.values(row.projects || {}).some(hasText));
    $('callsKpi').textContent = calls.toLocaleString(); $('meetingsKpi').textContent = meetings.toLocaleString();
    $('coverageKpi').textContent = noteRows.length ? `${noteRows.length} 筆` : '—';
    $('peopleKpi').textContent = new Set(records.map(row => row.salesperson_id)).size.toLocaleString();
    $('dateRangeLabel').textContent = `${humanDate($('fromDate').value)} 至 ${humanDate($('toDate').value)}`;
    $('recordCount').textContent = `${records.length} 筆`;
    renderChart(); renderProgressSummary(); renderRecords();
  }

  function renderChart() {
    const metric = numericMetricKeys.includes($('chartMetric').value) ? $('chartMetric').value : 'valid_calls'; const dimension = $('chartDimension').value;
    const groups = new Map();
    records.forEach(row => {
      const key = dimension === 'date' ? row.view_date : (row.salespeople?.name || '未指派');
      const item = groups.get(key) || { total: 0, count: 0 }; item.total += number(row[metric]); item.count += 1; groups.set(key, item);
    });
    const items = [...groups.entries()].sort((a, b) => dimension === 'date' ? a[0].localeCompare(b[0]) : b[1].total - a[1].total);
    const labels = items.map(([key]) => dimension === 'date' ? key.slice(5).replace('-', '/') : key);
    const values = items.map(([, value]) => value.total);
    if (chart) chart.destroy();
    chart = new Chart($('performanceChart'), { type: 'bar', data: { labels, datasets: [{ label: metricLabels[metric], data: values, backgroundColor: '#12776c', borderRadius: 6, maxBarThickness: 42 }] }, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { callbacks: { label: context => `${metricLabels[metric]}：${context.raw}` } } }, scales: { x: { grid: { display: false }, ticks: { color: '#6d7b78' } }, y: { beginAtZero: true, grid: { color: '#edf1ee' }, ticks: { color: '#6d7b78', precision: 0 } } } } });
  }

  function renderProgressSummary() {
    if (!records.length) { $('progressSummary').innerHTML = '<p class="empty-state">尚無資料</p>'; return; }
    const latestNotes = noteMetricKeys.map(key => {
      const row = records.find(item => hasText(item[key]));
      return row ? { key, value: row[key], row } : null;
    }).filter(Boolean);
    $('progressSummary').innerHTML = latestNotes.length ? latestNotes.map(({ key, value, row }) => `<div class="progress-item"><div class="progress-label"><span>${metricLabels[key]}</span><strong>${humanDate(row.view_date)} · ${escapeHtml(row.salespeople?.name || '未指派')}</strong></div><p class="progress-note">${escapeHtml(value)}</p></div>`).join('') : '<p class="empty-state">此區間尚無文字指標紀錄</p>';
  }

  function renderRecords() {
    const noteCell = value => `<td class="note-cell">${hasText(value) ? escapeHtml(value) : '—'}</td>`;
    $('recordsBody').innerHTML = records.length ? records.map(row => `<tr><td>${humanDate(row.view_date)}</td><td class="name-cell">${escapeHtml(row.salespeople?.name || '—')}</td><td>${escapeHtml(row.job_title || row.salespeople?.job_title || '—')}</td><td>${number(row.valid_calls)}</td><td>${number(row.valid_meetings)}</td>${noteCell(row.abay_progress)}${noteCell(row.svip_progress)}${noteCell(row.vip_progress)}${noteCell(row.hvip_progress)}${noteCell(row.call_progress)}${noteCell(row.coverage_rate)}<td class="manager-only" aria-hidden="${!isManager()}">${isManager() ? `<div class="row-actions"><button class="mini-btn" data-edit="${row.id}">編輯</button><button class="mini-btn danger" data-delete="${row.id}">刪除</button></div>` : ''}</td></tr>`).join('') : '<tr><td colspan="12"><p class="empty-state">此區間尚無紀錄</p></td></tr>';
    $('recordsBody').querySelectorAll('[data-edit]').forEach(button => button.addEventListener('click', () => openEntry(records.find(row => row.id === button.dataset.edit))));
    $('recordsBody').querySelectorAll('[data-delete]').forEach(button => button.addEventListener('click', () => deleteEntry(button.dataset.delete)));
  }

  function addProjectField(name = '', value = '') {
    const fragment = $('projectFieldTemplate').content.cloneNode(true);
    fragment.querySelector('.project-name').value = name; fragment.querySelector('.project-value').value = value;
    $('projectFields').append(fragment);
  }

  function getCustomMetricNames() {
    return [...new Set(records.flatMap(row => Object.keys(row.projects || {})).map(name => String(name).trim()).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b, 'zh-Hant'));
  }

  function refreshImportMetricOptions(selected = 'auto') {
    const select = $('importMetric'); if (!select) return;
    const previous = selected || select.value || 'auto';
    select.replaceChildren(new Option('自動判斷檔案中的指標', 'auto'));
    importMetricKeys.forEach(key => select.add(new Option(metricLabels[key], `standard:${key}`)));
    getCustomMetricNames().forEach(name => select.add(new Option(name, `custom:${name}`)));
    select.add(new Option('＋ 建立新的自訂績效指標', 'new'));
    select.value = [...select.options].some(option => option.value === previous) ? previous : 'auto';
    handleImportMetricChange();
  }

  function handleImportMetricChange() {
    const isNew = $('importMetric').value === 'new';
    $('customImportMetricWrap').classList.toggle('hidden', !isNew);
    if (isNew) $('customImportMetric').focus();
  }

  function getImportTarget() {
    const value = $('importMetric').value;
    if (value === 'auto') return { mode: 'auto' };
    if (value === 'new') {
      const label = $('customImportMetric').value.trim();
      if (!label) throw new Error('請輸入新的績效指標名稱。');
      return { mode: 'custom', label };
    }
    if (value.startsWith('standard:')) {
      const key = value.slice('standard:'.length);
      return { mode: 'standard', key, label: metricLabels[key] || key };
    }
    if (value.startsWith('custom:')) return { mode: 'custom', label: value.slice('custom:'.length) };
    return { mode: 'auto' };
  }

  function openEntry(row = null) {
    if (!isManager()) return;
    if (!row && !salespeople.length) return openPeopleDirectory();
    $('entryForm').reset(); $('projectFields').innerHTML = ''; setMessage('entryMessage'); setMessage('importStatus'); selectedImportFile = null;
    refreshImportMetricOptions('auto');
    $('entryDialogTitle').textContent = row ? '編輯追蹤紀錄' : '新增追蹤紀錄'; $('entryId').value = row?.id || '';
    $('viewDate').value = row?.view_date || today();
    $('entrySalesperson').value = row?.salesperson_id || salespeople[0]?.id || '';
    $('entryTitle').value = row?.job_title || row?.salespeople?.job_title || '';
    const numberFields = { validCalls: 'valid_calls', validMeetings: 'valid_meetings' };
    const noteFields = { abayProgress: 'abay_progress', svipProgress: 'svip_progress', vipProgress: 'vip_progress', hvipProgress: 'hvip_progress', callProgress: 'call_progress', coverageRate: 'coverage_rate' };
    Object.entries(numberFields).forEach(([id, key]) => { $(id).value = row ? number(row[key]) : 0; });
    Object.entries(noteFields).forEach(([id, key]) => { $(id).value = row?.[key] ?? ''; });
    Object.entries(row?.projects || {}).forEach(([name, value]) => addProjectField(name, value));
    $('entryDialog').showModal();
  }

  async function handleSalespersonChange() {
    const person = salespeople.find(item => item.id === $('entrySalesperson').value);
    if (person) $('entryTitle').value = person.job_title || '';
  }

  async function openPeopleDirectory() {
    if (!isManager()) return;
    setMessage('peopleMessage'); resetPersonForm();
    const { data, error } = await sb.from('salespeople').select('*').order('is_active', { ascending: false }).order('name');
    if (error) return setMessage('peopleMessage', error.message);
    renderPeopleDirectory(data || []);
    $('peopleDialog').showModal();
  }

  function resetPersonForm() {
    $('peopleForm').reset(); $('personId').value = ''; $('savePersonButton').textContent = '加入名單';
  }

  function renderPeopleDirectory(people) {
    $('peopleCount').textContent = `${people.filter(person => person.is_active).length} 位啟用`;
    $('peopleBody').innerHTML = people.length ? people.map(person => `<tr><td class="name-cell">${escapeHtml(person.name)}</td><td>${escapeHtml(person.job_title || '—')}</td><td><span class="status-pill ${person.is_active ? 'active' : ''}">${person.is_active ? '啟用中' : '已停用'}</span></td><td><div class="row-actions"><button class="mini-btn" type="button" data-person-edit="${person.id}">編輯</button><button class="mini-btn ${person.is_active ? 'danger' : ''}" type="button" data-person-toggle="${person.id}" data-person-active="${person.is_active}">${person.is_active ? '停用' : '重新啟用'}</button></div></td></tr>`).join('') : '<tr><td colspan="4"><p class="empty-state">尚未建立業務人員名單</p></td></tr>';
  }

  async function handlePeopleDirectoryAction(event) {
    const edit = event.target.closest('[data-person-edit]'); const toggle = event.target.closest('[data-person-toggle]');
    if (edit) {
      const { data, error } = await sb.from('salespeople').select('*').eq('id', edit.dataset.personEdit).single();
      if (error) return setMessage('peopleMessage', error.message);
      $('personId').value = data.id; $('personName').value = data.name; $('personJobTitle').value = data.job_title || ''; $('savePersonButton').textContent = '儲存變更'; $('personName').focus();
      return;
    }
    if (toggle) {
      const active = toggle.dataset.personActive === 'true';
      if (!window.confirm(active ? '確定要停用這位人員嗎？既有紀錄將保留。' : '確定要重新啟用這位人員嗎？')) return;
      const { error } = await sb.from('salespeople').update({ is_active: !active }).eq('id', toggle.dataset.personToggle);
      if (error) return setMessage('peopleMessage', error.message);
      await reloadPeopleDirectory();
    }
  }

  async function savePerson(event) {
    event.preventDefault(); if (!isManager()) return;
    const id = $('personId').value; const payload = { name: $('personName').value.trim(), job_title: $('personJobTitle').value.trim() };
    if (!payload.name) return setMessage('peopleMessage', '請輸入業務人員姓名。');
    const response = id ? await sb.from('salespeople').update(payload).eq('id', id) : await sb.from('salespeople').insert(payload);
    if (response.error) return setMessage('peopleMessage', response.error.message);
    resetPersonForm(); setMessage('peopleMessage', id ? '人員資料已更新。' : '已加入業務人員名單。', false);
    await reloadPeopleDirectory(); await loadDashboardData();
  }

  async function reloadPeopleDirectory() {
    const { data, error } = await sb.from('salespeople').select('*').order('is_active', { ascending: false }).order('name');
    if (error) return setMessage('peopleMessage', error.message);
    renderPeopleDirectory(data || []);
    salespeople = (data || []).filter(person => person.is_active);
    populatePeopleSelects();
    refreshImportMetricOptions();
  }

  function readProjects() {
    return [...$('projectFields').querySelectorAll('.project-row')].reduce((all, row) => {
      const name = row.querySelector('.project-name').value.trim(); const value = row.querySelector('.project-value').value.trim();
      if (name) all[name] = value; return all;
    }, {});
  }

  async function saveEntry(event) {
    event.preventDefault(); if (!isManager()) return;
    const payload = { view_date: $('viewDate').value, salesperson_id: $('entrySalesperson').value, job_title: $('entryTitle').value.trim(), valid_calls: number($('validCalls').value), valid_meetings: number($('validMeetings').value), abay_progress: $('abayProgress').value.trim(), svip_progress: $('svipProgress').value.trim(), vip_progress: $('vipProgress').value.trim(), hvip_progress: $('hvipProgress').value.trim(), call_progress: $('callProgress').value.trim(), coverage_rate: $('coverageRate').value.trim(), projects: readProjects(), updated_by: currentUser.id };
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
  function normalizePersonName(name) { return String(name || '').replace(/[\s\-_.，,。()（）]/g, '').toLowerCase(); }

  function matchSalespersonName(value) {
    const input = normalizePersonName(value);
    if (!input) return null;
    const exact = salespeople.find(person => normalizePersonName(person.name) === input);
    if (exact) return exact;
    return salespeople.find(person => {
      const name = normalizePersonName(person.name);
      return name.length >= 2 && (input.includes(name) || name.includes(input));
    }) || null;
  }

  function applyImportedValues(source) {
    const aliases = { viewdate: 'viewDate', '檢視日期': 'viewDate', '日期': 'viewDate', salespersonname: 'salespersonName', '業務人員': 'salespersonName', '姓名': 'salespersonName', jobtitle: 'entryTitle', '職級': 'entryTitle', validcalls: 'validCalls', '有效電訪': 'validCalls', '有效電訪紀錄': 'validCalls', validmeetings: 'validMeetings', '有效面訪': 'validMeetings', '有效面訪紀錄': 'validMeetings', abayprogress: 'abayProgress', '亞灣進度': 'abayProgress', '亞灣進度紀錄': 'abayProgress', svipprogress: 'svipProgress', svipupgradeprogress: 'svipProgress', 'svip進度': 'svipProgress', 'svip升等進度': 'svipProgress', vipprogress: 'vipProgress', vipupgradeprogress: 'vipProgress', 'vip升等進度': 'vipProgress', hvipprogress: 'hvipProgress', 'hvip進度': 'hvipProgress', callprogress: 'callProgress', '電訪進度': 'callProgress', coveragerate: 'coverageRate', '覆蓋率': 'coverageRate', '覆蓋率紀錄': 'coverageRate' };
    const projects = {};
    Object.entries(source || {}).forEach(([rawKey, value]) => {
      const key = normalizeKey(rawKey); const target = aliases[key] || aliases[rawKey];
      if (target && $(target)) $(target).value = value ?? '';
      else if (target === 'salespersonName') {
        const person = matchSalespersonName(value);
        if (person) {
          $('entrySalesperson').value = person.id; $('entryTitle').value = person.job_title || '';
          setMessage('importStatus', `已比對業務人員「${person.name}」並自動帶入職級。`, false);
        } else if (hasText(value)) {
          setMessage('importStatus', `辨識到業務人員「${String(value).trim()}」，但名單中找不到相符姓名；請手動選擇或先到「管理業務人員」新增。`);
        }
      } else if (rawKey && value !== undefined && rawKey !== 'projects' && rawKey !== 'customMetrics') projects[rawKey] = value;
    });
    if (source.projects && typeof source.projects === 'object') Object.assign(projects, source.projects);
    if (source.customMetrics && typeof source.customMetrics === 'object') Object.assign(projects, source.customMetrics);
    if (Object.keys(projects).length) { $('projectFields').innerHTML = ''; Object.entries(projects).forEach(([name, value]) => addProjectField(name, value)); setMessage('importStatus', `辨識完成；已帶入預設欄位，並自動建立 ${Object.keys(projects).length} 個可編輯的自訂指標。`, false); }
  }

  const isProvided = value => value !== null && value !== undefined && String(value).trim() !== '';
  const formatCoverage = value => {
    const text = String(value).trim();
    return /^\d+(?:\.\d+)?$/.test(text) ? `${text}%` : text;
  };

  async function importRecognizedRecords(items, importTarget = { mode: 'auto' }) {
    const viewDate = $('viewDate').value || today();
    const recognized = (Array.isArray(items) ? items : []).map(item => ({ item, person: matchSalespersonName(item?.salespersonName) })).filter(({ item }) => item && typeof item === 'object');
    const personIds = [...new Set(recognized.map(({ person }) => person?.id).filter(Boolean))];
    if (!personIds.length) throw new Error('檔案中沒有可與業務人員名單比對的姓名。請先建立或確認人員名單。');

    const { data: existingRows, error: existingError } = await sb.from('performance_entries').select('salesperson_id, projects').eq('view_date', viewDate).in('salesperson_id', personIds);
    if (existingError) throw existingError;
    const existingByPerson = new Map((existingRows || []).map(row => [row.salesperson_id, row]));
    const payloads = []; const unmatched = []; const skipped = [];

    recognized.forEach(({ item, person }) => {
      if (!person) { if (hasText(item.salespersonName)) unmatched.push(String(item.salespersonName).trim()); return; }
      const payload = { view_date: viewDate, salesperson_id: person.id, updated_by: currentUser.id };
      let hasMetric = false;
      if (isProvided(item.jobTitle)) payload.job_title = String(item.jobTitle).trim();
      else if (!existingByPerson.has(person.id)) payload.job_title = person.job_title || '';
      if (importTarget.mode !== 'auto' && isProvided(item.importValue)) {
        if (importTarget.mode === 'standard') {
          payload[importTarget.key] = importTarget.key === 'valid_calls' || importTarget.key === 'valid_meetings'
            ? Math.max(0, number(item.importValue))
            : importTarget.key === 'coverage_rate' ? formatCoverage(item.importValue) : String(item.importValue).trim();
        } else {
          payload.projects = { ...(existingByPerson.get(person.id)?.projects || {}), [importTarget.label]: String(item.importValue).trim() };
        }
        hasMetric = true;
      } else if (importTarget.mode === 'auto') {
        if (isProvided(item.validCalls)) { payload.valid_calls = Math.max(0, number(item.validCalls)); hasMetric = true; }
        if (isProvided(item.validMeetings)) { payload.valid_meetings = Math.max(0, number(item.validMeetings)); hasMetric = true; }
      }
      const textFields = { abayProgress: 'abay_progress', svipUpgradeProgress: 'svip_progress', svipProgress: 'svip_progress', vipUpgradeProgress: 'vip_progress', vipProgress: 'vip_progress', hvipProgress: 'hvip_progress', callProgress: 'call_progress', coverageRate: 'coverage_rate' };
      if (importTarget.mode === 'auto') Object.entries(textFields).forEach(([sourceKey, column]) => {
        if (!isProvided(item[sourceKey]) || (column in payload && sourceKey === 'svipProgress')) return;
        payload[column] = column === 'coverage_rate' ? formatCoverage(item[sourceKey]) : String(item[sourceKey]).trim(); hasMetric = true;
      });
      const customMetrics = item.customMetrics && typeof item.customMetrics === 'object' && !Array.isArray(item.customMetrics) ? item.customMetrics : {};
      if (importTarget.mode === 'auto' && Object.keys(customMetrics).length) {
        payload.projects = { ...(existingByPerson.get(person.id)?.projects || {}), ...customMetrics }; hasMetric = true;
      }
      if (!hasMetric) { skipped.push(person.name); return; }
      if (!existingByPerson.has(person.id)) payload.created_by = currentUser.id;
      payloads.push(payload);
    });

    if (!payloads.length) throw new Error('已辨識人員姓名，但沒有可更新的指標數據。');
    const { error } = await sb.from('performance_entries').upsert(payloads, { onConflict: 'view_date,salesperson_id' });
    if (error) throw error;
    await loadDashboardData();
    const details = [unmatched.length ? `未比對：${[...new Set(unmatched)].join('、')}` : '', skipped.length ? `未提供指標：${[...new Set(skipped)].join('、')}` : ''].filter(Boolean).join('；');
    const targetNote = importTarget.mode === 'auto' ? '辨識數據' : `「${importTarget.label || metricLabels[importTarget.key]}」`;
    return `已依 ${humanDate(viewDate)} 自動更新 ${payloads.length} 位業務人員的${targetNote}。${details ? ` ${details}。` : ''}`;
  }

  async function handleLocalFile(event) {
    selectedImportFile = event.target.files?.[0] || null; if (!selectedImportFile) return;
    const kind = /\.pdf$/i.test(selectedImportFile.name) ? 'PDF' : /image\//.test(selectedImportFile.type) ? '圖片' : '檔案';
    setMessage('importStatus', `已選擇${kind}：${selectedImportFile.name}。點擊「使用 Gemini 辨識」後，會比對全部業務姓名並批次帶入。`, false);
  }

  async function extractWithGemini() {
    if (!selectedImportFile) return setMessage('importStatus', '請先選擇圖片或檔案。');
    if (!isManager()) return;
    try {
      const importTarget = getImportTarget();
      const targetDescription = importTarget.mode === 'auto' ? '自動判斷相關指標' : `指定帶入「${importTarget.label}」`;
      if (!window.confirm(`即將把「${selectedImportFile.name}」傳送到 Google Gemini 進行辨識，${targetDescription}，並批次更新所有姓名比對成功的人員。是否繼續？`)) return;
      const payload = await buildGeminiPayload(selectedImportFile);
      setMessage('importStatus', 'Gemini 正在辨識…', false);
      const { data, error } = await sb.functions.invoke('extract-progress', { body: { ...payload, filename: selectedImportFile.name, importTarget, knownSalespeople: salespeople.map(person => ({ name: person.name, jobTitle: person.job_title || '' })) } });
      if (error) throw error;
      const result = data || {};
      const candidateRecord = result.record || result;
      const recognizedRecords = result.records || result.record?.records || result.batchCoverage || result.record?.batchCoverage || (hasText(candidateRecord?.salespersonName) ? [candidateRecord] : null);
      if (Array.isArray(recognizedRecords) && recognizedRecords.length) {
        const message = await importRecognizedRecords(recognizedRecords, importTarget);
        $('entryDialog').close(); window.alert(message);
      } else {
        applyImportedValues(candidateRecord); if (!Object.keys(candidateRecord?.customMetrics || {}).length) setMessage('importStatus', '辨識完成，請檢查帶入的文字紀錄後再儲存。', false);
      }
    } catch (error) { setMessage('importStatus', `Gemini 辨識失敗：${error.message || error}`); }
  }

  function bytesToBase64(bytes) {
    let binary = ''; const chunkSize = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
    return btoa(binary);
  }

  async function buildGeminiPayload(file) {
    if (/image\//.test(file.type) || /\.pdf$/i.test(file.name)) return { mimeType: file.type || 'application/pdf', contentBase64: bytesToBase64(new Uint8Array(await file.arrayBuffer())) };
    let text;
    if (/\.xlsx$/i.test(file.name)) {
      const workbook = XLSX.read(await file.arrayBuffer(), { type: 'array' });
      text = XLSX.utils.sheet_to_csv(workbook.Sheets[workbook.SheetNames[0]]);
    } else text = await file.text();
    return { mimeType: 'text/plain', contentBase64: bytesToBase64(new TextEncoder().encode(text)) };
  }

  init();
})();
