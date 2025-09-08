$(document).ready(function() {
    const ru = {
        intervalId: null,
        lastCumulativeByProxy: {},
        proxies: [],
        groups: [],
        chart: { canvas: null, ctx: null, dpr: (window.devicePixelRatio || 1), chartJs: null },
        // timeseries buffer: { [proxyId]: { metricKey: [{x:ms, y:number}] } }
        tsBuffer: {},
        bufferWindowMs: 60 * 60 * 1000, // last 1 hour
        bufferMaxPoints: 600
    };
    const STORAGE_KEY = 'ru_state_v1';

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

    function updateTable(items) {
        const $tbody = $('#ruTableBody');
        $tbody.empty();
        items.forEach(row => {
            const proxy = (ru.proxies || []).find(p => p.id === row.proxy_id);
            const name = proxy ? `${proxy.host}` : `#${row.proxy_id}`;
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
            const trId = `ru-row-${row.proxy_id}`;
            const cpuStr = (row.cpu ?? '').toString();
            const memStr = (row.mem ?? '').toString();
            const ccStr = (row.cc ?? '').toString();
            const csStr = (row.cs ?? '').toString();
            const httpStr = (deltas.http ?? '').toString();
            const httpsStr = (deltas.https ?? '').toString();
            const ftpStr = (deltas.ftp ?? '').toString();
            const timeStr = row.collected_at ? new Date(row.collected_at).toLocaleString() : '';
            const rowHtml = `
                <tr id="${trId}">
                    <td>${name}</td>
                    <td>${timeStr}</td>
                    <td>${cpuStr}</td>
                    <td>${memStr}</td>
                    <td>${ccStr}</td>
                    <td>${csStr}</td>
                    <td>${httpStr}</td>
                    <td>${httpsStr}</td>
                    <td>${ftpStr}</td>
                </tr>`;
            const $existing = $(`#${trId}`);
            if ($existing.length) { $existing.replaceWith(rowHtml); } else { $tbody.append(rowHtml); }
        });
        // Toggle empty/table state
        if (!items || items.length === 0) { $('#ruTableWrap').hide(); $('#ruEmptyState').show(); }
        else { $('#ruEmptyState').hide(); $('#ruTableWrap').show(); }
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
                bufferAppendBatch(latestRows);
                renderSeries();
            }).catch(() => {
                // fallback: use returned items
                bufferAppendBatch(items);
                renderSeries();
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
    $('#ruTableWrap').hide();
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
            const ts = row.collected_at ? new Date(row.collected_at).getTime() : now;
            ru.tsBuffer[proxyId] = ru.tsBuffer[proxyId] || { cpu: [], mem: [], cc: [], cs: [], http: [], https: [], ftp: [] };
            ['cpu','mem','cc','cs','http','https','ftp'].forEach(k => {
                const v = row[k];
                if (typeof v === 'number') {
                    ru.tsBuffer[proxyId][k].push({ x: ts, y: v });
                    if (ru.tsBuffer[proxyId][k].length > ru.bufferMaxPoints) {
                        ru.tsBuffer[proxyId][k].shift();
                    }
                }
            });
        });
        // prune old points
        const cutoff = now - ru.bufferWindowMs;
        Object.values(ru.tsBuffer).forEach(byMetric => {
            Object.keys(byMetric).forEach(k => {
                byMetric[k] = (byMetric[k] || []).filter(p => p.x >= cutoff);
            });
        });
    }

    function initChart() {
        const canvas = document.getElementById('ruChartCanvas');
        if (!canvas) return false;
        ru.chart.canvas = canvas;
        ru.chart.ctx = canvas.getContext('2d');
        resizeChart();
        window.addEventListener('resize', resizeChart);
        return true;
    }

    function resizeChart() {
        const canvas = ru.chart.canvas;
        if (!canvas) return;
        const dpr = ru.chart.dpr;
        const rect = canvas.getBoundingClientRect();
        const width = Math.max(300, Math.floor(rect.width));
        const height = 320;
        canvas.style.width = width + 'px';
        canvas.style.height = height + 'px';
        canvas.width = Math.floor(width * dpr);
        canvas.height = Math.floor(height * dpr);
        renderSeries();
    }

    function getSelectedMetrics() {
        const keys = ['cpu','mem','cc','cs','http','https','ftp'];
        return keys.filter(k => $('#ruMetric-' + k).is(':checked'));
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

    function fetchSeries() {
        clearSeriesError();
        const proxyIds = getSelectedProxyIds();
        if (proxyIds.length === 0) { showSeriesError('그래프: 프록시를 하나 이상 선택하세요.'); return; }
        // series API removed; this function is unused now
        return Promise.resolve();
    }

    function colorForSeries(metricKey, seriesIdx) {
        const base = {
            cpu: [46, 204, 113],
            mem: [52, 152, 219],
            cc: [155, 89, 182],
            cs: [241, 196, 15],
            http: [231, 76, 60],
            https: [230, 126, 34],
            ftp: [26, 188, 156]
        }[metricKey] || [100, 100, 100];
        const lighten = Math.min(40, seriesIdx * 10);
        const r = Math.max(0, Math.min(255, base[0] + lighten));
        const g = Math.max(0, Math.min(255, base[1] + lighten));
        const b = Math.max(0, Math.min(255, base[2] + lighten));
        return `rgb(${r}, ${g}, ${b})`;
    }

    function renderSeries() {
        // For now, still draw via Canvas. In next step we may switch to Chart.js.
        const canvas = ru.chart.canvas;
        const ctx = ru.chart.ctx;
        if (!canvas || !ctx) return;
        const dpr = ru.chart.dpr;
        ctx.save();
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        const selectedMetrics = getSelectedMetrics();
        // Flatten buffer into series per proxy/metric
        const series = [];
        let xMin = null, xMax = null;
        let yMin = null, yMax = null;
        let sIdx = 0;
        Object.entries(ru.tsBuffer).forEach(([proxyId, byMetric]) => {
            selectedMetrics.forEach(metricKey => {
                const pts = (byMetric[metricKey] || []);
                if (pts.length > 0) {
                    pts.forEach(p => {
                        if (xMin === null || p.x < xMin) xMin = p.x;
                        if (xMax === null || p.x > xMax) xMax = p.x;
                        if (yMin === null || p.y < yMin) yMin = p.y;
                        if (yMax === null || p.y > yMax) yMax = p.y;
                    });
                    series.push({ label: `${metricKey.toUpperCase()} #${proxyId}`, color: colorForSeries(metricKey, sIdx++), points: pts });
                }
            });
        });

        if (xMin === null || xMax === null || xMin === xMax) {
            ctx.fillStyle = '#94a3b8';
            ctx.font = `${12 * dpr}px sans-serif`;
            ctx.fillText('데이터가 없습니다. 수집을 시작하세요.', 12 * dpr, 20 * dpr);
            ctx.restore();
            return;
        }

        const padding = { left: 50 * dpr, right: 20 * dpr, top: 16 * dpr, bottom: 28 * dpr };
        const W = canvas.width, H = canvas.height;
        const plotW = Math.max(10, W - padding.left - padding.right);
        const plotH = Math.max(10, H - padding.top - padding.bottom);
        const yPad = (yMax - yMin) * 0.08;
        yMin -= yPad; yMax += yPad;
        function xToPx(x) { return padding.left + ((x - xMin) / (xMax - xMin)) * plotW; }
        function yToPx(y) { return padding.top + (1 - (y - yMin) / (yMax - yMin)) * plotH; }

        ctx.strokeStyle = '#e5e7eb';
        ctx.lineWidth = 1 * dpr;
        ctx.beginPath();
        for (let i = 0; i <= 5; i++) {
            const yv = yMin + (i / 5) * (yMax - yMin);
            const y = Math.round(yToPx(yv)) + 0.5;
            ctx.moveTo(padding.left, y);
            ctx.lineTo(W - padding.right, y);
        }
        ctx.stroke();

        ctx.fillStyle = '#64748b';
        ctx.font = `${11 * dpr}px sans-serif`;
        for (let i = 0; i <= 5; i++) {
            const xv = xMin + (i / 5) * (xMax - xMin);
            const x = xToPx(xv);
            const d = new Date(xv);
            const hh = String(d.getHours()).padStart(2, '0');
            const mm = String(d.getMinutes()).padStart(2, '0');
            const label = `${hh}:${mm}`;
            ctx.fillText(label, x - 12 * dpr, H - 8 * dpr);
        }

        series.forEach(s => {
            if (!s.points || s.points.length === 0) return;
            ctx.beginPath();
            ctx.strokeStyle = s.color;
            ctx.lineWidth = 2 * dpr;
            s.points.forEach((p, idx) => {
                const x = xToPx(p.x);
                const y = yToPx(p.y);
                if (idx === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
            });
            ctx.stroke();
        });

        ctx.restore();
    }

    // auto series refresh removed (chart updates on collect)

    if (initChart()) {
        $('#ruMetric-cpu, #ruMetric-mem, #ruMetric-cc, #ruMetric-cs, #ruMetric-http, #ruMetric-https, #ruMetric-ftp').on('change', function() { renderSeries(); });
    }
});

