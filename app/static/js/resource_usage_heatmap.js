/**
 * Resource Usage 히트맵 모듈 (증분 DOM 업데이트 + 프록시 상세보기)
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
            const t = scaled / 50;
            r = lerp(240, 134, t); g = lerp(253, 239, t); b = lerp(244, 172, t);
            color = '#166534';
        } else if (scaled <= 90) {
            const t = (scaled - 50) / 40;
            r = lerp(134, 254, t); g = lerp(239, 240, t); b = lerp(172, 138, t);
            color = t < 0.5 ? '#166534' : '#713f12';
        } else if (scaled <= 110) {
            const t = (scaled - 90) / 20;
            r = lerp(254, 251, t); g = lerp(240, 146, t); b = lerp(138, 60, t);
            color = '#7c2d12';
        } else {
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

    // ── 셀 데이터 계산 (모듈 스코프로 노출해서 _buildTable/_patchCells 공유) ──
    function getCellData(row, m, thr, ifThr, maxByMetric) {
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

    // ── 추세 계산 ────────────────────────────────────────────────
    function getTrend(proxyId, metricKey) {
        const bufferKey = metricKey === 'httpd'  ? 'http'  :
                          metricKey === 'httpsd' ? 'https' :
                          metricKey === 'http2d' ? 'http2' : metricKey;
        const arr = ((window.ru.tsBuffer || {})[proxyId] || {})[bufferKey] || [];
        if (arr.length < 2) return '';
        const last = arr[arr.length - 1].y;
        const prev = arr[arr.length - 2].y;
        if (typeof last !== 'number' || typeof prev !== 'number') return '';
        const delta = last - prev;
        const threshold = Math.max(Math.abs(prev) * 0.02, 0.5);
        if (Math.abs(delta) < threshold) return '→';
        return delta > 0 ? '↑' : '↓';
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

        // 스켈레톤 표시 시 프록시 키 초기화 (다음 실제 데이터에서 전체 빌드 유도)
        const el = document.getElementById('ruHeatmapEl');
        if (el) { el._lastProxyKey = ''; el._lastMetricKey = ''; }
    }

    // ── 이벤트 위임 등록 ─────────────────────────────────────────
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

        // 프록시 이름 클릭 → 상세 모달
        el.addEventListener('click', e => {
            const proxyCol = e.target.closest('td.ru-hm-proxy-clickable');
            if (!proxyCol || !proxyCol.dataset.proxyId) return;
            hideTooltip();
            ResourceUsageHeatmap.openProxyDetail(parseInt(proxyCol.dataset.proxyId, 10));
        });
    }

    // ── 테이블 빌드 (전체 재구성) ────────────────────────────────
    function buildTable(el, rows, metrics, thr, ifThr, maxByMetric) {
        const parts = ['<table class="ru-hm-table"><thead><tr>'];
        parts.push('<th class="ru-hm-proxy-col">Proxy</th>');
        metrics.forEach(m => {
            const tip = m.fullTitle + (m.unit ? ` (${m.unit})` : '');
            parts.push(`<th title="${tip}">${m.title}</th>`);
        });
        parts.push('</tr></thead><tbody>');

        rows.forEach(row => {
            parts.push(
                `<tr><td class="ru-hm-proxy-col ru-hm-proxy-clickable" title="${row._fullHost}" data-proxy-id="${row.proxy_id}">${row._fullHost}</td>`
            );
            metrics.forEach(m => {
                const { raw, scaled } = getCellData(row, m, thr, ifThr, maxByMetric);
                const { bg, color }   = getHeatmapCellStyle(scaled);
                const display         = raw !== null ? formatCellValue(raw, m.key) : '';
                const trend           = raw !== null ? getTrend(row.proxy_id, m.key) : '';
                const inner           = display + (trend ? `<span class="ru-trend">${trend}</span>` : '');
                parts.push(
                    `<td id="ru-cell-${row.proxy_id}-${m.key}" class="ru-hm-cell" style="background:${bg};color:${color}"` +
                    ` data-proxy="${row._fullHost}" data-proxy-id="${row.proxy_id}"` +
                    ` data-mk="${m.key}" data-mt="${m.title}"` +
                    ` data-raw="${raw !== null ? raw : ''}"` +
                    ` data-scaled="${scaled !== null ? scaled : ''}">${inner}</td>`
                );
            });
            parts.push('</tr>');
        });
        parts.push('</tbody></table>');

        el.innerHTML = parts.join('');
        attachTableEvents(el);
        renderLegend();
    }

    // ── 셀 패치 (증분 업데이트 - DOM 구조 유지) ──────────────────
    function patchCells(rows, metrics, thr, ifThr, maxByMetric) {
        rows.forEach(row => {
            metrics.forEach(m => {
                const cellEl = document.getElementById(`ru-cell-${row.proxy_id}-${m.key}`);
                if (!cellEl) return;
                const { raw, scaled } = getCellData(row, m, thr, ifThr, maxByMetric);
                const { bg, color }   = getHeatmapCellStyle(scaled);
                cellEl.style.background = bg;
                cellEl.style.color      = color;
                const display = raw !== null ? formatCellValue(raw, m.key) : '';
                const trend   = raw !== null ? getTrend(row.proxy_id, m.key) : '';
                cellEl.innerHTML        = display + (trend ? `<span class="ru-trend">${trend}</span>` : '');
                cellEl.dataset.raw      = raw    !== null ? String(raw)    : '';
                cellEl.dataset.scaled   = scaled !== null ? String(scaled) : '';
            });
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

            if (ru.apex) { try { ru.apex.destroy(); } catch(e) {} ru.apex = null; }

            ru.lastData = items || [];
            const rows = [];

            (items || []).forEach(row => {
                const proxy = (ru.proxies || []).find(p => p.id === row.proxy_id);
                rows.push({
                    proxy_id:       row.proxy_id,
                    cpu:            typeof row.cpu     === 'number' ? row.cpu     : null,
                    mem:            typeof row.mem     === 'number' ? row.mem     : null,
                    disk:           typeof row.disk    === 'number' ? row.disk    : null,
                    cc:             typeof row.cc      === 'number' ? row.cc      : null,
                    cs:             typeof row.cs      === 'number' ? row.cs      : null,
                    blocked:        typeof row.blocked === 'number' ? row.blocked : null,
                    httpd:          typeof row.http    === 'number' ? row.http    : 0,
                    httpsd:         typeof row.https   === 'number' ? row.https   : 0,
                    http2d:         typeof row.http2   === 'number' ? row.http2   : 0,
                    interface_mbps: row.interface_mbps || null,
                    _fullHost:      proxy ? proxy.host : `#${row.proxy_id}`
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

            // 스케일 최대값 갱신
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

            // 증분 업데이트 가능 여부 판별
            const currentProxyKey  = rows.map(r => r.proxy_id).join(',');
            const currentMetricKey = metrics.map(m => m.key).join(',');

            if (el._lastProxyKey === currentProxyKey && el._lastMetricKey === currentMetricKey) {
                // 같은 프록시 세트 → 셀 내용만 교체 (DOM 구조 유지)
                patchCells(rows, metrics, thr, ifThr, maxByMetric);
            } else {
                // 프록시 목록 변경 → 전체 재빌드
                buildTable(el, rows, metrics, thr, ifThr, maxByMetric);
                el._lastProxyKey  = currentProxyKey;
                el._lastMetricKey = currentMetricKey;
            }

            // 마지막 갱신 시각 업데이트
            const now = new Date();
            const timeStr = now.toTimeString().slice(0, 8);
            const lastUpdatedEl     = document.getElementById('ruLastUpdated');
            const lastUpdatedTimeEl = document.getElementById('ruLastUpdatedTime');
            if (lastUpdatedEl) lastUpdatedEl.style.display = '';
            if (lastUpdatedTimeEl) lastUpdatedTimeEl.textContent = timeStr;

            if (state && state.saveHeatmapState) state.saveHeatmapState();
        },

        // ── 프록시 상세 모달 ────────────────────────────────────
        openProxyDetail(proxyId) {
            const ru = window.ru;
            const proxy = (ru.proxies || []).find(p => p.id === proxyId);
            const row   = (ru.lastData || []).find(r => r.proxy_id === proxyId);
            const proxyHost = proxy ? proxy.host : `#${proxyId}`;

            const nameEl = document.getElementById('ruDetailProxyName');
            const atEl   = document.getElementById('ruDetailCollectedAt');
            if (nameEl) nameEl.textContent = proxyHost;
            if (atEl) {
                const collectedAt = row && row.collected_at
                    ? new Date(row.collected_at).toLocaleTimeString('ko-KR')
                    : '-';
                atEl.textContent = `수집 시각: ${collectedAt}`;
            }

            this._renderDetailTiles(proxyId, row);
            this._renderDetailSparklines(proxyId);

            const modal = document.getElementById('ruProxyDetailModal');
            if (modal) modal.classList.add('is-active');
        },

        closeProxyDetail() {
            const ru = window.ru;
            const modal = document.getElementById('ruProxyDetailModal');
            if (modal) modal.classList.remove('is-active');

            // 스파크라인 차트 인스턴스 정리
            if (ru.detailCharts) {
                Object.values(ru.detailCharts).forEach(chart => {
                    try { chart.destroy(); } catch(e) {}
                });
                ru.detailCharts = {};
            }
            const splContainer = document.getElementById('ruDetailSparklines');
            if (splContainer) splContainer.innerHTML = '';
            const tilesContainer = document.getElementById('ruDetailTiles');
            if (tilesContainer) tilesContainer.innerHTML = '';
        },

        _renderDetailTiles(proxyId, row) {
            const ru  = window.ru;
            const thr   = (ru.cachedConfig && ru.cachedConfig.thresholds)           ? ru.cachedConfig.thresholds           : {};
            const ifThr = (ru.cachedConfig && ru.cachedConfig.interface_thresholds) ? ru.cachedConfig.interface_thresholds : {};
            const maxByMetric = ru.heatmapMaxByMetric || {};
            const metrics = buildMetrics();

            // row 필드명을 heatmap row 형태로 매핑
            const rowData = row ? {
                cpu:           row.cpu,
                mem:           row.mem,
                disk:          row.disk,
                cc:            row.cc,
                cs:            row.cs,
                blocked:       row.blocked,
                httpd:         row.http  || 0,
                httpsd:        row.https || 0,
                http2d:        row.http2 || 0,
                interface_mbps: row.interface_mbps || null
            } : {};

            const el = document.getElementById('ruDetailTiles');
            if (!el) return;

            const parts = [];
            metrics.forEach(m => {
                const { raw, scaled } = getCellData(rowData, m, thr, ifThr, maxByMetric);
                const { bg, color }   = getHeatmapCellStyle(scaled);
                const display  = raw !== null ? formatTooltipValue(raw, m.key) : 'N/A';
                const pctText  = scaled !== null ? `임계치 ${scaled}%` : '';
                parts.push(
                    `<div class="ru-detail-tile" style="background:${bg};color:${color};">` +
                    `<div class="ru-detail-tile-value">${display}</div>` +
                    `<div class="ru-detail-tile-label">${m.fullTitle}</div>` +
                    `<div class="ru-detail-tile-pct">${pctText}</div>` +
                    `</div>`
                );
            });
            el.innerHTML = parts.join('');
        },

        _renderDetailSparklines(proxyId) {
            const ru = window.ru;
            if (!window.ApexCharts) return;
            const buffer = ru.tsBuffer && ru.tsBuffer[proxyId];
            const container = document.getElementById('ruDetailSparklines');
            if (!container) return;

            // 이전 차트 정리
            if (ru.detailCharts) {
                Object.values(ru.detailCharts).forEach(chart => { try { chart.destroy(); } catch(e) {} });
            }
            ru.detailCharts = {};
            container.innerHTML = '';

            if (!buffer) {
                container.innerHTML = '<p class="is-size-7 has-text-grey-light">시계열 데이터가 없습니다. 수집이 시작된 후 다시 확인하세요.</p>';
                return;
            }

            const metrics = buildMetrics();
            const grid = document.createElement('div');
            grid.className = 'ru-detail-sparklines';
            container.appendChild(grid);

            let rendered = 0;
            metrics.forEach(m => {
                // chart key: interface metrics use if_{name}_{dir}, basic metrics use the metric key as-is
                const bufferKey = m.isInterface ? m.key : (
                    m.key === 'httpd'  ? 'http'  :
                    m.key === 'httpsd' ? 'https' :
                    m.key === 'http2d' ? 'http2' : m.key
                );
                const data = buffer[bufferKey] || [];
                if (data.length < 2) return;

                rendered++;
                const elId = `ru-sparkline-${proxyId}-${m.key}`;
                const wrapper = document.createElement('div');
                wrapper.className = 'ru-detail-sparkline-item';
                wrapper.innerHTML =
                    `<div class="ru-detail-sparkline-label">${m.fullTitle}</div>` +
                    `<div id="${elId}"></div>`;
                grid.appendChild(wrapper);

                const seriesData = data.slice(-60); // 최근 60포인트
                const chart = new ApexCharts(document.getElementById(elId), {
                    chart: {
                        type: 'area',
                        height: 80,
                        sparkline: { enabled: true },
                        animations: { enabled: false },
                        toolbar: { show: false }
                    },
                    series: [{ name: m.title, data: seriesData }],
                    stroke: { curve: 'smooth', width: 1.5 },
                    fill: {
                        type: 'gradient',
                        gradient: { shadeIntensity: 1, opacityFrom: 0.35, opacityTo: 0.05, stops: [0, 100] }
                    },
                    colors: ['#4E79A7'],
                    xaxis: { type: 'datetime' },
                    tooltip: {
                        enabled: true,
                        x: { format: 'HH:mm:ss' },
                        y: {
                            formatter: val => val !== null ? formatTooltipValue(val, bufferKey) : 'N/A'
                        }
                    }
                });
                chart.render();
                ru.detailCharts[m.key] = chart;
            });

            if (rendered === 0) {
                container.innerHTML = '<p class="is-size-7 has-text-grey-light">아직 시계열 데이터가 충분하지 않습니다. (최소 2회 이상 수집 필요)</p>';
            }
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
