// 공통 유틸리티 함수
const utils = {
    showError: (message) => alert(message || '오류가 발생했습니다.'),
    formatTag: (isActive) => isActive ? 
        '<span class="tag is-success">활성</span>' : 
        '<span class="tag is-danger">비활성</span>',
    resetForm: (formId) => document.getElementById(formId).reset()
};

// 탭 관리
function activateSettingsTab(targetId) {
    document.querySelectorAll('.tabs li').forEach(t => {
        if (t.dataset && t.dataset.target) {
            t.classList.toggle('is-active', t.dataset.target === targetId);
        }
    });
    document.querySelectorAll('.tab-panel').forEach(panel => {
        panel.style.display = 'none';
    });
    const targetEl = document.getElementById(targetId);
    if (targetEl) targetEl.style.display = 'block';
}

// Clicks on navbar submenu are normal links to '/#<id>' so when we land here, sync by hash
function initSettingsTabsFromHash() {
    const hash = (window.location.hash || '#proxy-list').replace('#', '');
    activateSettingsTab(hash);
}

document.addEventListener('DOMContentLoaded', function() {
    initSettingsTabsFromHash();
    window.addEventListener('hashchange', initSettingsTabsFromHash);
});

// 모달 관리
function openModal(type, id = null) {
    const modalId = `${type}Modal`;
    if (id) {
        const endpoint = type === 'proxy' ? 'proxies' : 'proxy-groups';
        $.get(`/api/${endpoint}/${id}`)
            .done(data => fillForm(type, data))
            .fail(() => utils.showError('데이터를 불러오는데 실패했습니다.'));
    } else {
        utils.resetForm(`${type}Form`);
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
        $('#port').val(data.port);
        $('#username').val(data.username);
        $('#password').val('');
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
                        <td>${proxy.port}</td>
                        <td>${proxy.group_name || '-'}</td>
                        <td>${utils.formatTag(proxy.is_active)}</td>
                        <td>${proxy.description || ''}</td>
                        <td>
                            <div class="buttons are-small">
                                <button class="button is-link is-light" onclick="openModal('proxy', ${proxy.id})">
                                    수정
                                </button>
                                <button class="button is-danger is-light" onclick="deleteProxy(${proxy.id})">
                                    삭제
                                </button>
                            </div>
                        </td>
                    </tr>
                `);
            });
        })
        .fail(() => utils.showError('프록시 목록을 불러오는데 실패했습니다.'));

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
        port: parseInt($('#port').val()),
        username: $('#username').val(),
        is_active: $('#is_active').is(':checked'),
        group_id: $('#group_id').val() ? parseInt($('#group_id').val()) : null,
        description: $('#description').val() || null
    };

    if (!proxyId || password) {
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
        error: (xhr) => utils.showError(xhr.responseText)
    });
}

function deleteProxy(id) {
    if (confirm('정말 삭제하시겠습니까?')) {
        $.ajax({
            url: `/api/proxies/${id}`,
            method: 'DELETE',
            success: loadProxies,
            error: (xhr) => utils.showError(xhr.responseText)
        });
    }
}

// 그룹 관리
function loadGroups() {
    $.get('/api/proxy-groups')
        .done(groups => {
            console.log('Loaded groups:', groups);  // 디버깅용
            const tbody = $('#groupTableBody');
            tbody.empty();
            
            groups.forEach(group => {
                tbody.append(`
                    <tr>
                        <td>${group.name}</td>
                        <td>${group.description || ''}</td>
                        <td>${group.proxies_count}</td>
                        <td>
                            <div class="buttons are-small">
                                <button class="button is-link is-light" onclick="openModal('group', ${group.id})">
                                    수정
                                </button>
                                <button class="button is-danger is-light" onclick="deleteGroup(${group.id})">
                                    삭제
                                </button>
                            </div>
                        </td>
                    </tr>
                `);
            });
        })
        .fail((xhr) => {
            console.error('Failed to load groups:', xhr);  // 디버깅용
            utils.showError('그룹 목록을 불러오는데 실패했습니다.');
        });
}

// SNMP 설정 로드/저장
function loadResourceConfig() {
    $.get('/api/resource-config')
        .done(cfg => {
            $('#cfgCommunity').val(cfg.community || 'public');
            const oids = cfg.oids || {};
            $('#cfgOidCpu').val(oids.cpu || '');
            $('#cfgOidMem').val(oids.mem || '');
            $('#cfgOidCc').val(oids.cc || '');
            $('#cfgOidCs').val(oids.cs || '');
            $('#cfgOidHttp').val(oids.http || '');
            $('#cfgOidHttps').val(oids.https || '');
            $('#cfgOidFtp').val(oids.ftp || '');
            $('#cfgStatus').removeClass('is-danger').addClass('is-success').text('불러오기 완료');
        })
        .fail(() => {
            $('#cfgStatus').removeClass('is-success').addClass('is-danger').text('불러오기 실패');
        });
}

function saveResourceConfig() {
    const payload = {
        community: ($('#cfgCommunity').val() || 'public').toString(),
        oids: {
            cpu: $('#cfgOidCpu').val() || undefined,
            mem: $('#cfgOidMem').val() || undefined,
            cc: $('#cfgOidCc').val() || undefined,
            cs: $('#cfgOidCs').val() || undefined,
            http: $('#cfgOidHttp').val() || undefined,
            https: $('#cfgOidHttps').val() || undefined,
            ftp: $('#cfgOidFtp').val() || undefined,
        }
    };
    // remove undefined keys
    Object.keys(payload.oids).forEach(k => { if (!payload.oids[k]) delete payload.oids[k]; });

    $.ajax({
        url: '/api/resource-config',
        method: 'PUT',
        contentType: 'application/json',
        data: JSON.stringify(payload),
        success: () => {
            $('#cfgStatus').removeClass('is-danger').addClass('is-success').text('저장 완료');
        },
        error: () => {
            $('#cfgStatus').removeClass('is-success').addClass('is-danger').text('저장 실패');
        }
    });
}

// 세션브라우저 설정 로드/저장
function loadSessionConfig() {
    $.get('/api/session-browser/config')
        .done(cfg => {
            $('#sbCfgPort').val(cfg.ssh_port || 22);
            $('#sbCfgTimeout').val(cfg.timeout_sec || 10);
            $('#sbCfgHostKeyPolicy').val(cfg.host_key_policy || 'auto_add');
            $('#sbCfgStatus').removeClass('is-danger').addClass('is-success').text('불러오기 완료');
        })
        .fail(() => {
            $('#sbCfgStatus').removeClass('is-success').addClass('is-danger').text('불러오기 실패');
        });
}

function saveSessionConfig() {
    const payload = {
        ssh_port: parseInt($('#sbCfgPort').val(), 10) || 22,
        timeout_sec: parseInt($('#sbCfgTimeout').val(), 10) || 10,
        host_key_policy: ($('#sbCfgHostKeyPolicy').val() || 'auto_add').toString()
    };

    $.ajax({
        url: '/api/session-browser/config',
        method: 'PUT',
        contentType: 'application/json',
        data: JSON.stringify(payload),
        success: () => {
            $('#sbCfgStatus').removeClass('is-danger').addClass('is-success').text('저장 완료');
        },
        error: () => {
            $('#sbCfgStatus').removeClass('is-success').addClass('is-danger').text('저장 실패');
        }
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
        error: (xhr) => utils.showError(xhr.responseText)
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
            error: (xhr) => utils.showError(xhr.responseText)
        });
    }
}

// 초기화
$(document).ready(() => {
    loadProxies();
    loadGroups();
    loadResourceConfig();
    loadSessionConfig();
});

