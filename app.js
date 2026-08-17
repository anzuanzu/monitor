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
  let bulkMetricLoadedKey = '';
  let recoveryMode = false;
  let toastTimer = null;
  let dashboardLoadId = 0;

  const today = () => new Date().toISOString().slice(0, 10);
  const number = value => Number(value || 0);
  const hasText = value => String(value ?? '').trim().length > 0;
  const isManager = () => role === 'manager';
  const setMessage = (id, message = '', error = true) => {
    const el = $(id); if (!el) return;
    el.textContent = message; el.style.color = error ? 'var(--danger)' : 'var(--teal)';
  };
  const showToast = (message, type = 'success') => {
    const region = $('toastRegion'); if (!region || !message) return;
    window.clearTimeout(toastTimer);
    region.innerHTML = `<div class="toast ${type === 'error' ? 'error' : ''}" role="status">${escapeHtml(message)}</div>`;
    const toast = region.firstElementChild;
    toastTimer = window.setTimeout(() => {
      toast?.classList.add('is-leaving');
      window.setTimeout(() => { if (region.contains(toast)) toast.remove(); }, 240);
    }, 4200);
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

  function configureDateFilters(days = 30) {
    const to = today(); const from = new Date(); from.setDate(from.getDate() - (days - 1));
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
    $('toggleRecordsFocus').addEventListener('click', toggleRecordsFocus);
    $('applyFilterButton').addEventListener('click', applyFilters);
    $('clearFilterButton').addEventListener('click', clearFilters);
    $('recordSearch').addEventListener('input', renderDashboard);
    document.querySelectorAll('[data-range-days]').forEach(button => button.addEventListener('click', () => setQuickRange(number(button.dataset.rangeDays))));
    ['fromDate', 'toDate'].forEach(id => $(id).addEventListener('change', () => setActiveRangeChip()));
    $('openPeopleButton').addEventListener('click', openPeopleDirectory);
    $('openBulkMetricButton').addEventListener('click', openBulkMetricEditor);
    $('openEntryButton').addEventListener('click', () => openEntry());
    $('entryForm').addEventListener('submit', saveEntry);
    $('peopleForm').addEventListener('submit', savePerson);
    $('bulkMetricForm').addEventListener('submit', saveBulkMetricValues);
    $('loadBulkMetricButton').addEventListener('click', loadBulkMetricValues);
    $('deleteBulkMetricButton').addEventListener('click', deleteBulkMetricValues);
    $('addProjectButton').addEventListener('click', () => addProjectField());
    $('importFile').addEventListener('change', handleLocalFile);
    $('aiExtractButton').addEventListener('click', extractWithGemini);
    $('importMetric').addEventListener('change', handleImportMetricChange);
    $('chartDimension').addEventListener('change', renderChart);
    $('chartMetric').addEventListener('change', renderChart);
    document.querySelectorAll('[data-close-dialog]').forEach(button => button.addEventListener('click', () => $('entryDialog').close()));
    document.querySelectorAll('[data-close-people-dialog]').forEach(button => button.addEventListener('click', () => $('peopleDialog').close()));
    document.querySelectorAll('[data-close-bulk-dialog]').forEach(button => button.addEventListener('click', () => $('bulkMetricDialog').close()));
    $('projectFields').addEventListener('click', event => { if (event.target.closest('.remove-project')) event.target.closest('.project-row').remove(); });
    $('recordsHead').addEventListener('click', handleCustomMetricHeaderAction);
    $('entrySalesperson').addEventListener('change', handleSalespersonChange);
    $('peopleBody').addEventListener('click', handlePeopleDirectoryAction);
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && $('recordsPanel').classList.contains('is-focus-mode') && !document.querySelector('dialog[open]')) toggleRecordsFocus(false);
    });
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
    document.body.classList.remove('dashboard-active', 'records-focus-active');
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
    document.body.classList.add('dashboard-active');
    $('authView').classList.add('hidden'); $('dashboardView').classList.remove('hidden');
    $('userEmail').textContent = user.email || '';
    $('roleBadge').textContent = role === 'manager' ? '管理者' : '檢視者';
    $('roleBadge').classList.toggle('manager', isManager());
    document.querySelectorAll('.manager-only').forEach(el => el.setAttribute('aria-hidden', String(!isManager())));
    await loadDashboardData();
  }

  function toggleRecordsFocus(force) {
    const panel = $('recordsPanel');
    const shouldFocus = typeof force === 'boolean' ? force : !panel.classList.contains('is-focus-mode');
    panel.classList.toggle('is-focus-mode', shouldFocus);
    document.body.classList.toggle('records-focus-active', shouldFocus);
    $('toggleRecordsFocus').textContent = shouldFocus ? '退出全欄位模式' : '全欄位模式';
    $('toggleRecordsFocus').setAttribute('aria-pressed', String(shouldFocus));
    if (shouldFocus) panel.querySelector('.records-table-wrap')?.focus();
  }

  async function loadDashboardData() {
    if (!currentUser) return;
    const loadId = ++dashboardLoadId;
    const from = $('fromDate').value; const to = $('toDate').value; const salespersonId = $('salespersonFilter').value;
    if (from && to && from > to) return showToast('起始日期不可晚於結束日期。', 'error');
    const loadingButtons = [$('refreshButton'), $('applyFilterButton')].filter(Boolean);
    loadingButtons.forEach(button => { button.disabled = true; button.classList.add('is-loading'); button.setAttribute('aria-busy', 'true'); });
    try {
      const peopleResponse = await sb.from('salespeople').select('*').eq('is_active', true).order('name');
      if (peopleResponse.error) throw peopleResponse.error;
      if (loadId !== dashboardLoadId) return;
      salespeople = peopleResponse.data || [];
      let query = sb.from('performance_entries').select('*, salespeople(id,name,job_title)').gte('view_date', from).lte('view_date', to).order('view_date', { ascending: false });
      if (salespersonId) query = query.eq('salesperson_id', salespersonId);
      const response = await query;
      if (response.error) throw response.error;
      if (loadId !== dashboardLoadId) return;
      records = response.data || [];
      $('setupNotice').classList.add('hidden');
      populatePeopleSelects(); renderDashboard();
    } catch (error) {
      showSetup(`無法讀取雲端資料：${error.message || error}`);
      showToast('雲端資料讀取失敗，請稍後重試。', 'error');
    } finally {
      if (loadId === dashboardLoadId) loadingButtons.forEach(button => { button.disabled = false; button.classList.remove('is-loading'); button.removeAttribute('aria-busy'); });
    }
  }

  function applyFilters() {
    setActiveRangeChip();
    loadDashboardData();
  }

  function setQuickRange(days) {
    configureDateFilters(days);
    setActiveRangeChip(days);
    loadDashboardData();
  }

  function setActiveRangeChip(activeDays = 0) {
    document.querySelectorAll('[data-range-days]').forEach(button => button.classList.toggle('active', number(button.dataset.rangeDays) === activeDays));
  }

  function clearFilters() {
    configureDateFilters(30);
    $('salespersonFilter').value = '';
    $('recordSearch').value = '';
    setActiveRangeChip(30);
    loadDashboardData();
  }

  function populatePeopleSelects() {
    const current = $('salespersonFilter').value;
    const personOptions = salespeople.map(person => `<option value="${person.id}">${escapeHtml(person.name)}</option>`).join('');
    $('salespersonFilter').innerHTML = `<option value="">全部業務人員</option>${personOptions}`;
    $('salespersonFilter').value = current;
    $('entrySalesperson').innerHTML = personOptions || '<option value="">請先建立業務人員名單</option>';
  }

  function renderDashboard() {
    const visibleRecords = getVisibleRecords();
    const calls = visibleRecords.reduce((sum, row) => sum + number(row.valid_calls), 0);
    const meetings = visibleRecords.reduce((sum, row) => sum + number(row.valid_meetings), 0);
    const noteRows = visibleRecords.filter(row => noteMetricKeys.some(key => hasText(row[key])) || Object.values(row.projects || {}).some(hasText));
    $('callsKpi').textContent = calls.toLocaleString(); $('meetingsKpi').textContent = meetings.toLocaleString();
    $('coverageKpi').textContent = noteRows.length ? `${noteRows.length} 筆` : '—';
    $('peopleKpi').textContent = new Set(visibleRecords.map(row => row.salesperson_id)).size.toLocaleString();
    $('dateRangeLabel').textContent = `${humanDate($('fromDate').value)} 至 ${humanDate($('toDate').value)}`;
    $('recordCount').textContent = `${visibleRecords.length} 筆`;
    const selectedPerson = $('salespersonFilter').selectedOptions?.[0]?.textContent || '全部業務人員';
    const search = $('recordSearch').value.trim();
    $('filterSummary').textContent = `${selectedPerson}${search ? `・搜尋「${search}」` : ''}・${visibleRecords.length} 筆結果`;
    renderChart(); renderProgressSummary(); renderRecords();
  }

  function getVisibleRecords() {
    const keyword = normalizeKey($('recordSearch')?.value || '');
    if (!keyword) return records;
    return records.filter(row => normalizeKey([
      row.salespeople?.name, row.job_title, row.salespeople?.job_title,
      row.valid_calls, row.valid_meetings,
      ...noteMetricKeys.map(key => row[key]),
      ...Object.entries(row.projects || {}).flat()
    ].filter(value => value !== null && value !== undefined).join(' ')).includes(keyword));
  }

  function renderChart() {
    const metric = numericMetricKeys.includes($('chartMetric').value) ? $('chartMetric').value : 'valid_calls'; const dimension = $('chartDimension').value;
    const groups = new Map();
    getVisibleRecords().forEach(row => {
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
    const visibleRecords = getVisibleRecords();
    if (!visibleRecords.length) { $('progressSummary').innerHTML = '<p class="empty-state">尚無符合條件的資料</p>'; return; }
    const latestNotes = noteMetricKeys.map(key => {
      const row = visibleRecords.find(item => hasText(item[key]));
      return row ? { key, value: row[key], row } : null;
    }).filter(Boolean);
    getCustomMetricNames().forEach(name => {
      const row = visibleRecords.find(item => hasText(item.projects?.[name]));
      if (row) latestNotes.push({ key: name, value: row.projects[name], row, custom: true });
    });
    $('progressSummary').innerHTML = latestNotes.length ? latestNotes.slice(0, 12).map(({ key, value, row, custom }) => `<div class="progress-item"><div class="progress-label"><span>${escapeHtml(custom ? key : metricLabels[key])}</span><strong>${humanDate(row.view_date)} · ${escapeHtml(row.salespeople?.name || '未指派')}</strong></div><p class="progress-note">${escapeHtml(value)}</p></div>`).join('') : '<p class="empty-state">此區間尚無文字指標紀錄</p>';
  }

  function renderRecords() {
    const visibleRecords = getVisibleRecords();
    const noteCell = value => `<td class="note-cell">${hasText(value) ? escapeHtml(value) : '—'}</td>`;
    const customMetricNames = getCustomMetricNames();
    $('recordsHead').innerHTML = `<th>檢視日期</th><th>業務人員</th><th>職級</th><th>有效電訪</th><th>有效面訪</th><th>亞灣進度紀錄</th><th>SVIP 升等進度</th><th>VIP 升等進度</th><th>HVIP 進度</th><th>電訪進度</th><th>覆蓋率紀錄</th>${customMetricNames.map(name => `<th class="custom-metric-head"><div class="custom-metric-title"><span>${escapeHtml(name)}</span><span class="custom-metric-actions manager-only" aria-hidden="${!isManager()}"><button class="metric-header-btn" type="button" data-rename-metric="${escapeHtml(name)}" title="重新命名欄位" aria-label="重新命名 ${escapeHtml(name)}">✎</button><button class="metric-header-btn danger" type="button" data-delete-metric="${escapeHtml(name)}" title="刪除整個欄位" aria-label="刪除 ${escapeHtml(name)}">×</button></span></div></th>`).join('')}<th class="manager-only" aria-hidden="${!isManager()}">操作</th>`;
    $('recordsBody').innerHTML = visibleRecords.length ? visibleRecords.map(row => `<tr><td>${humanDate(row.view_date)}</td><td class="name-cell">${escapeHtml(row.salespeople?.name || '—')}</td><td>${escapeHtml(row.job_title || row.salespeople?.job_title || '—')}</td><td>${number(row.valid_calls)}</td><td>${number(row.valid_meetings)}</td>${noteCell(row.abay_progress)}${noteCell(row.svip_progress)}${noteCell(row.vip_progress)}${noteCell(row.hvip_progress)}${noteCell(row.call_progress)}${noteCell(row.coverage_rate)}${customMetricNames.map(name => noteCell(row.projects?.[name])).join('')}<td class="manager-only" aria-hidden="${!isManager()}">${isManager() ? `<div class="row-actions"><button class="mini-btn" data-edit="${row.id}">編輯</button><button class="mini-btn danger" data-delete="${row.id}">刪除</button></div>` : ''}</td></tr>`).join('') : `<tr><td colspan="${12 + customMetricNames.length}"><p class="empty-state">沒有符合目前條件的紀錄</p></td></tr>`;
    $('recordsBody').querySelectorAll('[data-edit]').forEach(button => button.addEventListener('click', () => openEntry(visibleRecords.find(row => row.id === button.dataset.edit))));
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

  function populateBulkMetricNames() {
    $('bulkMetricNameList').replaceChildren(...getCustomMetricNames().map(name => {
      const option = document.createElement('option'); option.value = name; return option;
    }));
  }

  async function openBulkMetricEditor() {
    if (!isManager()) return;
    if (!salespeople.length) return openPeopleDirectory();
    $('bulkMetricForm').reset(); $('bulkMetricDate').value = today();
    bulkMetricLoadedKey = '';
    populateBulkMetricNames();
    const existingNames = getCustomMetricNames();
    $('bulkMetricName').value = existingNames[0] || '';
    $('bulkMetricBody').innerHTML = '<tr><td colspan="3"><p class="empty-state">輸入指標名稱後載入全部業務</p></td></tr>';
    setMessage('bulkMetricMessage');
    $('bulkMetricDialog').showModal();
    if (existingNames.length) await loadBulkMetricValues();
  }

  async function loadBulkMetricValues() {
    if (!isManager()) return;
    const viewDate = $('bulkMetricDate').value;
    const metricName = $('bulkMetricName').value.trim();
    if (!viewDate) return setMessage('bulkMetricMessage', '請選擇檢視日期。');
    if (!metricName) return setMessage('bulkMetricMessage', '請選擇既有指標或輸入新的指標名稱。');
    setMessage('bulkMetricMessage', '正在載入全部業務資料…', false);
    const personIds = salespeople.map(person => person.id);
    const { data, error } = await sb.from('performance_entries').select('salesperson_id, projects').eq('view_date', viewDate).in('salesperson_id', personIds);
    if (error) return setMessage('bulkMetricMessage', `無法載入資料：${error.message}`);
    const existingByPerson = new Map((data || []).map(row => [row.salesperson_id, row]));
    $('bulkMetricBody').innerHTML = salespeople.map(person => `<tr><td class="name-cell">${escapeHtml(person.name)}</td><td>${escapeHtml(person.job_title || '—')}</td><td><textarea class="bulk-metric-value" data-person-id="${person.id}" rows="2" placeholder="輸入「${escapeHtml(metricName)}」資料">${escapeHtml(existingByPerson.get(person.id)?.projects?.[metricName] || '')}</textarea></td></tr>`).join('');
    bulkMetricLoadedKey = `${viewDate}\u0000${metricName}`;
    setMessage('bulkMetricMessage', `已載入 ${salespeople.length} 位業務人員，可直接同步編輯「${metricName}」。`, false);
  }

  async function saveBulkMetricValues(event) {
    event.preventDefault(); if (!isManager()) return;
    const viewDate = $('bulkMetricDate').value;
    const metricName = $('bulkMetricName').value.trim();
    const inputs = [...$('bulkMetricBody').querySelectorAll('.bulk-metric-value')];
    if (!viewDate || !metricName) return setMessage('bulkMetricMessage', '請先選擇日期與指標名稱。');
    if (!inputs.length) return setMessage('bulkMetricMessage', '請先載入全部業務資料。');
    if (bulkMetricLoadedKey !== `${viewDate}\u0000${metricName}`) return setMessage('bulkMetricMessage', '日期或指標名稱已變更，請先重新載入全部業務。');
    setMessage('bulkMetricMessage', '正在同步儲存…', false);
    const personIds = inputs.map(input => input.dataset.personId);
    const { data, error: loadError } = await sb.from('performance_entries').select('salesperson_id, projects').eq('view_date', viewDate).in('salesperson_id', personIds);
    if (loadError) return setMessage('bulkMetricMessage', `無法讀取既有資料：${loadError.message}`);
    const existingByPerson = new Map((data || []).map(row => [row.salesperson_id, row]));
    const payloads = [];
    inputs.forEach(input => {
      const person = salespeople.find(item => item.id === input.dataset.personId);
      if (!person) return;
      const existing = existingByPerson.get(person.id);
      const projects = { ...(existing?.projects || {}) };
      const value = input.value.trim();
      const previouslyHadMetric = Object.prototype.hasOwnProperty.call(projects, metricName);
      if (value) projects[metricName] = value;
      else delete projects[metricName];
      if (!existing && !value) return;
      if (existing && !previouslyHadMetric && !value) return;
      const payload = { view_date: viewDate, salesperson_id: person.id, projects, updated_by: currentUser.id };
      if (!existing) Object.assign(payload, { job_title: person.job_title || '', created_by: currentUser.id });
      payloads.push(payload);
    });
    if (!payloads.length) return setMessage('bulkMetricMessage', '沒有需要儲存的資料。');
    const { error } = await sb.from('performance_entries').upsert(payloads, { onConflict: 'view_date,salesperson_id' });
    if (error) return setMessage('bulkMetricMessage', `同步儲存失敗：${error.message}`);
    $('bulkMetricDialog').close();
    await loadDashboardData();
    showToast(`已同步更新 ${payloads.length} 位業務人員的「${metricName}」。`);
  }

  async function deleteBulkMetricValues() {
    if (!isManager()) return;
    const viewDate = $('bulkMetricDate').value;
    const metricName = $('bulkMetricName').value.trim();
    if (!viewDate || !metricName) return setMessage('bulkMetricMessage', '請先選擇日期與指標名稱。');
    if (!window.confirm(`確定要刪除 ${humanDate(viewDate)} 全部業務人員的「${metricName}」嗎？其他指標與績效紀錄會保留。`)) return;
    setMessage('bulkMetricMessage', '正在刪除全部業務的指定指標…', false);
    const { data, error: loadError } = await sb.from('performance_entries').select('salesperson_id, projects').eq('view_date', viewDate);
    if (loadError) return setMessage('bulkMetricMessage', `無法讀取既有資料：${loadError.message}`);
    const payloads = (data || []).filter(row => Object.prototype.hasOwnProperty.call(row.projects || {}, metricName)).map(row => {
      const projects = { ...(row.projects || {}) };
      delete projects[metricName];
      return { view_date: viewDate, salesperson_id: row.salesperson_id, projects, updated_by: currentUser.id };
    });
    if (!payloads.length) return setMessage('bulkMetricMessage', `當日沒有任何業務人員使用「${metricName}」。`);
    const { error } = await sb.from('performance_entries').upsert(payloads, { onConflict: 'view_date,salesperson_id' });
    if (error) return setMessage('bulkMetricMessage', `刪除失敗：${error.message}`);
    bulkMetricLoadedKey = '';
    $('bulkMetricBody').innerHTML = '<tr><td colspan="3"><p class="empty-state">此指標已從當日全部業務資料中移除</p></td></tr>';
    setMessage('bulkMetricMessage', `已刪除 ${payloads.length} 位業務人員的「${metricName}」，其他資料均已保留。`, false);
    await loadDashboardData();
  }

  async function fetchAllProjectRows() {
    const allRows = []; const pageSize = 1000;
    for (let from = 0; ; from += pageSize) {
      const { data, error } = await sb.from('performance_entries').select('view_date, salesperson_id, projects').order('view_date', { ascending: true }).order('salesperson_id', { ascending: true }).range(from, from + pageSize - 1);
      if (error) throw error;
      allRows.push(...(data || []));
      if (!data || data.length < pageSize) break;
    }
    return allRows;
  }

  async function upsertProjectRows(payloads) {
    const batchSize = 200;
    for (let offset = 0; offset < payloads.length; offset += batchSize) {
      const { error } = await sb.from('performance_entries').upsert(payloads.slice(offset, offset + batchSize), { onConflict: 'view_date,salesperson_id' });
      if (error) throw error;
    }
  }

  async function handleCustomMetricHeaderAction(event) {
    if (!isManager()) return;
    const renameButton = event.target.closest('[data-rename-metric]');
    const deleteButton = event.target.closest('[data-delete-metric]');
    if (!renameButton && !deleteButton) return;
    const oldName = String((renameButton || deleteButton).dataset.renameMetric || (renameButton || deleteButton).dataset.deleteMetric || '').trim();
    if (!oldName) return;
    if (renameButton) await renameCustomMetricColumn(oldName);
    else await deleteCustomMetricColumn(oldName);
  }

  async function renameCustomMetricColumn(oldName) {
    const newName = window.prompt(`將自訂欄位「${oldName}」重新命名為：`, oldName)?.trim();
    if (!newName || newName === oldName) return;
    try {
      const rows = await fetchAllProjectRows();
      const affectedRows = rows.filter(row => Object.prototype.hasOwnProperty.call(row.projects || {}, oldName));
      if (!affectedRows.length) return showToast(`找不到使用「${oldName}」的資料。`, 'error');
      const hasCollision = rows.some(row => Object.prototype.hasOwnProperty.call(row.projects || {}, newName));
      if (hasCollision && !window.confirm(`已有部分資料使用「${newName}」。是否合併欄位？既有「${newName}」內容會優先保留。`)) return;
      if (!window.confirm(`確定要將所有日期、所有業務的「${oldName}」重新命名為「${newName}」嗎？`)) return;
      const payloads = affectedRows.map(row => {
        const projects = { ...(row.projects || {}) };
        if (!hasText(projects[newName])) projects[newName] = projects[oldName];
        delete projects[oldName];
        return { view_date: row.view_date, salesperson_id: row.salesperson_id, projects, updated_by: currentUser.id };
      });
      await upsertProjectRows(payloads);
      await loadDashboardData();
      showToast(`已將 ${payloads.length} 筆資料的「${oldName}」重新命名為「${newName}」。`);
    } catch (error) { showToast(`重新命名失敗：${error.message || error}`, 'error'); }
  }

  async function deleteCustomMetricColumn(metricName) {
    if (!window.confirm(`確定要永久刪除所有日期、所有業務的「${metricName}」欄位嗎？其他績效欄位與紀錄會保留。`)) return;
    try {
      const rows = await fetchAllProjectRows();
      const payloads = rows.filter(row => Object.prototype.hasOwnProperty.call(row.projects || {}, metricName)).map(row => {
        const projects = { ...(row.projects || {}) };
        delete projects[metricName];
        return { view_date: row.view_date, salesperson_id: row.salesperson_id, projects, updated_by: currentUser.id };
      });
      if (!payloads.length) return showToast(`找不到使用「${metricName}」的資料。`, 'error');
      await upsertProjectRows(payloads);
      await loadDashboardData();
      showToast(`已從 ${payloads.length} 筆資料中刪除「${metricName}」欄位。`);
    } catch (error) { showToast(`刪除欄位失敗：${error.message || error}`, 'error'); }
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
    $('entryDialog').close(); await loadDashboardData(); showToast(id ? '追蹤紀錄已更新。' : '追蹤紀錄已新增。');
  }

  async function deleteEntry(id) {
    if (!isManager() || !window.confirm('確定要刪除這筆紀錄？此動作無法復原。')) return;
    const { error } = await sb.from('performance_entries').delete().eq('id', id);
    if (error) return showToast(error.message, 'error'); await loadDashboardData(); showToast('追蹤紀錄已刪除。');
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

  function normalizeRecognizedItem(source) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) return null;
    const aliases = {
      salespersonname: 'salespersonName', salesperson: 'salespersonName', name: 'salespersonName', '業務人員': 'salespersonName', '姓名': 'salespersonName',
      jobtitle: 'jobTitle', title: 'jobTitle', '職級': 'jobTitle', importvalue: 'importValue', value: 'importValue', '數值': 'importValue',
      validcalls: 'validCalls', '有效電訪': 'validCalls', validmeetings: 'validMeetings', '有效面訪': 'validMeetings',
      abayprogress: 'abayProgress', '亞灣進度': 'abayProgress', svipupgradeprogress: 'svipUpgradeProgress', svipprogress: 'svipProgress', 'svip升等進度': 'svipUpgradeProgress',
      vipupgradeprogress: 'vipUpgradeProgress', vipprogress: 'vipProgress', 'vip升等進度': 'vipUpgradeProgress', hvipprogress: 'hvipProgress', 'hvip進度': 'hvipProgress',
      callprogress: 'callProgress', '電訪進度': 'callProgress', coveragerate: 'coverageRate', '覆蓋率': 'coverageRate'
    };
    const normalized = {}; const customMetrics = {};
    Object.entries(source).forEach(([rawKey, value]) => {
      if (['customMetrics', 'projects', 'metrics'].includes(rawKey)) return;
      const target = aliases[normalizeKey(rawKey)];
      if (target) normalized[target] = value;
      else if (rawKey && value !== undefined && value !== null && typeof value !== 'object') customMetrics[rawKey] = value;
    });
    [source.customMetrics, source.projects].forEach(collection => {
      if (collection && typeof collection === 'object' && !Array.isArray(collection)) Object.assign(customMetrics, collection);
    });
    if (Array.isArray(source.metrics)) source.metrics.forEach(metric => {
      const name = String(metric?.name || metric?.label || metric?.metric || '').trim();
      if (name && isProvided(metric?.value)) customMetrics[name] = metric.value;
    });
    normalized.customMetrics = Object.fromEntries(Object.entries(customMetrics).filter(([name, value]) => name.trim() && isProvided(value)));
    return normalized;
  }

  function mergeRecognizedItems(current, next) {
    const merged = { ...(current || {}) };
    Object.entries(next || {}).forEach(([key, value]) => {
      if (key === 'customMetrics') merged.customMetrics = { ...(merged.customMetrics || {}), ...(value || {}) };
      else if (isProvided(value)) merged[key] = value;
    });
    return merged;
  }

  async function importRecognizedRecords(items, importTarget = { mode: 'auto' }) {
    const viewDate = $('viewDate').value || today();
    const normalizedItems = (Array.isArray(items) ? items : []).map(normalizeRecognizedItem).filter(Boolean);
    const unmatched = []; const mergedByPerson = new Map();
    normalizedItems.forEach(item => {
      const person = matchSalespersonName(item.salespersonName);
      if (!person) { if (hasText(item.salespersonName)) unmatched.push(String(item.salespersonName).trim()); return; }
      mergedByPerson.set(person.id, { person, item: mergeRecognizedItems(mergedByPerson.get(person.id)?.item, item) });
    });
    const recognized = [...mergedByPerson.values()];
    const personIds = [...new Set(recognized.map(({ person }) => person?.id).filter(Boolean))];
    if (!personIds.length) throw new Error('檔案中沒有可與業務人員名單比對的姓名。請先建立或確認人員名單。');

    const { data: existingRows, error: existingError } = await sb.from('performance_entries').select('salesperson_id, projects').eq('view_date', viewDate).in('salesperson_id', personIds);
    if (existingError) throw existingError;
    const existingByPerson = new Map((existingRows || []).map(row => [row.salesperson_id, row]));
    const payloads = []; const skipped = [];

    recognized.forEach(({ item, person }) => {
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
        $('entryDialog').close(); showToast(message);
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
