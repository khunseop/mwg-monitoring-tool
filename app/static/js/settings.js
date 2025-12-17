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

// Interface selector TomSelect instance
let cfgInterfaceSelect = null;

// Load active interfaces list
function loadActiveInterfaces() {
    $.get('/api/resource-usage/active-interfaces?limit=200')
        .done(interfaces => {
            const $select = $('#cfgSelectedInterfaces');
            
            // Clear existing options
            $select.empty();
            
            // Add interfaces as options
            interfaces.forEach(iface => {
                const displayText = `${iface.name} (인덱스: ${iface.index}) - ${iface.proxy_host}`;
                const option = $('<option>')
                    .val(iface.index)
                    .text(displayText)
                    .data('name', iface.name)
                    .data('proxy', iface.proxy_host);
                $select.append(option);
            });
            
            // Initialize or update TomSelect
            if (window.TomSelect) {
                if (cfgInterfaceSelect) {
                    cfgInterfaceSelect.destroy();
                }
                cfgInterfaceSelect = new TomSelect($select[0], {
                    plugins: ['remove_button'],
                    maxItems: null,
                    placeholder: '인터페이스를 선택하세요 (비워두면 모든 인터페이스 표시)',
                    allowEmptyOption: true
                });
            }
            
            // Load selected values from config
            loadResourceConfig();
        })
        .fail(() => {
            console.warn('[settings] Failed to load active interfaces');
            // Still try to load config even if interface list fails
            loadResourceConfig();
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
            // Load selected interfaces
            const selectedInterfaces = cfg.selected_interfaces || [];
            if (cfgInterfaceSelect) {
                // TomSelect instance exists, set values
                cfgInterfaceSelect.setValue(selectedInterfaces);
            } else {
                // Fallback: set as comma-separated string (for backward compatibility)
                $('#cfgSelectedInterfaces').val(selectedInterfaces.join(','));
            }
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

    // Parse selected interfaces (support both TomSelect and text input)
    let selectedInterfaces = [];
    if (cfgInterfaceSelect) {
        // TomSelect instance exists, get values from it
        selectedInterfaces = cfgInterfaceSelect.getValue() || [];
    } else {
        // Fallback: parse from text input (backward compatibility)
        const selectedInterfacesRaw = ($('#cfgSelectedInterfaces').val() || '').trim();
        selectedInterfaces = selectedInterfacesRaw
            ? selectedInterfacesRaw.split(',').map(s => s.trim()).filter(s => s.length > 0)
            : [];
    }
    
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
        selected_interfaces: selectedInterfaces,
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
    // Load active interfaces first, then config (config loading will set selected values)
    loadActiveInterfaces();
    loadSessionConfig();
    
    // Refresh button handler
    $('#cfgRefreshInterfaces').on('click', function() {
        loadActiveInterfaces();
    });
});

// Expose functions for inline onclick handlers
window.saveResourceConfig = saveResourceConfig;

