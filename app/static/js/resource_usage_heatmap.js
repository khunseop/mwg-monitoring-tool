/**
 * Resource Usage 히트맵 모듈 (CSS Table 기반)
 */
(function(window) {
    'use strict';

    let updateTimeout = null;
    let pendingUpdate = null;
    let isUpdating = false;
    let tooltipEl = null;
    let currentTooltipCell = null;

    // ── 색상 보간 ────────────────────────────────────────────────
    function lerp(a, b, t) { return a + (b - a) * t; }

    function getHeatmapCellStyle(scaled) {
        if (scaled === null || scaled === undefined) {
            return { bg: '#f1f5f9', color: '#94a3b8' };
        }
        if (scaled <= 0) return { bg: '#f8fafc', color: '#cbd5e1' };

        let r, g, b, color;
        if (scaled <= 50) {
            // 연초록(#f0fdf4) → 초록(#86efac)
            const t = scaled / 50;
            r = lerp(240, 134, t); g = lerp(253, 239, t); b = lerp(244, 172, t);
            color = '#166534';
        } else if (scaled <= 90) {
            // 초록(#86efac) → 노랑(#fef08a)
            const t = (scaled - 50) / 40;
            r = lerp(134, 254, t); g = lerp(239, 240, t); b = lerp(172, 138, t);
            color = t < 0.5 ? '#166534' : '#713f12';
        } else if (scaled <= 110) {
            // 노랑(#fef08a) → 주황(#fb923c)
            const t = (scaled - 90) / 20;
            r = lerp(254, 251, t); g = lerp(240, 146, t); b = lerp(138, 60, t);
            color = '#7c2d12';
        } else {
            // 주황(#fb923c) → 빨강(#ef4444)
            const t = Math.min((scaled - 110) / 40, 1);
            r = lerp(251, 239, t); g = lerp(146, 68, t); b = lerp(60, 68, t);
            color = '#7f1d1d';
        }
        return { bg: `rgb(${Math.round(r)},${Math.round(g)},${Math.round(b)})`, color };
    }

    // ── 값 포맷 ──────────────────────────────────────────────────
    function formatCellValue(raw, metricKey) {
        if (raw === null || raw === undefined) return '';
        if (['cpu', 'mem', 'disk'].includes(metricKey)) return Math.round(raw);
        const utils = window.ResourceUsageUtils;
        if (['cc', 'cs', 'blocked'].includes(metricKey)) return utils.abbreviateNumber(raw);
        return raw >= 10 ? raw.toFixed(0) : raw.toFixed(1);
    }

    function formatTooltipValue(raw, metricKey) {
        if (raw === null || raw === undefined) return 'N/A';
        if (['cpu', 'mem', 'disk'].includes(metricKey)) return raw.toFixed(1) + '%';
        if (['cc', 'cs', 'blocked'].includes(metricKey)) return raw.toLocaleString();
        return raw.toFixed(2) + ' Mbps';
    }

    // ── 툴팁 ─────────────────────────────────────────────────────
    function ensureTooltip() {
        if (tooltipEl) return;
        tooltipEl = document.createElement('div');
        tooltipEl.className = 'ru-hm-tooltip';
        tooltipEl.innerHTML =
            '<div class="ru-hm-tt-header">' +
                '<span class="ru-hm-tt-proxy"></span>' +
                '<span class="ru-hm-tt-metric"></span>' +
            '</div>' +
            '<div class="ru-hm-tt-value"></div>' +
            '<div class="ru-hm-tt-bar-track"><div class="ru-hm-tt-bar-fill"></div></div>' +
            '<div class="ru-hm-tt-pct"></div>';
        document.body.appendChild(tooltipEl);
    }

    function showTooltip(e, proxyName, metricTitle, metricKey, raw, scaled) {
        ensureTooltip();
        tooltipEl.querySelector('.ru-hm-tt-proxy').textContent = proxyName;
        tooltipEl.querySelector('.ru-hm-tt-metric').textContent = metricTitle;
        tooltipEl.querySelector('.ru-hm-tt-value').textContent = formatTooltipValue(raw, metricKey);
        tooltipEl.querySelector('.ru-hm-tt-pct').textContent =
            scaled !== null ? `임계치의 ${scaled}%` : '데이터 없음';

        const barFill = tooltipEl.querySelector('.ru-hm-tt-bar-fill');
        barFill.style.width = (scaled !== null ? Math.min(scaled, 100) : 0) + '%';
        const cs = getHeatmapCellStyle(scaled);
        barFill.style.background = (scaled === null || scaled <= 0) ? '#475569' : cs.bg;

        tooltipEl.style.display = 'block';
        positionTooltip(e);
    }

    function positionTooltip(e) {
        if (!tooltipEl) return;
        const w = tooltipEl.offsetWidth  || 180;
        const h = tooltipEl.offsetHeight || 90;
        tooltipEl.style.left = Math.min(e.clientX + 14, window.innerWidth  - w - 12) + 'px';
        tooltipEl.style.top  = Math.min(e.clientY + 14, window.innerHeight - h - 12) + 'px';
    }

    function hideTooltip() {
        if (tooltipEl) tooltipEl.style.display = 'none';
        currentTooltipCell = null;
    }

    // ── 메트릭 목록 빌드 ─────────────────────────────────────────
    function buildMetrics() {
        const ru = window.ru;
        const utils = window.ResourceUsageUtils;
        const ifOids = (ru.cachedConfig && ru.cachedConfig.interface_oids) ? ru.cachedConfig.interface_oids : {};

        const basic = [
            { key: 'cpu',     title: 'CPU',   fullTitle: 'CPU',               unit: '%'    },
            { key: 'mem',     title: 'MEM',   fullTitle: 'Memory',            unit: '%'    },
            { key: 'disk',    title: 'DISK',  fullTitle: 'Disk',              unit: '%'    },
            { key: 'cc',      title: 'CC',    fullTitle: 'Client Count',      unit: ''     },
            { key: 'cs',      title: 'CS',    fullTitle: 'Connected Sockets', unit: ''     },
            { key: 'blocked', title: 'BLKD',  fullTitle: 'Blocked',           unit: ''     },
            { key: 'httpd',   title: 'HTTP',  fullTitle: 'HTTP Traffic',      unit: 'Mbps' },
            { key: 'httpsd',  title: 'HTTPS', fullTitle: 'HTTPS Traffic',     unit: 'Mbps' },
            { key: 'http2d',  title: 'HTTP2', fullTitle: 'HTTP/2 Traffic',    unit: 'Mbps' },
        ];

        const ifaces = [];
        Object.keys(ifOids).forEach(ifName => {
            const dn = utils.abbreviateInterfaceName(ifName);
            ifaces.push({ key: `if_${ifName}_in`,  title: `${dn}↓`, fullTitle: `${ifName} IN`,  ifName, direction: 'in',  isInterface: true, unit: 'Mbps' });
            ifaces.push({ key: `if_${ifName}_out`, title: `${dn}↑`, fullTitle: `${ifName} OUT`, ifName, direction: 'out', isInterface: true, unit: 'Mbps' });
        });

        return [...basic, ...ifaces];
    }

    // ── 범례 렌더링 (최초 1회) ───────────────────────────────────
    function renderLegend() {
        const el = document.getElementById('ruHeatmapLegend');
        if (!el || el._legendSet) return;
        el._legendSet = true;
        el.innerHTML =
            '<div class="ru-hm-legend">' +
                '<span class="ru-hm-legend-item"><span class="ru-hm-legend-dot" style="background:#86efac"></span>정상 (&lt;50%)</span>' +
                '<span class="ru-hm-legend-item"><span class="ru-hm-legend-dot" style="background:#fef08a"></span>주의 (50~90%)</span>' +
                '<span class="ru-hm-legend-item"><span class="ru-hm-legend-dot" style="background:#fb923c"></span>경고 (90~110%)</span>' +
                '<span class="ru-hm-legend-item"><span class="ru-hm-legend-dot" style="background:#ef4444"></span>위험 (&gt;110%)</span>' +
                '<span class="ru-hm-legend-item"><span class="ru-hm-legend-dot" style="background:#f1f5f9;border:1px solid #e2e8f0"></span>N/A</span>' +
            '</div>';
    }

    // ── 스켈레톤 (선택된 프록시 기반 미리보기) ───────────────────
    function showSkeleton() {
        const ru = window.ru;
        const selectedIds = ($('#ruProxySelect').val() || []).map(v => parseInt(v, 10));
        if (!selectedIds.length) { $('#ruHeatmapWrap').hide(); $('#ruEmptyState').show(); return; }

        const proxies = (ru.proxies || [])
            .filter(p => selectedIds.includes(p.id))
            .sort((a, b) => (a.host || '').localeCompare(b.host || ''));
        if (!proxies.length) { $('#ruHeatmapWrap').hide(); $('#ruEmptyState').show(); return; }

        const metrics = buildMetrics();
        const parts = ['<table class="ru-hm-table"><thead><tr>'];
        parts.push('<th class="ru-hm-proxy-col">Proxy</th>');
        metrics.forEach(m => {
            const tip = m.fullTitle + (m.unit ? ` (${m.unit})` : '');
            parts.push(`<th title="${tip}">${m.title}</th>`);
        });
        parts.push('</tr></thead><tbody>');

        proxies.forEach(proxy => {
            parts.push(`<tr><td class="ru-hm-proxy-col" title="${proxy.host}">${proxy.host}</td>`);
            metrics.forEach(() => parts.push('<td class="ru-hm-cell ru-hm-skeleton"></td>'));
            parts.push('</tr>');
        });
        parts.push('</tbody></table>');

        $('#ruEmptyState').hide();
        $('#ruHeatmapWrap').show();
        document.getElementById('ruHeatmapEl').innerHTML = parts.join('');
        renderLegend();
    }

    // ── 이벤트 위임 등록 (최초 1회) ─────────────────────────────
    function attachTableEvents(el) {
        if (el._hmEventsAttached) return;
        el._hmEventsAttached = true;

        el.addEventListener('mouseover', e => {
            const cell = e.target.closest('td.ru-hm-cell');
            if (!cell || cell === currentTooltipCell || cell.classList.contains('ru-hm-skeleton')) return;
            currentTooltipCell = cell;
            const raw    = cell.dataset.raw    !== '' ? parseFloat(cell.dataset.raw)       : null;
            const scaled = cell.dataset.scaled !== '' ? parseInt(cell.dataset.scaled, 10)  : null;
            showTooltip(e, cell.dataset.proxy, cell.dataset.mt, cell.dataset.mk, raw, scaled);
        });
        el.addEventListener('mousemove', e => { if (currentTooltipCell) positionTooltip(e); });
        el.addEventListener('mouseout',  e => {
            if (!e.relatedTarget || !el.contains(e.relatedTarget)) hideTooltip();
        });
    }

    // ── 메인 업데이트 ────────────────────────────────────────────
    const ResourceUsageHeatmap = {
        updateTable(items) {
            pendingUpdate = items;
            if (updateTimeout) clearTimeout(updateTimeout);
            updateTimeout = setTimeout(() => {
                if (pendingUpdate && !isUpdating) {
                    this._updateTableInternal(pendingUpdate);
                    pendingUpdate = null;
                }
            }, 100);
        },

        _updateTableInternal(items) {
            if (isUpdating) return;
            isUpdating = true;
            requestAnimationFrame(() => {
                try {
                    this._doUpdate(items);
                } finally {
                    isUpdating = false;
                }
            });
        },

        _doUpdate(items) {
            const ru = window.ru;
            const state = window.ResourceUsageState;

            // 이전 버전 ApexCharts 인스턴스 정리
            if (ru.apex) { try { ru.apex.destroy(); } catch(e) {} ru.apex = null; }

            ru.lastData = items || [];
            const rows = [];

            (items || []).forEach(row => {
                const proxy = (ru.proxies || []).find(p => p.id === row.proxy_id);
                rows.push({
                    proxy_id:      row.proxy_id,
                    cpu:           typeof row.cpu     === 'number' ? row.cpu     : null,
                    mem:           typeof row.mem     === 'number' ? row.mem     : null,
                    disk:          typeof row.disk    === 'number' ? row.disk    : null,
                    cc:            typeof row.cc      === 'number' ? row.cc      : null,
                    cs:            typeof row.cs      === 'number' ? row.cs      : null,
                    blocked:       typeof row.blocked === 'number' ? row.blocked : null,
                    httpd:         typeof row.http    === 'number' ? row.http    : 0,
                    httpsd:        typeof row.https   === 'number' ? row.https   : 0,
                    http2d:        typeof row.http2   === 'number' ? row.http2   : 0,
                    interface_mbps: row.interface_mbps || null,
                    _fullHost:     proxy ? proxy.host : `#${row.proxy_id}`
                });
            });
            rows.sort((a, b) => (a._fullHost || '').localeCompare(b._fullHost || ''));

            const el = document.getElementById('ruHeatmapEl');
            if (!el) return;

            if (!rows.length) { $('#ruHeatmapWrap').hide(); $('#ruEmptyState').show(); return; }
            $('#ruEmptyState').hide(); $('#ruHeatmapWrap').show();

            const metrics = buildMetrics();
            const thr   = (ru.cachedConfig && ru.cachedConfig.thresholds)           ? ru.cachedConfig.thresholds           : {};
            const ifThr = (ru.cachedConfig && ru.cachedConfig.interface_thresholds) ? ru.cachedConfig.interface_thresholds : {};

            // 스케일 최대값 갱신 (색상 기준 일관성)
            const maxByMetric = {};
            metrics.forEach(m => {
                let vals;
                if (m.isInterface) {
                    vals = rows.map(r => {
                        if (!r.interface_mbps) return null;
                        const info = r.interface_mbps[m.ifName] || Object.values(r.interface_mbps).find(v => v.name === m.ifName);
                        return info ? (m.direction === 'in' ? info.in_mbps : info.out_mbps) : null;
                    });
                } else {
                    vals = rows.map(r => r[m.key]);
                }
                const clean = vals.filter(v => typeof v === 'number' && isFinite(v)).sort((a, b) => a - b);
                let max = clean.length ? clean[Math.max(0, Math.floor(clean.length * 0.95) - 1)] : 0;
                if (['cpu', 'mem', 'disk'].includes(m.key) && max < 100) max = 100;
                maxByMetric[m.key] = Math.max(ru.heatmapMaxByMetric[m.key] || 0, max || 1);
            });
            ru.heatmapMaxByMetric = maxByMetric;

            function getCellData(row, m) {
                let raw = null;
                if (m.isInterface) {
                    const info = row.interface_mbps
                        ? (row.interface_mbps[m.ifName] || Object.values(row.interface_mbps).find(v => v.name === m.ifName))
                        : null;
                    if (info) raw = m.direction === 'in' ? info.in_mbps : info.out_mbps;
                } else {
                    raw = row[m.key];
                }
                let thrKey = m.key;
                if (thrKey === 'httpd')  thrKey = 'http';
                else if (thrKey === 'httpsd') thrKey = 'https';
                else if (thrKey === 'http2d') thrKey = 'http2';
                const threshold = m.isInterface
                    ? (ifThr[m.ifName] || maxByMetric[m.key] || 1)
                    : (thr[thrKey]     || maxByMetric[m.key] || 1);
                const scaled = (typeof raw === 'number' && isFinite(raw))
                    ? Math.max(0, Math.min(150, Math.round((raw / threshold) * 100)))
                    : null;
                return { raw, scaled };
            }

            // HTML 테이블 빌드
            const parts = ['<table class="ru-hm-table"><thead><tr>'];
            parts.push('<th class="ru-hm-proxy-col">Proxy</th>');
            metrics.forEach(m => {
                const tip = m.fullTitle + (m.unit ? ` (${m.unit})` : '');
                parts.push(`<th title="${tip}">${m.title}</th>`);
            });
            parts.push('</tr></thead><tbody>');

            rows.forEach(row => {
                parts.push(`<tr><td class="ru-hm-proxy-col" title="${row._fullHost}">${row._fullHost}</td>`);
                metrics.forEach(m => {
                    const { raw, scaled } = getCellData(row, m);
                    const { bg, color }   = getHeatmapCellStyle(scaled);
                    const display         = raw !== null ? formatCellValue(raw, m.key) : '';
                    parts.push(
                        `<td class="ru-hm-cell" style="background:${bg};color:${color}"` +
                        ` data-proxy="${row._fullHost}"` +
                        ` data-mk="${m.key}" data-mt="${m.title}"` +
                        ` data-raw="${raw !== null ? raw : ''}"` +
                        ` data-scaled="${scaled !== null ? scaled : ''}">${display}</td>`
                    );
                });
                parts.push('</tr>');
            });
            parts.push('</tbody></table>');

            el.innerHTML = parts.join('');
            attachTableEvents(el);
            renderLegend();

            // 마지막 갱신 시각 업데이트
            const now = new Date();
            const timeStr = now.toTimeString().slice(0, 8);
            const lastUpdatedEl = document.getElementById('ruLastUpdated');
            const lastUpdatedTimeEl = document.getElementById('ruLastUpdatedTime');
            if (lastUpdatedEl) lastUpdatedEl.style.display = '';
            if (lastUpdatedTimeEl) lastUpdatedTimeEl.textContent = timeStr;

            if (state && state.saveHeatmapState) state.saveHeatmapState();
        },

        showSkeleton,

        /**
         * 현재 표시된 모든 수집값을 클립보드에 복사 (탭 구분 형식)
         */
        copyCurrentValues() {
            const ru = window.ru;
            if (!ru.lastData || !ru.lastData.length) {
                alert('복사할 데이터가 없습니다. 먼저 수집을 시작하세요.');
                return;
            }

            const utils = window.ResourceUsageUtils;
            const interfaceOids = (ru.cachedConfig && ru.cachedConfig.interface_oids) ? ru.cachedConfig.interface_oids : {};
            const configuredInterfaceNames = Object.keys(interfaceOids);

            const headers = ['Proxy', 'CPU (%)', 'MEM (%)', 'DISK (%)', 'Client Count', 'Connected Sockets', 'Blocked', 'HTTP (Mbps)', 'HTTPS (Mbps)', 'HTTP2 (Mbps)'];
            configuredInterfaceNames.forEach(name => {
                headers.push(`${name} IN`);
                headers.push(`${name} OUT`);
            });

            const csvRows = [headers.join('\t')];

            ru.lastData.forEach(row => {
                const proxy = (ru.proxies || []).find(p => p.id === row.proxy_id);
                const host  = proxy ? proxy.host : `#${row.proxy_id}`;

                const line = [
                    host,
                    (row.cpu   || 0).toFixed(1),
                    (row.mem   || 0).toFixed(1),
                    (row.disk  || 0).toFixed(1),
                    row.cc      || 0,
                    row.cs      || 0,
                    typeof row.blocked === 'number' ? row.blocked : 0,
                    (row.http  || 0).toFixed(2),
                    (row.https || 0).toFixed(2),
                    (row.http2 || 0).toFixed(2)
                ];

                const if_mbps = row.interface_mbps
                    ? (typeof row.interface_mbps === 'string' ? JSON.parse(row.interface_mbps) : row.interface_mbps)
                    : {};
                configuredInterfaceNames.forEach(name => {
                    const info = if_mbps[name] || Object.values(if_mbps).find(v => v.name === name);
                    line.push((info ? info.in_mbps  : 0).toFixed(2));
                    line.push((info ? info.out_mbps : 0).toFixed(2));
                });

                csvRows.push(line.join('\t'));
            });

            const ta = document.createElement('textarea');
            ta.value = csvRows.join('\n');
            document.body.appendChild(ta);
            ta.select();
            try {
                document.execCommand('copy');
                const $btn = $('#ruCopyBtn');
                const orig = $btn.find('span').text();
                $btn.find('span').text('복사 완료!');
                $btn.addClass('is-success is-light');
                setTimeout(() => {
                    $btn.find('span').text(orig);
                    $btn.removeClass('is-success is-light');
                }, 2000);
            } catch (err) {
                alert('클립보드 복사에 실패했습니다.');
            }
            document.body.removeChild(ta);
        }
    };

    window.ResourceUsageHeatmap = ResourceUsageHeatmap;
})(window);
