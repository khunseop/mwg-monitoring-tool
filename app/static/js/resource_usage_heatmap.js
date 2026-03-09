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
            // Debounce: 빠른 연속 업데이트 방지
            pendingUpdate = items;
            if (updateTimeout) clearTimeout(updateTimeout);
            updateTimeout = setTimeout(() => {
                if (pendingUpdate && !isUpdating) {
                    this._updateTableInternal(pendingUpdate);
                    pendingUpdate = null;
                }
            }, 100); // 100ms debounce
        },

        /**
         * 실제 히트맵 업데이트 로직
         * @param {Array} items - 데이터 아이템 배열
         */
        _updateTableInternal(items) {
            if (isUpdating) return;
            isUpdating = true;
            
            // requestAnimationFrame으로 렌더링 최적화
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
         * @param {Array} items - 데이터 아이템 배열
         */
        _doUpdate(items) {
            const ru = window.ru;
            const utils = window.ResourceUsageUtils;
            const state = window.ResourceUsageState;
            
            // Store latest data for interface name lookup
            ru.lastData = items || [];
            
            const rows = [];
            
            // First pass: collect all interface indices and process rows
            const intervalSec = parseInt($('#ruIntervalSec').val(), 10) || 60;
            (items || []).forEach(row => {
                const proxyId = row.proxy_id;
                const last = ru.lastCumulativeByProxy[proxyId] || {};
                const deltas = { http: null, https: null, http2: null };
                
                // 차트 버퍼에서 최신 Mbps 값을 가져와서 사용 (가장 정확하고 안정적임)
                ['http','https','http2'].forEach(k => {
                    const buffer = ru.tsBuffer[proxyId] || {};
                    const series = buffer[k] || [];
                    if (series.length > 0) {
                        const latestPoint = series[series.length - 1];
                        if (latestPoint && typeof latestPoint.y === 'number' && latestPoint.y >= 0) {
                            deltas[k] = latestPoint.y; 
                        }
                    }
                    
                    // 버퍼에 값이 없거나 비정상적이면 현재 누적치와 이전 누적치를 비교해 계산
                    if (deltas[k] === null || isNaN(deltas[k])) {
                        const v = row[k];
                        const prev = last[k];
                        if (typeof v === 'number' && typeof prev === 'number' && v >= prev) {
                            const mbps = utils.calculateTrafficMbps(v, prev, intervalSec);
                            deltas[k] = (mbps !== null && mbps >= 0) ? mbps : 0;
                        } else {
                            deltas[k] = 0;
                        }
                    }
                });
                
                // 누적값 캐시 업데이트 (다음 주기 계산용)
                // 만약 현재 수집값이 이전보다 작으면 (Counter Wrap 또는 재시작), 
                // 계산 로직(calculateTrafficMbps -> calculateDeltaWithWrap)에서 처리되지만
                // 일단 수집된 최신 값을 다음 주기를 위해 무조건 저장함
                ru.lastCumulativeByProxy[proxyId] = {
                    http: typeof row.http === 'number' ? row.http : last.http,
                    https: typeof row.https === 'number' ? row.https : last.https,
                    http2: typeof row.http2 === 'number' ? row.http2 : last.http2,
                };
                
                // Store proxy info for later use
                const proxy = (ru.proxies || []).find(p => p.id === proxyId);
                const fullHost = proxy ? proxy.host : `#${proxyId}`;
                
                rows.push({
                    proxy_id: proxyId,
                    cpu: typeof row.cpu === 'number' ? row.cpu : null,
                    mem: typeof row.mem === 'number' ? row.mem : null,
                    disk: typeof row.disk === 'number' ? row.disk : null,
                    cc: typeof row.cc === 'number' ? row.cc : null,
                    cs: typeof row.cs === 'number' ? row.cs : null,
                    httpd: deltas.http,
                    httpsd: deltas.https,
                    http2d: deltas.http2,
                    interface_mbps: row.interface_mbps || null,
                    _fullHost: fullHost
                });
            });

            rows.sort((a, b) => {
                const na = a._fullHost || String(a.proxy_id);
                const nb = b._fullHost || String(b.proxy_id);
                return na.localeCompare(nb);
            });

            // Get configured interfaces from config
            const interfaceOids = (ru.cachedConfig && ru.cachedConfig.interface_oids) ? ru.cachedConfig.interface_oids : {};
            const configuredInterfaceNames = Object.keys(interfaceOids);
            
            // Build metrics
            const basicMetrics = [
                { key: 'cpu', title: 'CPU' },
                { key: 'mem', title: 'MEM' },
                { key: 'disk', title: 'DISK' },
                { key: 'cc', title: 'CC' },
                { key: 'cs', title: 'CS' },
                { key: 'httpd', title: 'HTTP Δ' },
                { key: 'httpsd', title: 'HTTPS Δ' },
                { key: 'http2d', title: 'HTTP2 Δ' },
            ];
            
            const interfaceMetrics = [];
            configuredInterfaceNames.forEach(ifName => {
                const displayName = utils.abbreviateInterfaceName(ifName);
                interfaceMetrics.push({ key: `if_${ifName}_in`, title: `${displayName} IN`, ifName: ifName, direction: 'in', isInterface: true });
                interfaceMetrics.push({ key: `if_${ifName}_out`, title: `${displayName} OUT`, ifName: ifName, direction: 'out', isInterface: true });
            });
            
            const metrics = [...basicMetrics, ...interfaceMetrics];

            // Max values for scaling
            const maxByMetric = {};
            metrics.forEach(m => {
                const existingMax = ru.heatmapMaxByMetric[m.key];
                let vals;
                if (m.isInterface) {
                    const ifName = m.ifName;
                    const dir = m.direction;
                    vals = rows.map(r => {
                        if (!r.interface_mbps || typeof r.interface_mbps !== 'object') return null;
                        let ifData = r.interface_mbps[ifName];
                        if (!ifData) {
                            const key = Object.keys(r.interface_mbps).find(k => r.interface_mbps[k] && r.interface_mbps[k].name === ifName);
                            if (key) ifData = r.interface_mbps[key];
                        }
                        if (!ifData) return null;
                        return (dir === 'in') ? ifData.in_mbps : ifData.out_mbps;
                    }).filter(v => typeof v === 'number' && isFinite(v)).sort((a,b) => a-b);
                } else {
                    vals = rows.map(r => r[m.key]).filter(v => typeof v === 'number' && isFinite(v)).sort((a,b) => a-b);
                }
                let max = 0;
                if (vals.length > 0) {
                    const idx = Math.max(0, Math.floor(vals.length * 0.95) - 1);
                    max = vals[idx];
                }
                if ((m.key === 'cpu' || m.key === 'mem' || m.key === 'disk') && max < 100) max = 100;
                maxByMetric[m.key] = Math.max(existingMax || 0, max || 1);
            });
            ru.heatmapMaxByMetric = maxByMetric;

            const xCategories = metrics.map(m => m.title);
            const yCategories = rows.map(r => r._fullHost || `#${r.proxy_id}`);

            const data = [];
            rows.forEach((r, y) => {
                metrics.forEach((m, x) => {
                    let raw = null;
                    if (m.isInterface) {
                        const ifName = m.ifName;
                        const dir = m.direction;
                        let ifData = r.interface_mbps ? r.interface_mbps[ifName] : null;
                        if (!ifData && r.interface_mbps) {
                            const key = Object.keys(r.interface_mbps).find(k => r.interface_mbps[k] && r.interface_mbps[k].name === ifName);
                            if (key) ifData = r.interface_mbps[key];
                        }
                        if (ifData) raw = (dir === 'in') ? ifData.in_mbps : ifData.out_mbps;
                    } else {
                        raw = r[m.key];
                    }
                    if (typeof raw === 'number' && isFinite(raw)) {
                        const ratio = raw <= 0 ? 0 : raw / (maxByMetric[m.key] || 1);
                        data.push({ value: [x, y, ratio], raw: raw });
                    } else {
                        data.push({ value: [x, y, null], raw: null });
                    }
                });
            });

            const el = document.getElementById('ruHeatmapEl');
            if (!el || !window.ApexCharts) return;
            
            if (!items || items.length === 0) { 
                $('#ruHeatmapWrap').hide(); $('#ruEmptyState').show(); return;
            } else { 
                $('#ruEmptyState').hide(); $('#ruHeatmapWrap').show();
            }

            const isVisible = el.closest('#ruHeatmapWrap').offsetParent !== null;

            // Threshold scaling
            const thr = (ru.cachedConfig && ru.cachedConfig.thresholds) ? ru.cachedConfig.thresholds : {};
            const interfaceThr = (ru.cachedConfig && ru.cachedConfig.interface_thresholds) ? ru.cachedConfig.interface_thresholds : {};
            const interfaceBandwidths = (ru.cachedConfig && ru.cachedConfig.interface_bandwidths) ? ru.cachedConfig.interface_bandwidths : {};
            
            const scaleForCol = metrics.map(m => {
                let t;
                if (m.isInterface) {
                    t = interfaceThr[m.ifName] || (maxByMetric[m.key] || 1);
                } else {
                    const baseKey = m.key.replace(/d$/, ''); // httpd -> http
                    t = thr[baseKey] || (maxByMetric[m.key] || 1);
                }
                return (v) => (typeof v !== 'number' || !isFinite(v)) ? null : Math.max(0, Math.min(150, Math.round((v / t) * 100)));
            });

            ru._heatRaw = yCategories.map(() => new Array(xCategories.length).fill(null));
            ru._heatRows = rows.map(r => r._fullHost || `#${r.proxy_id}`);

            const seriesData = yCategories.map((rowLabel, rowIdx) => {
                const dataPoints = xCategories.map((colLabel, colIdx) => {
                    const point = data.find(d => d.value[0] === colIdx && d.value[1] === rowIdx);
                    const raw = point ? point.raw : null;
                    ru._heatRaw[rowIdx][colIdx] = raw;
                    const scaled = (typeof raw === 'number') ? scaleForCol[colIdx](raw) : null;
                    return { x: colLabel, y: scaled };
                });
                return { name: rowLabel, data: dataPoints };
            });

            ru._heatRaw.reverse();
            ru._heatRows.reverse();
            seriesData.reverse();

            // Dimensions: Smaller columns, Adjustable height
            const minColWidth = 60; // 줄임
            const finalWidth = Math.max($('#ruHeatmapWrap').width() || 1000, xCategories.length * minColWidth + 150);
            
            // Slider 기반 높이 조절
            const sliderVal = parseInt($('#ruHeatmapHeightSlider').val(), 10) || 600;
            const calculatedHeight = sliderVal;
            
            const options = {
                chart: { 
                    type: 'heatmap', height: calculatedHeight, width: '100%',
                    animations: { enabled: false }, toolbar: { show: false },
                    events: { mounted: (ctx) => setTimeout(() => { if(ctx && ctx.resize) ctx.resize(); }, 100) }
                },
                dataLabels: { 
                    enabled: true, 
                    style: { colors: ['#111827'], fontSize: '12px', fontWeight: 600 }, // 크게
                    formatter: function(val, opts) {
                        const y = opts.seriesIndex; const x = opts.dataPointIndex;
                        const raw = (ru._heatRaw && ru._heatRaw[y]) ? ru._heatRaw[y][x] : null;
                        if (raw == null) return '';
                        const metric = metrics[x];
                        if (metric.isInterface) {
                            const bw = interfaceBandwidths[metric.ifName];
                            return bw ? Math.round((raw/bw)*100)+'%' : raw.toFixed(1);
                        }
                        if (['httpd','httpsd','http2d'].includes(metric.key)) return raw.toFixed(1);
                        if (['cpu','mem','disk'].includes(metric.key)) return Math.round(raw)+'%';
                        return Math.round(raw);
                    }
                },
                plotOptions: {
                    heatmap: {
                        shadeIntensity: 0.5, radius: 2, enableShades: true,
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
                series: seriesData
            };

            $(el).css('width', finalWidth + 'px');

            if (ru.apex) {
                try {
                    ru.apex.updateSeries(seriesData, false);
                    ru.apex.updateOptions({ chart: { height: calculatedHeight } }, false);
                } catch (e) {
                    if (ru.apex.destroy) ru.apex.destroy();
                    ru.apex = new ApexCharts(el, options);
                    ru.apex.render();
                }
            } else {
                ru.apex = new ApexCharts(el, options);
                ru.apex.render();
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
            
            // 헤더 구성
            const headers = ['Proxy', 'CPU (%)', 'MEM (%)', 'DISK (%)', 'CC', 'CS', 'HTTP (Mbps)', 'HTTPS (Mbps)', 'HTTP2 (Mbps)'];
            
            // 인터페이스 목록 추출 (헤더용)
            const interfaceOids = (ru.cachedConfig && ru.cachedConfig.interface_oids) ? ru.cachedConfig.interface_oids : {};
            const configuredInterfaceNames = Object.keys(interfaceOids);
            configuredInterfaceNames.forEach(name => {
                headers.push(`${name} IN`);
                headers.push(`${name} OUT`);
            });

            const rows = [headers.join('\t')];

            // 데이터 행 구성
            const items = ru.lastData;
            const intervalSec = parseInt($('#ruIntervalSec').val(), 10) || 60;

            items.forEach(row => {
                const proxyId = row.proxy_id;
                const proxy = (ru.proxies || []).find(p => p.id === proxyId);
                const host = proxy ? proxy.host : `#${proxyId}`;
                
                // 델타 계산 (Mbps)
                const last = ru.lastCumulativeByProxy[proxyId] || {};
                const getDelta = (k) => {
                    // 1. 차트 버퍼에서 가장 최신 Mbps 값 가져오기 (가장 정확함)
                    const buffer = ru.tsBuffer[proxyId] || {};
                    const series = buffer[k] || [];
                    if (series.length > 0) {
                        const latest = series[series.length - 1];
                        if (latest && typeof latest.y === 'number' && !isNaN(latest.y)) {
                            return latest.y;
                        }
                    }
                    
                    // 2. 버퍼에 없으면 현재값과 캐시된 이전값을 비교해 직접 계산
                    const v = row[k];
                    const prev = last[k];
                    if (typeof v === 'number' && typeof prev === 'number') {
                        const mbps = utils.calculateTrafficMbps(v, prev, intervalSec);
                        return (mbps !== null && !isNaN(mbps) && mbps >= 0) ? mbps : 0;
                    }
                    return 0;
                };

                const line = [
                    host,
                    (row.cpu || 0).toFixed(1),
                    (row.mem || 0).toFixed(1),
                    (row.disk || 0).toFixed(1),
                    row.cc || 0,
                    row.cs || 0,
                    getDelta('http').toFixed(2),
                    getDelta('https').toFixed(2),
                    getDelta('http2').toFixed(2)
                ];

                // 인터페이스 데이터
                const if_mbps = row.interface_mbps ? (typeof row.interface_mbps === 'string' ? JSON.parse(row.interface_mbps) : row.interface_mbps) : {};
                configuredInterfaceNames.forEach(name => {
                    let in_val = 0, out_val = 0;
                    // if_mbps는 { "index": { name: "eth0", in_mbps: 1.2, ... } } 구조임
                    Object.keys(if_mbps).forEach(k => {
                        const info = if_mbps[k];
                        if (info && (info.name === name || k === name)) {
                            in_val = info.in_mbps || 0;
                            out_val = info.out_mbps || 0;
                        }
                    });
                    line.push(in_val.toFixed(2));
                    line.push(out_val.toFixed(2));
                });

                rows.push(line.join('\t'));
            });

            const text = rows.join('\n');
            
            // 클립보드 복사
            const tempTextArea = document.createElement('textarea');
            tempTextArea.value = text;
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
                console.error('Copy failed', err);
                alert('클립보드 복사에 실패했습니다.');
            }
            document.body.removeChild(tempTextArea);
        }
    };

    // 전역으로 노출
    window.ResourceUsageHeatmap = ResourceUsageHeatmap;
})(window);
