$(document).ready(function() {
    const sb = { proxies: [], groups: [], dt: null };
    const STORAGE_KEY = 'sb_state_v1';

    function showErr(msg) { $('#sbError').text(msg).show(); }
    function clearErr() { $('#sbError').hide().text(''); }
    function setStatus(text, isError) {
        const $t = $('#sbStatus');
        $t.text(text || '');
        $t.removeClass('is-success is-danger is-light');
        if (isError) $t.addClass('is-danger'); else $t.addClass(text ? 'is-success' : 'is-light');
    }

    function fetchGroups() {
        return $.getJSON('/api/proxy-groups').then(data => {
            sb.groups = data || [];
            const $sel = $('#sbGroupSelect');
            $sel.empty();
            $sel.append('<option value="">전체</option>');
            sb.groups.forEach(g => { $sel.append(`<option value="${g.id}">${g.name}</option>`); });
        }).catch(() => { showErr('그룹 목록을 불러오지 못했습니다.'); });
    }

    function fetchProxies() {
        return $.getJSON('/api/proxies').then(data => {
            sb.proxies = data || [];
            renderProxySelect();
        }).catch(() => { showErr('프록시 목록을 불러오지 못했습니다.'); });
    }

    function renderProxySelect() {
        const selectedGroupId = $('#sbGroupSelect').val();
        const $sel = $('#sbProxySelect');
        $sel.empty();
        (sb.proxies || []).filter(p => {
            if (!p.is_active) return false;
            if (!selectedGroupId) return true;
            return String(p.group_id || '') === String(selectedGroupId);
        }).forEach(p => {
            const label = `${p.host}:${p.port}${p.group_name ? ' ('+p.group_name+')' : ''}`;
            $sel.append(`<option value="${p.id}">${label}</option>`);
        });
    }

    function getSelectedProxyIds() { return ($('#sbProxySelect').val() || []).map(v => parseInt(v, 10)); }

    function saveState(itemsForSave) {
        try {
            let prevItems;
            try {
                const prevRaw = localStorage.getItem(STORAGE_KEY);
                if (prevRaw) {
                    const prev = JSON.parse(prevRaw);
                    prevItems = Array.isArray(prev.items) ? prev.items : undefined;
                }
            } catch (e) { /* ignore */ }
            const state = {
                groupId: $('#sbGroupSelect').val() || '',
                proxyIds: getSelectedProxyIds(),
                items: Array.isArray(itemsForSave) ? itemsForSave : prevItems,
                savedAt: Date.now()
            };
            localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
        } catch (e) { /* ignore */ }
    }

    function restoreState() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) return;
            const state = JSON.parse(raw);
            if (state.groupId !== undefined) {
                $('#sbGroupSelect').val(state.groupId);
                renderProxySelect();
            }
            if (Array.isArray(state.proxyIds)) {
                const strIds = state.proxyIds.map(id => String(id));
                $('#sbProxySelect option').each(function() {
                    $(this).prop('selected', strIds.includes($(this).val()));
                });
            }
            if (Array.isArray(state.items) && state.items.length > 0) {
                // Show table before initializing to allow correct width calc
                $('#sbEmptyState').hide();
                $('#sbTableWrap').show();
                initTable();
                const rows = rowsFromItems(state.items);
                if (sb.dt && sb.dt.clear) {
                    sb.dt.clear().rows.add(rows).draw(false);
                    try { if (sb.dt.columns && sb.dt.columns.adjust) { sb.dt.columns.adjust(); } } catch (e) {}
                }
                setStatus('저장된 내역');
            }
        } catch (e) { /* ignore */ }
    }

    function initTable() {
        if (sb.dt) return;
        try {
            if (typeof DataTable === 'function') {
                sb.dt = new DataTable('#sbTable', {
                    paging: true,
                    searching: true,
                    ordering: true,
                    info: true,
                    responsive: false,
                    scrollX: true,
                    scrollY: 480,
                    scrollCollapse: true,
                    pageLength: 25,
                    language: {
                        search: '검색:',
                        lengthMenu: '_MENU_ 개씩 보기',
                        info: '총 _TOTAL_건 중 _START_–_END_',
                        infoEmpty: '표시할 항목 없음',
                        zeroRecords: '일치하는 항목이 없습니다.',
                        paginate: { first: '처음', last: '마지막', next: '다음', previous: '이전' }
                    },
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
                        { targets: 8, className: 'dt-nowrap', width: '480px' }
                    ],
                    createdRow: function(row, data) { $(row).attr('data-item-id', data[data.length - 1]); }
                });
                // Adjust columns after initialization
                setTimeout(function(){ try { if (sb.dt && sb.dt.columns && sb.dt.columns.adjust) { sb.dt.columns.adjust(); } } catch (e) {} }, 0);
            } else if ($ && $.fn && $.fn.DataTable) {
                sb.dt = $('#sbTable').DataTable({
                    paging: true,
                    searching: true,
                    ordering: true,
                    info: true,
                    responsive: false,
                    scrollX: true,
                    scrollY: 480,
                    scrollCollapse: true,
                    pageLength: 25,
                    language: {
                        search: '검색:',
                        lengthMenu: '_MENU_ 개씩 보기',
                        info: '총 _TOTAL_건 중 _START_–_END_',
                        infoEmpty: '표시할 항목 없음',
                        zeroRecords: '일치하는 항목이 없습니다.',
                        paginate: { first: '처음', last: '마지막', next: '다음', previous: '이전' }
                    },
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
                    columnDefs: [ { targets: -1, visible: false, searchable: false }, { targets: 0, className: 'dt-nowrap' }, { targets: 1, className: 'dt-nowrap' }, { targets: 8, className: 'dt-nowrap', width: '480px' } ],
                    createdRow: function(row, data) { $(row).attr('data-item-id', data[data.length - 1]); }
                });
                // Adjust columns after initialization
                setTimeout(function(){ try { if (sb.dt && sb.dt.columns && sb.dt.columns.adjust) { sb.dt.columns.adjust(); } } catch (e) {} }, 0);
            }
        } catch (e) {
            // Ignore DataTables init failures; selection UI will still work
        }
    }

    let currentItemsById = {};
    function rowsFromItems(items) {
        currentItemsById = {};
        return (items || []).map(row => {
            if (row && typeof row.id !== 'undefined') { currentItemsById[String(row.id)] = row; }
            const proxy = (sb.proxies || []).find(p => p.id === row.proxy_id);
            const name = proxy ? `${proxy.host}:${proxy.port}` : `#${row.proxy_id}`;
            const ctStr = row.creation_time ? new Date(row.creation_time).toLocaleString() : '';
            const clRecv = (typeof row.cl_bytes_received === 'number') ? String(row.cl_bytes_received) : '';
            const clSent = (typeof row.cl_bytes_sent === 'number') ? String(row.cl_bytes_sent) : '';
            const urlFull = (row.url || '').toString();
            const urlShort = urlFull.length > 100 ? (urlFull.slice(0, 100) + '…') : urlFull;
            const ageStr = (typeof row.age_seconds === 'number' && row.age_seconds >= 0) ? String(row.age_seconds) : '';
            return [
                name,
                ctStr,
                row.user_name || '',
                row.client_ip || '',
                row.server_ip || '',
                clRecv,
                clSent,
                ageStr,
                urlShort,
                row.id || ''
            ];
        });
    }

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
            const items = res && res.items ? res.items : [];
            const rows = rowsFromItems(items);
            if (sb.dt) {
                sb.dt.clear();
                if (rows.length > 0) { sb.dt.rows.add(rows).draw(); }
                else { sb.dt.draw(); }
                try { if (sb.dt && sb.dt.columns && sb.dt.columns.adjust) { sb.dt.columns.adjust(); } } catch (e) {}
            }
            // Toggle empty/table state
            if (rows.length === 0) { $('#sbTableWrap').hide(); $('#sbEmptyState').show(); }
            else { $('#sbEmptyState').hide(); $('#sbTableWrap').show(); try { if (sb.dt && sb.dt.columns && sb.dt.columns.adjust) { sb.dt.columns.adjust(); } } catch (e) {} }
            if (res && res.failed && res.failed > 0) { showErr('일부 프록시 수집에 실패했습니다.'); }
            setStatus('완료');
            // persist current state and items (do not clear items when empty)
            if (res && Array.isArray(res.items)) { saveState(res.items); }
        }).catch(() => { setStatus('오류', true); showErr('수집 요청 중 오류가 발생했습니다.'); });
    }

    $('#sbLoadBtn').on('click', function() { loadLatest(); });
    $('#sbGroupSelect').on('change', function() { renderProxySelect(); saveState(undefined); });
    $('#sbSelectAll').on('change', function() {
        const checked = $(this).is(':checked');
        $('#sbProxySelect option').prop('selected', checked);
        // keep items; just persist selection/group
        saveState(undefined);
    });
    $('#sbProxySelect').on('change', function() { saveState(undefined); });

    // Row click -> open detail modal
    $('#sbTable tbody').on('click', 'tr', function() {
        const itemId = $(this).attr('data-item-id');
        if (!itemId) return;
        const item = currentItemsById[String(itemId)];
        if (!item) return;
        fillDetailModal(item);
        openSbModal();
    });

    initTable();
    // Show empty state initially
    $('#sbTableWrap').hide();
    $('#sbEmptyState').show();
    Promise.all([fetchGroups(), fetchProxies()]).then(() => { restoreState(); });
});

function openSbModal(){ $('#sbDetailModal').addClass('is-active'); }
function fillDetailModal(item){
    const rows = [];
    const kv = (k,v) => `<tr><th style="white-space:nowrap;">${k}</th><td>${(v===null||v===undefined)?'':String(v)}</td></tr>`;
    rows.push(kv('프록시 ID', item.proxy_id));
    rows.push(kv('트랜잭션', item.transaction));
    rows.push(kv('생성시각', item.creation_time ? new Date(item.creation_time).toLocaleString() : ''));
    rows.push(kv('프로토콜', item.protocol));
    rows.push(kv('사용자', item.user_name));
    rows.push(kv('Cust ID', item.cust_id));
    rows.push(kv('클라이언트 IP', item.client_ip));
    rows.push(kv('Client-side MWG IP', item.client_side_mwg_ip));
    rows.push(kv('Server-side MWG IP', item.server_side_mwg_ip));
    rows.push(kv('서버 IP', item.server_ip));
    rows.push(kv('클라이언트 수신(Bytes)', item.cl_bytes_received));
    rows.push(kv('클라이언트 송신(Bytes)', item.cl_bytes_sent));
    rows.push(kv('서버 수신(Bytes)', item.srv_bytes_received));
    rows.push(kv('서버 송신(Bytes)', item.srv_bytes_sent));
    rows.push(kv('Trxn Index', item.trxn_index));
    rows.push(kv('Age(s)', item.age_seconds));
    rows.push(kv('상태', item.status));
    rows.push(kv('In Use', item.in_use));
    rows.push(kv('URL', item.url));
    rows.push(kv('수집시각', item.collected_at ? new Date(item.collected_at).toLocaleString() : ''));
    rows.push(kv('원본', item.raw_line));
    $('#sbDetailBody').html(rows.join(''));
}

