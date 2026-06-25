(function ($, window) {
    'use strict';

    const METRIC_LABELS = {
        cpu: 'CPU', mem: 'MEM', disk: 'Disk',
        cc: 'Client Count', cs: 'Connected Sockets',
        http: 'HTTP', https: 'HTTPS', http2: 'HTTP2', blocked: 'Blocked',
    };
    const METRIC_UNITS = {
        cpu: '%', mem: '%', disk: '%', cc: '', cs: '',
        http: 'Mbps', https: 'Mbps', http2: 'Mbps', blocked: '',
    };
    const BAND_COLORS = ['#22c55e', '#84cc16', '#facc15', '#f97316', '#ef4444'];
    const CHART_COLORS = ['#6366f1', '#f59e0b', '#10b981', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316'];
    const WEEKDAY_NAMES = ['월', '화', '수', '목', '금', '토', '일'];
    const MAX_EPISODES = 15;

    let _cache = {};
    let _filter = null;       // proxy_id (number) or null = 전체
    let _smoothedChart = null;

    // ── 유틸 ──────────────────────────────────────────────────────
    function getSelectedProxyIds() {
        const sel = document.getElementById('analysisPageProxySelect');
        if (!sel) return [];
        if (sel._tom) return sel._tom.getValue().map(Number).filter(Boolean);
        return Array.from(sel.selectedOptions).map(o => Number(o.value)).filter(Boolean);
    }

    function toUTC(localStr) {
        if (!localStr) return null;
        return new Date(new Date(localStr).getTime() - 9 * 3600 * 1000).toISOString();
    }

    function fmtVal(val, metric) {
        if (val === null || val === undefined) return '-';
        const u = METRIC_UNITS[metric] || '';
        if (u === '%') return val.toFixed(1) + '%';
        if (u === 'Mbps') return val.toFixed(2) + ' Mbps';
        return val >= 1000 ? (val / 1000).toFixed(1) + 'k' : String(Math.round(val));
    }

    function fmtDt(iso) {
        if (!iso) return '-';
        try {
            return new Date(iso).toLocaleString('ko-KR', {
                month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
            });
        } catch { return iso; }
    }

    function filterRows(rows, filterId) {
        return filterId !== null ? rows.filter(r => r.proxy_id === filterId) : rows;
    }

    // ── 분석 실행 ─────────────────────────────────────────────────
    async function runAnalysis() {
        const pids = getSelectedProxyIds();
        if (!pids.length) {
            alert('분석할 프록시를 선택하세요.');
            return;
        }

        const metric    = $('#analysisPrimaryMetric').val() || 'cpu';
        const threshold = parseFloat($('#analysisThreshold').val()) || 80;
        const windowMin = parseInt($('#analysisWindowMin').val()) || 5;
        const start     = $('#analysisStartTime').val();
        const end       = $('#analysisEndTime').val();
        const bh        = $('#analysisBusinessHours').is(':checked');

        const base = new URLSearchParams({ proxy_ids: pids.join(',') });
        if (start) base.set('start_time', toUTC(start));
        if (end)   base.set('end_time',   toUTC(end));
        if (bh)    base.set('business_hours', 'true');
        const wm = new URLSearchParams(base);
        wm.set('metric', metric);

        $('#analysisLoading').show();
        $('#analysisResults').hide();
        $('#analysisError').hide();

        try {
            const [percentiles, timeBand, thrDur, heatmap, topN, smoothed] = await Promise.all([
                $.getJSON(`/api/resource-usage/analysis/percentiles?${base}&metrics=cpu,mem,disk,cc,cs,http,https,http2,blocked`),
                $.getJSON(`/api/resource-usage/analysis/time-in-band?${wm}`),
                $.getJSON(`/api/resource-usage/analysis/threshold-duration?${wm}&threshold=${threshold}`),
                $.getJSON(`/api/resource-usage/analysis/heatmap-weekly?${wm}`),
                $.getJSON(`/api/resource-usage/analysis/top-n?${wm}&stat=p95&n=10`),
                $.getJSON(`/api/resource-usage/analysis/smoothed?${wm}&window_min=${windowMin}`),
            ]);

            _cache = { percentiles, timeBand, thrDur, heatmap, topN, smoothed, metric, threshold, windowMin };
            _filter = null;

            // static labels
            const ml = METRIC_LABELS[metric] || metric;
            const u  = METRIC_UNITS[metric]  || '';
            $('#analysisTimeBandMetric, #analysisHeatmapMetricLabel, #analysisThresholdMetricLabel, #analysisTopNMetricLabel, #analysisSmoothedMetricLabel').text(ml);
            $('#analysisThresholdValueLabel').text(threshold + (u || ''));
            $('#analysisSmoothedWindowLabel').text(windowMin);

            buildProxyFilter();
            renderAll(null);
            $('#analysisResults').show();
        } catch (err) {
            $('#analysisError').text('분석 오류: ' + (err.responseJSON?.detail || err.statusText || err)).show();
        } finally {
            $('#analysisLoading').hide();
        }
    }

    // ── 프록시 필터 빌드 ─────────────────────────────────────────
    function buildProxyFilter() {
        const seen = new Set();
        const proxies = [];
        for (const r of _cache.percentiles) {
            if (!seen.has(r.proxy_id)) {
                seen.add(r.proxy_id);
                proxies.push({ id: r.proxy_id, host: r.host });
            }
        }
        proxies.sort((a, b) => a.host.localeCompare(b.host));

        const btns = [
            `<button class="button is-small is-primary px-3 analysis-filter-btn" data-id="">전체</button>`,
            ...proxies.map(p =>
                `<button class="button is-small is-subtle px-3 analysis-filter-btn" data-id="${p.id}">${p.host}</button>`
            ),
        ];
        const el = document.getElementById('analysisProxyFilter');
        if (el) el.innerHTML = btns.join('');
    }

    function syncFilterButtons() {
        document.querySelectorAll('.analysis-filter-btn').forEach(btn => {
            const id = btn.dataset.id;
            const active = id === '' ? _filter === null : Number(id) === _filter;
            btn.className = `button is-small ${active ? 'is-primary' : 'is-subtle'} px-3 analysis-filter-btn`;
        });
    }

    // ── 요약 카드 ────────────────────────────────────────────────
    function renderSummaryCards() {
        const { percentiles, thrDur, metric } = _cache;
        const u = METRIC_UNITS[metric] || '';

        const fp = filterRows(percentiles.filter(r => r.metric === metric), _filter);
        const p95max = fp.reduce((m, r) => r.p95 !== null ? Math.max(m, r.p95) : m, 0);
        const valMax = fp.reduce((m, r) => r.max  !== null ? Math.max(m, r.max)  : m, 0);

        const ft = filterRows(thrDur, _filter);
        const epCount = ft.reduce((s, r) => s + r.episode_count,       0);
        const epMins  = ft.reduce((s, r) => s + r.total_duration_min,  0);

        const warnP95 = u === '%' && p95max > 70;
        const warnEp  = epCount > 0;
        const warnDur = epMins  > 30;

        const cards = [
            { label: `${METRIC_LABELS[metric] || metric} p95`, value: fmtVal(p95max, metric), color: warnP95 ? '#dc2626' : '#1e40af' },
            { label: `${METRIC_LABELS[metric] || metric} 최대`,  value: fmtVal(valMax, metric), color: '#374151' },
            { label: '임계치 초과',   value: `${epCount}건`,               color: warnEp  ? '#ea580c' : '#374151' },
            { label: '누적 초과시간', value: `${epMins.toFixed(0)}분`,      color: warnDur ? '#dc2626' : '#374151' },
        ];

        const html = cards.map(c =>
            `<div style="background:var(--color-surface,#fff);border:1px solid var(--color-border,#e2e8f0);border-radius:8px;padding:0.3rem 0.85rem;text-align:center;min-width:72px;">
                <div style="font-size:0.6rem;color:#6b7280;font-weight:600;white-space:nowrap;">${c.label}</div>
                <div style="font-size:0.9rem;font-weight:700;color:${c.color};">${c.value}</div>
            </div>`
        ).join('');
        const el = document.getElementById('analysisSummaryCards');
        if (el) el.innerHTML = html;
    }

    // ── 전체 렌더링 ───────────────────────────────────────────────
    function renderAll(filterId) {
        _filter = filterId;
        syncFilterButtons();
        renderSummaryCards();
        renderPercentiles();
        renderTimeBand();
        renderHeatmapWeekly();
        renderTopN();
        renderSmoothed();
        renderThresholdDuration();
    }

    // ── 1. 백분위수 테이블 ────────────────────────────────────────
    const METRIC_ORDER = ['cpu', 'mem', 'disk', 'cc', 'cs', 'http', 'https', 'http2', 'blocked'];

    function renderPercentiles() {
        const tbody = document.getElementById('analysisPercentilesBody');
        if (!tbody) return;
        const { percentiles, metric } = _cache;

        const rows = filterRows(percentiles, _filter).slice().sort((a, b) => {
            const ai = a.metric === metric ? -1 : METRIC_ORDER.indexOf(a.metric);
            const bi = b.metric === metric ? -1 : METRIC_ORDER.indexOf(b.metric);
            return ai !== bi ? ai - bi : a.host.localeCompare(b.host);
        });

        tbody.innerHTML = rows.map(r => {
            if (!r.count) {
                return `<tr><td>${r.host}</td><td>${METRIC_LABELS[r.metric] || r.metric}</td>
                    <td colspan="6" class="has-text-grey has-text-centered is-size-7">데이터 없음</td></tr>`;
            }
            const fmt = v => fmtVal(v, r.metric);
            const u = METRIC_UNITS[r.metric] || '';
            const isPrimary = r.metric === metric;
            const warnP95 = r.p95 !== null && ((u === '%' && r.p95 > 70) || (u === 'Mbps' && r.p95 > 100));
            const warnP99 = r.p99 !== null && ((u === '%' && r.p99 > 85));
            return `<tr style="${isPrimary ? 'background:var(--color-surface-raised,#f8fafc);' : ''}">
                <td style="font-weight:${isPrimary ? 600 : 400};">${r.host}</td>
                <td>${METRIC_LABELS[r.metric] || r.metric}${u ? ' (' + u + ')' : ''}</td>
                <td class="has-text-right">${r.count.toLocaleString()}</td>
                <td class="has-text-right">${fmt(r.mean)}</td>
                <td class="has-text-right">${fmt(r.max)}</td>
                <td class="has-text-right">${fmt(r.p50)}</td>
                <td class="has-text-right" style="${warnP95 ? 'color:#b45309;font-weight:600;' : ''}">${fmt(r.p95)}</td>
                <td class="has-text-right" style="${warnP99 ? 'color:#dc2626;font-weight:600;' : ''}">${fmt(r.p99)}</td>
            </tr>`;
        }).join('') || `<tr><td colspan="8" class="has-text-centered has-text-grey">데이터 없음</td></tr>`;
    }

    // ── 2. Time-in-Band ──────────────────────────────────────────
    function renderTimeBand() {
        const el = document.getElementById('analysisTimeBandContent');
        if (!el) return;
        const { timeBand, metric } = _cache;
        const rows = filterRows(timeBand, _filter).filter(r => r.total_samples > 0);

        if (!rows.length) { el.innerHTML = '<p class="has-text-grey is-size-7">데이터 없음</p>'; return; }

        const bandLabels = rows[0]?.bands?.map(b => b.label) || [];
        const legend = bandLabels.map((lbl, i) =>
            `<span style="display:inline-flex;align-items:center;gap:3px;margin-right:10px;font-size:0.68rem;white-space:nowrap;">
                <span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${BAND_COLORS[i]};"></span>${lbl}
            </span>`
        ).join('');

        const blocks = rows.map(r => {
            const bar = r.bands.map((b, i) => b.pct > 0
                ? `<div title="${b.label}: ${b.pct}% (${b.duration_min}분)"
                        style="width:${b.pct}%;background:${BAND_COLORS[i]};height:20px;display:inline-block;"></div>`
                : ''
            ).join('');
            const tags = r.bands.filter(b => b.pct > 0).map((b, i) => {
                const ci = r.bands.findIndex(x => x.label === b.label);
                return `<span style="font-size:0.68rem;border-left:2px solid ${BAND_COLORS[ci]};padding-left:5px;margin-right:10px;white-space:nowrap;">
                    ${b.label} <strong>${b.pct}%</strong> <span style="color:#94a3b8;">${b.duration_min}분</span>
                </span>`;
            }).join('');
            const totalMin = (r.total_samples * 30 / 60).toFixed(0);
            const proxyLabel = _filter === null ? `<p class="is-size-7 mb-1" style="font-weight:600;">${r.host} <span style="font-weight:400;color:#94a3b8;font-size:0.68rem;">(총 ${totalMin}분 / ${r.total_samples.toLocaleString()}샘플)</span></p>` : `<p class="is-size-7 mb-1 has-text-grey">총 ${totalMin}분 / ${r.total_samples.toLocaleString()}샘플</p>`;
            return `<div class="mb-4">
                ${proxyLabel}
                <div style="border-radius:3px;overflow:hidden;height:20px;background:#f1f5f9;">${bar || '<div style="height:100%;background:#f1f5f9;"></div>'}</div>
                <div class="mt-2">${tags}</div>
            </div>`;
        }).join('');

        el.innerHTML = `<div class="mb-3" style="font-size:0.68rem;">${legend}</div>${blocks}`;
    }

    // ── 3. 요일×시간대 히트맵 ────────────────────────────────────
    function heatColor(val, maxVal) {
        if (val === null || maxVal === 0) return { bg: '#f8fafc', color: '#94a3b8' };
        const t = Math.min(val / maxVal, 1);
        const r = 255, g = Math.round(255 - t * 195), b = Math.round(255 - t * 225);
        return { bg: `rgb(${r},${g},${b})`, color: t > 0.5 ? '#7f1d1d' : '#374151' };
    }

    function renderHeatmapWeekly() {
        const el = document.getElementById('analysisHeatmapContent');
        if (!el) return;
        const { heatmap, metric } = _cache;
        const rows = filterRows(heatmap, _filter);
        const unit = METRIC_UNITS[metric] || '';

        const fmtCell = v => {
            if (v === null) return '';
            if (unit === '%')    return v.toFixed(1);
            if (unit === 'Mbps') return v.toFixed(1);
            return v >= 1000 ? (v / 1000).toFixed(0) + 'k' : v.toFixed(0);
        };

        const blocks = rows.map(r => {
            const allVals = Object.values(r.data).flatMap(h => Object.values(h));
            if (!allVals.length) {
                return `<div class="mb-2"><p class="is-size-7 has-text-grey">${_filter === null ? r.host + ' — ' : ''}데이터 없음</p></div>`;
            }
            const maxVal = Math.max(...allVals) || 1;
            const hours  = Array.from({ length: 24 }, (_, i) => i);
            const hdr    = hours.map(h => `<th style="font-size:0.58rem;padding:2px 2px;text-align:center;min-width:30px;">${h}</th>`).join('');
            const body   = WEEKDAY_NAMES.map((day, wd) => {
                const cells = hours.map(h => {
                    const v = r.data[wd]?.[h] ?? null;
                    const { bg, color } = heatColor(v, maxVal);
                    return `<td title="${day} ${h}시: ${v !== null ? v.toFixed(2) + unit : 'N/A'}"
                        style="background:${bg};color:${color};text-align:center;font-size:0.58rem;padding:3px 0;">${fmtCell(v)}</td>`;
                }).join('');
                return `<tr><th style="font-size:0.65rem;padding:3px 5px;white-space:nowrap;">${day}</th>${cells}</tr>`;
            }).join('');
            const proxyLabel = _filter === null
                ? `<p class="is-size-7 mb-1" style="font-weight:600;">${r.host} <span style="font-weight:400;color:#94a3b8;font-size:0.68rem;">— 최대 ${maxVal.toFixed(1)}${unit}</span></p>`
                : `<p class="is-size-7 mb-1 has-text-grey">최대 ${maxVal.toFixed(1)}${unit}</p>`;
            return `<div class="mb-4">${proxyLabel}<div style="overflow-x:auto;"><table style="border-collapse:collapse;table-layout:fixed;"><thead><tr><th style="min-width:24px;"></th>${hdr}</tr></thead><tbody>${body}</tbody></table></div></div>`;
        }).join('');

        el.innerHTML = blocks || '<p class="has-text-grey is-size-7">데이터 없음</p>';
    }

    // ── 4. Top-N 장비 ─────────────────────────────────────────────
    function renderTopN() {
        const el = document.getElementById('analysisTopNContent');
        if (!el) return;
        const { topN, metric } = _cache;

        if (!topN.length) { el.innerHTML = '<p class="has-text-grey is-size-7">데이터 없음</p>'; return; }

        const maxVal = topN[0]?.value || 1;
        const rankColors = ['#dc2626', '#f97316', '#facc15'];
        const barColors  = ['#ef4444', '#f97316', '#fbbf24', '#60a5fa'];

        el.innerHTML = topN.map((r, i) => {
            const barW = Math.round((r.value / maxVal) * 100);
            const isSelected = _filter !== null && r.proxy_id === _filter;
            const rankColor = rankColors[i] || '#94a3b8';
            const barColor  = barColors[Math.min(i, barColors.length - 1)];
            return `<div class="mb-2 is-flex is-align-items-center" style="gap:0.6rem;">
                <span style="width:16px;text-align:right;font-weight:700;font-size:0.72rem;color:${rankColor};">${i + 1}</span>
                <span class="is-size-7" style="min-width:90px;${isSelected ? 'color:#1e40af;font-weight:700;' : ''}">${r.host}</span>
                <div style="flex:1;background:#f1f5f9;border-radius:3px;height:14px;overflow:hidden;">
                    <div style="width:${barW}%;background:${barColor};height:100%;border-radius:3px;${isSelected ? 'outline:2px solid #3b82f6;' : ''}"></div>
                </div>
                <span class="is-size-7" style="min-width:58px;text-align:right;${isSelected ? 'font-weight:700;' : ''}">${fmtVal(r.value, metric)}</span>
            </div>`;
        }).join('');
    }

    // ── 5. 이동 평균 트렌드 ───────────────────────────────────────
    function renderSmoothed() {
        const el = document.getElementById('analysisSmoothedChart');
        if (!el) return;

        if (_smoothedChart) { try { _smoothedChart.destroy(); } catch (_) {} _smoothedChart = null; }

        const { smoothed, metric } = _cache;
        const unit = METRIC_UNITS[metric] || '';
        const rows = filterRows(smoothed, _filter).filter(r => r.points?.length);

        if (!rows.length) {
            el.innerHTML = '<p class="has-text-grey is-size-7 has-text-centered" style="padding:2rem 0;">데이터 없음</p>';
            return;
        }
        el.innerHTML = '';

        _smoothedChart = new ApexCharts(el, {
            chart: { type: 'line', height: 260, toolbar: { show: true }, animations: { enabled: false }, zoom: { type: 'x', enabled: true, autoScaleYaxis: true } },
            stroke: { width: 2, curve: 'smooth' },
            series: rows.map(r => ({
                name: r.host,
                data: r.points.map(p => ({ x: new Date(p.ts).getTime(), y: p.value })),
            })),
            xaxis: { type: 'datetime', labels: { datetimeUTC: false } },
            yaxis: {
                title: { text: unit || metric },
                labels: { formatter: v => v == null ? '' : v.toFixed(1) },
            },
            tooltip: {
                x: { format: 'MM/dd HH:mm' },
                y: { formatter: v => v != null ? `${v.toFixed(2)}${unit}` : '-' },
            },
            legend: { position: 'top', horizontalAlign: 'left', fontSize: '11px' },
            colors: CHART_COLORS,
        });
        _smoothedChart.render();
    }

    // ── 6. 임계치 초과 에피소드 ───────────────────────────────────
    function renderThresholdDuration() {
        const el = document.getElementById('analysisThresholdContent');
        if (!el) return;
        const { thrDur, metric } = _cache;
        const rows = filterRows(thrDur, _filter);

        el.innerHTML = rows.map(r => {
            const badge = `<div class="mb-2">
                <span class="tag is-light is-size-7" style="border-left:3px solid ${r.episode_count ? '#f97316' : '#94a3b8'};">
                    ${_filter === null ? r.host + ' — ' : ''}${r.episode_count}건 / 누적 ${r.total_duration_min}분
                </span>
            </div>`;
            if (!r.episode_count) return badge + `<p class="is-size-7 has-text-grey ml-2 mb-4">초과 이력 없음</p>`;

            const buildRows = eps => eps.map(ep => {
                const durStyle = ep.duration_min >= 15 ? 'color:#dc2626;font-weight:700;' : ep.duration_min >= 5 ? 'color:#f97316;font-weight:600;' : '';
                return `<tr>
                    <td class="is-size-7">${fmtDt(ep.start)}</td>
                    <td class="is-size-7">${fmtDt(ep.end)}</td>
                    <td class="is-size-7 has-text-right" style="${durStyle}">${ep.duration_min}분</td>
                    <td class="is-size-7 has-text-right">${fmtVal(ep.max_value, metric)}</td>
                    <td class="is-size-7 has-text-right">${fmtVal(ep.mean_value, metric)}</td>
                </tr>`;
            }).join('');

            const visible = r.episodes.slice(0, MAX_EPISODES);
            const hidden  = r.episodes.slice(MAX_EPISODES);
            const hidId   = `ep-hidden-${r.proxy_id}`;
            const moreBtn = hidden.length
                ? `<button class="button is-ghost is-small mt-1" onclick="
                    var h=document.getElementById('${hidId}');
                    h.style.display=h.style.display==='none'?'':'none';
                    this.textContent=h.style.display===''?'접기':'+ ${hidden.length}건 더 보기';
                  ">+ ${hidden.length}건 더 보기</button>`
                : '';

            return `${badge}
            <div class="table-container mb-4" style="overflow-x:auto;">
                <table class="table is-fullwidth is-hoverable is-size-7">
                    <thead><tr><th>시작</th><th>종료</th><th class="has-text-right">지속시간</th><th class="has-text-right">최대값</th><th class="has-text-right">평균값</th></tr></thead>
                    <tbody>${buildRows(visible)}<tbody id="${hidId}" style="display:none;">${buildRows(hidden)}</tbody></tbody>
                </table>
                ${moreBtn}
            </div>`;
        }).join('') || '<p class="has-text-grey is-size-7">데이터 없음</p>';
    }

    // ── 날짜 프리셋 ───────────────────────────────────────────────
    function applyPreset(range) {
        const now = new Date(), start = new Date(now);
        ({ '1w': () => start.setDate(now.getDate() - 7),
           '2w': () => start.setDate(now.getDate() - 14),
           '1m': () => start.setMonth(now.getMonth() - 1),
           '3m': () => start.setMonth(now.getMonth() - 3),
        }[range] || (() => {}))();
        const pad = n => String(n).padStart(2, '0');
        const fmt = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
        $('#analysisStartTime').val(fmt(start));
        $('#analysisEndTime').val(fmt(now));
        $('.analysis-preset').removeClass('is-active-preset');
        $(`.analysis-preset[data-range="${range}"]`).addClass('is-active-preset');
    }

    // ── 초기화 ────────────────────────────────────────────────────
    function init() {
        window.DeviceSelector.init({
            groupSelect: '#analysisGroupSelect',
            proxySelect: '#analysisPageProxySelect',
            proxyTrigger: '#analysisProxyTrigger',
            deselectBtn: '#analysisDeselectAllBtn',
            selectionCounter: '#analysisSelectionCounter',
            storageKey: 'ru_analysis_state',
        });

        $('#runAnalysisBtn').off('click.analysis').on('click.analysis', runAnalysis);

        $(document).off('click.ap', '.analysis-preset').on('click.ap', '.analysis-preset', function () {
            applyPreset($(this).data('range'));
        });
        $(document).off('click.af', '.analysis-filter-btn').on('click.af', '.analysis-filter-btn', function () {
            const id = $(this).data('id');
            renderAll(id !== '' ? Number(id) : null);
        });

        if (!$('#analysisStartTime').val()) applyPreset('1m');
    }

    $(document).ready(init);
    $(document).off('pjax:complete.analysis').on('pjax:complete.analysis', function (e, url) {
        if (url && url.includes('/history/analysis')) init();
    });

})(jQuery, window);
