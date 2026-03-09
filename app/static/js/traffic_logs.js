(function(){
    'use strict';
    
    const API_BASE = '/api';
    let PROXIES = [];
    const STORAGE_KEY = 'tl_state_v1';
    let IS_RESTORING = false;
    let tlGridApi = null;
    let LOG_RECORDS = [];

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
        $tag.removeClass().addClass('tag').addClass(cls || 'is-primary is-light');
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
            const state = {
                proxyId: $('#tlProxySelect').val(),
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
            
            setTimeout(async () => {
                if (state.groupId) $('#tlGroupSelect').val(state.groupId).trigger('change');
                
                // IndexedDB에서 데이터 복원
                if (window.AppDB) {
                    const data = await window.AppDB.get(STORAGE_KEY + '_records');
                    if (data && data.records && data.records.length > 0) {
                        LOG_RECORDS = data.records;
                        renderTable(LOG_RECORDS);
                        setStatus(`${LOG_RECORDS.length}건 복원됨`, 'is-info is-light');
                    }
                }

                setTimeout(() => {
                    if (state.proxyId) $('#tlProxySelect').val(state.proxyId);
                    IS_RESTORING = false;
                }, 150);
            }, 100);
        } catch(e) { 
            console.warn('Failed to restore state', e);
            IS_RESTORING = false; 
        }
    }

    async function loadLogs(){
        const proxyId = $('#tlProxySelect').val();
        if (!proxyId) {
            showError('조회할 프록시를 선택하세요.');
            return;
        }
        
        clearError();
        setStatus('로그 조회 중...', 'is-warning is-light');
        
        // Reset view for new search
        $('#tlEmptyState').hide();
        $('#tlResultParsed').hide();
        $('#tlResultRaw').hide();
        $('#tlLoadBtn').addClass('is-loading');
        
        try {
            const query = $('#tlQuery').val() || '';
            const limit = $('#tlLimit').val() || 200;
            const direction = $('#tlDirection').val() || 'tail';
            
            const res = await fetch(`${API_BASE}/traffic-logs/${proxyId}?q=${encodeURIComponent(query)}&limit=${limit}&direction=${direction}&parsed=true`);
            if (!res.ok) throw new Error('로그를 가져오지 못했습니다. SSH 연결 상태를 확인하세요.');
            
            const data = await res.json();
            const records = data.records || [];
            LOG_RECORDS = records;

            if (records.length === 0) {
                $('#tlEmptyState').fadeIn();
                setStatus('결과 없음', 'is-light');
            } else {
                renderTable(records);
                setStatus(`${records.length}건 조회됨`, 'is-primary is-light');
            }
            await saveState(records);
        } catch(err) {
            showError(err.message);
        } finally {
            $('#tlLoadBtn').removeClass('is-loading');
        }
    }

    function renderTable(records){
        // Ensure empty state is hidden when rendering results
        $('#tlEmptyState').hide();
        
        if (!tlGridApi) {
            const gridOptions = {
                columnDefs: window.AgGridConfig ? window.AgGridConfig.getTrafficLogColumns() : [],
                defaultColDef: {
                    resizable: true,
                    sortable: true,
                    filter: 'agTextColumnFilter',
                    minWidth: 100
                },
                rowData: records,
                pagination: true,
                paginationPageSize: 100,
                rowHeight: 35,
                headerHeight: 45, // Increase header height to prevent text clipping
                onRowDoubleClicked: params => showDetail(params.data),
                overlayNoRowsTemplate: '<div style="padding: 20px; text-align: center; color: var(--color-text-muted);">로그가 비어있습니다.</div>'
            };
            const gridDiv = document.querySelector('#tlTableGrid');
            if (gridDiv && window.agGrid) {
                tlGridApi = window.agGrid.createGrid(gridDiv, gridOptions);
            }
        } else {
            tlGridApi.setGridOption('rowData', records);
        }
        $('#tlResultParsed').fadeIn();
    }

    function initTrafficLogs() {
        function loadGroups() {
            $.getJSON(`${API_BASE}/proxy-groups`).done(data => {
                const $gs = $('#tlGroupSelect');
                $gs.empty().append('<option value="">전체 그룹</option>');
                data.forEach(g => $gs.append(`<option value="${g.id}">${g.name}</option>`));
                
                $gs.off('change').on('change', () => {
                    const gid = $gs.val();
                    const filtered = PROXIES.filter(p => !gid || String(p.group_id) === String(gid));
                    const $ps = $('#tlProxySelect');
                    $ps.empty();
                    if (filtered.length === 0) $ps.append('<option value="">프록시 없음</option>');
                    filtered.forEach(p => $ps.append(`<option value="${p.id}">${p.host}</option>`));
                });
            });
        }

        function loadProxiesList() {
            $.getJSON(`${API_BASE}/proxies`).done(data => {
                PROXIES = data.filter(p => p.is_active);
                $('#tlGroupSelect').trigger('change');
                if (!IS_RESTORING) restoreState();
            });
        }

        loadGroups();
        loadProxiesList();

        $('#tlLoadBtn').off('click').on('click', loadLogs);
        
        $('#tlQuickFilter').off('input').on('input', function() {
            if (tlGridApi) tlGridApi.setGridOption('quickFilterText', $(this).val());
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
