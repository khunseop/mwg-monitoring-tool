$(document).ready(function() {
    function formatBytes(bytes, decimals = 2, perSecond = false) {
        // Handle invalid, null, or undefined inputs
        if (bytes === null || bytes === undefined || isNaN(bytes)) return '';
        // Treat negative values as 0, as negative traffic is not meaningful
        if (bytes < 0) bytes = 0;

        if (bytes === 0) {
            let str = '0 Bytes';
            if (perSecond) str += '/s';
            return str;
        }

        const k = 1024;
        const dm = decimals < 0 ? 0 : decimals;
        const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];

        // Calculate the power of 1024 and clamp it to the available sizes
        let i = Math.floor(Math.log(bytes) / Math.log(k));
        if (i < 0) {
            // This handles cases where 0 < bytes < 1
            i = 0;
        }
        if (i >= sizes.length) {
            // Cap at the largest unit (YB) for extremely large numbers
            i = sizes.length - 1;
        }

        let str = parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
        if (perSecond) str += '/s';
        return str;
    }

    function formatNumber(num) {
        if (num === null || num === undefined) return '';
        return num.toString().replace(/(\d)(?=(\d{3})+(?!\d))/g, '$1,');
    }

    // 32-bit counter wrap 처리 상수 및 함수
    const COUNTER32_MAX = 4294967295; // 2^32 - 1
    
    function calculateDeltaWithWrap(current, previous) {
        if (typeof current !== 'number' || typeof previous !== 'number') return null;
        if (current < previous) {
            // Counter wrapped: (MAX + 1 - previous) + current
            return (COUNTER32_MAX + 1 - previous) + current;
        }
        return current - previous;
    }
    
    // 프록시 트래픽 델타를 Mbps로 변환하는 함수
    function calculateTrafficMbps(current, previous, intervalSec) {
        const deltaBytes = calculateDeltaWithWrap(current, previous);
        if (deltaBytes === null || deltaBytes < 0 || intervalSec <= 0) return null;
        // Convert bytes to Mbps: (delta_bytes * 8 bits/byte) / (intervalSec * 1,000,000 bits/Mbit)
        return (deltaBytes * 8.0) / (intervalSec * 1_000_000.0);
    }

    const ru = {
        intervalId: null,
        taskId: null, // 백그라운드 작업 ID
        lastCumulativeByProxy: {},
        proxies: [],
        groups: [],
        charts: {}, // { [metricKey]: ApexChartsInstance }
        seriesMap: {}, // { [metricKey]: proxyId[] in series order }
        chartDpr: (window.devicePixelRatio || 1),
        // timeseries buffer: { [proxyId]: { metricKey: [{x:ms, y:number}] } }
        tsBuffer: {},
        bufferWindowMs: 60 * 60 * 1000, // last 1 hour
        bufferMaxPoints: 600,
        timeBucketMs: 1000, // quantize to seconds to align x-axis across proxies
        legendState: {}, // { [metricKey]: { [proxyId]: hiddenBoolean } }
        _wsHandlerAdded: false // 웹소켓 핸들러 추가 여부
    };
    
    // 전역으로 노출 (웹소켓 핸들러에서 접근 가능하도록)
    window.ru = ru;
    const STORAGE_KEY = 'ru_state_v1';
    const LEGEND_STORAGE_KEY = 'ru_legend_v1';
    const BUFFER_STORAGE_KEY = 'ru_buffer_v1';
    const RUN_STORAGE_KEY = 'ru_running_v1';

    function showRuError(msg) { $('#ruError').text(msg).show(); }
    function clearRuError() { $('#ruError').hide().text(''); }
    function setRunning(running) {
        if (running) {
            $('#ruStartBtn').attr('disabled', true);
            $('#ruStopBtn').attr('disabled', false);
            $('#ruStatus').removeClass('is-light').removeClass('is-danger').addClass('is-success').text('실행 중');
        } else {
            $('#ruStartBtn').attr('disabled', false);
            $('#ruStopBtn').attr('disabled', true);
            $('#ruStatus').removeClass('is-success').removeClass('is-danger').addClass('is-light').text('정지됨');
        }
        try { localStorage.setItem(RUN_STORAGE_KEY, running ? '1' : '0'); } catch (e) { /* ignore */ }
    }
    
    // 전역으로 노출 (웹소켓 핸들러에서 접근 가능하도록)
    window.setRunning = setRunning;

    // Selection UI is now handled by shared DeviceSelector

    function getSelectedProxyIds() { return ($('#ruProxySelect').val() || []).map(v => parseInt(v, 10)); }
    let cachedConfig = null;
    function loadConfig() {
        return $.getJSON('/api/resource-config').then(cfg => { cachedConfig = cfg; });
    }

    function saveState(itemsForSave) {
        try {
            const state = {
                groupId: $('#ruGroupSelect').val() || '',
                proxyIds: getSelectedProxyIds(),
                items: Array.isArray(itemsForSave) ? itemsForSave : undefined,
                savedAt: Date.now()
            };
            localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
        } catch (e) { /* ignore */ }
    }

    function restoreState() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) return Promise.resolve();
            const state = JSON.parse(raw);
            if (state.groupId !== undefined) {
                const groupEl = document.getElementById('ruGroupSelect');
                const gtom = groupEl && groupEl._tom ? groupEl._tom : null;
                if (gtom) { gtom.setValue(state.groupId || '', true); }
                else {
                    $('#ruGroupSelect').val(state.groupId);
                    $('#ruGroupSelect').trigger('change');
                }
            }
            let proxyAppliedPromise = Promise.resolve();
            if (Array.isArray(state.proxyIds)) {
                const strIds = state.proxyIds.map(id => String(id));
                proxyAppliedPromise = new Promise(resolve => {
                    const applyProxySelection = function() {
                        const proxyEl = document.getElementById('ruProxySelect');
                        const ptom = proxyEl && proxyEl._tom ? proxyEl._tom : null;
                        if (ptom) { ptom.setValue(strIds, true); }
                        else {
                            $('#ruProxySelect option').each(function() {
                                $(this).prop('selected', strIds.includes($(this).val()));
                            });
                            $('#ruProxySelect').trigger('change');
                        }
                        // clear any prior selection error once selection is restored
                        clearRuError();
                        resolve();
                    };
                    // Defer to allow DeviceSelector's group change to populate proxies first
                    setTimeout(applyProxySelection, 0);
                });
            }
            if (Array.isArray(state.items) && state.items.length > 0) {
                // Reset cumulative cache so deltas don't mislead on restore
                ru.lastCumulativeByProxy = {};
                updateTable(state.items);
            }
            return proxyAppliedPromise;
        } catch (e) { return Promise.resolve(); }
    }

    function loadLegendState() {
        try {
            const raw = localStorage.getItem(LEGEND_STORAGE_KEY);
            if (!raw) return {};
            const obj = JSON.parse(raw);
            return (obj && typeof obj === 'object') ? obj : {};
        } catch (e) { return {}; }
    }
    function saveLegendState() {
        try { localStorage.setItem(LEGEND_STORAGE_KEY, JSON.stringify(ru.legendState || {})); } catch (e) { /* ignore */ }
    }

    function loadBufferState() {
        try {
            const raw = localStorage.getItem(BUFFER_STORAGE_KEY);
            if (!raw) return {};
            const obj = JSON.parse(raw);
            if (!obj || typeof obj !== 'object') return {};
            // sanitize to expected structure
            const out = {};
            Object.keys(obj).forEach(pid => {
                const byMetric = obj[pid] || {};
                out[pid] = { cpu: [], mem: [], cc: [], cs: [], http: [], https: [], ftp: [] };
                // Process basic metrics
                Object.keys(out[pid]).forEach(m => {
                    const arr = Array.isArray(byMetric[m]) ? byMetric[m] : [];
                    // keep within window and type-safe
                    out[pid][m] = arr.filter(p => p && typeof p.x === 'number' && typeof p.y === 'number');
                });
                // Process interface metrics (dynamic keys starting with if_)
                Object.keys(byMetric).forEach(m => {
                    if (m.startsWith('if_') && !out[pid][m]) {
                        const arr = Array.isArray(byMetric[m]) ? byMetric[m] : [];
                        out[pid][m] = arr.filter(p => p && typeof p.x === 'number' && typeof p.y === 'number');
                    }
                });
            });
            return out;
        } catch (e) { return {}; }
    }

    function saveBufferState() {
        try {
            const out = {};
            Object.keys(ru.tsBuffer || {}).forEach(pid => {
                const byMetric = ru.tsBuffer[pid] || {};
                out[pid] = {};
                Object.keys(byMetric).forEach(m => {
                    const arr = Array.isArray(byMetric[m]) ? byMetric[m] : [];
                    // store a bounded slice to control size
                    const tail = arr.slice(-ru.bufferMaxPoints);
                    out[pid][m] = tail;
                });
            });
            localStorage.setItem(BUFFER_STORAGE_KEY, JSON.stringify(out));
        } catch (e) { /* ignore */ }
    }

    function updateTable(items) {
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
                    // Only calculate delta if we have valid previous value
                    const mbps = calculateTrafficMbps(v, last[k], intervalSec);
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
            
            // Note: interface_mbps is now keyed by interface name, not index
            
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
                interface_mbps: row.interface_mbps || null, // Keep full interface data
                _fullHost: fullHost // Store full hostname for tooltip
            });
        });

        rows.sort((a, b) => {
            const na = a._fullHost || String(a.proxy_id);
            const nb = b._fullHost || String(b.proxy_id);
            return na.localeCompare(nb);
        });

        // Get configured interfaces from config
        const interfaceOids = (cachedConfig && cachedConfig.interface_oids) ? cachedConfig.interface_oids : {};
        const configuredInterfaceNames = Object.keys(interfaceOids);
        
        // Build interface data from collected data (now keyed by interface name, not index)
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
        
        // Helper function to abbreviate long interface names
        function abbreviateInterfaceName(name) {
            if (!name) return name;
            // Common abbreviations
            const abbrevs = {
                'GigabitEthernet': 'Gi',
                'FastEthernet': 'Fa',
                'TenGigabitEthernet': 'Te',
                'Ethernet': 'Eth'
            };
            let abbrev = name;
            for (const [full, short] of Object.entries(abbrevs)) {
                if (name.startsWith(full)) {
                    abbrev = name.replace(full, short);
                    break;
                }
            }
            // Limit length for display (keep first 15 chars)
            if (abbrev.length > 15) {
                abbrev = abbrev.substring(0, 12) + '...';
            }
            return abbrev;
        }
        
        // Add interface metrics with names (use configured interface names)
        const interfaceMetrics = configuredInterfaceNames.map(ifName => {
            const displayName = abbreviateInterfaceName(ifName);
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
                // For interface metrics, extract from interface_mbps data (now keyed by name)
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

        // Helper function to truncate long hostnames
        function truncateHostname(hostname, maxLength = 20) {
            if (!hostname || hostname.length <= maxLength) return hostname;
            return hostname.substring(0, maxLength - 3) + '...';
        }
        
        const xCategories = metrics.map(m => m.title);
        const yCategories = rows.map(r => {
            // Use stored full hostname, truncate for display
            return truncateHostname(r._fullHost || `#${r.proxy_id}`, 25);
        });

        const data = [];
        rows.forEach((r, y) => {
            metrics.forEach((m, x) => {
                let raw = null;
                if (m.key.startsWith('if_')) {
                    // Extract interface data (now keyed by name)
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
        const thr = (cachedConfig && cachedConfig.thresholds) ? cachedConfig.thresholds : {};
        const interfaceThr = (cachedConfig && cachedConfig.interface_thresholds) ? cachedConfig.interface_thresholds : {};
        function baseKeyFor(metricKey) {
            if (metricKey === 'httpd') return 'http';
            if (metricKey === 'httpsd') return 'https';
            if (metricKey === 'ftpd') return 'ftp';
            if (metricKey.startsWith('if_')) {
                // Use interface-specific threshold if available
                const ifName = metricKey.replace('if_', '');
                return interfaceThr[ifName] !== undefined ? `__interface_${ifName}__` : 'interface_mbps';
            }
            return metricKey;
        }
        const scaleForCol = metrics.map(m => {
            const baseKey = baseKeyFor(m.key);
            let t;
            if (baseKey.startsWith('__interface_')) {
                // Interface-specific threshold
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
        // Store full hostnames for tooltip access
        ru._heatRaw = yCategories.map(() => new Array(xCategories.length).fill(null));
        ru._heatRows = rows.map(r => r._fullHost || `#${r.proxy_id}`); // Store full hostnames

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
        ru._heatRows.reverse(); // Also reverse rows array to match
        seriesData.reverse();

        // Calculate dynamic dimensions based on data size
        const minColWidth = 80;
        const baseWidth = Math.max(800, xCategories.length * minColWidth);
        
        // Dynamic height: min 400px, max 1200px, ~25px per row
        const rowCount = yCategories.length;
        const minHeight = 400;
        const maxHeight = 1200;
        const rowHeight = 25;
        const calculatedHeight = Math.max(minHeight, Math.min(maxHeight, rowCount * rowHeight + 150)); // +150 for x-axis labels
        
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
                    // For large datasets, show abbreviated values
                    const isLargeDataset = rowCount > 20 || xCategories.length > 10;
                    if (key === 'httpd' || key === 'httpsd' || key === 'ftpd') {
                        return isLargeDataset ? raw.toFixed(1) + 'M' : raw.toFixed(2) + ' Mbps';
                    }
                    if (key === 'cc' || key === 'cs') {
                        return isLargeDataset ? abbreviateNumber(raw) : formatNumber(raw);
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
                        // Show percentage of threshold in legend ranges
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
                        // Return truncated value (already truncated in yCategories)
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
                                formattedRaw = formatNumber(raw);
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
                        // Show full hostname in tooltip (using reversed index)
                        if (ru._heatRows && ru._heatRows[seriesIndex]) {
                            return ru._heatRows[seriesIndex];
                        }
                        return val;
                    }
                },
                title: {
                    formatter: function(seriesName, { seriesIndex, dataPointIndex }) {
                        // Show full hostname and metric name
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

    // collectOnce는 더 이상 사용하지 않음 (백그라운드 작업으로 대체)
    // 하지만 수동 수집 버튼이 있다면 유지할 수 있음

    function fetchLatestForProxies(proxyIds) {
        const reqs = (proxyIds || []).map(id => $.getJSON(`/api/resource-usage/latest/${id}`).catch(() => null));
        return Promise.all(reqs).then(rows => rows.filter(r => r && r.id));
    }

    async function startPolling() {
        if (ru.intervalId) return;
        
        const proxyIds = getSelectedProxyIds();
        if (proxyIds.length === 0) { 
            showRuError('프록시를 하나 이상 선택하세요.'); 
            return; 
        }
        
        const community = (cachedConfig && cachedConfig.community) ? cachedConfig.community.toString() : 'public';
        const oids = (cachedConfig && cachedConfig.oids) ? cachedConfig.oids : {};
        if (Object.keys(oids).length === 0) { 
            showRuError('설정된 OID가 없습니다. 설정 페이지를 확인하세요.'); 
            return; 
        }
        
        const intervalSec = parseInt($('#ruIntervalSec').val(), 10) || 60;
        
        try {
            // 백그라운드 수집 시작
            const response = await $.ajax({
                url: '/api/resource-usage/background/start',
                method: 'POST',
                contentType: 'application/json',
                data: JSON.stringify({
                    proxy_ids: proxyIds,
                    community: community,
                    oids: oids,
                    interval_sec: intervalSec
                })
            });
            
            ru.taskId = response.task_id;
            setRunning(true);
            ru.intervalId = 'background'; // 백그라운드 작업 표시
            
            // 전역 상태도 업데이트
            if (window.ResourceUsageCollector) {
                window.ResourceUsageCollector.setCollecting(true);
                window.ResourceUsageCollector.taskId = response.task_id;
                
                // 웹소켓을 통해 수집 완료 시 데이터 갱신 핸들러 등록
                window.ResourceUsageCollector.onCollectionComplete = function(taskId, data) {
                    if (taskId === ru.taskId) {
                        const currentProxyIds = getSelectedProxyIds();
                        fetchLatestForProxies(currentProxyIds).then(latestRows => {
                            const valid = (latestRows || []).filter(r => r && r.proxy_id && r.collected_at);
                            if (valid.length > 0) {
                                // Only update cumulative cache if we have previous data
                                // This prevents wrong delta calculations after page return
                                const hasPreviousData = Object.keys(ru.lastCumulativeByProxy).length > 0;
                                if (!hasPreviousData) {
                                    // First collection or after page return - initialize cache without calculating deltas
                                    valid.forEach(row => {
                                        ru.lastCumulativeByProxy[row.proxy_id] = {
                                            http: typeof row.http === 'number' ? row.http : null,
                                            https: typeof row.https === 'number' ? row.https : null,
                                            ftp: typeof row.ftp === 'number' ? row.ftp : null,
                                        };
                                    });
                                }
                                bufferAppendBatch(valid);
                                saveBufferState();
                                renderAllCharts();
                                // 최신 데이터로 테이블 업데이트
                                updateTable(valid);
                            }
                        }).catch(() => {});
                    }
                };
            }
        } catch (error) {
            console.error('[resource_usage] Failed to start background collection:', error);
            showRuError('백그라운드 수집 시작에 실패했습니다.');
        }
    }
    
    async function stopPolling() {
        if (!ru.taskId) {
            ru.intervalId = null;
            setRunning(false);
            return;
        }
        
        const taskIdToStop = ru.taskId;
        
        try {
            await $.ajax({
                url: '/api/resource-usage/background/stop',
                method: 'POST',
                contentType: 'application/json',
                data: JSON.stringify({ task_id: taskIdToStop })
            });
            
            ru.taskId = null;
            ru.intervalId = null;
            setRunning(false);
            
            // 전역 상태도 업데이트
            if (window.ResourceUsageCollector) {
                window.ResourceUsageCollector.setCollecting(false);
                window.ResourceUsageCollector.taskId = null;
            }
        } catch (error) {
            console.error('[resource_usage] Failed to stop background collection:', error);
            // 에러가 나도 로컬 상태는 업데이트
            ru.taskId = null;
            ru.intervalId = null;
            setRunning(false);
            
            if (window.ResourceUsageCollector) {
                window.ResourceUsageCollector.setCollecting(false);
                window.ResourceUsageCollector.taskId = null;
            }
        }
    }

    $('#ruStartBtn').on('click', function() { startPolling(); });
    $('#ruStopBtn').on('click', function() { stopPolling(); });
    $('#ruGroupSelect').on('change', function() {
        ru.lastCumulativeByProxy = {};
        $('#ruTableBody').empty();
        saveState(undefined);
    });
    $('#ruProxySelect').on('change', function() { saveState(undefined); });

    // Function to reset cumulative cache and resync data
    async function resyncDataOnPageReturn() {
        // Reset cumulative cache to prevent wrong delta calculations
        ru.lastCumulativeByProxy = {};
        
        // If collection is running, fetch latest data and resync
        if (ru.taskId && ru.intervalId === 'background') {
            const proxyIds = getSelectedProxyIds();
            if (proxyIds.length > 0) {
                try {
                    const latestRows = await fetchLatestForProxies(proxyIds);
                    const valid = (latestRows || []).filter(r => r && r.proxy_id && r.collected_at);
                    if (valid.length > 0) {
                        // Reset cache before updating to prevent wrong deltas
                        ru.lastCumulativeByProxy = {};
                        // Update table and charts with fresh data
                        bufferAppendBatch(valid);
                        saveBufferState();
                        renderAllCharts();
                        updateTable(valid);
                    }
                } catch (e) {
                    console.warn('[resource_usage] Failed to resync data on page return:', e);
                }
            }
        }
    }
    
    // Handle page visibility changes (tab switch, minimize, etc.)
    let lastVisibilityChange = Date.now();
    document.addEventListener('visibilitychange', function() {
        if (document.visibilityState === 'visible') {
            // Page became visible - check if enough time has passed
            const timeSinceLastChange = Date.now() - lastVisibilityChange;
            // If more than 30 seconds passed, resync data
            if (timeSinceLastChange > 30000) {
                resyncDataOnPageReturn();
            }
        } else {
            lastVisibilityChange = Date.now();
        }
    });
    
    // Handle page focus (when returning from another tab/window)
    let lastFocusTime = Date.now();
    window.addEventListener('focus', function() {
        const timeSinceLastFocus = Date.now() - lastFocusTime;
        // If more than 30 seconds passed, resync data
        if (timeSinceLastFocus > 30000 && ru.taskId) {
            resyncDataOnPageReturn();
        }
        lastFocusTime = Date.now();
    });
    
    // Show empty state initially
    $('#ruHeatmapWrap').hide();
    $('#ruEmptyState').show();
    Promise.all([
        DeviceSelector.init({
            groupSelect: '#ruGroupSelect',
            proxySelect: '#ruProxySelect',
            selectAll: '#ruSelectAll',
            onData: function(data){ ru.groups = data.groups || []; ru.proxies = data.proxies || []; }
        }),
        loadConfig()
    ]).then(function() {
        return restoreState();
    }).then(function(){
        // After restore, start or render based on persisted running flag
        try {
            const running = localStorage.getItem(RUN_STORAGE_KEY) === '1';
            // 백그라운드 작업 상태 확인
            if (window.ResourceUsageCollector && window.ResourceUsageCollector.taskId) {
                ru.taskId = window.ResourceUsageCollector.taskId;
                setRunning(true);
                ru.intervalId = 'background';
                // Resync data when page loads if collection was running
                resyncDataOnPageReturn();
            } else if (running) {
                // ensure we actually have proxies before first collect
                if (getSelectedProxyIds().length === 0) { 
                    renderAllCharts(); 
                    setRunning(false); 
                } else { 
                    startPolling(); 
                }
            } else { 
                renderAllCharts(); 
            }
        } catch (e) { 
            renderAllCharts(); 
        }
    });

    // =====================
    // Timeseries Graph UI
    // =====================
    // timeseries buffer helpers
    function bufferAppendBatch(rows) {
        const now = Date.now();
        (rows || []).forEach(row => {
            const proxyId = row.proxy_id;
            const rawTs = row.collected_at ? new Date(row.collected_at).getTime() : now;
            // quantize to bucket to align across proxies in same cycle
            const ts = Math.floor(rawTs / ru.timeBucketMs) * ru.timeBucketMs;
            ru.tsBuffer[proxyId] = ru.tsBuffer[proxyId] || { cpu: [], mem: [], cc: [], cs: [], http: [], https: [], ftp: [] };
            
            // Initialize interface buffers dynamically (now keyed by interface name)
            if (row.interface_mbps && typeof row.interface_mbps === 'object') {
                Object.keys(row.interface_mbps).forEach(ifName => {
                    const key = `if_${ifName}`;
                    if (!ru.tsBuffer[proxyId][key]) {
                        ru.tsBuffer[proxyId][key] = [];
                    }
                });
            }
            
            const intervalSec = parseInt($('#ruIntervalSec').val(), 10) || 60;
            ['cpu','mem','cc','cs'].forEach(k => {
                const v = row[k];
                if (typeof v === 'number') {
                    const arr = ru.tsBuffer[proxyId][k];
                    const last = arr[arr.length - 1];
                    if (last && last.x === ts) {
                        // replace last if same bucket to avoid duplicate labels
                        arr[arr.length - 1] = { x: ts, y: v };
                    } else {
                        arr.push({ x: ts, y: v });
                    }
                    if (ru.tsBuffer[proxyId][k].length > ru.bufferMaxPoints) {
                        ru.tsBuffer[proxyId][k].shift();
                    }
                }
            });
            
            // 프록시 트래픽(http, https, ftp)은 누적값을 Mbps로 변환하여 저장
            ['http','https','ftp'].forEach(k => {
                const v = row[k];
                if (typeof v === 'number') {
                    const arr = ru.tsBuffer[proxyId][k];
                    const lastCumulative = ru.lastCumulativeByProxy[proxyId] || {};
                    const prevCumulative = lastCumulative[k];
                    
                    let mbpsValue = null;
                    if (typeof prevCumulative === 'number') {
                        // 이전 누적값이 있으면 델타 계산 및 Mbps 변환
                        mbpsValue = calculateTrafficMbps(v, prevCumulative, intervalSec);
                    }
                    
                    // 누적값 업데이트
                    ru.lastCumulativeByProxy[proxyId] = ru.lastCumulativeByProxy[proxyId] || {};
                    ru.lastCumulativeByProxy[proxyId][k] = v;
                    
                    // Mbps 값이 유효한 경우에만 버퍼에 저장
                    if (mbpsValue !== null && mbpsValue >= 0) {
                        const last = arr[arr.length - 1];
                        if (last && last.x === ts) {
                            arr[arr.length - 1] = { x: ts, y: mbpsValue };
                        } else {
                            arr.push({ x: ts, y: mbpsValue });
                        }
                        if (ru.tsBuffer[proxyId][k].length > ru.bufferMaxPoints) {
                            ru.tsBuffer[proxyId][k].shift();
                        }
                    }
                }
            });
            
            // Add interface data to buffer (per interface, now keyed by name)
            if (row.interface_mbps && typeof row.interface_mbps === 'object') {
                Object.keys(row.interface_mbps).forEach(ifName => {
                    const ifData = row.interface_mbps[ifName];
                    if (ifData && typeof ifData === 'object') {
                        const inMbps = typeof ifData.in_mbps === 'number' ? ifData.in_mbps : 0;
                        const outMbps = typeof ifData.out_mbps === 'number' ? ifData.out_mbps : 0;
                        const totalMbps = inMbps + outMbps;
                        const key = `if_${ifName}`;
                        const arr = ru.tsBuffer[proxyId][key] || [];
                        const last = arr[arr.length - 1];
                        if (last && last.x === ts) {
                            arr[arr.length - 1] = { x: ts, y: totalMbps };
                        } else {
                            arr.push({ x: ts, y: totalMbps });
                        }
                        ru.tsBuffer[proxyId][key] = arr;
                        if (arr.length > ru.bufferMaxPoints) {
                            arr.shift();
                        }
                    }
                });
            }
        });
        // prune old points (defensively skip null/invalid)
        const cutoff = now - ru.bufferWindowMs;
        Object.values(ru.tsBuffer).forEach(byMetric => {
            Object.keys(byMetric).forEach(k => {
                const arr = Array.isArray(byMetric[k]) ? byMetric[k] : [];
                byMetric[k] = arr.filter(p => p && typeof p.x === 'number' && p.x >= cutoff);
            });
        });
    }

    function ensureApexChartsDom(isModal = false, metricKey = null, height = 300) {
        const selector = isModal ? `#ruModalChart` : '#ruChartsWrap';
        const $wrap = $(selector);
        if ($wrap.length === 0) return false;

        if (!isModal) {
            if ($wrap.data('initialized')) return true;
            const basicMetrics = ['cpu','mem','cc','cs','http','https','ftp'];
            const basicTitles = { cpu: 'CPU', mem: 'MEM', cc: 'CC', cs: 'CS', http: 'HTTP', https: 'HTTPS', ftp: 'FTP' };
            
            // Get configured interfaces from config
            const interfaceOids = (cachedConfig && cachedConfig.interface_oids) ? cachedConfig.interface_oids : {};
            const configuredInterfaceNames = Object.keys(interfaceOids);
            
            // Helper function to abbreviate long interface names
            function abbreviateInterfaceName(name) {
                if (!name) return name;
                const abbrevs = {
                    'GigabitEthernet': 'Gi',
                    'FastEthernet': 'Fa',
                    'TenGigabitEthernet': 'Te',
                    'Ethernet': 'Eth'
                };
                let abbrev = name;
                for (const [full, short] of Object.entries(abbrevs)) {
                    if (name.startsWith(full)) {
                        abbrev = name.replace(full, short);
                        break;
                    }
                }
                if (abbrev.length > 15) {
                    abbrev = abbrev.substring(0, 12) + '...';
                }
                return abbrev;
            }
            
            const metrics = [...basicMetrics, ...configuredInterfaceNames.map(ifName => `if_${ifName}`)];
            const titles = { ...basicTitles };
            configuredInterfaceNames.forEach(ifName => {
                titles[`if_${ifName}`] = abbreviateInterfaceName(ifName);
            });
            $wrap.empty();
            metrics.forEach(m => {
                const panel = `
                    <div class="column is-12">
                        <div class="ru-chart-panel" id="ruChartPanel-${m}" style="border:1px solid var(--border-color,#e5e7eb); border-radius:6px; padding:8px;">
                            <div class="level" style="margin-bottom:6px;">
                                <div class="level-left"><h5 class="title is-6" style="margin:0;">${titles[m]}</h5></div>
                                <div class="level-right">
                                    <a class="button is-small ru-chart-zoom-btn" data-metric="${m}" title="Zoom in">확대</a>
                                </div>
                            </div>
                            <div id="ruApex-${m}" style="width:100%; height:${height}px;"></div>
                        </div>
                    </div>`;
                $wrap.append(panel);
            });
            $wrap.data('initialized', true);
        } else {
            // For modal, just create one chart placeholder
            $wrap.empty();
            const placeholder = `<div id="ruApexModal-${metricKey}" style="width:100%; height:${height}px;"></div>`;
            $wrap.append(placeholder);
        }
        return true;
    }

    // raw timeseries only; no mode (helper removed)

    // Assign consistent colors per proxy (same color across metrics of a proxy)
    function colorForProxy(proxyId) {
        ru._proxyColorMap = ru._proxyColorMap || {};
        if (ru._proxyColorMap[proxyId]) return ru._proxyColorMap[proxyId];
        // High-contrast qualitative palette (Tableau 10 + few extras)
        const palette = [
            '#4E79A7', '#F28E2B', '#E15759', '#76B7B2', '#59A14F',
            '#EDC948', '#B07AA1', '#FF9DA7', '#9C755F', '#BAB0AC',
            '#1F77B4', '#2CA02C', '#D62728', '#9467BD', '#8C564B',
            '#E377C2', '#7F7F7F', '#BCBD22', '#17BECF'
        ];
        const idx = Math.abs(parseInt(proxyId, 10) || 0) % palette.length;
        const hex = palette[idx];
        ru._proxyColorMap[proxyId] = hex;
        return hex;
    }

    function renderAllCharts() {
        if (!window.ApexCharts) return;
        ensureApexChartsDom(false, null, 300); // Main charts with default height
        
        // Get configured interfaces from config
        const interfaceOids = (cachedConfig && cachedConfig.interface_oids) ? cachedConfig.interface_oids : {};
        const configuredInterfaceNames = Object.keys(interfaceOids);
        
        const basicMetrics = ['cpu','mem','cc','cs','http','https','ftp'];
        const interfaceMetrics = configuredInterfaceNames.map(ifName => `if_${ifName}`);
        const metrics = [...basicMetrics, ...interfaceMetrics];
        
        metrics.forEach(m => renderMetricChart(m, false));
    }

    function renderMetricChart(metricKey, isModal = false) {
        const height = isModal ? $(window).height() * 0.7 : 300;
        const elId = isModal ? `ruApexModal-${metricKey}` : `ruApex-${metricKey}`;
        const el = document.getElementById(elId);
        if (!el) return;

        function abbreviateNumber(value) {
            if (value == null || typeof value !== 'number') return '0';
            if (value < 1000) return value.toString();
            const suffixes = ["", "k", "M", "B", "T"];
            const i = Math.floor(Math.log10(value) / 3);
            let num = (value / Math.pow(1000, i));
            if (num === Math.floor(num)) { return num.toFixed(0) + suffixes[i]; }
            return num.toFixed(1) + suffixes[i];
        }

        const selectedProxyIds = getSelectedProxyIds();
        // Build union of timestamps
        const tsSet = new Set();
        selectedProxyIds.forEach(pid => {
            const buffer = ru.tsBuffer[pid] || {};
            const series = buffer[metricKey] || [];
            series.forEach(p => { if (p && typeof p.x === 'number') tsSet.add(p.x); });
        });
        const labelsMs = Array.from(tsSet).sort((a,b) => a-b);
        const labelToIndex = new Map(labelsMs.map((ms, i) => [ms, i]));

        ru.legendState[metricKey] = ru.legendState[metricKey] || {};
        const series = [];
        const seriesProxyMap = [];
        selectedProxyIds.forEach(proxyId => {
            const byMetric = ru.tsBuffer[proxyId] || {};
            const arr = byMetric[metricKey] || [];
            const values = new Array(labelsMs.length).fill(null);
            arr.forEach(p => {
                if (!p || typeof p.x !== 'number') return;
                const idx = labelToIndex.get(p.x);
                if (idx !== undefined) values[idx] = (typeof p.y === 'number') ? p.y : null;
            });
            // http/https/ftp는 이미 Mbps로 변환되어 버퍼에 저장되어 있으므로 추가 처리 불필요
            if (values.some(v => typeof v === 'number')) {
                const proxyMeta = (ru.proxies || []).find(p => String(p.id) === String(proxyId));
                const proxyLabel = proxyMeta ? proxyMeta.host : `#${proxyId}`;
                const paired = labelsMs.map((ms, i) => ({ x: ms, y: values[i] }));
                series.push({ name: proxyLabel, data: paired });
                seriesProxyMap.push(proxyId);
            }
        });

        // deterministic colors based on proxy order
        const colors = seriesProxyMap.map(pid => colorForProxy(pid));
        ru.seriesMap[metricKey] = seriesProxyMap;

        const options = {
            chart: {
                type: 'line', height: height, animations: { enabled: false }, toolbar: { show: false },
                events: {
                    legendClick: function(chartContext, seriesIndex, config) {
                        const proxyId = ru.seriesMap[metricKey] && ru.seriesMap[metricKey][seriesIndex];
                        if (proxyId != null) {
                            // Toggle persists inside Apex; we flip our state for persistence across reloads
                            const prev = !!(ru.legendState[metricKey] && ru.legendState[metricKey][proxyId]);
                            ru.legendState[metricKey] = ru.legendState[metricKey] || {};
                            ru.legendState[metricKey][proxyId] = !prev;
                            saveLegendState();
                        }
                    },
                    mouseMove: function(event, chartContext, config) {
                        // On mouse out, reset all opacities
                        if (config.seriesIndex < 0) {
                            (chartContext.w.globals.series || []).forEach((s, i) => {
                                chartContext.updateSeries([{ data: s }], false);
                            });
                            chartContext.w.globals.dom.el.style.cursor = 'default';
                            return;
                        }
                        // On hover, dim all series except the hovered one
                        const seriesIndex = config.seriesIndex;
                        (chartContext.w.globals.series || []).forEach((s, i) => {
                            const newOpacity = (i === seriesIndex) ? 1 : 0.3;
                            chartContext.w.globals.dom.el.querySelector(`.apexcharts-series[seriesName="${s.name.replace(/"/g, '\\"')}"]`).style.opacity = newOpacity;
                        });
                        chartContext.w.globals.dom.el.style.cursor = 'pointer';
                    },
                    mouseLeave: function(event, chartContext, config) {
                        // Reset all opacities when mouse leaves the chart area
                        (chartContext.w.globals.series || []).forEach((s, i) => {
                           chartContext.w.globals.dom.el.querySelector(`.apexcharts-series[seriesName="${s.name.replace(/"/g, '\\"')}"]`).style.opacity = 1;
                        });
                        chartContext.w.globals.dom.el.style.cursor = 'default';
                    }
                }
            },
            colors: colors,
            stroke: { width: 2, curve: 'straight' },
            markers: {
                size: 4,
                hover: { sizeOffset: 3 }
            },
            dataLabels: { enabled: false },
            xaxis: { type: 'datetime', labels: { datetimeUTC: false } },
            yaxis: {
                decimalsInFloat: 0,
                labels: {
                    formatter: function(val) {
                        if (val == null) return '0';
                        if (metricKey === 'http' || metricKey === 'https' || metricKey === 'ftp') {
                            // 이미 Mbps 단위로 변환된 값
                            return val.toFixed(1) + ' Mbps';
                        }
                        if (metricKey === 'cc' || metricKey === 'cs') { return abbreviateNumber(val); }
                        if (metricKey.startsWith('if_')) { return val.toFixed(1) + ' Mbps'; }
                        return val;
                    }
                }
            },
            tooltip: {
                shared: false,
                intersect: true,
                x: { format: 'HH:mm:ss' },
                y: {
                    formatter: function(val) {
                        if (val == null) return 'N/A';
                        if (metricKey === 'http' || metricKey === 'https' || metricKey === 'ftp') {
                            // 이미 Mbps 단위로 변환된 값
                            return val.toFixed(2) + ' Mbps';
                        }
                        if (metricKey === 'cc' || metricKey === 'cs') { return formatNumber(Math.round(val)); }
                        if (metricKey === 'cpu' || metricKey === 'mem') { return String(Math.round(val)); }
                        if (metricKey.startsWith('if_')) { return val.toFixed(2) + ' Mbps'; }
                        return val;
                    }
                }
            },
            legend: { show: true }
        };

        const chartRef = isModal ? 'modalChart' : metricKey;
        const chartInstance = isModal ? ru.modalChart : ru.charts[metricKey];

        if (!chartInstance) {
            const newChart = new ApexCharts(el, { ...options, series });
            if (isModal) {
                ru.modalChart = newChart;
            } else {
                ru.charts[metricKey] = newChart;
            }
            newChart.render().then(() => {
                if (!isModal) {
                    (ru.seriesMap[metricKey] || []).forEach((pid, i) => {
                        if (ru.legendState[metricKey] && ru.legendState[metricKey][pid]) {
                            try { newChart.toggleSeries(series[i].name); } catch (e) {}
                        }
                    });
                }
            });
        } else {
            chartInstance.updateOptions({ ...options, colors }, false, true);
            chartInstance.updateSeries(series, true);
        }
    }

    // initialize DOM, legend and buffer state
    ru.legendState = loadLegendState();
    ru.tsBuffer = loadBufferState();
    // initialize charts DOM for ApexCharts
    ensureApexChartsDom();

    // ===============
    // Modal Zoom Logic
    // ===============
    const $modal = $('#ruChartModal');
    const $modalTitle = $('#ruModalTitle');
    ru.modalChart = null;

    function openModal(metricKey) {
        const titles = { cpu: 'CPU', mem: 'MEM', cc: 'CC', cs: 'CS', http: 'HTTP', https: 'HTTPS', ftp: 'FTP' };
        if (metricKey.startsWith('if_')) {
            const ifName = metricKey.replace('if_', '');
            $modalTitle.text(`${ifName} 회선사용률`);
        } else {
            $modalTitle.text(titles[metricKey] || 'Chart');
        }
        const modalHeight = $(window).height() * 0.7;
        ensureApexChartsDom(true, metricKey, modalHeight);
        renderMetricChart(metricKey, true);
        $modal.addClass('is-active');
    }

    function closeModal() {
        $modal.removeClass('is-active');
        if (ru.modalChart) {
            ru.modalChart.destroy();
            ru.modalChart = null;
        }
        $('#ruModalChart').empty();
    }

    $('#ruChartsWrap').on('click', '.ru-chart-zoom-btn', function() {
        const metric = $(this).data('metric');
        if (metric) openModal(metric);
    });

    $modal.find('.modal-background, .delete').on('click', closeModal);
});

