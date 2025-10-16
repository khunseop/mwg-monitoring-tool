$(document).ready(function() {
    const sb = { proxies: [], groups: [], gridApi: null };
    const STORAGE_KEY = 'sb_state_v1';

    function showErr(msg) { $('#sbError').text(msg).show(); }
    function clearErr() { $('#sbError').hide().text(''); }
    function setStatus(text, isError) {
        const $t = $('#sbStatus');
        $t.text(text || '');
        $t.removeClass('is-success is-danger is-light');
        if (isError) $t.addClass('is-danger'); else $t.addClass(text ? 'is-success' : 'is-light');
    }

    function getSelectedProxyIds() { return ($('#sbProxySelect').val() || []).map(v => parseInt(v, 10)); }

    function saveState() {
        var groupVal;
        try {
            var gEl = $('#sbGroupSelect')[0];
            if (gEl && gEl._tom && typeof gEl._tom.getValue === 'function') { groupVal = gEl._tom.getValue(); }
            else { groupVal = $('#sbGroupSelect').val() || ''; }
        } catch (e) { groupVal = $('#sbGroupSelect').val() || ''; }

        const state = {
            groupId: groupVal || '',
            proxyIds: getSelectedProxyIds(),
            savedAt: Date.now()
        };

        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
        } catch (e) {
            setStatus('로컬 저장 실패', true);
        }
    }

    function restoreState() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) return;
            const state = JSON.parse(raw);
            if (state.groupId !== undefined) {
                var $g = $('#sbGroupSelect');
                var gtom = ($g && $g[0]) ? $g[0]._tom : null;
                if (gtom && typeof gtom.setValue === 'function') {
                    try { gtom.setValue(String(state.groupId || ''), false); } catch (e) { /* ignore */ }
                    try { $g.trigger('change'); } catch (e) { /* ignore */ }
                } else {
                    $g.val(state.groupId);
                    $g.trigger('change');
                }
            }
            if (Array.isArray(state.proxyIds) && state.proxyIds.length > 0) {
                const strIds = state.proxyIds.map(function(id){ return String(id); });
                var $p = $('#sbProxySelect');
                var ptom = ($p && $p[0]) ? $p[0]._tom : null;
                if (ptom && typeof ptom.setValue === 'function') {
                    try { ptom.setValue(strIds, false); } catch (e) { /* ignore */ }
                } else {
                    $p.find('option').each(function() { $(this).prop('selected', strIds.indexOf($(this).val()) !== -1); });
                    try { $p.trigger('change'); } catch (e) { /* ignore */ }
                }
            }
        } catch (e) { /* ignore */ }
    }

    function initGrid() {
        if (sb.gridApi) return;

        const columnDefs = [
            { headerName: '프록시', field: 'host', filter: 'agTextColumnFilter', floatingFilter: true },
            { headerName: '생성시각', field: 'creation_time', valueFormatter: p => (window.AppUtils && AppUtils.formatDateTime) ? AppUtils.formatDateTime(p.value) : p.value, filter: 'agTextColumnFilter', floatingFilter: true },
            { headerName: '프로토콜', field: 'protocol', filter: 'agTextColumnFilter', floatingFilter: true },
            { headerName: '사용자', field: 'user_name', filter: 'agTextColumnFilter', floatingFilter: true },
            { headerName: '클라이언트 IP', field: 'client_ip', filter: 'agTextColumnFilter', floatingFilter: true },
            { headerName: '서버 IP', field: 'server_ip', filter: 'agTextColumnFilter', floatingFilter: true },
            { headerName: 'CL 수신', field: 'cl_bytes_received', type: 'numericColumn', valueFormatter: p => (window.AppUtils && AppUtils.formatBytes) ? AppUtils.formatBytes(p.value) : p.value, filter: 'agNumberColumnFilter', floatingFilter: true },
            { headerName: 'CL 송신', field: 'cl_bytes_sent', type: 'numericColumn', valueFormatter: p => (window.AppUtils && AppUtils.formatBytes) ? AppUtils.formatBytes(p.value) : p.value, filter: 'agNumberColumnFilter', floatingFilter: true },
            { headerName: 'Age(s)', field: 'age_seconds', type: 'numericColumn', valueFormatter: p => (window.AppUtils && AppUtils.formatSeconds) ? AppUtils.formatSeconds(p.value) : p.value, filter: 'agNumberColumnFilter', floatingFilter: true },
            { headerName: 'URL', field: 'url', tooltipField: 'url', filter: 'agTextColumnFilter', floatingFilter: true, width: 480 },
            { field: 'id', hide: true }
        ];

        const gridOptions = {
            columnDefs: columnDefs,
            rowModelType: 'serverSide',
            serverSideDatasource: createServerSideDatasource(),
            pagination: true,
            paginationPageSize: 100,
            cacheBlockSize: 100,
            onCellClicked: (event) => {
                const itemId = event.data.id;
                if (!itemId) return;
                $.getJSON(`/api/session-browser/item/${itemId}`)
                    .done(function(item){ fillDetailModal(item || {}); openSbModal(); })
                    .fail(function(){ showErr('상세를 불러오지 못했습니다.'); });
            },
            defaultColDef: {
                sortable: true,
                resizable: true,
                suppressHeaderMenuButton: true,
            },
            onGridReady: (params) => {
                sb.gridApi = params.api;
            }
        };

        const gridDiv = document.querySelector('#sbTableWrap');
        agGrid.createGrid(gridDiv, gridOptions);
    }

    function createServerSideDatasource() {
        return {
            getRows: (params) => {
                const pids = getSelectedProxyIds().join(',');
                if (!pids) {
                    params.successCallback({ rowData: [], rowCount: 0 });
                    return;
                }
                const request = {
                    startRow: params.request.startRow,
                    endRow: params.request.endRow,
                    sortModel: params.request.sortModel,
                    filterModel: params.request.filterModel,
                    proxy_ids: pids
                };

                $.ajax({
                    url: '/api/session-browser/ag-grid',
                    method: 'POST',
                    contentType: 'application/json',
                    data: JSON.stringify(request),
                    success: function(response) {
                        params.successCallback({
                            rowData: response.rows,
                            rowCount: response.rowCount
                        });
                    },
                    error: function() {
                        params.failCallback();
                    }
                });
            }
        };
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
            if (sb.gridApi) {
                sb.gridApi.setDatasource(createServerSideDatasource());
            }
            if (res && res.failed && res.failed > 0) { showErr('일부 프록시 수집에 실패했습니다.'); }
            setStatus('완료');
            saveState();
            try { if (window.SbAnalyze && typeof window.SbAnalyze.run === 'function') { window.SbAnalyze.run({ proxyIds: proxyIds }); $('#sbAnalyzeSection').show(); } } catch (e) { /* ignore */ }
        }).catch(() => { setStatus('오류', true); showErr('수집 요청 중 오류가 발생했습니다.'); });
    }

    $('#sbLoadBtn').on('click', function() { loadLatest(); });
    $('#sbExportBtn').on('click', function() {
        const params = {};
        const pids = getSelectedProxyIds().join(',');
        if (pids) params.proxy_ids = pids;

        if (sb.gridApi) {
            const sortModel = sb.gridApi.getSortModel();
            if (sortModel && sortModel.length > 0) {
                params['order[0][column]'] = sortModel[0].colId; // Adapt to old export format if needed
                params['order[0][dir]'] = sortModel[0].sort;
            }
            const filterModel = sb.gridApi.getFilterModel();
            let searchVal = [];
            for (const col in filterModel) {
                searchVal.push(filterModel[col].filter);
            }
            if (searchVal.length > 0) params['search[value]'] = searchVal.join(' ');
        }

        const qs = $.param(params);
        const url = '/api/session-browser/export' + (qs ? ('?' + qs) : '');
        window.open(url, '_blank');
    });

    $('#sbGroupSelect').on('change', function() { saveState(); });
    $('#sbProxySelect').on('change', function() { saveState(); });

    initGrid();
    DeviceSelector.init({ 
        groupSelect: '#sbGroupSelect', 
        proxySelect: '#sbProxySelect', 
        selectAll: '#sbSelectAll',
        allowAllGroups: false,
        onData: function(data){ sb.groups = data.groups || []; sb.proxies = data.proxies || []; }
    }).then(function(){
        restoreState();
        if (sb.gridApi) {
            sb.gridApi.setDatasource(createServerSideDatasource());
        }
    });

    try {
        window.addEventListener('storage', function(e) {
            if (!e) return;
            if (e.key === STORAGE_KEY) {
                restoreState();
                if (sb.gridApi) {
                    sb.gridApi.setDatasource(createServerSideDatasource());
                }
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