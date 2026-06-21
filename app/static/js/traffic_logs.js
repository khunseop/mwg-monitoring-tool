(function(){
    'use strict';
    
    function switchTlTab(tabId) {
        $('.tl-tab-content').hide();
        $('.subnav-tab').removeClass('is-active');

        if (tabId === 'remote') {
            $('#tlRemoteSection').show();
            $('#tab-remote').addClass('is-active');
            setTimeout(() => window.dispatchEvent(new Event('resize')), 50);
        } else if (tabId === 'analyze') {
            $('#tlAnalyzeSection').show();
            $('#tab-analyze').addClass('is-active');
            setTimeout(() => window.dispatchEvent(new Event('resize')), 50);
        } else if (tabId === 'upload') {
            $('#tlaUploadSection').show();
            $('#tab-upload').addClass('is-active');
        } else if (tabId === 'live') {
            $('#tlLiveSection').show();
            $('#tab-live').addClass('is-active');
            populateLiveProxySelect();
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

            // 수집 완료 후 그리드 완전 재생성 (누적 방지)
            destroyTlGrid();
            renderTable([]);

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

                // 컬럼 필터 추출 (AG Grid v33 호환)
                let filterCol = '';
                let filterVal = '';
                const filterModel = params.filterModel;
                if (filterModel && Object.keys(filterModel).length > 0) {
                    filterCol = Object.keys(filterModel)[0];
                    const fm = filterModel[filterCol];
                    // AG Grid v33: conditions 배열 형식 또는 단순 filter 형식 모두 처리
                    if (fm.conditions && fm.conditions.length > 0) {
                        filterVal = fm.conditions[0].filter;
                    } else {
                        filterVal = fm.filter;
                    }
                    // 유효하지 않은 값 방어
                    if (filterVal === undefined || filterVal === null) {
                        filterCol = '';
                        filterVal = '';
                    } else {
                        filterVal = String(filterVal);
                    }
                }

                try {
                    const searchVal = encodeURIComponent($('#tlQuickFilter').val() || '');
                    const url = `${API_BASE}/traffic-logs?proxy_ids=${pIdsParam}&offset=${offset}&limit=${limit}&sort_col=${sortCol}&sort_dir=${sortDir}&filter_col=${filterCol}&filter_val=${encodeURIComponent(filterVal)}&search=${searchVal}`;
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
            // 그리드 이미 존재 → 캐시 초기화 후 데이터 갱신 (누적 방지)
            tlGridApi.setGridOption('datasource', getDataSource());
            tlGridApi.purgeInfiniteCache();
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
            rowHeight: 28,
            headerHeight: 32,
            onRowDoubleClicked: params => showDetail(params.data),
            overlayNoRowsTemplate: '<div style="padding: 20px; text-align: center; color: var(--color-text-muted);">로그가 비어있습니다. [수집/조회] 버튼을 눌러보세요.</div>',
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
                    populateLiveProxySelect();
                    
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
            collectLogs();
        });
        
        // 새로고침 버튼 기능 (데이터 수집 없이 DB의 현재 데이터만 다시 조회)
        $('#tlRefreshBtn').off('click').on('click', () => {
            if (tlGridApi) tlGridApi.refreshInfiniteCache();
            else renderTable([]);
        });
        $('#tlAnalyzeBtn').off('click').on('click', () => switchTlTab('analyze'));
        
        $('#tlQuickFilter').off('input').on('input', function() {
            if (tlGridApi) tlGridApi.setGridOption('datasource', getDataSource());
        });

        $('#tlClearFiltersBtn').off('click').on('click', () => {
            $('#tlQuickFilter').val('');
            if (tlGridApi) {
                tlGridApi.setFilterModel(null);
                tlGridApi.setGridOption('datasource', getDataSource());
            }
        });

        $('#tlExportBtn').off('click').on('click', async () => {
            if (!tlGridApi) {
                alert('내보낼 데이터가 없습니다.');
                return;
            }

            let proxyIds = [];
            const $ps = $('#tlProxySelect');
            if ($ps[0] && $ps[0].tomselect) {
                proxyIds = $ps[0].tomselect.getValue();
            } else {
                proxyIds = $ps.val() || [];
            }
            if (!proxyIds || proxyIds.length === 0) {
                alert('프록시를 선택해주세요.');
                return;
            }

            // 현재 필터/정렬 상태 수집
            const pIdsParam = Array.isArray(proxyIds) ? proxyIds.join(',') : proxyIds;
            const searchVal = encodeURIComponent($('#tlQuickFilter').val() || '');
            let sortCol = 'id', sortDir = 'desc';
            const sortState = tlGridApi.getColumnState().filter(c => c.sort);
            if (sortState.length > 0) {
                sortCol = sortState[0].colId;
                sortDir = sortState[0].sort;
            }
            let filterCol = '', filterVal = '';
            const filterModel = tlGridApi.getFilterModel();
            if (filterModel && Object.keys(filterModel).length > 0) {
                filterCol = Object.keys(filterModel)[0];
                const fm = filterModel[filterCol];
                filterVal = (fm.conditions && fm.conditions.length > 0) ? fm.conditions[0].filter : fm.filter;
                if (filterVal === undefined || filterVal === null) { filterCol = ''; filterVal = ''; }
                else { filterVal = encodeURIComponent(String(filterVal)); }
            }

            const url = `${API_BASE}/traffic-logs/export?proxy_ids=${pIdsParam}&sort_col=${sortCol}&sort_dir=${sortDir}&filter_col=${filterCol}&filter_val=${filterVal}&search=${searchVal}`;
            const $btn = $('#tlExportBtn');
            $btn.addClass('is-loading');
            try {
                const res = await fetch(url);
                if (!res.ok) throw new Error(`서버 오류 (${res.status})`);
                const blob = await res.blob();
                const filename = `traffic_logs_${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.csv`;
                const a = document.createElement('a');
                a.href = URL.createObjectURL(blob);
                a.download = filename;
                a.click();
                URL.revokeObjectURL(a.href);
            } catch(err) {
                alert('내보내기 실패: ' + err.message);
            } finally {
                $btn.removeClass('is-loading');
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

    // ── 실시간 감시 ──────────────────────────────────────────────
    let _liveInterval = null;
    let _liveProxyId = null;
    const LIVE_MAX_ROWS = 1000;

    function populateLiveProxySelect() {
        const $sel = $('#liveProxySelect');
        const currentVal = $sel.val();
        $sel.empty().append('<option value="">-- 선택 --</option>');
        (window.PROXIES || []).forEach(p => {
            $sel.append(`<option value="${p.id}">${p.host}</option>`);
        });
        if (currentVal) $sel.val(currentVal);
    }

    function setLiveStatus(text, type) {
        const $tag = $('#liveStatus');
        $tag.text(text).removeClass().addClass('tag is-small');
        if (type === 'running') $tag.addClass('is-success is-light');
        else if (type === 'error') $tag.addClass('is-danger is-light');
        else if (type === 'loading') $tag.addClass('is-warning is-light');
        else $tag.addClass('is-light');
    }

    const LIVE_LOG_FIELDS = [
        "datetime","username","client_ip","url_destination_ip","timeintransaction",
        "response_statuscode","cache_status","comm_name","url_protocol","url_host",
        "url_path","url_parametersstring","url_port","url_categories","url_reputationstring",
        "url_reputation","mediatype_header","recv_byte","sent_byte","user_agent","referer",
        "url_geolocation","application_name","currentruleset","currentrule","action_names",
        "block_id","proxy_id","ssl_certificate_cn","ssl_certificate_sigmethod",
        "web_socket","content_lenght"
    ];
    const LIVE_BYTE_FIELDS = new Set(["recv_byte","sent_byte","content_lenght"]);
    const LIVE_STATUS_FIELD = "response_statuscode";
    const LIVE_LONG_FIELDS = new Set(["url_path","url_parametersstring","user_agent","referer"]);
    const LIVE_RIGHT_FIELDS = new Set(["recv_byte","sent_byte","content_lenght","url_port","url_reputation","timeintransaction","response_statuscode"]);

    function _escHtml(s) {
        if (s === null || s === undefined) return '';
        return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    }

    function _initLiveTableHead() {
        const $head = $('#liveTableHead');
        if ($head.find('th').length > 0) return;
        const ths = LIVE_LOG_FIELDS.map(f => {
            const label = f.replace(/_/g, ' ').toUpperCase();
            const minW = LIVE_LONG_FIELDS.has(f) ? '200px' : f === 'datetime' ? '160px' : '90px';
            return `<th style="min-width:${minW};">${label}</th>`;
        }).join('');
        $head.html(`<tr>${ths}</tr>`);
    }

    function appendLiveRecords(records) {
        if (!records || records.length === 0) return;
        _initLiveTableHead();
        const $tbody = $('#liveTableBody');
        $('#liveTablePlaceholder').remove();

        records.forEach(r => {
            const cells = LIVE_LOG_FIELDS.map(f => {
                const v = (r[f] === null || r[f] === undefined) ? '' : r[f];
                const s = _escHtml(String(v));
                const isRight = LIVE_RIGHT_FIELDS.has(f);
                const align = isRight ? 'text-align:right;' : '';

                if (f === LIVE_STATUS_FIELD && v !== '') {
                    const tag = (window.AppUtils && AppUtils.renderStatusTag) ? AppUtils.renderStatusTag(v) : s;
                    return `<td style="text-align:center;">${tag}</td>`;
                }
                if (LIVE_BYTE_FIELDS.has(f) && v !== '') {
                    const fmt = (window.AppUtils && AppUtils.formatBytes) ? AppUtils.formatBytes(v) : s;
                    return `<td style="text-align:right;">${fmt}</td>`;
                }
                if (LIVE_LONG_FIELDS.has(f)) {
                    return `<td style="max-width:300px;overflow:hidden;text-overflow:ellipsis;" title="${s}">${s}</td>`;
                }
                if (f === 'action_names' && String(v).toLowerCase() === 'block') {
                    return `<td style="${align}color:#dc2626;font-weight:700;">${s}</td>`;
                }
                return `<td style="${align}">${s}</td>`;
            }).join('');
            $tbody.append(`<tr>${cells}</tr>`);
        });

        const rows = $tbody.children('tr:not(#liveTablePlaceholder)');
        if (rows.length > LIVE_MAX_ROWS) {
            rows.slice(0, rows.length - LIVE_MAX_ROWS).remove();
        }

        if ($('#liveAutoScroll').is(':checked')) {
            const $wrap = $('#liveTableWrap');
            $wrap.scrollTop($wrap[0].scrollHeight);
        }
    }

    async function fetchLiveLog() {
        if (!_liveProxyId) return;
        const initialLines = $('#liveInitialLines').val() || 100;
        const q = encodeURIComponent($('#liveKeyword').val().trim());
        const clientIp = encodeURIComponent($('#liveClientIp').val().trim());
        const urlHost = encodeURIComponent($('#liveUrlHost').val().trim());
        const url = `${API_BASE}/traffic-logs/live/${_liveProxyId}?initial_lines=${initialLines}&q=${q}&client_ip=${clientIp}&url_host=${urlHost}`;
        try {
            const res = await fetch(url);
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                setLiveStatus('오류: ' + (err.detail || res.status), 'error');
                return;
            }
            const data = await res.json();
            appendLiveRecords(data.records);
            const newMsg = data.new_lines > 0 ? `, +${data.new_lines}건` : ', 변화 없음';
            setLiveStatus(`감시 중 (총 ${(data.total_count || 0).toLocaleString()}줄${newMsg})`, 'running');
        } catch (e) {
            setLiveStatus('연결 오류', 'error');
        }
    }

    function startLiveLog() {
        const proxyId = parseInt($('#liveProxySelect').val());
        if (!proxyId) { alert('프록시를 선택하세요.'); return; }
        const keyword = $('#liveKeyword').val().trim();
        if (!keyword) { alert('키워드를 입력해야 시작할 수 있습니다.'); $('#liveKeyword').focus(); return; }

        if (_liveProxyId && _liveProxyId !== proxyId) {
            fetch(`${API_BASE}/traffic-logs/live/${_liveProxyId}`, { method: 'DELETE' }).catch(() => {});
        }

        _liveProxyId = proxyId;
        $('#liveTableHead').empty();
        $('#liveTableBody').empty().append(
            '<tr id="liveTablePlaceholder"><td colspan="32" style="text-align:center;color:var(--color-text-muted);padding:1.5rem;">로딩 중...</td></tr>'
        );
        $('#liveStartBtn').hide();
        $('#liveStopBtn').show();
        $('#liveProxySelect, #liveIntervalSelect, #liveInitialLines, #liveKeyword, #liveClientIp, #liveUrlHost').prop('disabled', true);
        setLiveStatus('연결 중...', 'loading');

        fetchLiveLog();
        const intervalSec = parseInt($('#liveIntervalSelect').val()) || 10;
        _liveInterval = setInterval(fetchLiveLog, intervalSec * 1000);
    }

    function stopLiveLog() {
        clearInterval(_liveInterval);
        _liveInterval = null;
        if (_liveProxyId) {
            fetch(`${API_BASE}/traffic-logs/live/${_liveProxyId}`, { method: 'DELETE' }).catch(() => {});
        }
        _liveProxyId = null;
        $('#liveStartBtn').show();
        $('#liveStopBtn').hide();
        $('#liveProxySelect, #liveIntervalSelect, #liveInitialLines, #liveKeyword, #liveClientIp, #liveUrlHost').prop('disabled', false);
        setLiveStatus('중지됨', '');
    }

    function initLiveLog() {
        $('#liveStartBtn').off('click').on('click', startLiveLog);
        $('#liveStopBtn').off('click').on('click', stopLiveLog);
        $('#liveClearBtn').off('click').on('click', () => {
            $('#liveTableBody').empty().append(
                '<tr id="liveTablePlaceholder"><td colspan="7" style="text-align:center;color:var(--color-text-muted);padding:2rem;">로그 영역을 지웠습니다.</td></tr>'
            );
        });
    }
    // ─────────────────────────────────────────────────────────────

    $(document).ready(() => {
        initTrafficLogs();
        initLiveLog();
    });

    // PJAX 페이지 전환 대응
    $(document).off('pjax:complete.tl').on('pjax:complete.tl', function(e, url) {
        if (url.includes('/traffic-logs')) {
            stopLiveLog();
            initTrafficLogs();
            initLiveLog();
        }
    });
})();
