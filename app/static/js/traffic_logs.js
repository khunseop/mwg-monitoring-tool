(function(){
    'use strict';
    
    function switchTlTab(tabId) {
        $('.tl-tab-content').hide();
        $('.tabs li').removeClass('is-active');
        
        if (tabId === 'remote') {
            $('#tlRemoteSection').show();
            $('#tab-remote').addClass('is-active');
            // 그리드 리사이즈 유도
            setTimeout(() => window.dispatchEvent(new Event('resize')), 50);
        } else if (tabId === 'analyze') {
            $('#tlAnalyzeSection').show();
            $('#tab-analyze').addClass('is-active');
            // 차트 리사이즈 유도
            setTimeout(() => window.dispatchEvent(new Event('resize')), 50);
        } else if (tabId === 'upload') {
            $('#tlaUploadSection').show();
            $('#tab-upload').addClass('is-active');
        }
    }
    window.switchTlTab = switchTlTab;

    const API_BASE = '/api';
    let PROXIES = [];
    window.PROXIES = PROXIES; 
    const STORAGE_KEY = 'tl_state_v1';
    let IS_RESTORING = false;
    let tlGridApi = null;
    let LOG_RECORDS = [];
    window.LOG_RECORDS = LOG_RECORDS; // 분석 모듈에서 접근 가능하도록 노출

    // Columns defined in AgGridConfig are used, but we keep this for reference and detail view
    const COLS = [
        "datetime","username","client_ip","url_destination_ip","timeintransaction",
        "response_statuscode","cache_status","comm_name","url_protocol","url_host",
        "url_path","url_parametersstring","url_port","url_categories","url_reputationstring",
        "url_reputation","mediatype_header","recv_byte","sent_byte","user_agent","referer",
        "url_geolocation","application_name","currentruleset","currentrule","action_names",
        "block_id","proxy_id","ssl_certificate_cn","ssl_certificate_sigmethod",
        "web_socket","content_lenght"
    ];

    function setStatus(text, cls){
        const $tag = $('#tlStatus');
        if (!$tag.length) return;
        $tag.text(text);
        $tag.removeClass().addClass('tag');
        
        // Apply standardized classes
        if (cls && cls.includes('primary')) $tag.addClass('is-success is-light');
        else if (cls && cls.includes('warning')) $tag.addClass('is-collecting');
        else if (cls && cls.includes('danger')) $tag.addClass('is-danger is-light');
        else if (cls && cls.includes('info')) $tag.addClass('is-info is-light');
        else $tag.addClass('is-ready');
    }

    function showError(msg){
        $('#tlError').text(msg).fadeIn();
        setStatus('오류', 'is-danger is-light');
    }

    function clearError(){ $('#tlError').hide().text(''); }

    function showDetail(record){
        const $body = $('#tlDetailBody');
        const $raw = $('#tlDetailRaw');
        $body.empty();
        $raw.text(record._raw_line_ || '원본 로그 라인이 없습니다.');

        COLS.forEach(c => {
            let v = record[c];
            if(v === null || v === undefined) v = '';
            let formatted = v;
            
            if(c === 'datetime' || c === 'collected_at'){
                formatted = (window.AppUtils && AppUtils.formatDateTime) ? AppUtils.formatDateTime(v) : v;
            } else if(c === 'response_statuscode'){
                formatted = (window.AppUtils && AppUtils.renderStatusTag) ? AppUtils.renderStatusTag(v) : String(v);
            } else if(c === 'recv_byte' || c === 'sent_byte' || c === 'content_lenght'){
                formatted = (window.AppUtils && AppUtils.formatBytes) ? AppUtils.formatBytes(v) : v;
            } else if(c === 'timeintransaction'){
                var num = Number(v);
                if(Number.isFinite(num)){
                    formatted = (window.AppUtils && AppUtils.formatDurationMs) ? AppUtils.formatDurationMs(num < 1000 ? num * 1000 : num) : v;
                }
            }
            
            const isLongText = (c === 'url_path' || c === 'url_parametersstring' || c === 'referer' || c === 'user_agent');
            const cls = isLongText ? '' : (c === 'recv_byte' || c === 'sent_byte' || c === 'content_lenght' || c === 'response_statuscode' ? 'num' : '');
            
            $body.append(`
                <tr>
                    <th style="width: 200px; background: #f8fafc; font-size: 0.75rem; color: #64748b;">${c.replace(/_/g, ' ').toUpperCase()}</th>
                    <td class="${cls}" style="font-size: 0.8rem; ${isLongText ? 'word-break: break-all; white-space: normal;' : ''}">${typeof formatted === 'string' ? formatted : String(formatted)}</td>
                </tr>
            `);
        });
        $('#tlDetailModal').addClass('is-active');
    }
    
    window.showTrafficLogDetail = showDetail;

    async function saveState(records){
        try {
            const $ps = $('#tlProxySelect');
            let proxyIds = [];
            if ($ps[0] && $ps[0].tomselect) {
                proxyIds = $ps[0].tomselect.getValue();
            } else {
                proxyIds = $ps.val() || [];
            }

            const state = {
                proxyIds: proxyIds,
                groupId: $('#tlGroupSelect').val(),
                query: $('#tlQuery').val(),
                limit: $('#tlLimit').val(),
                direction: $('#tlDirection').val(),
                timestamp: new Date().getTime()
            };
            localStorage.setItem(STORAGE_KEY, JSON.stringify(state));

            // 대용량 데이터는 IndexedDB에 저장
            if (window.AppDB) {
                await window.AppDB.set(STORAGE_KEY + '_records', {
                    records: records || [],
                    timestamp: new Date().getTime()
                });
            }
        } catch(e) { console.warn('Failed to save state', e); }
    }

    async function restoreState(){
        try {
            const saved = localStorage.getItem(STORAGE_KEY);
            if (!saved) return;
            const state = JSON.parse(saved);
            
            // 1시간 초과 시 만료
            const now = new Date().getTime();
            if (state.timestamp && (now - state.timestamp > 3600000)) {
                localStorage.removeItem(STORAGE_KEY);
                if (window.AppDB) await window.AppDB.delete(STORAGE_KEY + '_records');
                return;
            }

            IS_RESTORING = true;
            
            if (state.query !== undefined) $('#tlQuery').val(state.query);
            if (state.limit !== undefined) $('#tlLimit').val(state.limit);
            if (state.direction !== undefined) $('#tlDirection').val(state.direction);
            
            // DeviceSelector가 초기화된 후 상태 복원 수행 (initTrafficLogs에서 처리됨)
            // 여기서는 데이터만 복원
            if (window.AppDB) {
                const data = await window.AppDB.get(STORAGE_KEY + '_records');
                if (data && data.records && data.records.length > 0) {
                    LOG_RECORDS = data.records;
                    window.LOG_RECORDS = data.records; // 글로벌 업데이트 추가
                    renderTable(LOG_RECORDS);
                    setStatus(`${LOG_RECORDS.length}건 복원됨`, 'is-info is-light');
                }
            }
            IS_RESTORING = false;
        } catch(e) { 
            console.warn('Failed to restore state', e);
            IS_RESTORING = false; 
        }
    }

    async function collectLogs(){
        let proxyIds = [];
        const $ps = $('#tlProxySelect');
        if ($ps[0] && $ps[0].tomselect) {
            proxyIds = $ps[0].tomselect.getValue();
        } else {
            proxyIds = $ps.val() || [];
        }

        if (!proxyIds || proxyIds.length === 0) {
            showError('수집할 프록시를 적어도 하나 선택하세요.');
            return;
        }

        clearError();
        setStatus('로그 수집 중...', 'is-warning is-light');
        $('#tlLoadBtn').addClass('is-loading');

        try {
            const query = $('#tlQuery').val() || '';
            const limit = $('#tlLimit').val() || 10000;
            const direction = $('#tlDirection').val() || 'tail';
            const pIdsParam = Array.isArray(proxyIds) ? proxyIds.join(',') : proxyIds;

            const res = await fetch(`${API_BASE}/traffic-logs/collect?proxy_ids=${pIdsParam}&q=${encodeURIComponent(query)}&limit=${limit}&direction=${direction}`, {
                method: 'POST'
            });

            if (!res.ok) {
                const errData = await res.json().catch(() => ({}));
                throw new Error(errData.detail || '수집 요청에 실패했습니다.');
            }

            const data = await res.json();
            const failMsg = data.failed > 0 ? ` (${data.failed}개 실패)` : '';
            setStatus(`수집 완료 (${data.succeeded}개 성공${failMsg})`, 'is-primary is-light');

            // 수집 완료 후 그리드 새로고침 (window 참조로도 시도)
            const gridApi = tlGridApi || window.__tlGridApi;
            if (gridApi) gridApi.refreshInfiniteCache();

        } catch(err) {
            showError(err.message);
        } finally {
            $('#tlLoadBtn').removeClass('is-loading');
        }
    }

    function getDataSource() {
        return {
            getRows: async (params) => {
                let proxyIds = [];
                const $ps = $('#tlProxySelect');
                if ($ps[0] && $ps[0].tomselect) {
                    proxyIds = $ps[0].tomselect.getValue();
                } else {
                    proxyIds = $ps.val() || [];
                }

                if (!proxyIds || proxyIds.length === 0) {
                    params.successCallback([], 0);
                    return;
                }

                const pIdsParam = Array.isArray(proxyIds) ? proxyIds.join(',') : proxyIds;
                const offset = params.startRow;
                const limit = params.endRow - params.startRow;
                
                // Sorting
                let sortCol = 'id';
                let sortDir = 'desc';
                if (params.sortModel && params.sortModel.length > 0) {
                    sortCol = params.sortModel[0].colId;
                    sortDir = params.sortModel[0].sort;
                }

                // Filtering (Simple implementation)
                let filterCol = '';
                let filterVal = '';
                const filterModel = params.filterModel;
                if (filterModel && Object.keys(filterModel).length > 0) {
                    filterCol = Object.keys(filterModel)[0];
                    filterVal = filterModel[filterCol].filter;
                }

                try {
                    const url = `${API_BASE}/traffic-logs?proxy_ids=${pIdsParam}&offset=${offset}&limit=${limit}&sort_col=${sortCol}&sort_dir=${sortDir}&filter_col=${filterCol}&filter_val=${encodeURIComponent(filterVal)}`;
                    const res = await fetch(url);
                    if (!res.ok) {
                        const errText = await res.text().catch(() => '');
                        throw new Error(`서버 오류 (${res.status}): ${errText.slice(0, 200)}`);
                    }
                    const data = await res.json();

                    params.successCallback(data.records, data.total_count);

                    if (data.total_count === 0) {
                        if ($('#tlResultParsed').is(':hidden')) {
                            $('#tlEmptyState').show();
                        }
                    } else {
                        $('#tlEmptyState').hide();
                        // 첫 번째 블록 요청(startRow===0)에서만 총 건수 표시
                        if (params.startRow === 0) {
                            setStatus(`총 ${data.total_count.toLocaleString()}건 조회됨`, 'is-primary is-light');
                        }
                    }
                } catch (e) {
                    console.error('Failed to fetch rows', e);
                    params.failCallback();
                }
            }
        };
    }

    function destroyTlGrid() {
        const api = tlGridApi || window.__tlGridApi;
        if (api) {
            try { api.destroy(); } catch(e) {}
        }
        tlGridApi = null;
        window.__tlGridApi = null;
        const gridDiv = document.querySelector('#tlTableGrid');
        if (gridDiv) gridDiv.innerHTML = '';
    }

    function renderTable(records){
        // Ensure empty state is hidden when rendering results
        $('#tlEmptyState').hide();

        const gridDiv = document.querySelector('#tlTableGrid');
        if (!gridDiv || !window.agGrid) return;

        // PJAX 재실행으로 클로저가 리셋된 경우 window 레벨 참조로 복구
        if (!tlGridApi && window.__tlGridApi) {
            tlGridApi = window.__tlGridApi;
        }

        const hasGridDom = !!gridDiv.querySelector('.ag-root-wrapper');

        if (tlGridApi && hasGridDom) {
            // 그리드 이미 존재 → 데이터만 갱신
            tlGridApi.setGridOption('datasource', getDataSource());
            $('#tlResultParsed').fadeIn();
            return;
        }

        // 기존 그리드 완전히 제거 후 재생성
        destroyTlGrid();

        const gridOptions = {
            columnDefs: window.AgGridConfig ? window.AgGridConfig.getTrafficLogColumns() : [],
            rowModelType: 'infinite',
            datasource: getDataSource(),
            cacheBlockSize: 100,
            maxBlocksInCache: 10,
            infiniteInitialRowCount: 100,
            pagination: true,
            paginationPageSize: 100,
            rowHeight: 35,
            headerHeight: 45,
            onRowDoubleClicked: params => showDetail(params.data),
            overlayNoRowsTemplate: '<div style="padding: 20px; text-align: center; color: var(--color-text-muted);">로그가 비어있습니다. [수집/조회] 버튼을 눌러보세요.</div>',
            // quickFilterText는 infinite 모델 미지원 → 외부 필터로 대체
            isExternalFilterPresent: () => !!$('#tlQuickFilter').val(),
            doesExternalFilterPass: (node) => {
                const q = ($('#tlQuickFilter').val() || '').toLowerCase();
                if (!q || !node.data) return true;
                return Object.values(node.data).some(v =>
                    v !== null && v !== undefined && String(v).toLowerCase().includes(q)
                );
            }
        };

        tlGridApi = window.agGrid.createGrid(gridDiv, gridOptions);
        window.__tlGridApi = tlGridApi;

        $('#tlResultParsed').fadeIn();
    }

    function initTrafficLogs() {
        // 설정 로드 및 캐싱 (페이지 크기 등)
        $.get('/api/session-browser/config').done(cfg => {
            localStorage.setItem('sb_config', JSON.stringify(cfg));
        });

        // PJAX 재실행으로 클로저가 리셋된 경우 window 레벨 참조로 복구
        if (!tlGridApi && window.__tlGridApi) {
            tlGridApi = window.__tlGridApi;
        }

        const gridDiv = document.querySelector('#tlTableGrid');
        if (gridDiv && !gridDiv.querySelector('.ag-root-wrapper')) {
            destroyTlGrid();
        }

        if (window.DeviceSelector) {
            window.DeviceSelector.init({
                groupSelect: '#tlGroupSelect',
                proxySelect: '#tlProxySelect',
                proxyTrigger: '#tlProxyTrigger',
                deselectBtn: '#tlDeselectAllBtn',
                selectionCounter: '#tlSelectionCounter',
                storageKey: STORAGE_KEY,
                onData: (data) => {
                    PROXIES = data.proxies;
                    window.PROXIES = PROXIES; // 글로벌 참조 업데이트
                    
                    // URL 파라미터 확인 (자원이력 연동 등)
                    const urlParams = new URLSearchParams(window.location.search);
                    const queryProxyId = urlParams.get('proxy_id');
                    const queryQ = urlParams.get('q');
                    const queryLimit = urlParams.get('limit');
                    
                    if (queryProxyId && queryQ) {
                        IS_RESTORING = true;
                        
                        // Set Group to 'all' or default
                        const $gs = $('#tlGroupSelect');
                        if ($gs.length > 0) {
                            $gs.val('');
                        }
                        
                        // Set Proxy
                        const $ps = $('#tlProxySelect');
                        if ($ps[0] && $ps[0].tomselect) {
                            $ps[0].tomselect.setValue([queryProxyId]);
                        } else {
                            $ps.val([queryProxyId]);
                        }
                        
                        // Set Query and Limit
                        $('#tlQuery').val(queryQ);
                        if (queryLimit) $('#tlLimit').val(queryLimit);
                        
                        // Clear parameters from URL without reloading
                        const newUrl = window.location.pathname;
                        window.history.replaceState({}, document.title, newUrl);
                        
                        // Trigger search automatically
                        setTimeout(() => {
                            $('#tlLoadBtn').click();
                            IS_RESTORING = false;
                        }, 100);
                        
                    } else if (!IS_RESTORING) {
                        restoreState();
                    }
                },
                onGroupChange: (groupId) => {
                    // 그룹 변경 시 이전 결과와 에러 메시지 초기화
                    clearError();
                    setStatus('준비', 'is-primary is-light');
                }
            });
        }

        $('#tlLoadBtn').off('click').on('click', () => {
            if (!tlGridApi) renderTable([]);
            collectLogs();
        });
        
        // 새로고침 버튼 기능 (데이터 수집 없이 DB의 현재 데이터만 다시 조회)
        $('#tlRefreshBtn').off('click').on('click', () => {
            if (tlGridApi) tlGridApi.refreshInfiniteCache();
            else renderTable([]);
        });
        $('#tlAnalyzeBtn').off('click').on('click', () => switchTlTab('analyze'));
        
        $('#tlQuickFilter').off('input').on('input', function() {
            if (tlGridApi) tlGridApi.onFilterChanged();
        });

        $('#tlClearFiltersBtn').off('click').on('click', () => {
            $('#tlQuickFilter').val('');
            if (tlGridApi) {
                tlGridApi.setFilterModel(null);
                tlGridApi.onFilterChanged();
            }
        });

        $('#tlExportBtn').off('click').on('click', () => {
            if (tlGridApi) {
                const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
                tlGridApi.exportDataAsCsv({ 
                    fileName: `traffic_logs_${timestamp}.csv`,
                    allColumns: true,
                    processCellCallback: window.AgGridConfig ? window.AgGridConfig.processCellForExport : null
                });
            } else {
                alert('내보낼 데이터가 없습니다.');
            }
        });

        $('#tlDetailModal .delete, #tlDetailModal .button, #tlDetailModal .modal-background').off('click').on('click', () => {
            $('#tlDetailModal').removeClass('is-active');
        });
        
        if (window.location.pathname === '/traffic-logs/upload') {
            $('#tlRemoteSection').hide();
            $('#tlaSection').show();
        }
    }

    $(document).ready(() => {
        initTrafficLogs();
    });

    // PJAX 페이지 전환 대응
    $(document).off('pjax:complete.tl').on('pjax:complete.tl', function(e, url) {
        if (url.includes('/traffic-logs')) {
            initTrafficLogs();
        }
    });
})();
