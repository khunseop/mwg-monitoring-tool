(function(){
    'use strict';
    
    const API_BASE = '/api';
    let PROXIES = [];
    const STORAGE_KEY = 'tl_state_v1';
    let IS_RESTORING = false;
    let CURRENT_VIEW = 'remote';
    let tlGridApi = null;
    let LOG_RECORDS = [];

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
        $tag.removeClass().addClass('tag').addClass(cls || 'is-light');
    }

    function showError(msg){
        $('#tlError').text(msg).fadeIn();
    }

    function clearError(){ $('#tlError').hide().text(''); }

    function showDetail(record){
        const $body = $('#tlDetailBody');
        const $raw = $('#tlDetailRaw');
        $body.empty();
        $raw.text(record.url_path || ''); // 원본 라인 표시용 (있다면)

        COLS.forEach(c => {
            let v = record[c];
            if(v === null || v === undefined) v = '';
            let formatted = v;
            if(c === 'datetime' || c === 'collected_at'){
                formatted = (window.AppUtils && AppUtils.formatDateTime) ? AppUtils.formatDateTime(v) : v;
            }else if(c === 'response_statuscode'){
                formatted = (window.AppUtils && AppUtils.renderStatusTag) ? AppUtils.renderStatusTag(v) : String(v);
            }else if(c === 'recv_byte' || c === 'sent_byte' || c === 'content_lenght'){
                formatted = (window.AppUtils && AppUtils.formatBytes) ? AppUtils.formatBytes(v) : v;
            }else if(c === 'timeintransaction'){
                var num = Number(v);
                if(Number.isFinite(num)){
                    formatted = (window.AppUtils && AppUtils.formatDurationMs) ? AppUtils.formatDurationMs(num < 1000 ? num * 1000 : num) : v;
                }
            }
            const isUrlish = (c === 'url_path' || c === 'url_parametersstring' || c === 'referer' || c === 'url_host' || c === 'user_agent');
            const cls = isUrlish ? '' : (c === 'recv_byte' || c === 'sent_byte' || c === 'content_lenght' || c === 'response_statuscode' ? 'num' : '');
            $body.append(`<tr><th style="width: 220px; font-size: 0.75rem; color: #888;">${c.toUpperCase()}</th><td class="${cls}" style="font-size: 0.825rem;">${typeof formatted === 'string' ? formatted : String(formatted)}</td></tr>`);
        });
        $('#tlDetailModal').addClass('is-active');
    }
    
    window.showTrafficLogDetail = showDetail;

    function saveState(records){
        try {
            const state = {
                proxyId: $('#tlProxySelect').val(),
                groupId: $('#tlGroupSelect').val(),
                query: $('#tlQuery').val(),
                limit: $('#tlLimit').val(),
                direction: $('#tlDirection').val(),
                records: records || []
            };
            localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
        } catch(e) {}
    }

    function restoreState(){
        try {
            const saved = localStorage.getItem(STORAGE_KEY);
            if (!saved) return;
            const state = JSON.parse(saved);
            IS_RESTORING = true;
            
            if (state.query !== undefined) $('#tlQuery').val(state.query);
            if (state.limit !== undefined) $('#tlLimit').val(state.limit);
            if (state.direction !== undefined) $('#tlDirection').val(state.direction);
            
            setTimeout(() => {
                if (state.groupId) $('#tlGroupSelect').val(state.groupId).trigger('change');
                setTimeout(() => {
                    if (state.proxyId) $('#tlProxySelect').val(state.proxyId);
                    if (state.records && state.records.length > 0) {
                        LOG_RECORDS = state.records;
                        renderTable(LOG_RECORDS);
                    }
                    IS_RESTORING = false;
                }, 150);
            }, 100);
        } catch(e) { IS_RESTORING = false; }
    }

    async function loadLogs(){
        const proxyId = $('#tlProxySelect').val();
        if (!proxyId) {
            showError('프록시를 선택하세요.');
            return;
        }
        
        clearError();
        setStatus('조회 중...', 'is-warning');
        $('#tlEmptyState').hide();
        
        try {
            const query = $('#tlQuery').val() || '';
            const limit = $('#tlLimit').val() || 200;
            const direction = $('#tlDirection').val() || 'tail';
            
            const res = await fetch(`${API_BASE}/traffic-logs/${proxyId}?q=${encodeURIComponent(query)}&limit=${limit}&direction=${direction}&parsed=true`);
            if (!res.ok) throw new Error('로그 조회에 실패했습니다. (SSH 연결 확인 필요)');
            
            const data = await res.json();
            const records = data.records || [];
            LOG_RECORDS = records;

            if (records.length === 0) {
                $('#tlResultParsed').hide();
                $('#tlEmptyState').fadeIn();
                setStatus('데이터 없음', 'is-light');
            } else {
                renderTable(records);
                setStatus(`${records.length}건 조회됨`, 'is-success');
            }
            saveState(records);
        } catch(err) {
            showError(err.message);
            setStatus('실패', 'is-danger');
        }
    }

    function renderTable(records){
        if (!tlGridApi) {
            const gridOptions = {
                columnDefs: COLS.map(c => ({ 
                    field: c, 
                    headerName: c.replace(/_/g, ' ').toUpperCase(), 
                    width: 150,
                    filter: true,
                    sortable: true
                })),
                defaultColDef: {
                    resizable: true,
                    filter: 'agTextColumnFilter',
                    menuTabs: ['filterMenuTab']
                },
                rowData: records,
                pagination: true,
                paginationPageSize: 100,
                rowHeight: 32,
                headerHeight: 38,
                onRowDoubleClicked: params => showDetail(params.data),
                theme: 'quartz',
                overlayNoRowsTemplate: '<div style="padding: 20px; text-align: center; color: var(--color-text-muted);">조회된 로그 데이터가 없습니다.</div>'
            };
            tlGridApi = agGrid.createGrid(document.querySelector('#tlTableGrid'), gridOptions);
        } else {
            tlGridApi.setGridOption('rowData', records);
        }
        $('#tlResultParsed').fadeIn();
    }

    $(document).ready(() => {
        // DeviceSelector 초기화 (트래픽 로그용 커스텀: 단일 선택 지원을 위해 수동 연동)
        // 기존 DeviceSelector.init은 multiple 위주이므로, 로그 조회는 단순 select로 처리
        
        function loadGroups() {
            $.getJSON(`${API_BASE}/proxy-groups`).done(data => {
                const $gs = $('#tlGroupSelect');
                $gs.empty().append('<option value="">전체</option>');
                data.forEach(g => $gs.append(`<option value="${g.id}">${g.name}</option>`));
                
                $gs.on('change', () => {
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

        $('#tlLoadBtn').on('click', loadLogs);
        
        $('#tlQuickFilter').on('input', function() {
            if (tlGridApi) tlGridApi.setGridOption('quickFilterText', $(this).val());
        });

        $('.modal-background, .modal-card-head .delete, .modal-card-foot .button').on('click', () => {
            $('.modal').removeClass('is-active');
        });
        
        // URL 경로 처리
        if (window.location.pathname === '/traffic-logs/upload') {
            $('#tlRemoteSection').hide();
            $('#tlaSection').show();
        }
    });
})();
