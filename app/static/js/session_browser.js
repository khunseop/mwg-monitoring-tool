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
        const select = document.getElementById('sbProxySelect');
        if (select && select._tom) {
            return select._tom.getValue().map(v => parseInt(v, 10));
        }
        return ($(select).val() || []).map(v => parseInt(v, 10));
    }

    function updateDashboard(records) {
        if (!records || records.length === 0) {
            $('#sbMiniDashboard').hide();
            return;
        }

        const stats = {
            total: records.length,
            errors: 0,
            slow: 0,
            traffic: 0
        };

        records.forEach(r => {
            const status = parseInt(r.status, 10);
            if (status >= 400) stats.errors++;
            if (r.duration >= 500) stats.slow++;
            stats.traffic += (r.received_bytes || 0) + (r.sent_bytes || 0);
        });

        $('#stat-total').text(stats.total.toLocaleString());
        $('#stat-errors').text(stats.errors.toLocaleString());
        $('#stat-slow').text(stats.slow.toLocaleString());
        $('#stat-traffic').text((window.AppUtils && AppUtils.formatBytes) ? AppUtils.formatBytes(stats.traffic) : stats.traffic);
        
        $('#sbMiniDashboard').fadeIn();
    }

    async function loadSessions() {
        const proxyIds = getSelectedProxyIds();
        if (proxyIds.length === 0) {
            showError('조회할 프록시를 최소 하나 이상 선택하세요.');
            return;
        }

        clearError();
        setStatus('조회 중...', 'is-warning');
        $('#sbLoadingIndicator').css('display', 'flex'); 

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
                setTimeout(() => {
                    sb.gridApi.setGridOption('rowData', sb.records);
                    updateDashboard(sb.records);
                }, 0);
            }
            
            setStatus(`${sb.records.length}건 조회됨`, 'is-success');
            persistState();
        } catch (err) {
            showError(err.message);
            setStatus('오류', 'is-danger');
        } finally {
            setTimeout(() => {
                $('#sbLoadingIndicator').hide();
            }, 200);
        }
    }

    function persistState() {
        const current = JSON.parse(localStorage.getItem(sb.storageKey) || '{}');
        current.records = sb.records.slice(0, 500);
        localStorage.setItem(sb.storageKey, JSON.stringify(current));
    }

    function restoreState() {
        try {
            const saved = localStorage.getItem(sb.storageKey);
            if (!saved) return;
            
            const state = JSON.parse(saved);

            if (state.records && state.records.length > 0) {
                sb.records = state.records;
                if (sb.gridApi) sb.gridApi.setGridOption('rowData', sb.records);
                updateDashboard(sb.records);
                setStatus(`${sb.records.length}건 복원됨`, 'is-info');
            }
        } catch (e) {
            console.warn('[SessionBrowser] State restore failed', e);
        } finally {
            $('#sbLoadingIndicator').hide();
        }
    }

    function initGrid() {
        const gridOptions = {
            columnDefs: [
                { field: 'id', headerName: 'ID', width: 80, hide: true },
                { field: 'created_at', headerName: '시간', width: 170, sort: 'desc', filter: 'agDateColumnFilter', valueFormatter: params => (window.AppUtils && AppUtils.formatDateTime) ? AppUtils.formatDateTime(params.value) : params.value },
                { field: 'client_ip', headerName: '클라이언트', width: 130, filter: 'agTextColumnFilter' },
                { 
                    field: 'url', 
                    headerName: 'URL', 
                    flex: 1, 
                    minWidth: 300,
                    filter: 'agTextColumnFilter',
                    cellStyle: { 'font-size': '0.825rem' },
                    tooltipField: 'url'
                },
                { 
                    field: 'status', 
                    headerName: '상태', 
                    width: 85, 
                    filter: 'agNumberColumnFilter',
                    cellRenderer: params => {
                        const val = parseInt(params.value, 10);
                        let color = 'is-success';
                        if (val >= 500) color = 'is-danger';
                        else if (val >= 400) color = 'is-warning';
                        else if (val === 0) color = 'is-light';
                        return `<span class="tag ${color} is-light" style="width: 100%; font-weight: 600; font-size: 0.75rem;">${params.value || '-'}</span>`;
                    }
                },
                { 
                    field: 'duration', 
                    headerName: '소요시간', 
                    width: 95, 
                    cellClass: 'num',
                    filter: 'agNumberColumnFilter',
                    valueFormatter: params => (window.AppUtils && AppUtils.formatDurationMs) ? AppUtils.formatDurationMs(params.value) : params.value,
                    cellStyle: params => {
                        if (params.value >= 1000) return { color: '#ff3860', 'font-weight': 'bold' };
                        if (params.value >= 500) return { color: '#ffdd57', 'font-weight': 'bold' };
                        return null;
                    }
                },
                { field: 'received_bytes', headerName: 'Received', width: 105, cellClass: 'num', filter: 'agNumberColumnFilter', valueFormatter: params => (window.AppUtils && AppUtils.formatBytes) ? AppUtils.formatBytes(params.value) : params.value },
                { field: 'sent_bytes', headerName: 'Sent', width: 105, cellClass: 'num', filter: 'agNumberColumnFilter', valueFormatter: params => (window.AppUtils && AppUtils.formatBytes) ? AppUtils.formatBytes(params.value) : params.value }
            ],
            defaultColDef: {
                resizable: true,
                sortable: true,
                filter: true,
                floatingFilter: false // 상단 검색창 제거
            },
            rowData: [],
            pagination: true,
            paginationPageSize: 100,
            rowHeight: 32,
            headerHeight: 38, // 헤더 높이 복원
            onRowDoubleClicked: params => showDetail(params.data),
            theme: 'quartz',
            enableBrowserTooltips: true,
            overlayNoRowsTemplate: '<div style="padding: 20px; text-align: center; color: var(--color-text-muted);">조회된 세션 데이터가 없습니다.</div>'
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
            storageKey: sb.storageKey,
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
                sb.gridApi.setFilterModel(null);
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
