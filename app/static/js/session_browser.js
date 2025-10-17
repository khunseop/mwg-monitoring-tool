$(document).ready(function() {
    const sb = { proxies: [], groups: [] };
    const STORAGE_KEY = 'sb_state_v1';

    function showErr(msg) { $('#sbError').text(msg).show(); }
    function clearErr() { $('#sbError').hide().text(''); }
    function setStatus(text, isError) {
        const $t = $('#sbStatus');
        $t.text(text || '');
        $t.removeClass('is-success is-danger is-light');
        if (isError) $t.addClass('is-danger'); else $t.addClass(text ? 'is-success' : 'is-light');
    }

    function getSelectedProxyIds() {
        // Tom-select might not be initialized, so check for its instance
        const select = document.getElementById('sbProxySelect');
        if (select && select.tomselect) {
            return (select.tomselect.getValue() || []).map(v => parseInt(v, 10));
        }
        // Fallback for standard select
        return ($('#sbProxySelect').val() || []).map(v => parseInt(v, 10));
    }

    function saveState() {
        try {
            const state = {
                groupId: $('#sbGroupSelect').val() || '',
                proxyIds: getSelectedProxyIds(),
                savedAt: Date.now()
            };
            localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
        } catch (e) {
            console.error("Failed to save state to localStorage", e);
            setStatus('로컬 저장 실패', true);
        }
    }

    function restoreState() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) return;
            const state = JSON.parse(raw);

            // Restore group selection
            const groupSelect = document.getElementById('sbGroupSelect');
            if (groupSelect && groupSelect.tomselect && state.groupId) {
                groupSelect.tomselect.setValue(String(state.groupId || ''), true); // silent=true
            } else if (groupSelect) {
                $(groupSelect).val(state.groupId);
            }

            // Restore proxy selection - wait for DeviceSelector to populate options
            // The 'onData' callback in DeviceSelector init handles the actual selection restoration
            const proxySelect = document.getElementById('sbProxySelect');
            if (proxySelect && proxySelect.tomselect && Array.isArray(state.proxyIds)) {
                 // We need to ensure the options are available before setting the value.
                 // This is better handled in the DeviceSelector's `onData` or `then` block.
            }

        } catch (e) {
            console.error("Failed to restore state from localStorage", e);
        }
    }

    function loadLatest() {
        clearErr();
        const proxyIds = getSelectedProxyIds();
        if (proxyIds.length === 0) {
            showErr('프록시를 하나 이상 선택하세요.');
            return;
        }
        setStatus('수집 중...');

        // This just triggers the collection on the backend.
        // The grid itself will be responsible for fetching the new data.
        $.ajax({
            url: '/api/session-browser/collect',
            method: 'POST',
            contentType: 'application/json',
            data: JSON.stringify({ proxy_ids: proxyIds })
        }).then(res => {
            setStatus('완료');
            if (res && res.failed && res.failed > 0) {
                showErr('일부 프록시 수집에 실패했습니다.');
            }

            // Now, tell the AG-Grid to load the data (force=true)
            if (window.sessionBrowserGrid) {
                window.sessionBrowserGrid.loadData(proxyIds, true);
            }

            // Trigger analysis
            try {
                if (window.SbAnalyze && typeof window.SbAnalyze.run === 'function') {
                    window.SbAnalyze.run({ proxyIds: proxyIds });
                    $('#sbAnalyzeSection').show();
                }
            } catch (e) {
                console.error("Failed to run analysis", e);
            }

        }).catch((xhr) => {
            setStatus('오류', true);
            const errorMsg = (xhr.responseJSON && xhr.responseJSON.detail) ? xhr.responseJSON.detail : '수집 요청 중 오류가 발생했습니다.';
            showErr(errorMsg);
        });
    }

    $('#sbLoadBtn').on('click', function() {
        loadLatest();
    });

    $('#sbExportBtn').on('click', function() {
        const gridOptions = window.sessionBrowserGrid ? window.sessionBrowserGrid.gridOptions : null;
        if (!gridOptions) {
            showErr("Grid not initialized.");
            return;
        }

        const sortModel = gridOptions.api.getSortModel();
        const filterModel = gridOptions.api.getFilterModel();
        const proxyIds = getSelectedProxyIds();

        const payload = {
            proxy_ids: proxyIds,
            sortModel: sortModel,
            filterModel: filterModel
        };

        fetch('/api/session-browser/export', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        })
        .then(resp => {
            if (resp.ok) {
                return resp.blob().then(blob => {
                    const url = window.URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.style.display = 'none';
                    a.href = url;
                    // Provide a filename
                    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
                    a.download = `session-browser-export-${timestamp}.xlsx`;
                    document.body.appendChild(a);
                    a.click();
                    window.URL.revokeObjectURL(url);
                    document.body.removeChild(a);
                });
            } else {
                 resp.json().then(data => showErr(data.detail || '엑셀 내보내기에 실패했습니다.'));
            }
        })
        .catch(err => {
            console.error('Export error:', err);
            showErr('엑셀 내보내기 중 오류가 발생했습니다.');
        });
    });

    $('#sbGroupSelect, #sbProxySelect').on('change', function() {
        saveState();
    });

    DeviceSelector.init({
        groupSelect: '#sbGroupSelect',
        proxySelect: '#sbProxySelect',
        selectAll: '#sbSelectAll',
        allowAllGroups: false,
        onData: function(data) {
            sb.groups = data.groups || [];
            sb.proxies = data.proxies || [];
            // Once data is loaded, try to restore state which might depend on the options now being available
            restoreState();
        }
    }).then(function() {
        // Initial data load for the grid after device selector is ready
        const proxyIds = getSelectedProxyIds();
        if (window.sessionBrowserGrid && proxyIds.length > 0) {
            window.sessionBrowserGrid.loadData(proxyIds, false);
        } else if (window.sessionBrowserGrid) {
            // If no proxies are selected initially, ensure the grid is cleared
             window.sessionBrowserGrid.gridOptions.api.setRowData([]);
        }
    });

    // Cross-tab sync
    window.addEventListener('storage', function(e) {
        if (e.key === STORAGE_KEY) {
            restoreState();
            const proxyIds = getSelectedProxyIds();
            if (window.sessionBrowserGrid) {
                window.sessionBrowserGrid.loadData(proxyIds, false);
            }
        }
    });
});

// Detail modal logic remains, but will be triggered by AG-Grid
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