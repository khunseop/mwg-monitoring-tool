// 탭 관리
function activateSettingsTab(targetId) {
    document.querySelectorAll('.tabs li').forEach(t => {
        if (t.dataset && t.dataset.target) {
            t.classList.toggle('is-active', t.dataset.target === targetId);
        }
    });
    document.querySelectorAll('.tab-panel').forEach(panel => {
        panel.classList.toggle('is-active', panel.id === targetId);
    });
}

// Clicks on navbar submenu are normal links to '/#<id>' so when we land here, sync by hash
function initSettingsTabsFromQuery() {
    const params = new URLSearchParams(window.location.search);
    let tab = params.get('tab');
    if (!tab || tab.length === 0) {
        // Fallback: support legacy hash anchors if present
        const legacy = (window.location.hash || '#resource-config').replace('#', '');
        tab = legacy || 'resource-config';
    }
    // Legacy tab names redirect
    if (tab === 'proxy-list' || tab === 'proxy-groups' || tab === 'proxy-management') {
        // Redirect to proxy management page
        window.location.href = '/proxy';
        return;
    }
    activateSettingsTab(tab);
}

document.addEventListener('DOMContentLoaded', function() {
    initSettingsTabsFromQuery();
});

// Interface OID management
let interfaceOidCounter = 0;

function addInterfaceOidRow(name = '', oid = '') {
    const counter = interfaceOidCounter++;
    const row = $(`
        <div class="field is-horizontal mb-3 interface-oid-row" data-counter="${counter}">
            <div class="field-body">
                <div class="field">
                    <div class="control">
                        <input class="input interface-name" type="text" placeholder="인터페이스 이름 (예: eth0)" value="${name}">
                    </div>
                </div>
                <div class="field">
                    <div class="control">
                        <input class="input interface-oid" type="text" placeholder="OID (예: 1.3.6.1.2.1.2.2.1.10.1)" value="${oid}">
                    </div>
                </div>
                <div class="field">
                    <div class="control">
                        <button class="button is-danger is-light remove-interface" type="button">삭제</button>
                    </div>
                </div>
            </div>
        </div>
    `);
    $('#cfgInterfaceList').append(row);
    
    row.find('.remove-interface').on('click', function() {
        row.remove();
        updateInterfaceThresholds();
    });
}

function addInterfaceThresholdRow(name = '', threshold = '') {
    const row = $(`
        <div class="columns mb-3 interface-threshold-row" data-name="${name}">
            <div class="column is-4">
                <div class="field">
                    <label class="label">${name || '인터페이스 이름'}</label>
                </div>
            </div>
            <div class="column is-6">
                <div class="field">
                    <div class="control">
                        <input class="input interface-threshold" type="number" step="0.01" min="0" placeholder="임계치 (Mbps)" value="${threshold}">
                    </div>
                </div>
            </div>
        </div>
    `);
    $('#cfgInterfaceThresholdList').append(row);
}

function updateInterfaceThresholds() {
    // Get all interface names from OID list
    const interfaceNames = [];
    $('.interface-oid-row').each(function() {
        const name = $(this).find('.interface-name').val().trim();
        if (name) {
            interfaceNames.push(name);
        }
    });
    
    // Remove threshold rows for interfaces that no longer exist
    $('.interface-threshold-row').each(function() {
        const rowName = $(this).data('name');
        if (!interfaceNames.includes(rowName)) {
            $(this).remove();
        }
    });
    
    // Add threshold rows for new interfaces
    interfaceNames.forEach(name => {
        if ($(`.interface-threshold-row[data-name="${name}"]`).length === 0) {
            addInterfaceThresholdRow(name, '');
        }
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
            const th = cfg.thresholds || {};
            $('#cfgThrCpu').val(th.cpu ?? '');
            $('#cfgThrMem').val(th.mem ?? '');
            $('#cfgThrCc').val(th.cc ?? '');
            $('#cfgThrCs').val(th.cs ?? '');
            $('#cfgThrHttp').val(th.http ?? '');
            $('#cfgThrHttps').val(th.https ?? '');
            $('#cfgThrFtp').val(th.ftp ?? '');
            
            // Load interface OIDs
            $('#cfgInterfaceList').empty();
            const interfaceOids = cfg.interface_oids || {};
            Object.keys(interfaceOids).forEach(name => {
                addInterfaceOidRow(name, interfaceOids[name]);
            });
            
            // Load interface thresholds
            $('#cfgInterfaceThresholdList').empty();
            const interfaceThresholds = cfg.interface_thresholds || {};
            Object.keys(interfaceOids).forEach(name => {
                addInterfaceThresholdRow(name, interfaceThresholds[name] || '');
            });
            
            // Load bandwidth_mbps
            const bandwidthMbps = cfg.bandwidth_mbps !== undefined ? cfg.bandwidth_mbps : 1000.0;
            $('#cfgBandwidthMbps').val(bandwidthMbps);
            $('#cfgStatus').removeClass('is-danger').addClass('is-success').text('불러오기 완료');
        })
        .fail(() => {
            $('#cfgStatus').removeClass('is-success').addClass('is-danger').text('불러오기 실패');
        });
}

function saveResourceConfig() {
    try { if (document && document.activeElement) { document.activeElement.blur(); } } catch (e) {}
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

    // Collect interface OIDs
    const interfaceOids = {};
    $('.interface-oid-row').each(function() {
        const name = $(this).find('.interface-name').val().trim();
        const oid = $(this).find('.interface-oid').val().trim();
        if (name && oid) {
            interfaceOids[name] = oid;
        }
    });
    
    // Collect interface thresholds
    const interfaceThresholds = {};
    $('.interface-threshold-row').each(function() {
        const name = $(this).data('name');
        const threshold = numOrUndef($(this).find('.interface-threshold'));
        if (name && threshold !== undefined) {
            interfaceThresholds[name] = threshold;
        }
    });
    
    // Parse bandwidth_mbps
    const bandwidthMbpsRaw = ($('#cfgBandwidthMbps').val() || '').toString().trim();
    const bandwidthMbps = bandwidthMbpsRaw ? parseFloat(bandwidthMbpsRaw) : 1000.0;
    
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
        bandwidth_mbps: (Number.isFinite(bandwidthMbps) && bandwidthMbps >= 0) ? bandwidthMbps : 1000.0
    };
    Object.keys(payload.oids).forEach(k => { if (!payload.oids[k]) delete payload.oids[k]; });
    Object.keys(payload.thresholds).forEach(k => { if (payload.thresholds[k] == null || !Number.isFinite(payload.thresholds[k])) delete payload.thresholds[k]; });

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

// 초기화
$(document).ready(() => {
    loadResourceConfig();
    loadSessionConfig();
    
    // Add interface button handler
    $('#cfgAddInterface').on('click', function() {
        addInterfaceOidRow('', '');
        updateInterfaceThresholds();
    });
    
    // Update thresholds when interface name changes
    $(document).on('input', '.interface-name', function() {
        const row = $(this).closest('.interface-oid-row');
        const name = $(this).val().trim();
        const oldName = row.data('old-name') || '';
        
        if (name !== oldName) {
            row.data('old-name', name);
            updateInterfaceThresholds();
        }
    });
});

// Expose functions for inline onclick handlers
window.saveResourceConfig = saveResourceConfig;
