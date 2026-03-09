// URL 및 탭 기반 섹션 표시
function switchProxySection(section) {
    if (section === 'list') {
        $('#proxy-list-tab').addClass('is-active');
        $('#proxy-groups-tab').removeClass('is-active');
        $('#proxy-list-section').show();
        $('#proxy-groups-section').hide();
        // URL 업데이트 (히스토리 저장 없이)
        window.history.replaceState(null, '', '/proxy');
    } else {
        $('#proxy-list-tab').removeClass('is-active');
        $('#proxy-groups-tab').addClass('is-active');
        $('#proxy-list-section').hide();
        $('#proxy-groups-section').show();
        // URL 업데이트
        window.history.replaceState(null, '', '/proxy/groups');
    }
}

// 초기화 함수
function initProxyPage() {
    // URL 경로에 따라 초기 섹션 설정
    const path = window.location.pathname;
    if (path === '/proxy/groups') {
        switchProxySection('groups');
    } else {
        switchProxySection('list');
    }
    
    loadProxies();
    loadGroups();
}

// 모달 관리
function openModal(type, id = null) {
    const modalId = `${type}Modal`;
    if (id) {
        const endpoint = type === 'proxy' ? 'proxies' : 'proxy-groups';
        $.get(`/api/${endpoint}/${id}`)
            .done(data => fillForm(type, data))
            .fail(() => (window.AppUtils && AppUtils.showError('데이터를 불러오는데 실패했습니다.')));
    } else {
        try { document.getElementById(`${type}Form`).reset(); } catch (e) {}
        $(`#${type}Id`).val('');
    }
    $(`#${modalId}`).addClass('is-active');
}

function closeModal(type) {
    $(`#${type}Modal`).removeClass('is-active');
}

function fillForm(type, data) {
    if (type === 'proxy') {
        $('#proxyId').val(data.id);
        $('#host').val(data.host);
        $('#username').val(data.username);
        $('#password').val('');
        $('#traffic_log_path').val(data.traffic_log_path || '');
        $('#group_id').val(data.group_id || '');
        $('#description').val(data.description || '');
        $('#is_active').prop('checked', data.is_active);

        // OID 개별 설정 초기화
        $('#proxyInterfaceList').empty();
        $('#use_custom_oids').prop('checked', false);
        $('#customOidSection').hide();

        if (data.oids_json) {
            try {
                const oids = JSON.parse(data.oids_json);
                if (oids && oids.__interface_oids__ && Object.keys(oids.__interface_oids__).length > 0) {
                    $('#use_custom_oids').prop('checked', true);
                    $('#customOidSection').show();
                    
                    for (const [name, config] of Object.entries(oids.__interface_oids__)) {
                        const in_oid = typeof config === 'string' ? config : (config.in_oid || '');
                        const out_oid = typeof config === 'object' ? (config.out_oid || '') : '';
                        addProxyInterfaceRow(name, in_oid, out_oid);
                    }
                }
            } catch (e) {
                console.error('Failed to parse oids_json:', e);
            }
        }
    } else {
        $('#groupId').val(data.id);
        $('#groupName').val(data.name);
        $('#groupDescription').val(data.description || '');
    }
}

function toggleCustomOids() {
    const isChecked = $('#use_custom_oids').is(':checked');
    if (isChecked) {
        $('#customOidSection').show();
        if ($('#proxyInterfaceList tr').length === 0) {
            addProxyInterfaceRow();
        }
    } else {
        $('#customOidSection').hide();
    }
}

function addProxyInterfaceRow(name = '', in_oid = '', out_oid = '') {
    const row = `
        <tr style="border-bottom: 1px solid var(--color-border-light);">
            <td style="padding: 0.5rem 0.25rem;"><input class="input is-small if-name" type="text" value="${name}" placeholder="eth0" style="background: white;"></td>
            <td style="padding: 0.5rem 0.25rem;"><input class="input is-small if-in-oid" type="text" value="${in_oid}" placeholder="1.3.6.1..." style="background: white;"></td>
            <td style="padding: 0.5rem 0.25rem;"><input class="input is-small if-out-oid" type="text" value="${out_oid}" placeholder="1.3.6.1..." style="background: white;"></td>
            <td class="has-text-centered" style="padding: 0.5rem 0.25rem;">
                <button class="button is-small is-ghost px-0 py-0" onclick="$(this).closest('tr').remove()" title="삭제" style="color: var(--color-text-muted); height: auto; font-weight: bold;">
                    <span>삭제</span>
                </button>
            </td>
        </tr>
    `;
    $('#proxyInterfaceList').append(row);
}

// 프록시 관리
function loadProxies() {
    $.get('/api/proxies')
        .done(proxies => {
            const tbody = $('#proxyTableBody');
            tbody.empty();
            
            proxies.forEach(proxy => {
                const statusTag = proxy.is_active 
                    ? '<span class="tag is-success is-light" style="font-weight:600;">활성</span>' 
                    : '<span class="tag is-danger is-light" style="font-weight:600;">비활성</span>';
                
                tbody.append(`
                    <tr>
                        <td class="px-5 py-3 has-text-weight-semibold">${proxy.host}</td>
                        <td class="py-3">${proxy.group_name || '<span class="has-text-grey-light">없음</span>'}</td>
                        <td class="has-text-centered py-3">${statusTag}</td>
                        <td class="py-3 is-size-7 has-text-grey">${proxy.description || ''}</td>
                        <td class="has-text-centered py-2">
                            <div class="buttons is-centered">
                                <button class="button is-subtle is-small" onclick="openModal('proxy', ${proxy.id})" title="수정">
                                    <span>수정</span>
                                </button>
                                <button class="button is-subtle is-small" onclick="cloneProxy(${proxy.id})" title="복제">
                                    <span>복제</span>
                                </button>
                                <button class="button is-subtle is-small has-text-danger" onclick="deleteProxy(${proxy.id})" title="삭제">
                                    <span>삭제</span>
                                </button>
                            </div>
                        </td>
                    </tr>
                `);
            });
        })
        .fail(() => (window.AppUtils && AppUtils.showError('프록시 목록을 불러오는데 실패했습니다.')));

    // 그룹 선택 옵션 업데이트
    $.get('/api/proxy-groups')
        .done(groups => {
            const select = $('#group_id');
            select.find('option:gt(0)').remove();
            groups.forEach(group => {
                select.append(`<option value="${group.id}">${group.name}</option>`);
            });
        });
}

function saveProxy() {
    const proxyId = $('#proxyId').val();
    const password = $('#password').val();
    
    // OID 개별 설정 수집
    let oids_json = null;
    if ($('#use_custom_oids').is(':checked')) {
        const interfaceOids = {};
        $('#proxyInterfaceList tr').each(function() {
            const name = $(this).find('.if-name').val().trim();
            const in_oid = $(this).find('.if-in-oid').val().trim();
            const out_oid = $(this).find('.if-out-oid').val().trim();
            if (name && (in_oid || out_oid)) {
                interfaceOids[name] = { in_oid, out_oid };
            }
        });
        
        if (Object.keys(interfaceOids).length > 0) {
            oids_json = JSON.stringify({
                __interface_oids__: interfaceOids
            });
        }
    }

    const data = {
        host: $('#host').val(),
        username: $('#username').val(),
        traffic_log_path: ($('#traffic_log_path').val() || '').trim(),
        is_active: $('#is_active').is(':checked'),
        group_id: $('#group_id').val() ? parseInt($('#group_id').val()) : null,
        oids_json: oids_json,
        description: $('#description').val() || null
    };

    if (!proxyId) {
        if (!password || password.length === 0) {
            if (window.AppUtils) AppUtils.showError('비밀번호는 필수입니다.');
            return;
        }
        data.password = password;
    } else if (password) {
        data.password = password;
    }

    const method = proxyId ? 'PUT' : 'POST';
    const url = proxyId ? `/api/proxies/${proxyId}` : '/api/proxies';

    $.ajax({
        url,
        method,
        contentType: 'application/json',
        data: JSON.stringify(data),
        success: () => {
            loadProxies();
            closeModal('proxy');
        },
        error: (xhr) => (window.AppUtils && AppUtils.showError(xhr.responseText))
    });
}

function deleteProxy(id) {
    if (confirm('정말 삭제하시겠습니까?')) {
        $.ajax({
            url: `/api/proxies/${id}`,
            method: 'DELETE',
            success: loadProxies,
            error: (xhr) => (window.AppUtils && AppUtils.showError(xhr.responseText))
        });
    }
}

// 그룹 관리
function loadGroups() {
    $.get('/api/proxy-groups')
        .done(groups => {
            const tbody = $('#groupTableBody');
            tbody.empty();
            
            groups.forEach(group => {
                tbody.append(`
                    <tr>
                        <td class="px-5 py-3 has-text-weight-semibold">${group.name}</td>
                        <td class="py-3 is-size-7 has-text-grey">${group.description || ''}</td>
                        <td class="has-text-centered py-3">
                            <span class="tag is-info is-light" style="font-weight:700;">${group.proxies_count}</span>
                        </td>
                        <td class="has-text-centered py-2">
                            <div class="buttons is-centered">
                                <button class="button is-subtle is-small" onclick="openModal('group', ${group.id})">
                                    <span>수정</span>
                                </button>
                                <button class="button is-subtle is-small has-text-danger" onclick="deleteGroup(${group.id})">
                                    <span>삭제</span>
                                </button>
                            </div>
                        </td>
                    </tr>
                `);
            });
        })
        .fail((xhr) => {
            if (window.AppUtils) AppUtils.showError('그룹 목록을 불러오는데 실패했습니다.');
        });
}

function saveGroup() {
    const groupId = $('#groupId').val();
    const data = {
        name: $('#groupName').val(),
        description: $('#groupDescription').val() || null
    };

    const method = groupId ? 'PUT' : 'POST';
    const url = groupId ? `/api/proxy-groups/${groupId}` : '/api/proxy-groups';

    $.ajax({
        url,
        method,
        contentType: 'application/json',
        data: JSON.stringify(data),
        success: () => {
            loadGroups();
            loadProxies();
            closeModal('group');
        },
        error: (xhr) => (window.AppUtils && AppUtils.showError(xhr.responseText))
    });
}

function deleteGroup(id) {
    if (confirm('정말 삭제하시겠습니까?\n그룹에 속한 프록시들은 기본 그룹으로 이동됩니다.')) {
        $.ajax({
            url: `/api/proxy-groups/${id}`,
            method: 'DELETE',
            success: () => {
                loadGroups();
                loadProxies();
            },
            error: (xhr) => (window.AppUtils && AppUtils.showError(xhr.responseText))
        });
    }
}

// 일괄 등록 UI helpers
function openBulkProxyModal() {
    try { $('#bulkProxyInput').val(''); } catch (e) {}
    $('#bulkProxyModal').addClass('is-active');
}

function closeBulkProxyModal() {
    $('#bulkProxyModal').removeClass('is-active');
}

function downloadProxySampleCsv() {
    const header = "host,user,pass,group,log_path,active,desc,oids_json\n";
    const sample = '10.10.10.1,admin,mypassword123,서울센터,/var/log/mwg/traffic.log,true,Primary MWG,"{\"__interface_oids__\":{\"eth0\":{\"in_oid\":\"1.3.6.1.2.1.2.2.1.10.1\",\"out_oid\":\"1.3.6.1.2.1.2.2.1.16.1\"}}}"\n';
    const blob = new Blob(["\ufeff" + header + sample], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.setAttribute("download", "pmt_proxy_sample.csv");
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

function exportProxiesToCsv() {
    $.get('/api/proxies')
        .done(proxies => {
            const header = "host,user,pass,group,log_path,active,desc,oids_json\n";
            let csv = header;
            proxies.forEach(p => {
                const fields = [
                    p.host,
                    p.username || '',
                    '', // password is not exported for security
                    p.group_name || '',
                    p.traffic_log_path || '',
                    p.is_active ? 'true' : 'false',
                    p.description || '',
                    p.oids_json ? JSON.stringify(p.oids_json) : ''
                ];
                
                const row = fields.map(f => {
                    const str = String(f);
                    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
                        return '"' + str.replace(/"/g, '""') + '"';
                    }
                    return str;
                }).join(',');
                csv += row + '\n';
            });
            
            const blob = new Blob(["\ufeff" + csv], { type: 'text/csv;charset=utf-8;' });
            const link = document.createElement("a");
            link.href = URL.createObjectURL(blob);
            link.setAttribute("download", `pmt_proxies_export_${new Date().toISOString().split('T')[0]}.csv`);
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
        })
        .fail(() => (window.AppUtils && AppUtils.showError('내보내기 실패')));
}

function parseCsvLinesToProxies(text) {
    const lines = (text || '').split(/\r?\n/);
    const proxies = [];
    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i].trim();
        if (raw.length === 0) continue;
        
        // Robust CSV parser (handles quoted strings and escaped quotes)
        const parts = [];
        let current = '';
        let inQuotes = false;
        for (let j = 0; j < raw.length; j++) {
            const char = raw[j];
            const nextChar = raw[j+1];

            if (char === '"') {
                if (inQuotes && nextChar === '"') {
                    // Escaped quote
                    current += '"';
                    j++;
                } else {
                    // Toggle quote mode
                    inQuotes = !inQuotes;
                }
            } else if (char === ',' && !inQuotes) {
                parts.push(current.trim());
                current = '';
            } else {
                current += char;
            }
        }
        parts.push(current.trim());

        // Skip header if it matches "host,user,pass"
        if (i === 0 && parts[0].toLowerCase() === 'host' && parts[1].toLowerCase() === 'user') continue;

        const host = parts[0] || '';
        const username = parts[1] || '';
        const password = parts[2] || '';
        if (!host || !username) continue; // password might be empty for existing records if we supported updates via CSV, but for create it's usually needed.
        
        const groupNameRaw = parts[3] || '';
        const trafficLogPathRaw = parts[4] || '';
        const isActiveRaw = parts[5] || '';
        const descriptionRaw = parts[6] || '';
        let oidsJsonRaw = parts[7] || '';

        const payload = { host, username, password };
        if (groupNameRaw) payload.group_name = groupNameRaw;
        if (trafficLogPathRaw) payload.traffic_log_path = trafficLogPathRaw;
        if (isActiveRaw) {
            const lowered = isActiveRaw.toLowerCase();
            if (['true','1','yes','y','on'].includes(lowered)) payload.is_active = true;
            else if (['false','0','no','n','off'].includes(lowered)) payload.is_active = false;
        }
        
        // If oids_json is provided
        if (oidsJsonRaw) {
            // If it's already a valid JSON string, use it. 
            // The parser handles escaped quotes if they were provided correctly.
            payload.oids_json = oidsJsonRaw;
        }
        
        if (descriptionRaw) payload.description = descriptionRaw;
        
        proxies.push(payload);
    }
    return proxies;
}

function submitBulkProxies() {
    const raw = $('#bulkProxyInput').val() || '';
    const items = parseCsvLinesToProxies(raw);
    if (!items.length) {
        if (window.AppUtils) AppUtils.showError('유효한 입력이 없습니다. host,username,password는 필수입니다.');
        return;
    }
    $.ajax({
        url: '/api/proxies/bulk',
        method: 'POST',
        contentType: 'application/json',
        dataType: 'json',
        data: JSON.stringify(items),
        success: (results) => {
            try {
                // Normalize results to an array
                let arr = Array.isArray(results) ? results : [];
                if (!arr.length && results && typeof results === 'string') {
                    try { const parsed = JSON.parse(results); if (Array.isArray(parsed)) arr = parsed; } catch (e) {}
                }
                const created = (arr || []).filter(r => r && r.status === 'created').length;
                const dup = (arr || []).filter(r => r && r.status === 'duplicate').length;
                const errors = (arr || []).filter(r => r && r.status === 'error');
                const groupMissing = (arr || []).filter(r => r && r.status === 'error' && typeof r.detail === 'string' && r.detail.toLowerCase().includes('group not found'));

                // Specific alert for missing group rows
                if (groupMissing.length > 0 && window.AppUtils) {
                    const sample = groupMissing.slice(0, 5).map(e => `${((e && typeof e.index === 'number') ? (e.index + 1) : '?')}:${(e && e.host) || '?'} - ${e && e.detail ? e.detail : '그룹 없음'}`).join('\n');
                    const more = groupMissing.length > 5 ? '\n...' : '';
                    AppUtils.showError(`그룹이 존재하지 않아 실패: ${groupMissing.length}건\n\n예시:\n${sample}${more}`);
                }

                // Success alert for created rows
                if (created > 0 && window.AppUtils) {
                    AppUtils.showInfo(`프록시 ${created}건 등록 완료`);
                }

                // Summary info
                if (window.AppUtils) {
                    let msg = `완료: 생성 ${created}건, 중복 ${dup}건, 오류 ${errors.length}건`;
                    if (errors.length > 0) {
                        const sampleAll = errors.slice(0, 5).map(e => `${((e && typeof e.index === 'number') ? (e.index + 1) : '?')}:${(e && e.host) || '?'} - ${e && e.detail ? e.detail : '오류'}`).join('\n');
                        msg += `\n\n오류 예시:\n${sampleAll}${errors.length > 5 ? '\n...' : ''}`;
                    }
                    AppUtils.showInfo(msg);
                }
            } catch (err) {
                // Swallow UI summarization errors; proceed to close and refresh
                if (window.console && console.warn) console.warn('Bulk summary render failed:', err);
            }
            // Always close & refresh even if summary failed
            closeBulkProxyModal();
            loadProxies();
        },
        error: (xhr) => {
            if (window.AppUtils) AppUtils.showError(xhr.responseText || '일괄 등록 실패');
        }
    });
}

function cloneProxy(id) {
    $.get(`/api/proxies/${id}`)
        .done(data => {
            // 새 프록시 등록 모달을 열되, 기존 데이터로 채움
            try { document.getElementById(`proxyForm`).reset(); } catch (e) {}
            $('#proxyId').val(''); // ID는 비움 (신규 등록)
            $('#host').val(''); // Host도 비움 (수동 입력 필요)
            $('#username').val(data.username);
            $('#password').val(''); // 비밀번호는 보안상 비움
            $('#traffic_log_path').val(data.traffic_log_path || '');
            $('#group_id').val(data.group_id || '');
            $('#description').val(`${data.host} 복제본`);
            $('#is_active').prop('checked', data.is_active);

            // OID 개별 설정 복제
            $('#proxyInterfaceList').empty();
            $('#use_custom_oids').prop('checked', false);
            $('#customOidSection').hide();

            if (data.oids_json) {
                try {
                    const oids = JSON.parse(data.oids_json);
                    if (oids && oids.__interface_oids__ && Object.keys(oids.__interface_oids__).length > 0) {
                        $('#use_custom_oids').prop('checked', true);
                        $('#customOidSection').show();
                        for (const [name, config] of Object.entries(oids.__interface_oids__)) {
                            const in_oid = typeof config === 'string' ? config : (config.in_oid || '');
                            const out_oid = typeof config === 'object' ? (config.out_oid || '') : '';
                            addProxyInterfaceRow(name, in_oid, out_oid);
                        }
                    }
                } catch (e) {}
            }
            $('#proxyModal').addClass('is-active');
        })
        .fail(() => (window.AppUtils && AppUtils.showError('데이터를 불러오는데 실패했습니다.')));
}

async function syncGroupOids() {
    const proxies = await $.get('/api/proxies');
    if (!proxies || proxies.length === 0) return;

    // 커스텀 OID가 설정된 프록시 목록 추출
    const sourceProxies = proxies.filter(p => {
        if (!p.oids_json) return false;
        try {
            const oids = JSON.parse(p.oids_json);
            return oids && oids.__interface_oids__ && Object.keys(oids.__interface_oids__).length > 0;
        } catch(e) { return false; }
    });

    if (sourceProxies.length === 0) {
        alert('그룹에 적용할 커스텀 OID 설정이 있는 프록시가 없습니다.\n먼저 하나의 프록시에 대해 OID 개별 설정을 완료하세요.');
        return;
    }

    // 소스 선택 팝업 (간단하게 prompt/confirm 조합으로 구현하거나 전용 모달 필요하지만, 여기선 confirm 활용)
    let msg = "OID 설정을 복사할 소스 장비를 선택하세요 (번호 입력):\n\n";
    sourceProxies.forEach((p, i) => {
        msg += `${i+1}. ${p.host} (${p.group_name || '그룹없음'})\n`;
    });

    const choice = prompt(msg);
    if (!choice) return;
    
    const idx = parseInt(choice, 10) - 1;
    if (isNaN(idx) || !sourceProxies[idx]) {
        alert('잘못된 선택입니다.');
        return;
    }

    const source = sourceProxies[idx];
    const targetGroup = source.group_id;
    const targets = proxies.filter(p => p.group_id === targetGroup && p.id !== source.id);

    if (targets.length === 0) {
        alert(`'${source.group_name}' 그룹에 다른 장비가 없습니다.`);
        return;
    }

    if (!confirm(`${source.host}의 OID 설정을 '${source.group_name}' 그룹 내 다른 ${targets.length}개 장비에 모두 동일하게 적용하시겠습니까?`)) {
        return;
    }

    let successCount = 0;
    for (const target of targets) {
        try {
            const updateData = {
                oids_json: source.oids_json
            };
            await $.ajax({
                url: `/api/proxies/${target.id}`,
                method: 'PUT',
                contentType: 'application/json',
                data: JSON.stringify(updateData)
            });
            successCount++;
        } catch (e) {
            console.error(`Failed to sync for ${target.host}:`, e);
        }
    }

    alert(`${successCount}개 장비의 OID 설정 동기화 완료`);
    loadProxies();
}

// 초기화
$(document).ready(() => {
    initProxyPage();
    
    $('#btnSyncGroupOids').on('click', syncGroupOids);
});

// PJAX 지원: 페이지 전환 후 초기화 재실행
$(document).on('pjax:complete', function(e, url) {
    if (url.includes('/proxy')) {
        initProxyPage();
    }
});

// expose for inline handlers
window.cloneProxy = cloneProxy;
window.syncGroupOids = syncGroupOids;
window.switchProxySection = switchProxySection;
window.openBulkProxyModal = openBulkProxyModal;
window.closeBulkProxyModal = closeBulkProxyModal;
window.submitBulkProxies = submitBulkProxies;
window.openModal = openModal;
window.closeModal = closeModal;
window.saveProxy = saveProxy;
window.deleteProxy = deleteProxy;
window.saveGroup = saveGroup;
window.deleteGroup = deleteGroup;
window.toggleCustomOids = toggleCustomOids;
window.addProxyInterfaceRow = addProxyInterfaceRow;
window.downloadProxySampleCsv = downloadProxySampleCsv;
window.exportProxiesToCsv = exportProxiesToCsv;
