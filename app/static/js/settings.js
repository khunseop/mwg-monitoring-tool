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

function addInterfaceRow(name = '', oids = {}, threshold = '', bandwidth = '') {
    const counter = interfaceOidCounter++;
    const inOid = oids.in_oid || '';
    const outOid = oids.out_oid || '';
    const row = $(`
        <div class="box mb-3 interface-row" data-counter="${counter}" style="border: 1px solid var(--border-color, #e5e7eb);">
            <div class="columns is-multiline is-vcentered">
                <div class="column is-2">
                    <div class="field">
                        <label class="label is-small">인터페이스 이름</label>
                        <div class="control">
                            <input class="input interface-name" type="text" placeholder="예: eth0" value="${name}">
                        </div>
                    </div>
                </div>
                <div class="column is-3">
                    <div class="field">
                        <label class="label is-small">IN OID</label>
                        <div class="control">
                            <input class="input interface-in-oid" type="text" placeholder="예: 1.3.6.1.2.1.2.2.1.10.1" value="${inOid}">
                        </div>
                    </div>
                </div>
                <div class="column is-3">
                    <div class="field">
                        <label class="label is-small">OUT OID</label>
                        <div class="control">
                            <input class="input interface-out-oid" type="text" placeholder="예: 1.3.6.1.2.1.2.2.1.16.1" value="${outOid}">
                        </div>
                    </div>
                </div>
                <div class="column is-2">
                    <div class="field">
                        <label class="label is-small">임계치 (Mbps)</label>
                        <div class="control">
                            <input class="input interface-threshold" type="number" step="0.01" min="0" placeholder="예: 100" value="${threshold}">
                        </div>
                    </div>
                </div>
                <div class="column is-2">
                    <div class="field">
                        <label class="label is-small">대역폭 (Mbps)</label>
                        <div class="control">
                            <input class="input interface-bandwidth" type="number" step="0.1" min="0" placeholder="예: 1000" value="${bandwidth}">
                        </div>
                    </div>
                </div>
            </div>
            <div class="field is-grouped is-grouped-right">
                <div class="control">
                    <button class="button is-danger is-light is-small remove-interface" type="button">삭제</button>
                </div>
            </div>
        </div>
    `);
    $('#cfgInterfaceList').append(row);
    
    row.find('.remove-interface').on('click', function() {
        row.remove();
    });
}

// 인터페이스 임계치/대역폭 행 추가 함수는 더 이상 사용하지 않음 (통합된 인터페이스 행 사용)

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
            
            // Load global bandwidth_mbps (전체 회선 대역폭, 기본값으로 사용)
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

    // Collect interface settings (통합된 형태로 수집)
    const interfaceOids = {};
    const interfaceThresholds = {};
    const interfaceBandwidths = {}; // 향후 인터페이스별 대역폭 지원
    
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
            
            // 향후 인터페이스별 대역폭 지원
            if (bandwidth !== undefined && bandwidth > 0) {
                interfaceBandwidths[name] = bandwidth;
            }
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
        interface_bandwidths: interfaceBandwidths, // 향후 인터페이스별 대역폭 지원
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
        addInterfaceRow('', {}, '', '');
    });
});

// Expose functions for inline onclick handlers
window.saveResourceConfig = saveResourceConfig;
