/**
 * Resource Usage 히트맵 모듈
 * 히트맵 생성 및 업데이트 로직
 */
(function(window) {
    'use strict';

    const ResourceUsageHeatmap = {
        /**
         * 테이블 데이터를 히트맵으로 업데이트
         * @param {Array} items - 데이터 아이템 배열
         */
        updateTable(items) {
            const ru = window.ru;
            const utils = window.ResourceUsageUtils;
            const state = window.ResourceUsageState;
            
            // Store latest data for interface name lookup
            ru.lastData = items || [];
            
            const rows = [];
            const allInterfaceIndices = new Set();
            
            // First pass: collect all interface indices and process rows
            const intervalSec = parseInt($('#ruIntervalSec').val(), 10) || 60;
            (items || []).forEach(row => {
                const last = ru.lastCumulativeByProxy[row.proxy_id] || {};
                const deltas = { http: null, https: null, ftp: null };
                ['http','https','ftp'].forEach(k => {
                    const v = row[k];
                    if (typeof v === 'number' && typeof last[k] === 'number' && last[k] !== null) {
                        // 32-bit counter wrap 처리 및 Mbps 변환
                        const mbps = utils.calculateTrafficMbps(v, last[k], intervalSec);
                        deltas[k] = (mbps !== null && mbps >= 0) ? mbps : null;
                    } else if (typeof v === 'number') {
                        // First collection or cache was reset - don't calculate delta yet
                        deltas[k] = null;
                    }
                });
                // Update cache with current values
                ru.lastCumulativeByProxy[row.proxy_id] = {
                    http: typeof row.http === 'number' ? row.http : (last.http || null),
                    https: typeof row.https === 'number' ? row.https : (last.https || null),
                    ftp: typeof row.ftp === 'number' ? row.ftp : (last.ftp || null),
                };
                
                // Store proxy info for later use
                const proxy = (ru.proxies || []).find(p => p.id === row.proxy_id);
                const fullHost = proxy ? proxy.host : `#${row.proxy_id}`;
                
                rows.push({
                    proxy_id: row.proxy_id,
                    cpu: typeof row.cpu === 'number' ? row.cpu : null,
                    mem: typeof row.mem === 'number' ? row.mem : null,
                    cc: typeof row.cc === 'number' ? row.cc : null,
                    cs: typeof row.cs === 'number' ? row.cs : null,
                    httpd: deltas.http,
                    httpsd: deltas.https,
                    ftpd: deltas.ftp,
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
            
            // Build interface data from collected data
            const interfaceDataMap = {};
            (items || []).forEach(row => {
                if (row.interface_mbps && typeof row.interface_mbps === 'object') {
                    Object.keys(row.interface_mbps).forEach(ifName => {
                        const ifData = row.interface_mbps[ifName];
                        if (ifData && typeof ifData === 'object') {
                            interfaceDataMap[ifName] = ifData;
                        }
                    });
                }
            });
            
            // Build metrics: basic metrics first, then interface metrics
            const basicMetrics = [
                { key: 'cpu', title: 'CPU' },
                { key: 'mem', title: 'MEM' },
                { key: 'cc', title: 'CC' },
                { key: 'cs', title: 'CS' },
                { key: 'httpd', title: 'HTTP Δ' },
                { key: 'httpsd', title: 'HTTPS Δ' },
                { key: 'ftpd', title: 'FTP Δ' },
            ];
            
            // Add interface metrics with names
            const interfaceMetrics = configuredInterfaceNames.map(ifName => {
                const displayName = utils.abbreviateInterfaceName(ifName);
                return {
                    key: `if_${ifName}`,
                    title: displayName,
                    fullName: ifName,
                    ifName: ifName
                };
            });
            
            const metrics = [...basicMetrics, ...interfaceMetrics];

            const maxByMetric = {};
            metrics.forEach(m => {
                let vals;
                if (m.key.startsWith('if_')) {
                    const ifName = m.ifName;
                    vals = rows
                        .map(r => {
                            if (!r.interface_mbps || typeof r.interface_mbps !== 'object') return null;
                            const ifData = r.interface_mbps[ifName];
                            if (!ifData || typeof ifData !== 'object') return null;
                            const inMbps = typeof ifData.in_mbps === 'number' ? ifData.in_mbps : 0;
                            const outMbps = typeof ifData.out_mbps === 'number' ? ifData.out_mbps : 0;
                            return inMbps + outMbps;
                        })
                        .filter(v => typeof v === 'number' && isFinite(v) && v >= 0)
                        .sort((a, b) => a - b);
                } else {
                    vals = rows
                        .map(r => r[m.key])
                        .filter(v => typeof v === 'number' && isFinite(v) && v >= 0)
                        .sort((a, b) => a - b);
                }
                let max = 0;
                if (vals.length > 0) {
                    const idx = Math.max(0, Math.floor(vals.length * 0.95) - 1);
                    max = vals[idx];
                }
                if ((m.key === 'cpu' || m.key === 'mem') && max < 100) max = 100;
                maxByMetric[m.key] = max || 1;
            });

            const xCategories = metrics.map(m => m.title);
            const yCategories = rows.map(r => {
                return utils.truncateHostname(r._fullHost || `#${r.proxy_id}`, 25);
            });

            const data = [];
            rows.forEach((r, y) => {
                metrics.forEach((m, x) => {
                    let raw = null;
                    if (m.key.startsWith('if_')) {
                        const ifName = m.ifName;
                        if (r.interface_mbps && typeof r.interface_mbps === 'object') {
                            const ifData = r.interface_mbps[ifName];
                            if (ifData && typeof ifData === 'object') {
                                const inMbps = typeof ifData.in_mbps === 'number' ? ifData.in_mbps : 0;
                                const outMbps = typeof ifData.out_mbps === 'number' ? ifData.out_mbps : 0;
                                raw = inMbps + outMbps;
                            }
                        }
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
            if (!el) return;
            if (!window.ApexCharts) return;

            // Build per-column scaling using thresholds when provided
            const thr = (ru.cachedConfig && ru.cachedConfig.thresholds) ? ru.cachedConfig.thresholds : {};
            const interfaceThr = (ru.cachedConfig && ru.cachedConfig.interface_thresholds) ? ru.cachedConfig.interface_thresholds : {};
            function baseKeyFor(metricKey) {
                if (metricKey === 'httpd') return 'http';
                if (metricKey === 'httpsd') return 'https';
                if (metricKey === 'ftpd') return 'ftp';
                if (metricKey.startsWith('if_')) {
                    const ifName = metricKey.replace('if_', '');
                    return interfaceThr[ifName] !== undefined ? `__interface_${ifName}__` : 'interface_mbps';
                }
                return metricKey;
            }
            const scaleForCol = metrics.map(m => {
                const baseKey = baseKeyFor(m.key);
                let t;
                if (baseKey.startsWith('__interface_')) {
                    const ifName = baseKey.replace('__interface_', '').replace('__', '');
                    t = (typeof interfaceThr[ifName] === 'number' && isFinite(interfaceThr[ifName]) && interfaceThr[ifName] > 0) 
                        ? interfaceThr[ifName] 
                        : (maxByMetric[m.key] || 1);
                } else {
                    t = (typeof thr[baseKey] === 'number' && isFinite(thr[baseKey]) && thr[baseKey] > 0) 
                        ? thr[baseKey] 
                        : (maxByMetric[m.key] || 1);
                }
                return function(v) {
                    if (typeof v !== 'number' || !isFinite(v)) return null;
                    const scaled = (v / t) * 100;
                    return Math.max(0, Math.min(150, Math.round(scaled)));
                };
            });

            // Preserve raw values separately for labels/tooltips
            ru._heatRaw = yCategories.map(() => new Array(xCategories.length).fill(null));
            ru._heatRows = rows.map(r => r._fullHost || `#${r.proxy_id}`);

            const seriesData = yCategories.map((rowLabel, rowIdx) => {
                const dataPoints = xCategories.map((colLabel, colIdx) => {
                    const point = data.find(d => d.value[0] === colIdx && d.value[1] === rowIdx);
                    const raw = point ? point.raw : null;
                    ru._heatRaw[rowIdx][colIdx] = (typeof raw === 'number' && isFinite(raw)) ? raw : null;
                    const scaled = (typeof raw === 'number' && isFinite(raw)) ? scaleForCol[colIdx](raw) : null;
                    return { x: colLabel, y: scaled };
                });
                return { name: rowLabel, data: dataPoints };
            });

            // ApexCharts heatmap renders series from bottom to top; reverse to anchor top-left
            ru._heatRaw.reverse();
            ru._heatRows.reverse();
            seriesData.reverse();

            // Calculate dynamic dimensions based on data size
            const minColWidth = 80;
            const baseWidth = Math.max(800, xCategories.length * minColWidth);
            
            const rowCount = yCategories.length;
            const minHeight = 400;
            const maxHeight = 1200;
            const rowHeight = 25;
            const calculatedHeight = Math.max(minHeight, Math.min(maxHeight, rowCount * rowHeight + 150));
            
            const options = {
                chart: { 
                    type: 'heatmap', 
                    height: calculatedHeight,
                    width: baseWidth,
                    animations: { enabled: false }, 
                    toolbar: { show: false }
                },
                dataLabels: { 
                    enabled: true, 
                    style: { colors: ['#111827'], fontSize: rowCount > 20 ? '9px' : '11px' },
                    formatter: function(val, opts) {
                        const y = opts.seriesIndex; const x = opts.dataPointIndex;
                        const raw = (ru._heatRaw && ru._heatRaw[y]) ? ru._heatRaw[y][x] : null;
                        if (raw == null) return '';
                        const metric = metrics[x];
                        if (!metric) return String(Math.round(raw));
                        const key = metric.key;
                        const isLargeDataset = rowCount > 20 || xCategories.length > 10;
                        if (key === 'httpd' || key === 'httpsd' || key === 'ftpd') {
                            return isLargeDataset ? raw.toFixed(1) + 'M' : raw.toFixed(2) + ' Mbps';
                        }
                        if (key === 'cc' || key === 'cs') {
                            return isLargeDataset ? utils.abbreviateNumber(raw) : utils.formatNumber(raw);
                        }
                        if (key.startsWith('if_')) {
                            return isLargeDataset ? raw.toFixed(1) + 'M' : raw.toFixed(2) + ' Mbps';
                        }
                        return String(Math.round(raw));
                    }
                },
                colors: ["#12824C"],
                plotOptions: {
                    heatmap: {
                        shadeIntensity: 0.5,
                        radius: 2,
                        enableShades: true,
                        colorScale: {
                            ranges: [
                                { from: -1, to: -0.1, color: '#f3f4f6', name: 'N/A' },
                                { from: 0, to: 50, color: '#a3d977', name: '0–50% of threshold' },
                                { from: 50, to: 90, color: '#f2c94c', name: '50–90%' },
                                { from: 90, to: 110, color: '#e67e22', name: '90–110%' },
                                { from: 110, to: 1000, color: '#eb5757', name: '>110%' }
                            ]
                        }
                    }
                },
                xaxis: { 
                    type: 'category', 
                    categories: xCategories, 
                    position: 'top',
                    labels: { 
                        rotate: -45,
                        rotateAlways: false,
                        style: { fontSize: '10px' },
                        maxHeight: 100
                    }
                },
                yaxis: { 
                    labels: { 
                        style: { fontSize: rowCount > 20 ? '9px' : '11px' },
                        maxWidth: 120,
                        formatter: function(val) {
                            return val;
                        }
                    }
                },
                tooltip: { 
                    y: { 
                        formatter: function(val, { seriesIndex, dataPointIndex }) {
                            const raw = (ru._heatRaw && ru._heatRaw[seriesIndex]) ? ru._heatRaw[seriesIndex][dataPointIndex] : null;
                            if (raw == null) return 'N/A';

                            const metric = metrics[dataPointIndex];
                            let formattedRaw = String(Math.round(raw));
                            if (metric) {
                                const key = metric.key;
                                if (key === 'httpd' || key === 'httpsd' || key === 'ftpd') {
                                    formattedRaw = raw.toFixed(2) + ' Mbps';
                                } else if (key === 'cc' || key === 'cs') {
                                    formattedRaw = utils.formatNumber(raw);
                                } else if (key.startsWith('if_')) {
                                    formattedRaw = raw.toFixed(2) + ' Mbps';
                                }
                            }

                            const percent = (val == null || val < 0) ? null : Math.round(val) + '% of threshold';
                            return percent ? `${formattedRaw} (${percent})` : formattedRaw;
                        }
                    },
                    x: {
                        formatter: function(val, { seriesIndex }) {
                            if (ru._heatRows && ru._heatRows[seriesIndex]) {
                                return ru._heatRows[seriesIndex];
                            }
                            return val;
                        }
                    },
                    title: {
                        formatter: function(seriesName, { seriesIndex, dataPointIndex }) {
                            const fullHost = (ru._heatRows && ru._heatRows[seriesIndex]) ? ru._heatRows[seriesIndex] : seriesName;
                            const metric = metrics[dataPointIndex];
                            const metricTitle = metric ? metric.title : '';
                            return `${fullHost} - ${metricTitle}`;
                        }
                    }
                },
                series: seriesData
            };

            if (ru.apex) { ru.apex.updateOptions(options, true, true); }
            else { ru.apex = new ApexCharts(el, options); ru.apex.render(); }

            if (!items || items.length === 0) { $('#ruHeatmapWrap').hide(); $('#ruEmptyState').show(); }
            else { $('#ruEmptyState').hide(); $('#ruHeatmapWrap').show(); }
        }
    };

    // 전역으로 노출
    window.ResourceUsageHeatmap = ResourceUsageHeatmap;
})(window);
