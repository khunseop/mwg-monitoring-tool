// 섹션 탭 관리
function activateSectionTab(targetId) {
    document.querySelectorAll('.tabs li').forEach(t => {
        if (t.dataset && t.dataset.target) {
            t.classList.toggle('is-active', t.dataset.target === targetId);
        }
    });
    document.querySelectorAll('.tab-content').forEach(section => {
        section.classList.toggle('is-active', section.id === targetId);
    });
}

document.addEventListener('DOMContentLoaded', function() {
    // 섹션 탭 클릭 이벤트
    document.querySelectorAll('.tabs li').forEach(tab => {
        tab.addEventListener('click', function(e) {
            e.preventDefault();
            const target = this.dataset.target;
            if (target) {
                activateSectionTab(target);
            }
        });
    });

    // URL 쿼리 파라미터로 섹션 탭 활성화
    const params = new URLSearchParams(window.location.search);
    const section = params.get('section');
    if (section === 'groups') {
        activateSectionTab('proxy-groups-section');
    } else {
        activateSectionTab('proxy-list-section');
    }
});

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
    } else {
        $('#groupId').val(data.id);
        $('#groupName').val(data.name);
        $('#groupDescription').val(data.description || '');
    }
}

// 프록시 관리
function loadProxies() {
    $.get('/api/proxies')
        .done(proxies => {
            const tbody = $('#proxyTableBody');
            tbody.empty();
            
            proxies.forEach(proxy => {
                tbody.append(`
                    <tr>
                        <td>${proxy.host}</td>
                        <td>${proxy.group_name || '-'}</td>
                        <td>${proxy.is_active ? '<span class="tag is-success">활성</span>' : '<span class="tag is-danger">비활성</span>'}</td>
                        <td>${proxy.description || ''}</td>
                        <td>
                            <div class="buttons">
                                <button class="button is-secondary is-light" onclick="openModal('proxy', ${proxy.id})">수정</button>
                                <button class="button is-danger is-light" onclick="deleteProxy(${proxy.id})">삭제</button>
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
    
    const data = {
        host: $('#host').val(),
        username: $('#username').val(),
        traffic_log_path: ($('#traffic_log_path').val() || '').trim(),
        is_active: $('#is_active').is(':checked'),
        group_id: $('#group_id').val() ? parseInt($('#group_id').val()) : null,
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
                        <td>${group.name}</td>
                        <td>${group.description || ''}</td>
                        <td>${group.proxies_count}</td>
                        <td>
                            <div class="buttons">
                                <button class="button is-secondary is-light" onclick="openModal('group', ${group.id})">수정</button>
                                <button class="button is-danger is-light" onclick="deleteGroup(${group.id})">삭제</button>
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

function parseCsvLinesToProxies(text) {
    const lines = (text || '').split(/\r?\n/);
    const proxies = [];
    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i].trim();
        if (raw.length === 0) continue;
        // Split by comma, keeping empty entries
        const parts = raw.split(',').map(s => (s == null ? '' : s.trim()));
        const host = parts[0] || '';
        const username = parts[1] || '';
        const password = parts[2] || '';
        if (!host || !username || !password) {
            // Skip malformed line
            continue;
        }
        const groupNameRaw = parts[3] || '';
        const trafficLogPathRaw = parts[4] || '';
        const isActiveRaw = parts[5] || '';
        const descriptionRaw = parts.slice(6).join(','); // allow commas in description by joining remainder

        const payload = {
            host,
            username,
            password,
        };
        if (groupNameRaw && groupNameRaw.trim().length > 0) {
            payload.group_name = groupNameRaw.trim();
        }
        if (trafficLogPathRaw && trafficLogPathRaw.trim().length > 0) {
            payload.traffic_log_path = trafficLogPathRaw.trim();
        }
        if (isActiveRaw) {
            const lowered = isActiveRaw.toLowerCase();
            if (['true','1','yes','y','on'].includes(lowered)) payload.is_active = true;
            else if (['false','0','no','n','off'].includes(lowered)) payload.is_active = false;
        }
        if (descriptionRaw && descriptionRaw.trim().length > 0) {
            payload.description = descriptionRaw.trim();
        }
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

// 초기화
$(document).ready(() => {
    loadProxies();
    loadGroups();
});

// expose for inline handlers
window.openBulkProxyModal = openBulkProxyModal;
window.closeBulkProxyModal = closeBulkProxyModal;
window.submitBulkProxies = submitBulkProxies;
window.openModal = openModal;
window.closeModal = closeModal;
window.saveProxy = saveProxy;
window.deleteProxy = deleteProxy;
window.saveGroup = saveGroup;
window.deleteGroup = deleteGroup;
