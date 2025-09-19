$(document).ready(function() {
    const sb = { proxies: [], groups: [], dt: null, mode: undefined, tmpToken: null };

    // No local storage persistence (as requested)

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

    function saveState() { /* no-op */ }

    function restoreState() { /* no-op */ }

    function initTable() { ensureClientMode([]); }

    function destroyTable() {
        try { if (sb.dt && sb.dt.destroy) { sb.dt.destroy(); } } catch (e) { /* ignore */ }
        try { $('#sbTable').DataTable && $('#sbTable').DataTable().clear(); } catch (e) { /* ignore */ }
        sb.dt = null;
    }

    function ensureServerMode() { /* removed: server-side table not used */ }

    function ensureClientMode(rows) {
        destroyTable();
        sb.mode = undefined;
        try {
            sb.dt = TableConfig.init('#sbTable', {
                serverSide: false,
                data: Array.isArray(rows) ? rows : [],
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
                    { targets: 1, className: 'dt-nowrap' },
                    { targets: 3, className: 'dt-nowrap mono' },
                    { targets: 4, className: 'dt-nowrap mono' },
                    { targets: 5, className: 'dt-nowrap num' },
                    { targets: 6, className: 'dt-nowrap num' },
                    { targets: 7, className: 'dt-nowrap' },
                    { targets: 8, className: 'dt-nowrap dt-ellipsis', width: '480px' }
                ],
                createdRow: function(row, data) { $(row).attr('data-item-id', data[data.length - 1]); },
                drawCallback: function(){ updateTableVisibility(); }
            });
            sb.mode = 'client';
            setTimeout(function(){ TableConfig.adjustColumns(sb.dt); }, 0);
        } catch (e) { /* ignore */ }
    }

    // Removed unused rowsFromItems/currentItemsById

    function loadLatest() {
        clearErr();
        const proxyIds = getSelectedProxyIds();
        if (proxyIds.length === 0) { showErr('프록시를 하나 이상 선택하세요.'); return; }
        const deferSave = true;
        setStatus('수집 중...');
        return $.ajax({
            url: '/api/session-browser/collect',
            method: 'POST',
            contentType: 'application/json',
            data: JSON.stringify({ proxy_ids: proxyIds, defer_save: deferSave })
        }).then(res => {
            if (res && Array.isArray(res.rows)) {
                sb.tmpToken = res.tmp_token || null;
                ensureClientMode(res.rows);
                $('#sbEmptyState').hide();
                $('#sbTableWrap').show();
                setStatus('완료(' + res.rows.length + '건 표시)');
            } else {
                sb.tmpToken = null;
                $('#sbEmptyState').hide();
                $('#sbTableWrap').show();
            }
            if (res && res.failed && res.failed > 0) { showErr('일부 프록시 수집에 실패했습니다.'); }
            // Clear any cached items to avoid mixing old data on next restore; persist only selection
            saveState();
        }).catch(() => { setStatus('오류', true); showErr('수집 요청 중 오류가 발생했습니다.'); });
    }

    $('#sbLoadBtn').on('click', function() { loadLatest(); });
    $('#sbExportBtn').on('click', function() {
        const params = {};
        let url;
        if (sb.tmpToken) {
            url = '/api/session-browser/tmp/export?token=' + encodeURIComponent(sb.tmpToken);
        } else {
            const g = $('#sbGroupSelect').val();
            if (g) params.group_id = g;
            const pids = ($('#sbProxySelect').val() || []).join(',');
            if (pids) params.proxy_ids = pids;
            const searchVal = (sb.dt && sb.dt.search) ? (typeof sb.dt.search === 'function' ? sb.dt.search() : '') : '';
            if (searchVal) params['search[value]'] = searchVal;
            try {
                const order = sb.dt && sb.dt.order ? (typeof sb.dt.order === 'function' ? sb.dt.order() : []) : [];
                if (order && order.length > 0) {
                    params['order[0][column]'] = order[0][0];
                    params['order[0][dir]'] = order[0][1];
                }
            } catch (e) {}
            const qs = $.param(params);
            url = '/api/session-browser/export' + (qs ? ('?' + qs) : '');
        }
        // open in new tab to trigger download without blocking UI
        window.open(url, '_blank');
    });
    $('#sbGroupSelect').on('change', function() { /* no-op */ });
    $('#sbProxySelect').on('change', function() { /* no-op */ });

    // Row click -> open detail modal
    $('#sbTable tbody').on('click', 'tr', function() {
        const itemId = $(this).attr('data-item-id');
        if (!itemId) return;
        if (itemId.startsWith('tmp:')) {
            const parts = itemId.split(':');
            const token = parts[1];
            const idx = parts[2];
            $.getJSON(`/api/session-browser/tmp/item/${encodeURIComponent(token)}/${encodeURIComponent(idx)}`)
                .done(function(item){ fillDetailModal(item || {}); openSbModal(); })
                .fail(function(){ showErr('상세를 불러오지 못했습니다.'); });
        } else {
            // Fetch full row from backend to avoid relying on client cache
            $.getJSON(`/api/session-browser/item/${itemId}`)
                .done(function(item){ fillDetailModal(item || {}); openSbModal(); })
                .fail(function(){ showErr('상세를 불러오지 못했습니다.'); });
        }
    });

    initTable();
    // Show empty state initially
    $('#sbTableWrap').hide();
    $('#sbEmptyState').show();
    DeviceSelector.init({ 
        groupSelect: '#sbGroupSelect', 
        proxySelect: '#sbProxySelect', 
        selectAll: '#sbSelectAll',
        allowAllGroup: false,
        autoSelectOnGroupChange: true,
        enableSelectAll: true,
        onData: function(data){ sb.groups = data.groups || []; sb.proxies = data.proxies || []; }
    }).then(function(){ restoreState(); });

    // No cross-tab storage sync
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

