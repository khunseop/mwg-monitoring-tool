(function() {
    'use strict';

    const sb = {
        groups: [],
        proxies: [],
        records: [],
        gridApi: null,
        columnApi: null,
        isRestoring: false,
        storageKey: 'sb_state_v1',
        exportLimit: 10000,
        analyzeStatus: 'idle'
    };

    const COLS = [
        "id", "proxy_id", "client_ip", "client_port", "server_ip", "server_port",
        "protocol", "status", "user_agent", "url", "received_bytes", "sent_bytes",
        "duration", "created_at"
    ];

    function setStatus(text, cls) {
        const $tag = $('#sbStatus');
        $tag.text(text);
        $tag.removeClass().addClass('tag').addClass(cls || 'is-light');
    }

    function showError(msg) {
        $('#sbError').text(msg).show();
    }

    function clearError() {
        $('#sbError').hide().text('');
    }

    function showDetail(record) {
        const $body = $('#sbDetailBody');
        $body.empty();
        COLS.forEach(c => {
            let v = record[c];
            if (v === null || v === undefined) v = '';
            let formatted = v;
            
            if (c === 'created_at') {
                formatted = (window.AppUtils && AppUtils.formatDateTime) ? AppUtils.formatDateTime(v) : v;
            } else if (c === 'received_bytes' || c === 'sent_bytes') {
                formatted = (window.AppUtils && AppUtils.formatBytes) ? AppUtils.formatBytes(v) : v;
            } else if (c === 'duration') {
                formatted = (window.AppUtils && AppUtils.formatDurationMs) ? AppUtils.formatDurationMs(v) : v;
            } else if (c === 'status') {
                formatted = (window.AppUtils && AppUtils.renderStatusTag) ? AppUtils.renderStatusTag(v) : String(v);
            }
            
            const isUrlish = (c === 'url' || c === 'user_agent');
            const cls = isUrlish ? '' : (c === 'received_bytes' || c === 'sent_bytes' || c === 'duration' || c === 'status' ? 'num' : '');
            $body.append(`<tr><th style="width: 220px;">${c}</th><td class="${cls}">${typeof formatted === 'string' ? escapeHtml(formatted) : String(formatted)}</td></tr>`);
        });
        $('#sbDetailModal').addClass('is-active');
    }

    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    function getSelectedProxyIds() {
        return ($('#sbProxySelect').val() || []).map(v => parseInt(v, 10));
    }

    async function loadSessions() {
        const proxyIds = getSelectedProxyIds();
        if (proxyIds.length === 0) {
            showError('조회할 프록시를 최소 하나 이상 선택하세요.');
            return;
        }

        clearError();
        setStatus('조회 중...', 'is-warning');
        $('#sbLoadingIndicator').show();

        try {
            const res = await fetch('/api/session-browser/query', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ proxy_ids: proxyIds, limit: 1000 })
            });

            if (!res.ok) throw new Error('세션 정보를 가져오는데 실패했습니다.');

            const data = await res.json();
            sb.records = data.records || [];
            
            if (sb.gridApi) {
                sb.gridApi.setGridOption('rowData', sb.records);
            }
            
            setStatus(`${sb.records.length}건 조회됨`, 'is-success');
            persistState();
        } catch (err) {
            showError(err.message);
            setStatus('오류', 'is-danger');
        } finally {
            $('#sbLoadingIndicator').hide();
        }
    }

    function persistState() {
        const state = {
            proxyIds: getSelectedProxyIds(),
            groupId: $('#sbGroupSelect').val(),
            records: sb.records.slice(0, 500) // 저장 용량 제한
        };
        localStorage.setItem(sb.storageKey, JSON.stringify(state));
    }

    function restoreState() {
        try {
            const saved = localStorage.getItem(sb.storageKey);
            if (!saved) return;
            
            const state = JSON.parse(saved);
            sb.isRestoring = true;

            if (state.groupId) {
                $('#sbGroupSelect').val(state.groupId).trigger('change');
            }

            if (state.proxyIds && state.proxyIds.length > 0) {
                // DeviceSelector가 프록시 목록을 채운 후 값을 설정해야 함
                setTimeout(() => {
                    const ts = document.getElementById('sbProxySelect')._tom;
                    if (ts) {
                        ts.setValue(state.proxyIds.map(String), false);
                    }
                    
                    if (state.records && state.records.length > 0) {
                        sb.records = state.records;
                        if (sb.gridApi) sb.gridApi.setGridOption('rowData', sb.records);
                        setStatus(`${sb.records.length}건 복원됨`, 'is-info');
                    }
                    sb.isRestoring = false;
                }, 300);
            } else {
                sb.isRestoring = false;
            }
        } catch (e) {
            console.warn('[SessionBrowser] State restore failed', e);
            sb.isRestoring = false;
        }
    }

    function initGrid() {
        const gridOptions = {
            columnDefs: [
                { field: 'id', headerName: 'ID', width: 80, hide: true },
                { field: 'created_at', headerName: '시간', width: 180, sort: 'desc', valueFormatter: params => (window.AppUtils && AppUtils.formatDateTime) ? AppUtils.formatDateTime(params.value) : params.value },
                { field: 'client_ip', headerName: '클라이언트', width: 140 },
                { field: 'url', headerName: 'URL', flex: 1, minWidth: 300 },
                { field: 'status', headerName: '상태', width: 100, cellRenderer: params => (window.AppUtils && AppUtils.renderStatusTag) ? AppUtils.renderStatusTag(params.value) : params.value },
                { field: 'duration', headerName: '소요시간', width: 100, cellClass: 'num', valueFormatter: params => (window.AppUtils && AppUtils.formatDurationMs) ? AppUtils.formatDurationMs(params.value) : params.value },
                { field: 'received_bytes', headerName: 'Received', width: 110, cellClass: 'num', valueFormatter: params => (window.AppUtils && AppUtils.formatBytes) ? AppUtils.formatBytes(params.value) : params.value },
                { field: 'sent_bytes', headerName: 'Sent', width: 110, cellClass: 'num', valueFormatter: params => (window.AppUtils && AppUtils.formatBytes) ? AppUtils.formatBytes(params.value) : params.value }
            ],
            rowData: [],
            pagination: true,
            paginationPageSize: 100,
            onRowDoubleClicked: params => showDetail(params.data),
            theme: 'quartz'
        };

        const gridDiv = document.querySelector('#sbTableGrid');
        sb.gridApi = agGrid.createGrid(gridDiv, gridOptions);
    }

    $(document).ready(() => {
        initGrid();

        // DeviceSelector 초기화 (통합 모니터링 바 적용)
        window.DeviceSelector.init({
            groupSelect: '#sbGroupSelect',
            proxySelect: '#sbProxySelect',
            proxyTrigger: '#sbProxyTrigger',
            selectionCounter: '#sbSelectionCounter',
            onData: (data) => {
                sb.groups = data.groups;
                sb.proxies = data.proxies;
                if (!sb.isRestoring) restoreState();
            }
        });

        $('#sbLoadBtn').on('click', loadSessions);
        
        $('#sbQuickFilter').on('input', function() {
            if (sb.gridApi) sb.gridApi.setGridOption('quickFilterText', $(this).val());
        });

        $('#sbClearFilters').on('click', () => {
            $('#sbQuickFilter').val('');
            if (sb.gridApi) {
                sb.gridApi.setGridOption('quickFilterText', '');
                sb.gridApi.setColumnFilterModel(null);
            }
        });

        $('#sbExportBtn').on('click', () => {
            if (sb.gridApi) sb.gridApi.exportDataAsCsv({ fileName: `sessions_${new Date().toISOString().slice(0,10)}.csv` });
        });

        $('#sbAnalyzeBtn').on('click', () => {
            $('#sbListSection').hide();
            $('#sbAnalyzeSection').show();
            if (window.sbAnalyze) window.sbAnalyze.run(sb.records);
        });

        $('.modal-background, .modal-card-head .delete, .modal-card-foot .button').on('click', () => {
            $('.modal').removeClass('is-active');
        });
    });

})();
