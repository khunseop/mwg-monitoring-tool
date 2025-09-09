$(document).ready(function() {
    const ru = {
        intervalId: null,
        lastCumulativeByProxy: {},
        proxies: [],
        groups: [],
        charts: {}, // { [metricKey]: ChartJSInstance }
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

    function fetchGroups() {
        return $.getJSON('/api/proxy-groups').then(data => {
            ru.groups = data || [];
            const $sel = $('#ruGroupSelect');
            $sel.empty();
            $sel.append('<option value="">전체</option>');
            ru.groups.forEach(g => { $sel.append(`<option value="${g.id}">${g.name}</option>`); });
        }).catch(() => { showRuError('그룹 목록을 불러오지 못했습니다.'); });
    }

    function fetchProxies() {
        return $.getJSON('/api/proxies').then(data => {
            ru.proxies = data || [];
            renderProxySelect();
        }).catch(() => { showRuError('프록시 목록을 불러오지 못했습니다.'); });
    }

    function renderProxySelect() {
        const selectedGroupId = $('#ruGroupSelect').val();
        const $sel = $('#ruProxySelect');
        $sel.empty();
        (ru.proxies || []).filter(p => {
            if (!p.is_active) return false; // 활성 프록시만
            if (!selectedGroupId) return true;
            return String(p.group_id || '') === String(selectedGroupId);
        }).forEach(p => {
            const label = `${p.host}${p.group_name ? ' ('+p.group_name+')' : ''}`;
            $sel.append(`<option value="${p.id}">${label}</option>`);
        });
    }

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
                renderProxySelect();
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

        const seriesData = yCategories.map((rowLabel, rowIdx) => {
            const dataPoints = xCategories.map((colLabel, colIdx) => {
                const point = data.find(d => d.value[0] === colIdx && d.value[1] === rowIdx);
                const raw = point ? point.raw : null;
                return { x: colLabel, y: raw == null ? null : Math.round(raw) };
            });
            return { name: rowLabel, data: dataPoints };
        });

        const options = {
            chart: { type: 'heatmap', height: 460, animations: { enabled: false }, toolbar: { show: false } },
            dataLabels: { enabled: true, style: { colors: ['#111827'] }, formatter: function(val, opts) { return val == null ? '' : val; } },
            colors: ["#12824C"],
            plotOptions: {
                heatmap: {
                    shadeIntensity: 0.5,
                    radius: 2,
                    enableShades: true,
                    colorScale: {
                        ranges: [
                            { from: 0, to: 0, color: '#f3f4f6', name: 'N/A' },
                            { from: 0, to: 1, color: '#e8f7e1' },
                            { from: 2, to: 10, color: '#cdeeb4' },
                            { from: 11, to: 30, color: '#a3d977' },
                            { from: 31, to: 60, color: '#f2c94c' },
                            { from: 61, to: 85, color: '#e67e22' },
                            { from: 86, to: 999999999, color: '#eb5757' }
                        ]
                    }
                }
            },
            xaxis: { type: 'category', categories: xCategories },
            yaxis: { labels: { style: { fontSize: '11px' } } },
            tooltip: { y: { formatter: function(val) { return val == null ? 'N/A' : String(val); } } },
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
        renderProxySelect();
        ru.lastCumulativeByProxy = {};
        $('#ruTableBody').empty();
        saveState(undefined);
    });
    $('#ruSelectAll').on('change', function() {
        const checked = $(this).is(':checked');
        $('#ruProxySelect option').prop('selected', checked);
        saveState(undefined);
    });
    $('#ruProxySelect').on('change', function() { saveState(undefined); });

    // Show empty state initially
    $('#ruHeatmapWrap').hide();
    $('#ruEmptyState').show();
    Promise.all([fetchGroups(), fetchProxies(), loadConfig()]).then(() => { restoreState(); });

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

    function ensureChartsDom() {
        const $wrap = $('#ruChartsWrap');
        if ($wrap.length === 0) return false;
        if ($wrap.data('initialized')) return true;
        const metrics = ['cpu','mem','cc','cs','http','https','ftp'];
        const titles = { cpu: 'CPU', mem: 'MEM', cc: 'CC', cs: 'CS', http: 'HTTP', https: 'HTTPS', ftp: 'FTP' };
        $wrap.empty();
        metrics.forEach(m => {
            const panel = `
                <div class="column is-4">
                    <div class="ru-chart-panel" id="ruChartPanel-${m}" style="border:1px solid var(--border-color,#e5e7eb); border-radius:6px; padding:8px;">
                        <div class="level" style="margin-bottom:6px;">
                            <div class="level-left"><h5 class="title is-6" style="margin:0;">${titles[m]}</h5></div>
                        </div>
                        <canvas id="ruChartCanvas-${m}" style="width:100%; height:180px; max-height:180px;"></canvas>
                    </div>
                </div>`;
            $wrap.append(panel);
        });
        $wrap.data('initialized', true);
        return true;
    }

    // raw timeseries only; no mode

    function toIsoOrNull(val) {
        if (!val) return null;
        const d = new Date(val);
        if (isNaN(d.getTime())) return null;
        return d.toISOString();
    }

    // no user-facing series error UI now
    function showSeriesError(msg) { /* noop */ }
    function clearSeriesError() { /* noop */ }

    function fetchSeries() { return Promise.resolve(); }

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
        if (!window.Chart) return;
        ensureChartsDom();
        const metrics = ['cpu','mem','cc','cs','http','https','ftp'];
        metrics.forEach(m => renderMetricChart(m));
    }

    function renderMetricChart(metricKey) {
        const canvas = document.getElementById(`ruChartCanvas-${metricKey}`);
        if (!canvas) return;
        const selectedProxyIds = getSelectedProxyIds();
        // Build labels from union of all timestamps in buffer for this metric (sorted)
        const tsSet = new Set();
        selectedProxyIds.forEach(pid => {
            const series = (ru.tsBuffer[pid] && ru.tsBuffer[pid][metricKey]) ? ru.tsBuffer[pid][metricKey] : [];
            series.forEach(p => { if (p && typeof p.x === 'number') tsSet.add(p.x); });
        });
        const labelsMs = Array.from(tsSet).sort((a,b) => a-b);
        const labels = labelsMs.map(ms => {
            const d = new Date(ms);
            const hh = String(d.getHours()).padStart(2, '0');
            const mm = String(d.getMinutes()).padStart(2, '0');
            const ss = String(d.getSeconds()).padStart(2, '0');
            return `${hh}:${mm}:${ss}`;
        });
        const labelToIndex = new Map(labelsMs.map((ms, i) => [ms, i]));

        const datasets = [];
        ru.legendState[metricKey] = ru.legendState[metricKey] || {};
        selectedProxyIds.forEach(proxyId => {
            const byMetric = ru.tsBuffer[proxyId] || {};
            const arr = byMetric[metricKey] || [];
            const data = new Array(labels.length).fill(null);
            arr.forEach(p => {
                if (!p || typeof p.x !== 'number') return;
                const idx = labelToIndex.get(p.x);
                if (idx !== undefined) data[idx] = (typeof p.y === 'number') ? p.y : null;
            });
            // Convert cumulative counters to delta per interval for http/https/ftp
            if (metricKey === 'http' || metricKey === 'https' || metricKey === 'ftp') {
                let prev = null;
                for (let i = 0; i < data.length; i++) {
                    const v = data[i];
                    if (typeof v === 'number' && typeof prev === 'number') {
                        const d = v - prev;
                        data[i] = (d >= 0) ? d : null;
                    } else {
                        data[i] = null;
                    }
                    if (typeof v === 'number') prev = v;
                }
            }
            if (data.some(v => typeof v === 'number')) {
                const proxyMeta = (ru.proxies || []).find(p => String(p.id) === String(proxyId));
                const proxyLabel = proxyMeta ? proxyMeta.host : `#${proxyId}`;
                const color = colorForProxy(proxyId);
                const hidden = !!ru.legendState[metricKey][proxyId];
                datasets.push({
                    label: proxyLabel,
                    data,
                    borderColor: color,
                    backgroundColor: color,
                    borderWidth: 2,
                    pointRadius: 0,
                    pointHitRadius: 6,
                    tension: 0.2,
                    spanGaps: true,
                    hidden: hidden,
                    _proxyId: proxyId
                });
            }
        });

        const options = {
            animation: false,
            normalized: true,
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                x: { type: 'category', ticks: { autoSkip: true, maxTicksLimit: 8 }, grid: { color: '#e5e7eb' } },
                y: { beginAtZero: false, ticks: { precision: 0 }, grid: { color: '#e5e7eb' } }
            },
            elements: { point: { radius: 0, hitRadius: 6, hoverRadius: 3 } },
            plugins: {
                legend: {
                    display: true,
                    labels: { boxWidth: 12 },
                    onClick: (evt, legendItem, legend) => {
                        const chart = legend.chart;
                        const index = legendItem.datasetIndex;
                        // use default toggle behavior first
                        const defaultClick = Chart.defaults.plugins.legend.onClick;
                        if (defaultClick) defaultClick.call(this, evt, legendItem, legend);
                        // persist visibility by metric/proxy
                        const ds = chart.data.datasets[index];
                        const meta = chart.getDatasetMeta(index);
                        const proxyId = ds && ds._proxyId;
                        if (proxyId != null) {
                            // hidden state is true when dataset not visible
                            const hidden = meta.hidden === true || chart.isDatasetVisible(index) === false;
                            ru.legendState[metricKey] = ru.legendState[metricKey] || {};
                            ru.legendState[metricKey][proxyId] = hidden;
                            saveLegendState();
                        }
                    }
                },
                tooltip: { mode: 'nearest', intersect: false },
                title: { display: false }
            }
        };

        if (!ru.charts[metricKey]) {
            ru.charts[metricKey] = new Chart(canvas.getContext('2d'), {
                type: 'line',
                data: { labels, datasets },
                options
            });
        } else {
            const chart = ru.charts[metricKey];
            chart.data.labels = labels;
            chart.data.datasets = datasets;
            chart.update('none');
        }
    }

    // initialize DOM, legend and buffer state
    ru.legendState = loadLegendState();
    ru.tsBuffer = loadBufferState();
    ensureChartsDom();
    // auto-restore running state and render charts from buffer
    try {
        const running = localStorage.getItem(RUN_STORAGE_KEY) === '1';
        if (running) { startPolling(); } else { renderAllCharts(); }
    } catch (e) { renderAllCharts(); }
});

