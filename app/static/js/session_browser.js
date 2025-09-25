$(document).ready(function() {
    const sb = { proxies: [], groups: [], dt: null };
    const STORAGE_KEY = 'sb_state_v1';

    // Helpers for robust localStorage persistence
    function sanitizeItemsForStorage(items) {
        // Drop heavy fields and bound array length to avoid quota errors
        const MAX_ITEMS = 250; // keep most recent up to 250
        const trimmed = Array.isArray(items) ? items.slice(0, MAX_ITEMS) : [];
        return trimmed.map(function(it) {
            if (!it || typeof it !== 'object') return {};
            const out = {
                id: it.id,
                proxy_id: it.proxy_id,
                creation_time: it.creation_time,
                user_name: it.user_name,
                client_ip: it.client_ip,
                server_ip: it.server_ip,
                cl_bytes_received: it.cl_bytes_received,
                cl_bytes_sent: it.cl_bytes_sent,
                age_seconds: it.age_seconds,
                url: (typeof it.url === 'string') ? (it.url.length > 1000 ? it.url.slice(0, 1000) + '…' : it.url) : it.url,
                collected_at: it.collected_at,
                transaction: it.transaction,
                protocol: it.protocol,
                cust_id: it.cust_id,
                client_side_mwg_ip: it.client_side_mwg_ip,
                server_side_mwg_ip: it.server_side_mwg_ip,
                srv_bytes_received: it.srv_bytes_received,
                srv_bytes_sent: it.srv_bytes_sent,
                trxn_index: it.trxn_index,
                status: it.status,
                in_use: it.in_use
            };
            return out;
        });
    }

    function tryWriteState(state) {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
            return true;
        } catch (e) {
            return false;
        }
    }

    function persistState(state) {
        // Attempt to persist; if it fails due to quota, progressively reduce items size
        if (tryWriteState(state)) return true;
        if (!state || !Array.isArray(state.items) || state.items.length === 0) return false;
        // First, sanitize items by dropping heavy fields
        var reduced = sanitizeItemsForStorage(state.items);
        var temp = Object.assign({}, state, { items: reduced });
        if (tryWriteState(temp)) return true;
        // If still failing, aggressively reduce count
        var count = Math.min(reduced.length, 120);
        while (count > 0) {
            var slice = reduced.slice(0, count);
            temp = Object.assign({}, state, { items: slice });
            if (tryWriteState(temp)) return true;
            count = Math.floor(count / 2);
        }
        return false;
    }

    function showErr(msg) { $('#sbError').text(msg).show(); }
    function clearErr() { $('#sbError').hide().text(''); }
    function setStatus(text, isError) {
        const $t = $('#sbStatus');
        $t.text(text || '');
        $t.removeClass('is-success is-danger is-light');
        if (isError) $t.addClass('is-danger'); else $t.addClass(text ? 'is-success' : 'is-light');
    }

    // Selection UI is now handled by shared DeviceSelector

    function getSelectedProxyIds() { return ($('#sbProxySelect').val() || []).map(v => parseInt(v, 10)); }

    function updateTableVisibility() {
        try {
            var $tbody = $('#sbTable tbody');
            var rowCount = $tbody.find('tr').length;
            var isEmpty = rowCount === 0 || ($tbody.find('td').first().hasClass('dataTables_empty'));
            if (isEmpty) { $('#sbTableWrap').hide(); $('#sbEmptyState').show(); }
            else { $('#sbEmptyState').hide(); $('#sbTableWrap').show(); try { if (sb.dt && sb.dt.columns && sb.dt.columns.adjust) { sb.dt.columns.adjust(); } } catch (e) {} }
        } catch (e) { /* ignore */ }
    }

    function saveState(itemsForSave) {
        var prevItems;
        try {
            var prevRaw = localStorage.getItem(STORAGE_KEY);
            if (prevRaw) {
                var prev = JSON.parse(prevRaw);
                prevItems = Array.isArray(prev.items) ? prev.items : undefined;
            }
        } catch (e) { /* ignore */ }
        // If itemsForSave is provided, use it as-is (including empty array to CLEAR)
        var items = (itemsForSave !== undefined) ? (Array.isArray(itemsForSave) ? itemsForSave : undefined) : prevItems;
        var state = {
            groupId: $('#sbGroupSelect').val() || '',
            proxyIds: getSelectedProxyIds(),
            items: items,
            savedAt: Date.now()
        };
        var ok = persistState(state);
        if (!ok) { try { setStatus('로컬 저장 실패', true); } catch (e) { /* ignore */ } }
    }

    function restoreState() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) return;
            const state = JSON.parse(raw);
            if (state.groupId !== undefined) {
                $('#sbGroupSelect').val(state.groupId);
                // Trigger change so DeviceSelector repopulates proxies for selected group
                $('#sbGroupSelect').trigger('change');
            }
            if (Array.isArray(state.proxyIds)) {
                const strIds = state.proxyIds.map(id => String(id));
                $('#sbProxySelect option').each(function() {
                    $(this).prop('selected', strIds.includes($(this).val()));
                });
            }
            // Do not restore cached items; rely on server-side data to persist last load
        } catch (e) { /* ignore */ }
    }

    function initTable() {
        if (sb.dt) return;
        try {
            var ajaxFn = function(data, callback) {
                // DataTables -> backend query params
                var params = {
                    draw: data.draw,
                    start: data.start,
                    length: data.length,
                };
                if (data.search && data.search.value) {
                    params['search[value]'] = data.search.value;
                }
                if (data.order && data.order.length > 0) {
                    params['order[0][column]'] = data.order[0].column;
                    params['order[0][dir]'] = data.order[0].dir;
                }
                var g = $('#sbGroupSelect').val();
                if (g) params.group_id = g;
                var pids = ($('#sbProxySelect').val() || []).join(',');
                if (pids) params.proxy_ids = pids;
                $.ajax({ url: '/api/session-browser/datatables', method: 'GET', data: params })
                    .done(function(res){ callback(res); })
                    .fail(function(){ callback({ draw: data.draw, recordsTotal: 0, recordsFiltered: 0, data: [] }); });
            };
            sb.dt = TableConfig.init('#sbTable', {
                serverSide: true,
                ajax: function(data, callback){ ajaxFn(data, callback); },
                drawCallback: function(){ updateTableVisibility(); },
                columns: [
                    { title: '프록시' },
                    { title: '생성시각' },
                    { title: '사용자' },
                    { title: '클라이언트 IP' },
                    { title: '서버 IP' },
                    { title: 'CL 수신' },
                    { title: 'CL 송신' },
                    { title: 'Age(s)' },
                    { title: 'URL' },
                    { title: 'id', visible: false }
                ],
                columnDefs: [
                    { targets: -1, visible: false, searchable: false },
                    { targets: 0, className: 'dt-nowrap' },
                    { targets: 1, className: 'dt-nowrap', render: function(data){ return (window.AppUtils && AppUtils.formatDateTime) ? AppUtils.formatDateTime(data) : data; } },
                    { targets: 3, className: 'dt-nowrap mono' },
                    { targets: 4, className: 'dt-nowrap mono' },
                    { targets: 5, className: 'dt-nowrap num', render: function(data){ return (window.AppUtils && AppUtils.formatBytes) ? AppUtils.formatBytes(data) : data; } },
                    { targets: 6, className: 'dt-nowrap num', render: function(data){ return (window.AppUtils && AppUtils.formatBytes) ? AppUtils.formatBytes(data) : data; } },
                    { targets: 7, className: 'dt-nowrap', render: function(data){ return (window.AppUtils && AppUtils.formatSeconds) ? AppUtils.formatSeconds(data) : data; } },
                    { targets: 8, className: 'dt-nowrap dt-ellipsis', width: '480px' }
                ],
                createdRow: function(row, data) { $(row).attr('data-item-id', data[data.length - 1]); }
            });
            setTimeout(function(){ TableConfig.adjustColumns(sb.dt); }, 0);
        } catch (e) {
            // Ignore DataTables init failures; selection UI will still work
        }
    }

    // Removed unused rowsFromItems/currentItemsById

    function loadLatest() {
        clearErr();
        const proxyIds = getSelectedProxyIds();
        if (proxyIds.length === 0) { showErr('프록시를 하나 이상 선택하세요.'); return; }
        setStatus('수집 중...');
        return $.ajax({
            url: '/api/session-browser/collect',
            method: 'POST',
            contentType: 'application/json',
            data: JSON.stringify({ proxy_ids: proxyIds })
        }).then(res => {
            // On collect, simply reload table from DB via server-side ajax
            if (sb.dt && sb.dt.ajax) { sb.dt.ajax.reload(null, false); }
            $('#sbEmptyState').hide();
            $('#sbTableWrap').show();
            if (res && res.failed && res.failed > 0) { showErr('일부 프록시 수집에 실패했습니다.'); }
            setStatus('완료');
            // Clear any cached items to avoid mixing old data on next restore; persist only selection
            saveState([]);
            try { if (window.SbAnalyze && typeof window.SbAnalyze.run === 'function') { window.SbAnalyze.run({ proxyIds: proxyIds }); $('#sbAnalyzeSection').show(); } } catch (e) { /* ignore */ }
        }).catch(() => { setStatus('오류', true); showErr('수집 요청 중 오류가 발생했습니다.'); });
    }

    $('#sbLoadBtn').on('click', function() { loadLatest(); });
    // Removed analyze button and tabs; analysis auto-runs after collect
    $('#sbExportBtn').on('click', function() {
        const params = {};
        const g = $('#sbGroupSelect').val();
        if (g) params.group_id = g;
        const pids = ($('#sbProxySelect').val() || []).join(',');
        if (pids) params.proxy_ids = pids;
        const searchVal = (sb.dt && sb.dt.search) ? (typeof sb.dt.search === 'function' ? sb.dt.search() : '') : '';
        if (searchVal) params['search[value]'] = searchVal;
        // carry over ordering
        try {
            const order = sb.dt && sb.dt.order ? (typeof sb.dt.order === 'function' ? sb.dt.order() : []) : [];
            if (order && order.length > 0) {
                params['order[0][column]'] = order[0][0];
                params['order[0][dir]'] = order[0][1];
            }
        } catch (e) {}
        const qs = $.param(params);
        const url = '/api/session-browser/export' + (qs ? ('?' + qs) : '');
        // open in new tab to trigger download without blocking UI
        window.open(url, '_blank');
    });
    $('#sbGroupSelect').on('change', function() { saveState(undefined); if (sb.dt && sb.dt.ajax) sb.dt.ajax.reload(null, true); });
    $('#sbProxySelect').on('change', function() { saveState(undefined); if (sb.dt && sb.dt.ajax) sb.dt.ajax.reload(null, true); });

    // Row click -> open detail modal
    $('#sbTable tbody').on('click', 'tr', function() {
        const itemId = $(this).attr('data-item-id');
        if (!itemId) return;
        // Fetch full row from backend to avoid relying on client cache
        $.getJSON(`/api/session-browser/item/${itemId}`)
            .done(function(item){ fillDetailModal(item || {}); openSbModal(); })
            .fail(function(){ showErr('상세를 불러오지 못했습니다.'); });
    });

    initTable();
    // Show empty state initially
    $('#sbTableWrap').hide();
    $('#sbEmptyState').show();
    DeviceSelector.init({ 
        groupSelect: '#sbGroupSelect', 
        proxySelect: '#sbProxySelect', 
        selectAll: '#sbSelectAll',
        allowAllGroups: false,
        onData: function(data){ sb.groups = data.groups || []; sb.proxies = data.proxies || []; }
    }).then(function(){ restoreState(); if (sb.dt && sb.dt.ajax) sb.dt.ajax.reload(null, true); });

    // Cross-tab sync: update UI when other tabs modify stored state
    try {
        window.addEventListener('storage', function(e) {
            if (!e) return;
            if (e.key === STORAGE_KEY) {
                restoreState();
                if (sb.dt && sb.dt.ajax) sb.dt.ajax.reload(null, false);
            }
        });
    } catch (e) { /* ignore */ }
});

function openSbModal(){ $('#sbDetailModal').addClass('is-active'); }
function fillDetailModal(item){
    const rows = [];
    const kv = (k,v,cls) => `<tr><th style="white-space:nowrap;">${k}</th><td class="${cls||''}">${(v===null||v===undefined)?'':String(v)}</td></tr>`;
    rows.push(kv('프록시 ID', item.proxy_id));
    rows.push(kv('트랜잭션', item.transaction, 'mono'));
    rows.push(kv('생성시각', (window.AppUtils && AppUtils.formatDateTime) ? AppUtils.formatDateTime(item.creation_time) : (item.creation_time ? new Date(item.creation_time).toLocaleString() : '')));
    rows.push(kv('프로토콜', item.protocol));
    rows.push(kv('사용자', item.user_name));
    rows.push(kv('Cust ID', item.cust_id));
    rows.push(kv('클라이언트 IP', item.client_ip, 'mono'));
    rows.push(kv('Client-side MWG IP', item.client_side_mwg_ip, 'mono'));
    rows.push(kv('Server-side MWG IP', item.server_side_mwg_ip, 'mono'));
    rows.push(kv('서버 IP', item.server_ip, 'mono'));
    rows.push(kv('클라이언트 수신(Bytes)', (window.AppUtils && AppUtils.formatBytes) ? AppUtils.formatBytes(item.cl_bytes_received) : item.cl_bytes_received, 'num'));
    rows.push(kv('클라이언트 송신(Bytes)', (window.AppUtils && AppUtils.formatBytes) ? AppUtils.formatBytes(item.cl_bytes_sent) : item.cl_bytes_sent, 'num'));
    rows.push(kv('서버 수신(Bytes)', (window.AppUtils && AppUtils.formatBytes) ? AppUtils.formatBytes(item.srv_bytes_received) : item.srv_bytes_received, 'num'));
    rows.push(kv('서버 송신(Bytes)', (window.AppUtils && AppUtils.formatBytes) ? AppUtils.formatBytes(item.srv_bytes_sent) : item.srv_bytes_sent, 'num'));
    rows.push(kv('Trxn Index', item.trxn_index));
    rows.push(kv('Age(s)', (window.AppUtils && AppUtils.formatSeconds) ? AppUtils.formatSeconds(item.age_seconds) : item.age_seconds));
    rows.push(kv('상태', item.status));
    rows.push(kv('In Use', (window.AppUtils && AppUtils.renderBoolTag) ? AppUtils.renderBoolTag(item.in_use) : (item.in_use ? 'Y' : 'N')));
    rows.push(kv('URL', item.url));
    rows.push(kv('수집시각', (window.AppUtils && AppUtils.formatDateTime) ? AppUtils.formatDateTime(item.collected_at) : (item.collected_at ? new Date(item.collected_at).toLocaleString() : '')));
    rows.push(kv('원본', item.raw_line));
    $('#sbDetailBody').html(rows.join(''));
}

