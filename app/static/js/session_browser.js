$(document).ready(function() {
    const sb = { proxies: [], groups: [], gridApi: null, gridColumnApi: null };
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
        try { if (sb.gridApi && sb.gridApi.sizeColumnsToFit) { sb.gridApi.sizeColumnsToFit(); } } catch (e) { /* ignore */ }
    }

    function updateFilterCount() {
        if (!sb.gridApi) return;
        try {
            var filterModel = sb.gridApi.getFilterModel();
            var filterCount = 0;
            if (filterModel) {
                // 필터 모델에서 실제로 값이 있는 필터의 수를 계산
                for (var colId in filterModel) {
                    if (filterModel.hasOwnProperty(colId)) {
                        var filter = filterModel[colId];
                        // 필터가 있고 값이 있는지 확인
                        if (filter && typeof filter === 'object') {
                            // agTextColumnFilter의 경우 filter 속성 확인
                            if (filter.filter && String(filter.filter).trim() !== '') {
                                filterCount++;
                            }
                            // agNumberColumnFilter의 경우 filter, filterTo, filterTo 등 확인
                            else if (filter.filter !== undefined && filter.filter !== null && filter.filter !== '') {
                                filterCount++;
                            }
                            else if (filter.filterTo !== undefined && filter.filterTo !== null && filter.filterTo !== '') {
                                filterCount++;
                            }
                            else if (filter.type && filter.type !== 'equals') {
                                // 다른 필터 타입들
                                filterCount++;
                            }
                        }
                    }
                }
            }
            var $filterCount = $('#sbFilterCount');
            if (filterCount > 0) {
                $filterCount.text('필터: ' + filterCount).show();
            } else {
                $filterCount.hide();
            }
        } catch (e) {
            console.error('Failed to update filter count:', e);
        }
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
        var groupVal;
        try {
            var gEl = $('#sbGroupSelect')[0];
            if (gEl && gEl._tom && typeof gEl._tom.getValue === 'function') { groupVal = gEl._tom.getValue(); }
            else { groupVal = $('#sbGroupSelect').val() || ''; }
        } catch (e) { groupVal = $('#sbGroupSelect').val() || ''; }
        var state = {
            groupId: groupVal || '',
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
                var $g = $('#sbGroupSelect');
                var gtom = ($g && $g[0]) ? $g[0]._tom : null;
                if (gtom && typeof gtom.setValue === 'function') {
                    try { gtom.setValue(String(state.groupId || ''), false); } catch (e) { /* ignore */ }
                    try { $g.trigger('change'); } catch (e) { /* ignore */ }
                } else {
                    $g.val(state.groupId);
                    // Trigger change so DeviceSelector repopulates proxies for selected group
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
            // Do not restore cached items; rely on server-side data to persist last load
        } catch (e) { /* ignore */ }
    }

    function showLoading() {
        $('#sbLoadingIndicator').show();
    }

    function hideLoading() {
        $('#sbLoadingIndicator').hide();
    }

    function loadGridData() {
        var proxyIds = getSelectedProxyIds();
        if (proxyIds.length === 0) {
            if (sb.gridApi) {
                // Server-side model: refresh to clear data
                if (sb.gridApi.refreshServerSide) {
                    sb.gridApi.refreshServerSide({ purge: true });
                } else {
                    sb.gridApi.setGridOption('rowData', []);
                }
            }
            hideLoading();
            return;
        }

        // Server-side model: refresh to reload data
        if (sb.gridApi && sb.gridApi.refreshServerSide) {
            sb.gridApi.refreshServerSide({ purge: true });
        }
    }

    function initTable() {
        if (sb.gridApi) return;
        try {
            var gridOptions = {
                columnDefs: AgGridConfig.getSessionBrowserColumns(),
                defaultColDef: {
                    sortable: true,
                    filter: 'agTextColumnFilter',
                    filterParams: { applyButton: true, clearButton: true },
                    resizable: true,
                    minWidth: 100
                },
                rowModelType: 'serverSide',
                serverSideInfiniteScroll: false,
                cacheBlockSize: 100,
                pagination: true,
                paginationPageSize: 100,
                enableFilter: true,
                enableSorting: true,
                animateRows: false,
                suppressRowClickSelection: false,
                headerHeight: 50,
                overlayNoRowsTemplate: '<div style="padding: 20px; text-align: center; color: var(--color-text-muted);">표시할 세션이 없습니다.<br><small style="margin-top: 8px; display: block;">프록시를 선택하고 "세션 불러오기" 버튼을 클릭하세요.</small></div>',
                getRows: function(params) {
                    // Server-side data loading
                    var proxyIds = getSelectedProxyIds();
                    if (proxyIds.length === 0) {
                        params.success({ rowData: [], rowCount: 0 });
                        return;
                    }

                    showLoading();
                    
                    // Build request parameters
                    var requestParams = {
                        startRow: params.request.startRow || 0,
                        endRow: (params.request.startRow || 0) + (params.request.endRow || 100),
                        proxy_ids: proxyIds.join(',')
                    };
                    
                    // Add sorting
                    if (params.request.sortModel && params.request.sortModel.length > 0) {
                        requestParams.sortModel = JSON.stringify(params.request.sortModel);
                    }
                    
                    // Add filtering
                    if (params.request.filterModel && Object.keys(params.request.filterModel).length > 0) {
                        requestParams.filterModel = JSON.stringify(params.request.filterModel);
                    }
                    
                    // Add quick filter
                    if (params.request.quickFilterText) {
                        requestParams.quickFilterText = params.request.quickFilterText;
                    }
                    
                    $.ajax({
                        url: '/api/session-browser/datatables',
                        method: 'GET',
                        data: requestParams
                    }).done(function(response) {
                        hideLoading();
                        params.success({
                            rowData: response.rowData || [],
                            rowCount: response.rowCount || 0
                        });
                        updateFilterCount();
                    }).fail(function() {
                        hideLoading();
                        params.fail();
                    });
                },
                onGridReady: function(params) {
                    sb.gridApi = params.api;
                    if (params.columnApi) {
                        sb.gridColumnApi = params.columnApi;
                    }
                    // 컬럼 너비 자동 조절 (헤더 텍스트가 잘리지 않도록)
                    setTimeout(function() {
                        if (sb.gridApi) {
                            var allColumnIds = [];
                            sb.gridApi.getColumns().forEach(function(column) {
                                if (column.getColDef().field !== 'id') {
                                    allColumnIds.push(column.getColId());
                                }
                            });
                            if (sb.gridApi.autoSizeColumns) {
                                // 헤더 텍스트를 기준으로 자동 크기 조절
                                sb.gridApi.autoSizeColumns(allColumnIds, { skipHeader: false });
                            } else if (sb.gridApi.sizeColumnsToFit) {
                                sb.gridApi.sizeColumnsToFit();
                            }
                        }
                    }, 200);
                    updateTableVisibility();
                    // 초기 데이터 로드
                    loadGridData();
                },
                onRowDoubleClicked: function(params) {
                    var itemId = params.data.id;
                    if (!itemId) return;
                    $.getJSON('/api/session-browser/item/' + itemId)
                        .done(function(item){ fillDetailModal(item || {}); openSbModal(); })
                        .fail(function(){ showErr('상세를 불러오지 못했습니다.'); });
                },
                onFilterChanged: function() {
                    // 필터 변경 시 서버 사이드에서 처리되므로 로딩만 표시
                    showLoading();
                    updateFilterCount();
                }
            };

            var gridDiv = document.querySelector('#sbTableGrid');
            if (gridDiv && window.agGrid) {
                if (typeof window.agGrid.createGrid === 'function') {
                    sb.gridApi = window.agGrid.createGrid(gridDiv, gridOptions);
                } else if (window.agGrid.Grid) {
                    new window.agGrid.Grid(gridDiv, gridOptions);
                }
            }
        } catch (e) {
            console.error('ag-grid init failed:', e);
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
            // On collect, reload grid data
            loadGridData();
            $('#sbEmptyState').hide();
            $('#sbTableWrap').show();
            if (res && res.failed && res.failed > 0) { showErr('일부 프록시 수집에 실패했습니다.'); }
            setStatus('완료');
            // Clear any cached items to avoid mixing old data on next restore; persist only selection
            saveState([]);
            // 자동 분석 제거 - 통계 분석 버튼으로 대체
        }).catch(() => { setStatus('오류', true); showErr('수집 요청 중 오류가 발생했습니다.'); });
    }

    $('#sbLoadBtn').on('click', function() { loadLatest(); });
    
    // 통계 분석 버튼 클릭 이벤트
    $('#sbAnalyzeBtn').on('click', function() {
        const proxyIds = getSelectedProxyIds();
        if (proxyIds.length === 0) {
            showErr('프록시를 하나 이상 선택하세요.');
            return;
        }
        try {
            if (window.SbAnalyze && typeof window.SbAnalyze.run === 'function') {
                window.SbAnalyze.run({ proxyIds: proxyIds });
                $('#sbAnalyzeSection').show();
            } else {
                showErr('분석 기능을 사용할 수 없습니다.');
            }
        } catch (e) {
            console.error('Analysis error:', e);
            showErr('분석 중 오류가 발생했습니다.');
        }
    });
    // Removed analyze button and tabs; analysis auto-runs after collect
    $('#sbExportBtn').on('click', function() {
        const params = {};
        const g = $('#sbGroupSelect').val();
        if (g) params.group_id = g;
        const pids = ($('#sbProxySelect').val() || []).join(',');
        if (pids) params.proxy_ids = pids;
        // Get quick filter from ag-grid if available
        if (sb.gridApi) {
            const quickFilter = sb.gridApi.getQuickFilter();
            if (quickFilter) params['search[value]'] = quickFilter;
            // Get sort model
            const sortModel = sb.gridApi.getSortModel();
            if (sortModel && sortModel.length > 0) {
                // Convert ag-grid sort model to DataTables format for export endpoint
                const colMapping = { 'host': 0, 'creation_time': 1, 'protocol': 2, 'user_name': 3, 'client_ip': 4, 'server_ip': 5, 'cl_bytes_received': 6, 'cl_bytes_sent': 7, 'age_seconds': 8, 'url': 9 };
                const colId = sortModel[0].colId;
                const colIdx = colMapping[colId];
                if (colIdx !== undefined) {
                    params['order[0][column]'] = colIdx;
                    params['order[0][dir]'] = sortModel[0].sort === 'desc' ? 'desc' : 'asc';
                }
            }
        }
        const qs = $.param(params);
        const url = '/api/session-browser/export' + (qs ? ('?' + qs) : '');
        // open in new tab to trigger download without blocking UI
        window.open(url, '_blank');
    });
    // Quick filter (전체 검색)
    $('#sbQuickFilter').on('input', function() {
        var filterText = $(this).val();
        if (sb.gridApi) {
            sb.gridApi.setGridOption('quickFilterText', filterText);
        }
    });
    
    // 필터 초기화 버튼
    $('#sbClearFilters').on('click', function() {
        if (sb.gridApi) {
            sb.gridApi.setFilterModel(null);
            sb.gridApi.setGridOption('quickFilterText', '');
            $('#sbQuickFilter').val('');
            updateFilterCount();
        }
    });
    
    $('#sbGroupSelect').on('change', function() {
        saveState(undefined);
        // 그룹 변경 시 그리드 데이터 다시 로드
        loadGridData();
    });
    $('#sbProxySelect').on('change', function() {
        saveState(undefined);
        // 프록시 선택 변경 시 그리드 데이터 다시 로드
        loadGridData();
    });

    initTable();
    // Always show table
    $('#sbTableWrap').show();
    DeviceSelector.init({ 
        groupSelect: '#sbGroupSelect', 
        proxySelect: '#sbProxySelect', 
        selectAll: '#sbSelectAll',
        allowAllGroups: false,
        onData: function(data){ 
            sb.groups = data.groups || []; 
            sb.proxies = data.proxies || [];
            console.log('[SessionBrowser] DeviceSelector onData - groups:', sb.groups.length, 'proxies:', sb.proxies.length);
            var activeProxies = sb.proxies.filter(function(p) { return p && p.is_active; });
            console.log('[SessionBrowser] Active proxies:', activeProxies.length);
            
            // 프록시가 없을 때 안내 메시지 표시
            if (!sb.proxies || sb.proxies.length === 0) {
                $('#sbError').text('프록시가 등록되어 있지 않습니다. 설정 > 프록시 관리에서 프록시를 등록하세요.').show();
            } else if (activeProxies.length === 0) {
                $('#sbError').text('활성화된 프록시가 없습니다. 설정 > 프록시 관리에서 프록시를 활성화하세요.').show();
            } else {
                $('#sbError').hide();
            }
        }
    }).then(function(){ 
        console.log('[SessionBrowser] DeviceSelector initialized');
        restoreState(); 
        // Grid가 준비되면 데이터 로드 (onGridReady에서 처리됨)
    }).catch(function(err) {
        console.error('[SessionBrowser] DeviceSelector init failed:', err);
        $('#sbError').text('프록시 목록을 불러오는 중 오류가 발생했습니다: ' + (err.message || String(err))).show();
    });

    // Cross-tab sync: update UI when other tabs modify stored state
    try {
        window.addEventListener('storage', function(e) {
            if (!e) return;
            if (e.key === STORAGE_KEY) {
                restoreState();
                loadGridData();
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

