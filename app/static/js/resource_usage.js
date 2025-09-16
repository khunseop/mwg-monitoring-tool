$(document).ready(function() {
    const ru = {
        intervalId: null,
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
        legendState: {} // { [metricKey]: { [proxyId]: hiddenBoolean } }
    };
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
            if (!raw) return;
            const state = JSON.parse(raw);
            if (state.groupId !== undefined) {
                $('#ruGroupSelect').val(state.groupId);
                // Trigger change so DeviceSelector repopulates proxies for selected group
                $('#ruGroupSelect').trigger('change');
            }
            if (Array.isArray(state.proxyIds)) {
                const strIds = state.proxyIds.map(id => String(id));
                $('#ruProxySelect option').each(function() {
                    $(this).prop('selected', strIds.includes($(this).val()));
                });
            }
            if (Array.isArray(state.items) && state.items.length > 0) {
                // Reset cumulative cache so deltas don't mislead on restore
                ru.lastCumulativeByProxy = {};
                updateTable(state.items);
            }
        } catch (e) { /* ignore */ }
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
                Object.keys(out[pid]).forEach(m => {
                    const arr = Array.isArray(byMetric[m]) ? byMetric[m] : [];
                    // keep within window and type-safe
                    out[pid][m] = arr.filter(p => p && typeof p.x === 'number' && typeof p.y === 'number');
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
        const rows = [];
        (items || []).forEach(row => {
            const last = ru.lastCumulativeByProxy[row.proxy_id] || {};
            const deltas = { http: null, https: null, ftp: null };
            ['http','https','ftp'].forEach(k => {
                const v = row[k];
                if (typeof v === 'number' && typeof last[k] === 'number') {
                    const d = v - last[k];
                    deltas[k] = (d >= 0) ? d : null;
                }
            });
            ru.lastCumulativeByProxy[row.proxy_id] = {
                http: typeof row.http === 'number' ? row.http : last.http,
                https: typeof row.https === 'number' ? row.https : last.https,
                ftp: typeof row.ftp === 'number' ? row.ftp : last.ftp,
            };
            rows.push({
                proxy_id: row.proxy_id,
                cpu: typeof row.cpu === 'number' ? row.cpu : null,
                mem: typeof row.mem === 'number' ? row.mem : null,
                cc: typeof row.cc === 'number' ? row.cc : null,
                cs: typeof row.cs === 'number' ? row.cs : null,
                httpd: deltas.http,
                httpsd: deltas.https,
                ftpd: deltas.ftp,
            });
        });

        rows.sort((a, b) => {
            const pa = (ru.proxies || []).find(p => p.id === a.proxy_id);
            const pb = (ru.proxies || []).find(p => p.id === b.proxy_id);
            const na = pa ? pa.host : String(a.proxy_id);
            const nb = pb ? pb.host : String(b.proxy_id);
            return na.localeCompare(nb);
        });

        const metrics = [
            { key: 'cpu', title: 'CPU' },
            { key: 'mem', title: 'MEM' },
            { key: 'cc', title: 'CC' },
            { key: 'cs', title: 'CS' },
            { key: 'httpd', title: 'HTTP Δ' },
            { key: 'httpsd', title: 'HTTPS Δ' },
            { key: 'ftpd', title: 'FTP Δ' },
        ];

        const maxByMetric = {};
        metrics.forEach(m => {
            const vals = rows
                .map(r => r[m.key])
                .filter(v => typeof v === 'number' && isFinite(v) && v >= 0)
                .sort((a, b) => a - b);
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
            const proxy = (ru.proxies || []).find(p => p.id === r.proxy_id);
            return proxy ? proxy.host : `#${r.proxy_id}`;
        });

        const data = [];
        rows.forEach((r, y) => {
            metrics.forEach((m, x) => {
                const raw = r[m.key];
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
        function baseKeyFor(metricKey) {
            if (metricKey === 'httpd') return 'http';
            if (metricKey === 'httpsd') return 'https';
            if (metricKey === 'ftpd') return 'ftp';
            return metricKey;
        }
        const scaleForCol = metrics.map(m => {
            const baseKey = baseKeyFor(m.key);
            const t = (typeof thr[baseKey] === 'number' && isFinite(thr[baseKey]) && thr[baseKey] > 0) ? thr[baseKey] : (maxByMetric[m.key] || 1);
            return function(v) {
                if (typeof v !== 'number' || !isFinite(v)) return null;
                const scaled = (v / t) * 100;
                return Math.max(0, Math.min(150, Math.round(scaled)));
            };
        });

        // Preserve raw values separately for labels/tooltips
        ru._heatRaw = yCategories.map(() => new Array(xCategories.length).fill(null));

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

        const options = {
            chart: { type: 'heatmap', height: 460, animations: { enabled: false }, toolbar: { show: false } },
            dataLabels: { enabled: true, style: { colors: ['#111827'] }, formatter: function(val, opts) {
                const y = opts.seriesIndex; const x = opts.dataPointIndex;
                const raw = (ru._heatRaw && ru._heatRaw[y]) ? ru._heatRaw[y][x] : null;
                return raw == null ? '' : String(Math.round(raw));
            } },
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
            xaxis: { type: 'category', categories: xCategories },
            yaxis: { labels: { style: { fontSize: '11px' } } },
            tooltip: { y: { formatter: function(val, { seriesIndex, dataPointIndex }) {
                const raw = (ru._heatRaw && ru._heatRaw[seriesIndex]) ? ru._heatRaw[seriesIndex][dataPointIndex] : null;
                if (raw == null) return 'N/A';
                const percent = (val == null || val < 0) ? null : Math.round(val) + '% of threshold';
                return percent ? `${raw} (${percent})` : String(raw);
            } } },
            series: seriesData
        };

        if (ru.apex) { ru.apex.updateOptions(options, true, true); }
        else { ru.apex = new ApexCharts(el, options); ru.apex.render(); }

        if (!items || items.length === 0) { $('#ruHeatmapWrap').hide(); $('#ruEmptyState').show(); }
        else { $('#ruEmptyState').hide(); $('#ruHeatmapWrap').show(); }
    }

    function collectOnce() {
        clearRuError();
        const proxyIds = getSelectedProxyIds();
        if (proxyIds.length === 0) { showRuError('프록시를 하나 이상 선택하세요.'); return; }
        const community = (cachedConfig && cachedConfig.community) ? cachedConfig.community.toString() : 'public';
        const oids = (cachedConfig && cachedConfig.oids) ? cachedConfig.oids : {};
        if (Object.keys(oids).length === 0) { showRuError('설정된 OID가 없습니다. 설정 페이지를 확인하세요.'); return; }
        return $.ajax({
            url: '/api/resource-usage/collect',
            method: 'POST',
            contentType: 'application/json',
            data: JSON.stringify({ proxy_ids: proxyIds, community: community, oids: oids })
        }).then(res => {
            const items = (res && Array.isArray(res.items)) ? res.items : [];
            updateTable(items);
            if (Array.isArray(items)) { saveState(items); } else { saveState(undefined); }
            if (res && res.failed && res.failed > 0) { showRuError('일부 프록시 수집에 실패했습니다.'); }
            // Fetch latest rows from DB to ensure consistency and append to buffer
            fetchLatestForProxies(proxyIds).then(latestRows => {
                // filter invalid latest rows
                const valid = (latestRows || []).filter(r => r && r.proxy_id && r.collected_at);
                bufferAppendBatch(valid);
                saveBufferState();
                renderAllCharts();
            }).catch(() => {
                // fallback: use returned items
                const valid = (items || []).filter(r => r && r.proxy_id && r.collected_at);
                bufferAppendBatch(valid);
                saveBufferState();
                renderAllCharts();
            });
        }).catch(() => { showRuError('수집 요청 중 오류가 발생했습니다.'); });
    }

    function fetchLatestForProxies(proxyIds) {
        const reqs = (proxyIds || []).map(id => $.getJSON(`/api/resource-usage/latest/${id}`).catch(() => null));
        return Promise.all(reqs).then(rows => rows.filter(r => r && r.id));
    }

    function startPolling() {
        if (ru.intervalId) return;
        const intervalSec = parseInt($('#ruIntervalSec').val(), 10) || 30;
        const periodMs = Math.max(5, intervalSec) * 1000;
        setRunning(true);
        collectOnce();
        ru.intervalId = setInterval(() => { collectOnce(); }, periodMs);
    }
    function stopPolling() {
        if (ru.intervalId) { clearInterval(ru.intervalId); ru.intervalId = null; }
        setRunning(false);
    }

    $('#ruStartBtn').on('click', function() { startPolling(); });
    $('#ruStopBtn').on('click', function() { stopPolling(); });
    $('#ruGroupSelect').on('change', function() {
        ru.lastCumulativeByProxy = {};
        $('#ruTableBody').empty();
        saveState(undefined);
    });
    $('#ruProxySelect').on('change', function() { saveState(undefined); });

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
    ]).then(function(){ restoreState(); });

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
            ['cpu','mem','cc','cs','http','https','ftp'].forEach(k => {
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

    function ensureApexChartsDom() {
        const $wrap = $('#ruChartsWrap');
        if ($wrap.length === 0) return false;
        if ($wrap.data('initialized')) return true;
        const metrics = ['cpu','mem','cc','cs','http','https','ftp'];
        const titles = { cpu: 'CPU', mem: 'MEM', cc: 'CC', cs: 'CS', http: 'HTTP', https: 'HTTPS', ftp: 'FTP' };
        $wrap.empty();
        metrics.forEach(m => {
            const panel = `
                <div class="column is-12">
                    <div class="ru-chart-panel" id="ruChartPanel-${m}" style="border:1px solid var(--border-color,#e5e7eb); border-radius:6px; padding:8px;">
                        <div class="level" style="margin-bottom:6px;">
                            <div class="level-left"><h5 class="title is-6" style="margin:0;">${titles[m]}</h5></div>
                        </div>
                        <div id="ruApex-${m}" style="width:100%; height:200px;"></div>
                    </div>
                </div>`;
            $wrap.append(panel);
        });
        $wrap.data('initialized', true);
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
        ensureApexChartsDom();
        const metrics = ['cpu','mem','cc','cs','http','https','ftp'];
        metrics.forEach(m => renderMetricChart(m));
    }

    function renderMetricChart(metricKey) {
        const el = document.getElementById(`ruApex-${metricKey}`);
        if (!el) return;
        const selectedProxyIds = getSelectedProxyIds();
        // Build union of timestamps
        const tsSet = new Set();
        selectedProxyIds.forEach(pid => {
            const series = (ru.tsBuffer[pid] && ru.tsBuffer[pid][metricKey]) ? ru.tsBuffer[pid][metricKey] : [];
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
            if (metricKey === 'http' || metricKey === 'https' || metricKey === 'ftp') {
                let prev = null;
                for (let i = 0; i < values.length; i++) {
                    const v = values[i];
                    if (typeof v === 'number' && typeof prev === 'number') {
                        const d = v - prev;
                        values[i] = (d >= 0) ? d : null;
                    } else {
                        values[i] = null;
                    }
                    if (typeof v === 'number') prev = v;
                }
            }
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
                type: 'line', height: 200, animations: { enabled: false }, toolbar: { show: false },
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
                    }
                }
            },
            colors: colors,
            stroke: { width: 2, curve: 'smooth' },
            markers: { size: 0 },
            dataLabels: { enabled: false },
            xaxis: { type: 'datetime', labels: { datetimeUTC: false } },
            yaxis: { decimalsInFloat: 0 },
            tooltip: { shared: true, x: { format: 'HH:mm:ss' } },
            legend: { show: true }
        };

        if (!ru.charts[metricKey]) {
            ru.charts[metricKey] = new ApexCharts(el, { ...options, series });
            ru.charts[metricKey].render().then(() => {
                // apply hidden state persistence
                (ru.seriesMap[metricKey] || []).forEach((pid, i) => {
                    if (ru.legendState[metricKey] && ru.legendState[metricKey][pid]) {
                        try { ru.charts[metricKey].toggleSeries(series[i].name); } catch (e) {}
                    }
                });
            });
        } else {
            ru.charts[metricKey].updateOptions({ colors }, false, true);
            ru.charts[metricKey].updateSeries(series, true);
        }
    }

    // initialize DOM, legend and buffer state
    ru.legendState = loadLegendState();
    ru.tsBuffer = loadBufferState();
    // initialize charts DOM for ApexCharts
    ensureApexChartsDom();
    // auto-restore running state and render charts from buffer
    try {
        const running = localStorage.getItem(RUN_STORAGE_KEY) === '1';
        if (running) { startPolling(); } else { renderAllCharts(); }
    } catch (e) { renderAllCharts(); }
});

