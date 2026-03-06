(function() {
    'use strict';

    const sb = {
        groups: [],
        proxies: [],
        records: [],
        gridApi: null,
        storageKey: 'sb_state_v1',
        analyzeStatus: 'idle'
    };

    const COLS = [
        "id", "host", "creation_time", "client_ip", "server_ip",
        "protocol", "status", "user_name", "url", "cl_bytes_received", "cl_bytes_sent",
        "age_seconds"
    ];

    function setStatus(text, cls) {
        const $tag = $('#sbStatus');
        $tag.text(text);
        $tag.removeClass().addClass('tag').addClass(cls || 'is-primary is-light');
    }

    function showDetail(record) {
        const $body = $('#sbDetailBody');
        $body.empty();
        
        // Use a more comprehensive set of fields for detail view
        const detailFields = [
            { key: 'host', label: '프록시' },
            { key: 'creation_time', label: '생성 시각', format: 'datetime' },
            { key: 'protocol', label: '프로토콜' },
            { key: 'status', label: '상태 코드', format: 'status' },
            { key: 'user_name', label: '사용자' },
            { key: 'client_ip', label: '클라이언트 IP' },
            { key: 'server_ip', label: '서버 IP' },
            { key: 'cl_bytes_received', label: '수신 데이터', format: 'bytes' },
            { key: 'cl_bytes_sent', label: '송신 데이터', format: 'bytes' },
            { key: 'age_seconds', label: '세션 유지(초)', format: 'seconds' },
            { key: 'url', label: 'URL' }
        ];

        detailFields.forEach(f => {
            let v = record[f.key];
            if (v === null || v === undefined) v = '-';
            let formatted = v;
            
            if (f.format === 'datetime') {
                formatted = (window.AppUtils && AppUtils.formatDateTime) ? AppUtils.formatDateTime(v) : v;
            } else if (f.format === 'bytes') {
                formatted = (window.AppUtils && AppUtils.formatBytes) ? AppUtils.formatBytes(v) : v;
            } else if (f.format === 'seconds') {
                formatted = (window.AppUtils && AppUtils.formatSeconds) ? AppUtils.formatSeconds(v) : v;
            } else if (f.format === 'status') {
                formatted = (window.AppUtils && AppUtils.renderStatusTag) ? AppUtils.renderStatusTag(v) : String(v);
            }
            
            const isLongText = (f.key === 'url');
            const cellStyle = isLongText ? 'style="word-break: break-all; white-space: normal;"' : '';
            
            $body.append(`
                <tr>
                    <th style="width: 180px; background: #f8fafc; font-size: 0.8rem; color: #64748b;">${f.label}</th>
                    <td ${cellStyle}>${formatted}</td>
                </tr>
            `);
        });
        $('#sbDetailModal').addClass('is-active');
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
            if (r.age_seconds >= 60) stats.slow++; // 1분 이상 세션
            stats.traffic += (r.cl_bytes_received || 0) + (r.cl_bytes_sent || 0);
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
            alert('조회할 프록시를 선택하세요.');
            return;
        }

        setStatus('데이터 수집 중...', 'is-warning is-light');
        $('#sbLoadingIndicator').css('display', 'flex'); 
        $('#sbLoadBtn').addClass('is-loading');

        try {
            const res = await fetch('/api/session-browser/load', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ proxy_ids: proxyIds })
            });

            if (!res.ok) {
                const errData = await res.json().catch(() => ({}));
                throw new Error(errData.detail || '세션 정보를 가져오는데 실패했습니다.');
            }

            const data = await res.json();
            sb.records = data.sessions || [];
            
            if (sb.gridApi) {
                sb.gridApi.setGridOption('rowData', sb.records);
                updateDashboard(sb.records);
            }
            
            setStatus(`성공 (${sb.records.length}건)`, 'is-primary is-light');
            persistState();
        } catch (err) {
            console.error('[SessionBrowser] Load failed:', err);
            alert(err.message);
            setStatus('수집 실패', 'is-danger is-light');
        } finally {
            $('#sbLoadingIndicator').hide();
            $('#sbLoadBtn').removeClass('is-loading');
        }
    }

    function persistState() {
        try {
            const state = {
                records: sb.records.slice(0, 1000), // 최대 1000건 저장
                timestamp: new Date().getTime()
            };
            localStorage.setItem(sb.storageKey, JSON.stringify(state));
        } catch (e) {
            console.warn('[SessionBrowser] Failed to persist state:', e);
        }
    }

    function restoreState() {
        try {
            const saved = localStorage.getItem(sb.storageKey);
            if (!saved) return;
            
            const state = JSON.parse(saved);
            // 1시간 이내 데이터만 복원
            const oneHour = 60 * 60 * 1000;
            if (new Date().getTime() - state.timestamp > oneHour) {
                localStorage.removeItem(sb.storageKey);
                return;
            }

            if (state.records && state.records.length > 0) {
                sb.records = state.records;
                if (sb.gridApi) {
                    sb.gridApi.setGridOption('rowData', sb.records);
                    updateDashboard(sb.records);
                    setStatus(`데이터 복원됨 (${sb.records.length}건)`, 'is-info is-light');
                }
            }
        } catch (e) {
            console.warn('[SessionBrowser] State restore failed', e);
        }
    }

    function initGrid() {
        const gridOptions = {
            columnDefs: window.AgGridConfig ? window.AgGridConfig.getSessionBrowserColumns() : [],
            defaultColDef: {
                resizable: true,
                sortable: true,
                filter: 'agTextColumnFilter',
                filterParams: { applyButton: true, clearButton: true },
                minWidth: 100
            },
            rowData: [],
            pagination: true,
            paginationPageSize: 100,
            rowHeight: 35,
            headerHeight: 40,
            onRowDoubleClicked: params => showDetail(params.data),
            theme: 'quartz',
            enableBrowserTooltips: true,
            overlayNoRowsTemplate: '<div style="padding: 20px; text-align: center; color: var(--color-text-muted); font-size: 0.875rem;">조회된 세션 데이터가 없습니다. 상단에서 "세션 불러오기"를 클릭하세요.</div>',
            onGridReady: (params) => {
                sb.gridApi = params.api;
                restoreState();
            }
        };

        const gridDiv = document.querySelector('#sbTableGrid');
        if (gridDiv && window.agGrid) {
            sb.gridApi = window.agGrid.createGrid(gridDiv, gridOptions);
        }
    }

    $(document).ready(() => {
        initGrid();

        // DeviceSelector 초기화
        if (window.DeviceSelector) {
            window.DeviceSelector.init({
                groupSelect: '#sbGroupSelect',
                proxySelect: '#sbProxySelect',
                proxyTrigger: '#sbProxyTrigger',
                selectionCounter: '#sbSelectionCounter',
                storageKey: sb.storageKey,
                onData: (data) => {
                    sb.groups = data.groups;
                    sb.proxies = data.proxies;
                }
            });
        }

        $('#sbLoadBtn').on('click', loadSessions);
        
        $('#sbQuickFilter').on('input', function() {
            if (sb.gridApi) sb.gridApi.setGridOption('quickFilterText', $(this).val());
        });

        $('#sbClearFilters').on('click', () => {
            $('#sbQuickFilter').val('');
            if (sb.gridApi) {
                sb.gridApi.setGridOption('quickFilterText', '');
                sb.gridApi.setFilterModel(null);
                // 필터 초기화 피드백
                const originalText = $('#sbClearFilters span').text();
                $('#sbClearFilters span').text('초기화 완료');
                setTimeout(() => $('#sbClearFilters span').text(originalText), 1500);
            }
        });

        $('#sbExportBtn').on('click', () => {
            if (sb.gridApi) {
                const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
                sb.gridApi.exportDataAsCsv({ 
                    fileName: `sessions_export_${timestamp}.csv`,
                    allColumns: true
                });
            }
        });

        $('#sbAnalyzeBtn').on('click', (e) => {
            e.preventDefault();
            if (sb.records.length === 0) {
                alert('분석할 세션 데이터가 없습니다. 먼저 데이터를 불러오세요.');
                return;
            }
            $('#sbListSection').hide();
            $('#sbAnalyzeSection').show();
            if (window.sbAnalyze) window.sbAnalyze.run(sb.records);
        });

        // Modal closing handlers
        $('#sbDetailModal .delete, #sbDetailModal .button, #sbDetailModal .modal-background').on('click', () => {
            $('#sbDetailModal').removeClass('is-active');
        });
    });

})();
