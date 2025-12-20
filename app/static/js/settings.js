// 레거시 URL 파라미터 지원 (리다이렉트)
document.addEventListener('DOMContentLoaded', function() {
    const params = new URLSearchParams(window.location.search);
    const tab = params.get('tab');
    if (tab && (tab === 'resource-config' || tab === 'session-config')) {
        // 레거시 URL 파라미터 제거하고 통합 페이지로 리다이렉트
        window.history.replaceState({}, '', '/settings');
    }
});

// Interface OID management
let interfaceOidCounter = 0;

function addInterfaceRow(name = '', oids = {}, threshold = '', bandwidth = '') {
    const counter = interfaceOidCounter++;
    const inOid = oids.in_oid || '';
    const outOid = oids.out_oid || '';
    const row = $(`
        <tr class="interface-row" data-counter="${counter}">
            <td>
                <input class="input is-small interface-name" type="text" placeholder="예: eth0" value="${name}">
            </td>
            <td>
                <input class="input is-small interface-in-oid" type="text" placeholder="예: 1.3.6.1.2.1.2.2.1.10.1" value="${inOid}">
            </td>
            <td>
                <input class="input is-small interface-out-oid" type="text" placeholder="예: 1.3.6.1.2.1.2.2.1.16.1" value="${outOid}">
            </td>
            <td>
                <input class="input is-small interface-threshold" type="number" step="0.01" min="0" placeholder="예: 100" value="${threshold}">
            </td>
            <td>
                <input class="input is-small interface-bandwidth" type="number" step="0.1" min="0" placeholder="예: 1000" value="${bandwidth}">
            </td>
            <td>
                <button class="button is-danger is-small remove-interface" type="button">삭제</button>
            </td>
        </tr>
    `);
    $('#cfgInterfaceList').append(row);
    
    row.find('.remove-interface').on('click', function() {
        row.remove();
    });
}

// 인터페이스 임계치/대역폭 행 추가 함수는 더 이상 사용하지 않음 (통합된 인터페이스 행 사용)

// 초기 설정값 저장 (수정사항 감지용)
let initialConfigData = null;
let hasChanges = false;

// 설정값 비교 함수
function compareConfigData(current, initial) {
    if (!initial) return true; // 초기값이 없으면 변경사항 있음으로 간주
    
    // JSON 문자열로 비교
    return JSON.stringify(current) !== JSON.stringify(initial);
}

// 수정사항 감지
function checkForChanges() {
    if (!initialConfigData) return;
    
    const currentResourceData = getResourceConfigData();
    const currentSessionData = {
        ssh_port: parseInt($('#sbCfgPort').val(), 10) || 22,
        timeout_sec: parseInt($('#sbCfgTimeout').val(), 10) || 10,
        host_key_policy: ($('#sbCfgHostKeyPolicy').val() || 'auto_add').toString()
    };
    
    const resourceChanged = compareConfigData(currentResourceData, initialConfigData.resource);
    const sessionChanged = compareConfigData(currentSessionData, initialConfigData.session);
    
    hasChanges = resourceChanged || sessionChanged;
}

// 리소스 설정 데이터 수집 함수
function getResourceConfigData() {
    function numOrUndef(selector) {
        const raw = ($(selector).val() || '').toString().trim();
        if (raw.length === 0) return undefined;
        let s = raw.replace(/\s|%/g, '');
        s = s.replace(/(?!^-)[^0-9.,-]/g, '');
        if (s.indexOf('.') >= 0) { s = s.replace(/,/g, ''); }
        else if (s.indexOf(',') >= 0) {
            const last = s.lastIndexOf(',');
            s = s.replace(/,/g, (m, idx) => (idx === last ? '.' : ''));
        }
        s = s.replace(/[^0-9.-]/g, '');
        const n = Number(s);
        if (!Number.isFinite(n)) return undefined;
        return n < 0 ? 0 : n;
    }

    // Collect interface settings
    const interfaceOids = {};
    const interfaceThresholds = {};
    const interfaceBandwidths = {};
    
    $('.interface-row').each(function() {
        const name = $(this).find('.interface-name').val().trim();
        const inOid = $(this).find('.interface-in-oid').val().trim();
        const outOid = $(this).find('.interface-out-oid').val().trim();
        const threshold = numOrUndef($(this).find('.interface-threshold'));
        const bandwidth = numOrUndef($(this).find('.interface-bandwidth'));
        
        if (name && (inOid || outOid)) {
            interfaceOids[name] = {
                in_oid: inOid || '',
                out_oid: outOid || ''
            };
            
            if (threshold !== undefined) {
                interfaceThresholds[name] = threshold;
            }
            
            if (bandwidth !== undefined && bandwidth > 0) {
                interfaceBandwidths[name] = bandwidth;
            }
        }
    });
    
    // bandwidth_mbps는 기본값 1000.0 사용 (회선 대역폭 설정 UI 제거됨)
    const bandwidthMbps = 1000.0;
    
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
        },
        thresholds: {
            cpu: numOrUndef('#cfgThrCpu'),
            mem: numOrUndef('#cfgThrMem'),
            cc: numOrUndef('#cfgThrCc'),
            cs: numOrUndef('#cfgThrCs'),
            http: numOrUndef('#cfgThrHttp'),
            https: numOrUndef('#cfgThrHttps'),
            ftp: numOrUndef('#cfgThrFtp'),
        },
        interface_oids: interfaceOids,
        interface_thresholds: interfaceThresholds,
        interface_bandwidths: interfaceBandwidths,
        bandwidth_mbps: bandwidthMbps
    };
    Object.keys(payload.oids).forEach(k => { if (!payload.oids[k]) delete payload.oids[k]; });
    Object.keys(payload.thresholds).forEach(k => { if (payload.thresholds[k] == null || !Number.isFinite(payload.thresholds[k])) delete payload.thresholds[k]; });
    
    return payload;
}

// SNMP 설정 로드/저장
function loadResourceConfig() {
    return $.get('/api/resource-config')
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
            const th = cfg.thresholds || {};
            $('#cfgThrCpu').val(th.cpu ?? '');
            $('#cfgThrMem').val(th.mem ?? '');
            $('#cfgThrCc').val(th.cc ?? '');
            $('#cfgThrCs').val(th.cs ?? '');
            $('#cfgThrHttp').val(th.http ?? '');
            $('#cfgThrHttps').val(th.https ?? '');
            $('#cfgThrFtp').val(th.ftp ?? '');
            
            // Load interface settings (통합된 형태로 로드)
            $('#cfgInterfaceList').empty();
            const interfaceOids = cfg.interface_oids || {};
            const interfaceThresholds = cfg.interface_thresholds || {};
            const interfaceBandwidths = cfg.interface_bandwidths || {}; // 인터페이스별 대역폭
            
            Object.keys(interfaceOids).forEach(name => {
                // Support both old format (string) and new format (object with in_oid/out_oid)
                const oids = typeof interfaceOids[name] === 'string' 
                    ? { in_oid: interfaceOids[name], out_oid: '' } 
                    : (interfaceOids[name] || {});
                const threshold = interfaceThresholds[name] || '';
                const bandwidth = interfaceBandwidths[name] || ''; // 인터페이스별 대역폭
                addInterfaceRow(name, oids, threshold, bandwidth);
            });
            
            // 초기값 저장 (수정사항 감지용)
            initialConfigData = initialConfigData || {};
            initialConfigData.resource = getResourceConfigData();
        })
        .fail(() => {
            $('#cfgStatus').removeClass('is-success').addClass('is-danger').text('불러오기 실패');
            throw new Error('리소스 설정 불러오기 실패');
        });
}

function saveResourceConfig() {
    try { if (document && document.activeElement) { document.activeElement.blur(); } } catch (e) {}
    
    const payload = getResourceConfigData();

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
    return $.get('/api/session-browser/config')
        .done(cfg => {
            $('#sbCfgPort').val(cfg.ssh_port || 22);
            $('#sbCfgTimeout').val(cfg.timeout_sec || 10);
            $('#sbCfgHostKeyPolicy').val(cfg.host_key_policy || 'auto_add');
            
            // 초기값 저장 (수정사항 감지용)
            initialConfigData = initialConfigData || {};
            initialConfigData.session = {
                ssh_port: cfg.ssh_port || 22,
                timeout_sec: cfg.timeout_sec || 10,
                host_key_policy: cfg.host_key_policy || 'auto_add'
            };
        })
        .fail(() => {
            $('#cfgStatus').removeClass('is-success').addClass('is-danger').text('세션브라우저 설정 불러오기 실패');
            throw new Error('세션브라우저 설정 불러오기 실패');
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
            // 개별 상태 표시는 하지 않음 (통합 저장 함수에서 처리)
        },
        error: () => {
            $('#cfgStatus').removeClass('is-success').addClass('is-danger').text('세션브라우저 설정 저장 실패');
        }
    });
}

// 통합 저장 함수
function saveAllConfig() {
    try { if (document && document.activeElement) { document.activeElement.blur(); } } catch (e) {}
    
    // 수정사항 확인
    checkForChanges();
    if (hasChanges && !confirm('변경사항이 있습니다. 저장하시겠습니까?')) {
        return;
    }
    
    $('#cfgStatus').removeClass('is-danger is-success').text('저장 중...');
    
    // 리소스 설정 저장
    const saveResourcePromise = new Promise((resolve, reject) => {
        const originalSuccess = () => {
            resolve();
        };
        const originalError = () => {
            reject(new Error('리소스 설정 저장 실패'));
        };
        
        // 임시로 성공/실패 핸들러 저장 후 원래 함수 호출
        const originalSaveResourceConfig = saveResourceConfig;
        // saveResourceConfig 내부의 AJAX 호출을 수정하기 위해 직접 호출
        // 대신 saveResourceConfig를 Promise 기반으로 래핑
        const resourceConfigData = getResourceConfigData();
        
        $.ajax({
            url: '/api/resource-config',
            method: 'PUT',
            contentType: 'application/json',
            data: JSON.stringify(resourceConfigData),
            success: originalSuccess,
            error: originalError
        });
    });
    
    // 세션브라우저 설정 저장
    const saveSessionPromise = new Promise((resolve, reject) => {
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
            success: () => resolve(),
            error: () => reject(new Error('세션브라우저 설정 저장 실패'))
        });
    });
    
    Promise.all([saveResourcePromise, saveSessionPromise])
        .then(() => {
            // 저장 후 초기값 업데이트
            initialConfigData = {
                resource: getResourceConfigData(),
                session: {
                    ssh_port: parseInt($('#sbCfgPort').val(), 10) || 22,
                    timeout_sec: parseInt($('#sbCfgTimeout').val(), 10) || 10,
                    host_key_policy: ($('#sbCfgHostKeyPolicy').val() || 'auto_add').toString()
                }
            };
            hasChanges = false;
            $('#cfgStatus').removeClass('is-danger').addClass('is-success').text('모든 설정 저장 완료');
        })
        .catch((error) => {
            $('#cfgStatus').removeClass('is-success').addClass('is-danger').text('설정 저장 실패: ' + error.message);
        });
}

// 초기화
$(document).ready(() => {
    // 두 설정을 모두 로드한 후 "불러옴" 표시
    Promise.all([loadResourceConfig(), loadSessionConfig()])
        .then(() => {
            $('#cfgStatus').removeClass('is-danger is-success').text('불러옴');
        })
        .catch(() => {
            // 에러는 각 함수에서 이미 처리됨
        });
    
    // Add interface button handler
    $('#cfgAddInterface').on('click', function() {
        addInterfaceRow('', {}, '', '');
        checkForChanges();
    });
    
    // 모든 입력 필드 변경 감지
    const configInputs = [
        '#cfgCommunity', '#cfgOidCpu', '#cfgOidMem', '#cfgOidCc', '#cfgOidCs', 
        '#cfgOidHttp', '#cfgOidHttps', '#cfgOidFtp',
        '#cfgThrCpu', '#cfgThrMem', '#cfgThrCc', '#cfgThrCs',
        '#cfgThrHttp', '#cfgThrHttps', '#cfgThrFtp',
        '#sbCfgPort', '#sbCfgTimeout', '#sbCfgHostKeyPolicy'
    ];
    
    configInputs.forEach(selector => {
        $(document).on('input change', selector, function() {
            checkForChanges();
        });
    });
    
    // 인터페이스 행의 입력 필드 변경 감지
    $(document).on('input change', '.interface-name, .interface-in-oid, .interface-out-oid, .interface-threshold, .interface-bandwidth', function() {
        checkForChanges();
    });
    
    // 인터페이스 행 삭제 감지
    $(document).on('click', '.remove-interface', function() {
        setTimeout(() => checkForChanges(), 100);
    });
});

// Expose functions for inline onclick handlers
window.saveResourceConfig = saveResourceConfig;
window.saveSessionConfig = saveSessionConfig;
window.saveAllConfig = saveAllConfig;
