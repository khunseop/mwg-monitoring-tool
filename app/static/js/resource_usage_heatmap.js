/**
 * Resource Usage 히트맵 모듈
 * 히트맵 생성 및 업데이트 로직
 */
(function(window) {
    'use strict';

    // Debounce 및 성능 최적화를 위한 변수
    let updateTimeout = null;
    let pendingUpdate = null;
    let isUpdating = false;

    const ResourceUsageHeatmap = {
        /**
         * 테이블 데이터를 히트맵으로 업데이트 (debounced)
         * @param {Array} items - 데이터 아이템 배열
         */
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

        /**
         * 히트맵 업데이트 실행
         */
        _doUpdate(items) {
            const ru = window.ru;
            const utils = window.ResourceUsageUtils;
            const state = window.ResourceUsageState;
            
            ru.lastData = items || [];
            const rows = [];

            (items || []).forEach(row => {
                const proxyId = row.proxy_id;
                const proxy = (ru.proxies || []).find(p => p.id === proxyId);
                const fullHost = proxy ? proxy.host : `#${proxyId}`;
                
                // 백엔드에서 이미 Mbps로 계산되어 오므로 그대로 사용 (CPU, MEM 등과 동일한 로직)
                rows.push({
                    proxy_id: proxyId,
                    cpu: typeof row.cpu === 'number' ? row.cpu : null,
                    mem: typeof row.mem === 'number' ? row.mem : null,
                    disk: typeof row.disk === 'number' ? row.disk : null,
                    cc: typeof row.cc === 'number' ? row.cc : null,
                    cs: typeof row.cs === 'number' ? row.cs : null,
                    blocked: typeof row.blocked === 'number' ? row.blocked : null,
                    httpd: typeof row.http === 'number' ? row.http : 0,
                    httpsd: typeof row.https === 'number' ? row.https : 0,
                    http2d: typeof row.http2 === 'number' ? row.http2 : 0,
                    interface_mbps: row.interface_mbps || null,
                    _fullHost: fullHost
                });
            });

            rows.sort((a, b) => (a._fullHost || '').localeCompare(b._fullHost || ''));

            const interfaceOids = (ru.cachedConfig && ru.cachedConfig.interface_oids) ? ru.cachedConfig.interface_oids : {};
            const configuredInterfaceNames = Object.keys(interfaceOids);
            
            const basicMetrics = [
                { key: 'cpu', title: 'CPU' },
                { key: 'mem', title: 'MEM' },
                { key: 'disk', title: 'DISK' },
                { key: 'cc', title: 'Client Count' },
                { key: 'cs', title: 'Connected Sockets' },
                { key: 'blocked', title: 'Blocked' },
                { key: 'httpd', title: 'HTTP' },
                { key: 'httpsd', title: 'HTTPS' },
                { key: 'http2d', title: 'HTTP2' },
            ];
            
            const interfaceMetrics = [];
            configuredInterfaceNames.forEach(ifName => {
                const displayName = utils.abbreviateInterfaceName(ifName);
                interfaceMetrics.push({ key: `if_${ifName}_in`, title: `${displayName} IN`, ifName: ifName, direction: 'in', isInterface: true });
                interfaceMetrics.push({ key: `if_${ifName}_out`, title: `${displayName} OUT`, ifName: ifName, direction: 'out', isInterface: true });
            });
            
            const metrics = [...basicMetrics, ...interfaceMetrics];

            // Scaling을 위한 최대값 계산 (색상 결정용)
            const maxByMetric = {};
            metrics.forEach(m => {
                const existingMax = ru.heatmapMaxByMetric[m.key];
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
                const cleanVals = vals.filter(v => typeof v === 'number' && isFinite(v)).sort((a,b) => a-b);
                let max = 0;
                if (cleanVals.length > 0) {
                    const idx = Math.max(0, Math.floor(cleanVals.length * 0.95) - 1);
                    max = cleanVals[idx];
                }
                if ((m.key === 'cpu' || m.key === 'mem' || m.key === 'disk') && max < 100) max = 100;
                maxByMetric[m.key] = Math.max(existingMax || 0, max || 1);
            });
            ru.heatmapMaxByMetric = maxByMetric;

            const xCategories = metrics.map(m => m.title);
            const seriesData = rows.map((r, rowIdx) => {
                const dataPoints = metrics.map((m, colIdx) => {
                    let raw = null;
                    if (m.isInterface) {
                        const info = r.interface_mbps ? (r.interface_mbps[m.ifName] || Object.values(r.interface_mbps).find(v => v.name === m.ifName)) : null;
                        if (info) raw = (m.direction === 'in' ? info.in_mbps : info.out_mbps);
                    } else {
                        raw = r[m.key];
                    }
                    
                    const thr = (ru.cachedConfig && ru.cachedConfig.thresholds) ? ru.cachedConfig.thresholds : {};
                    const interfaceThr = (ru.cachedConfig && ru.cachedConfig.interface_thresholds) ? ru.cachedConfig.interface_thresholds : {};
                    
                    let metricThresholdKey = m.key;
                    // Map UI metric keys to threshold config keys
                    if (metricThresholdKey === 'httpd') metricThresholdKey = 'http';
                    else if (metricThresholdKey === 'httpsd') metricThresholdKey = 'https';
                    else if (metricThresholdKey === 'http2d') metricThresholdKey = 'http2';
                    
                    let t = m.isInterface ? (interfaceThr[m.ifName] || maxByMetric[m.key] || 1) : (thr[metricThresholdKey] || maxByMetric[m.key] || 1);
                    
                    const scaled = (typeof raw === 'number' && isFinite(raw)) ? Math.max(0, Math.min(150, Math.round((raw / t) * 100))) : null;
                    return { x: m.title, y: scaled, rawValue: raw };
                });
                return { name: r._fullHost, data: dataPoints };
            });

            seriesData.reverse();

            const el = document.getElementById('ruHeatmapEl');
            if (!el || !window.ApexCharts) return;
            
            if (rows.length === 0) {
                $('#ruHeatmapWrap').hide(); $('#ruEmptyState').show(); return;
            } else {
                $('#ruEmptyState').hide(); $('#ruHeatmapWrap').show();
            }

            // 내부 차트 조밀하게 (프록시 개수에 따라 자동 조절)
            const rowHeight = 30; // 행당 높이
            const chartHeight = rows.length * rowHeight + 120; // 패딩 및 헤더 공간 포함

            // 외부 프레임 높이 자동 조절 (최소 400, 최대 1200 후 스크롤)
            $('#ruHeatmapWrap').css({
                'height': 'auto',
                'max-height': '1200px'
            });

            // 셀 너비 축소
            const minColWidth = 50; 
            const finalWidth = Math.max($('#ruHeatmapWrap').width() || 1000, xCategories.length * minColWidth + 160);
            $(el).css('width', finalWidth + 'px');

            const options = {
                chart: { 
                    type: 'heatmap', height: chartHeight, width: '100%',
                    animations: { enabled: false }, toolbar: { show: false },
                    events: { mounted: (ctx) => setTimeout(() => { if(ctx && ctx.resize) ctx.resize(); }, 100) }
                },
                dataLabels: { 
                    enabled: true, 
                    style: { colors: ['#111827'], fontSize: '11px', fontWeight: 700 }, // 글자 강조
                    formatter: function(val, opts) {
                        const raw = opts.w.config.series[opts.seriesIndex].data[opts.dataPointIndex].rawValue;
                        if (raw == null) return '';
                        const metric = metrics[opts.dataPointIndex];
                        if (['cpu','mem','disk'].includes(metric.key)) return Math.round(raw);
                        if (['cc', 'cs', 'blocked'].includes(metric.key)) return utils.abbreviateNumber(raw);
                        return raw.toFixed(raw >= 10 ? 0 : 1);
                    }
                },
                plotOptions: {
                    heatmap: {
                        shadeIntensity: 0.5, radius: 1, enableShades: true,
                        colorScale: {
                            ranges: [
                                { from: -1, to: -0.1, color: '#f3f4f6', name: 'N/A' },
                                { from: 0, to: 50, color: '#a3d977' },
                                { from: 50, to: 90, color: '#f2c94c' },
                                { from: 90, to: 110, color: '#e67e22' },
                                { from: 110, to: 1000, color: '#eb5757' }
                            ]
                        }
                    }
                },
                xaxis: { 
                    type: 'category', categories: xCategories, position: 'top',
                    labels: { rotate: -45, rotateAlways: true, style: { fontSize: '10px' } }
                },
                yaxis: { labels: { style: { fontSize: '11px', fontWeight: 600 }, maxWidth: 300 } },
                tooltip: {
                    y: {
                        formatter: (val, opts) => {
                            const raw = opts.w.config.series[opts.seriesIndex].data[opts.dataPointIndex].rawValue;
                            if (raw == null) return 'N/A';
                            return raw.toFixed(2) + (val !== null ? ` (${val}%)` : '');
                        }
                    }
                },
                series: seriesData
            };

            if (ru.apex) {
                try {
                    ru.apex.updateOptions({ chart: { height: chartHeight }, series: seriesData }, false);
                } catch (e) {
                    if (ru.apex.destroy) ru.apex.destroy();
                    ru.apex = new ApexCharts(el, options); ru.apex.render();
                }
            } else {
                ru.apex = new ApexCharts(el, options); ru.apex.render();
            }
            if (state && state.saveHeatmapState) state.saveHeatmapState();
        },

        /**
         * 현재 표시된 모든 수집값을 클립보드에 복사 (탭 구분 형식)
         */
        copyCurrentValues() {
            const ru = window.ru;
            if (!ru.lastData || ru.lastData.length === 0) {
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

            const rows = [headers.join('\t')];

            ru.lastData.forEach(row => {
                const proxyId = row.proxy_id;
                const proxy = (ru.proxies || []).find(p => p.id === proxyId);
                const host = proxy ? proxy.host : `#${proxyId}`;
                
                const line = [
                    host,
                    (row.cpu || 0).toFixed(1),
                    (row.mem || 0).toFixed(1),
                    (row.disk || 0).toFixed(1),
                    row.cc || 0,
                    row.cs || 0,
                    (typeof row.blocked === 'number' ? row.blocked : 0),
                    (row.http || 0).toFixed(2),
                    (row.https || 0).toFixed(2),
                    (row.http2 || 0).toFixed(2)
                ];

                const if_mbps = row.interface_mbps ? (typeof row.interface_mbps === 'string' ? JSON.parse(row.interface_mbps) : row.interface_mbps) : {};
                configuredInterfaceNames.forEach(name => {
                    let info = if_mbps[name] || Object.values(if_mbps).find(v => v.name === name);
                    line.push((info ? info.in_mbps : 0).toFixed(2));
                    line.push((info ? info.out_mbps : 0).toFixed(2));
                });

                rows.push(line.join('\t'));
            });

            const tempTextArea = document.createElement('textarea');
            tempTextArea.value = rows.join('\n');
            document.body.appendChild(tempTextArea);
            tempTextArea.select();
            try {
                document.execCommand('copy');
                const $btn = $('#ruCopyBtn');
                const originalText = $btn.find('span').text();
                $btn.find('span').text('복사 완료!');
                $btn.addClass('is-success is-light');
                setTimeout(() => {
                    $btn.find('span').text(originalText);
                    $btn.removeClass('is-success is-light');
                }, 2000);
            } catch (err) {
                alert('클립보드 복사에 실패했습니다.');
            }
            document.body.removeChild(tempTextArea);
        }
    };

    window.ResourceUsageHeatmap = ResourceUsageHeatmap;
})(window);
