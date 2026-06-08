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
    const WEEKDAY_NAMES = ['월', '화', '수', '목', '금', '토', '일'];

    let smoothedChart = null;

    // ── 유틸 ──────────────────────────────────────────────────────
    function getSelectedProxyIds() {
        const sel = document.getElementById('ruHistoryProxySelect');
        if (!sel) return [];
        if (sel._tom) return sel._tom.getValue().map(Number).filter(Boolean);
        return Array.from(sel.selectedOptions).map(o => Number(o.value)).filter(Boolean);
    }

    function formatKSTToUTC(localStr) {
        if (!localStr) return null;
        return new Date(new Date(localStr).getTime() - 9 * 3600 * 1000).toISOString();
    }

    function fmtVal(val, metric) {
        if (val === null || val === undefined) return '-';
        const u = METRIC_UNITS[metric] || '';
        if (u === '%') return val.toFixed(1) + '%';
        if (u === 'Mbps') return val.toFixed(2) + ' Mbps';
        return val.toLocaleString();
    }

    function fmtDt(isoStr) {
        if (!isoStr) return '-';
        try {
            return new Date(isoStr).toLocaleString('ko-KR', {
                year: 'numeric', month: '2-digit', day: '2-digit',
                hour: '2-digit', minute: '2-digit', second: '2-digit',
            });
        } catch { return isoStr; }
    }

    // ── 공통 쿼리 파라미터 빌드 ──────────────────────────────────
    function buildQP() {
        const pids = getSelectedProxyIds();
        const start = $('#analysisStartTime').val();
        const end = $('#analysisEndTime').val();
        const bh = $('#analysisBusinessHours').is(':checked');
        const metric = $('#analysisPrimaryMetric').val() || 'cpu';
        const threshold = parseFloat($('#analysisThreshold').val()) || 80;
        const windowMin = parseInt($('#analysisWindowMin').val()) || 5;

        const base = new URLSearchParams({ proxy_ids: pids.join(',') });
        if (start) base.set('start_time', formatKSTToUTC(start));
        if (end) base.set('end_time', formatKSTToUTC(end));
        if (bh) base.set('business_hours', 'true');

        const withMetric = new URLSearchParams(base);
        withMetric.set('metric', metric);

        return { pids, metric, threshold, windowMin, base, withMetric };
    }

    // ── 분석 실행 ─────────────────────────────────────────────────
    async function runAnalysis() {
        const pids = getSelectedProxyIds();
        if (!pids.length) {
            alert('분석할 프록시를 선택하세요.\n(이력 조회 탭에서 프록시를 먼저 선택해주세요)');
            return;
        }

        const { metric, threshold, windowMin, base, withMetric } = buildQP();
        const metricLabel = METRIC_LABELS[metric] || metric;
        const unit = METRIC_UNITS[metric] || '';

        $('#analysisLoading').show();
        $('#analysisResults').hide();
        $('#analysisError').hide();

        try {
            const [percentiles, timeBand, thrDur, heatmap, topN, smoothed] = await Promise.all([
                $.getJSON(`/api/resource-usage/analysis/percentiles?${base}&metrics=cpu,mem,disk,cc,cs,http,https,http2,blocked`),
                $.getJSON(`/api/resource-usage/analysis/time-in-band?${withMetric}`),
                $.getJSON(`/api/resource-usage/analysis/threshold-duration?${withMetric}&threshold=${threshold}`),
                $.getJSON(`/api/resource-usage/analysis/heatmap-weekly?${withMetric}`),
                $.getJSON(`/api/resource-usage/analysis/top-n?${withMetric}&stat=p95&n=10`),
                $.getJSON(`/api/resource-usage/analysis/smoothed?${withMetric}&window_min=${windowMin}`),
            ]);

            const thresholdDisplay = unit ? `${threshold}${unit}` : threshold.toLocaleString();

            $('#analysisTimeBandMetric').text(metricLabel);
            $('#analysisThresholdMetricLabel').text(metricLabel);
            $('#analysisThresholdValueLabel').text(thresholdDisplay);
            $('#analysisHeatmapMetricLabel').text(metricLabel);
            $('#analysisTopNMetricLabel').text(metricLabel);
            $('#analysisSmoothedMetricLabel').text(metricLabel);
            $('#analysisSmoothedWindowLabel').text(windowMin);

            renderPercentiles(percentiles, metric);
            renderTimeBand(timeBand, metric);
            renderThresholdDuration(thrDur, metric);
            renderHeatmapWeekly(heatmap, metric);
            renderTopN(topN, metric);
            renderSmoothed(smoothed, metric);

            $('#analysisResults').show();
        } catch (err) {
            const msg = err.responseJSON?.detail || err.statusText || String(err);
            $('#analysisError').text('분석 중 오류가 발생했습니다: ' + msg).show();
        } finally {
            $('#analysisLoading').hide();
        }
    }

    // ── 1. 백분위수 테이블 ────────────────────────────────────────
    function renderPercentiles(rows, primaryMetric) {
        const tbody = document.getElementById('analysisPercentilesBody');
        if (!tbody) return;

        const metricOrder = ['cpu', 'mem', 'disk', 'cc', 'cs', 'http', 'https', 'http2', 'blocked'];
        // Sort: primary metric first, then alphabetical
        rows.sort((a, b) => {
            const ai = a.metric === primaryMetric ? -1 : metricOrder.indexOf(a.metric);
            const bi = b.metric === primaryMetric ? -1 : metricOrder.indexOf(b.metric);
            if (ai !== bi) return ai - bi;
            return a.host.localeCompare(b.host);
        });

        const html = rows.map(r => {
            if (r.count === 0) {
                return `<tr><td>${r.host}</td><td>${METRIC_LABELS[r.metric] || r.metric}</td>
                    <td colspan="6" class="has-text-grey has-text-centered is-size-7">데이터 없음</td></tr>`;
            }
            const u = METRIC_UNITS[r.metric] || '';
            const fmt = v => v === null ? '-' : (u === '%' ? v.toFixed(1) + '%' : u === 'Mbps' ? v.toFixed(2) : v.toLocaleString());
            const bold = r.metric === primaryMetric ? 'style="font-weight:600;"' : '';
            const p95Style = r.p95 !== null && r.p95 > 80 && u === '%' ? 'style="color:#b45309;font-weight:600;"' : '';
            const p99Style = r.p99 !== null && r.p99 > 90 && u === '%' ? 'style="color:#dc2626;font-weight:600;"' : '';
            return `<tr ${bold}>
                <td>${r.host}</td>
                <td>${METRIC_LABELS[r.metric] || r.metric}${u ? ' (' + u + ')' : ''}</td>
                <td class="has-text-right">${r.count.toLocaleString()}</td>
                <td class="has-text-right">${fmt(r.mean)}</td>
                <td class="has-text-right">${fmt(r.max)}</td>
                <td class="has-text-right">${fmt(r.p50)}</td>
                <td class="has-text-right" ${p95Style}>${fmt(r.p95)}</td>
                <td class="has-text-right" ${p99Style}>${fmt(r.p99)}</td>
            </tr>`;
        }).join('');

        tbody.innerHTML = html || '<tr><td colspan="8" class="has-text-centered has-text-grey">데이터 없음</td></tr>';
    }

    // ── 2. Time-in-Band 바 ────────────────────────────────────────
    function renderTimeBand(rows, metric) {
        const el = document.getElementById('analysisTimeBandContent');
        if (!el) return;

        if (!rows.length) { el.innerHTML = '<p class="has-text-grey is-size-7">데이터 없음</p>'; return; }

        const bandLabels = rows[0]?.bands?.map(b => b.label) || [];

        const legend = bandLabels.map((label, i) =>
            `<span style="display:inline-flex;align-items:center;gap:4px;margin-right:12px;font-size:0.72rem;">
                <span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${BAND_COLORS[i]};"></span>${label}
            </span>`
        ).join('');

        const proxyBlocks = rows.map(r => {
            if (!r.total_samples) {
                return `<div class="mb-3"><span class="is-size-7 has-text-grey">${r.host}: 데이터 없음</span></div>`;
            }
            const bar = r.bands.map((b, i) =>
                b.pct > 0
                    ? `<div title="${b.label}: ${b.pct}% (${b.duration_min}분)"
                            style="width:${b.pct}%;background:${BAND_COLORS[i]};height:28px;display:inline-block;"></div>`
                    : ''
            ).join('');

            const labels = r.bands.map((b, i) =>
                `<span class="tag is-light is-size-7 mr-1" style="border-left:3px solid ${BAND_COLORS[i]};">
                    ${b.label} <strong class="ml-1">${b.pct}%</strong>
                    <span class="has-text-grey ml-1">${b.duration_min}분</span>
                </span>`
            ).join('');

            return `<div class="mb-4">
                <p class="is-size-7 mb-1" style="font-weight:600;">${r.host}
                    <span class="has-text-grey" style="font-weight:400;">— 총 ${r.total_samples.toLocaleString()}샘플 (${(r.total_samples * 30 / 60).toFixed(0)}분)</span>
                </p>
                <div style="border-radius:4px;overflow:hidden;height:28px;background:#f1f5f9;">${bar}</div>
                <div class="mt-2">${labels}</div>
            </div>`;
        }).join('');

        el.innerHTML = `<div class="mb-3">${legend}</div>${proxyBlocks}`;
    }

    // ── 3. 임계치 초과 에피소드 ───────────────────────────────────
    function renderThresholdDuration(rows, metric) {
        const el = document.getElementById('analysisThresholdContent');
        if (!el) return;

        const unit = METRIC_UNITS[metric] || '';
        const fmtV = v => unit === '%' ? v.toFixed(1) + '%' : unit === 'Mbps' ? v.toFixed(2) + ' Mbps' : v.toLocaleString();

        const blocks = rows.map(r => {
            const summary = `<div class="mb-2">
                <span class="tag is-warning is-light is-size-7 mr-2">
                    ${r.host} — 총 ${r.episode_count}건 / 누적 ${r.total_duration_min}분 초과
                </span>
            </div>`;

            if (!r.episode_count) {
                return summary + `<p class="is-size-7 has-text-grey ml-2 mb-4">임계치 초과 이력 없음</p>`;
            }

            const rows_html = r.episodes.slice(0, 50).map((ep, idx) => {
                const durClass = ep.duration_min >= 15 ? 'has-text-danger' : ep.duration_min >= 5 ? 'has-text-warning-dark' : '';
                return `<tr>
                    <td class="is-size-7">${idx + 1}</td>
                    <td class="is-size-7">${fmtDt(ep.start)}</td>
                    <td class="is-size-7">${fmtDt(ep.end)}</td>
                    <td class="is-size-7 has-text-right ${durClass}"><strong>${ep.duration_min}분</strong></td>
                    <td class="is-size-7 has-text-right">${fmtV(ep.max_value)}</td>
                    <td class="is-size-7 has-text-right">${fmtV(ep.mean_value)}</td>
                    <td class="is-size-7 has-text-centered">${ep.sample_count}</td>
                </tr>`;
            }).join('');

            const more = r.episodes.length > 50
                ? `<p class="is-size-7 has-text-grey mt-1">... 외 ${r.episodes.length - 50}건</p>` : '';

            return `${summary}
            <div class="table-container mb-5" style="overflow-x:auto;">
                <table class="table is-fullwidth is-hoverable is-size-7">
                    <thead><tr>
                        <th>#</th><th>시작</th><th>종료</th>
                        <th class="has-text-right">지속시간</th>
                        <th class="has-text-right">최대값</th>
                        <th class="has-text-right">평균값</th>
                        <th class="has-text-centered">샘플</th>
                    </tr></thead>
                    <tbody>${rows_html}</tbody>
                </table>
                ${more}
            </div>`;
        }).join('');

        el.innerHTML = blocks || '<p class="has-text-grey is-size-7">데이터 없음</p>';
    }

    // ── 4. 요일×시간대 히트맵 ────────────────────────────────────
    function heatColor(val, maxVal) {
        if (val === null || val === undefined || maxVal === 0) return { bg: '#f8fafc', color: '#94a3b8' };
        const ratio = Math.min(val / maxVal, 1);
        // white → orange-red gradient
        const r = Math.round(255);
        const g = Math.round(255 - ratio * 200);
        const b = Math.round(255 - ratio * 230);
        const textColor = ratio > 0.5 ? '#7f1d1d' : '#374151';
        return { bg: `rgb(${r},${g},${b})`, color: textColor };
    }

    function renderHeatmapWeekly(rows, metric) {
        const el = document.getElementById('analysisHeatmapContent');
        if (!el) return;

        const unit = METRIC_UNITS[metric] || '';
        const fmtCell = v => {
            if (v === null) return '';
            if (unit === '%') return v.toFixed(1);
            if (unit === 'Mbps') return v.toFixed(1);
            return v >= 1000 ? (v / 1000).toFixed(1) + 'k' : v.toFixed(0);
        };

        const blocks = rows.map(r => {
            // gather all values for max
            const allVals = [];
            for (let wd = 0; wd < 7; wd++) {
                for (let h = 0; h < 24; h++) {
                    const v = r.data[wd]?.[h];
                    if (v !== undefined) allVals.push(v);
                }
            }
            if (!allVals.length) {
                return `<div class="mb-4"><p class="is-size-7 mb-1" style="font-weight:600;">${r.host} <span class="has-text-grey" style="font-weight:400;">— 데이터 없음</span></p></div>`;
            }
            const maxVal = Math.max(...allVals) || 1;

            const hours = Array.from({ length: 24 }, (_, i) => i);
            const headerCells = hours.map(h =>
                `<th style="font-size:0.65rem;padding:2px 4px;text-align:center;min-width:36px;">${h}시</th>`
            ).join('');

            const bodyRows = WEEKDAY_NAMES.map((day, wd) => {
                const cells = hours.map(h => {
                    const v = r.data[wd]?.[h] ?? null;
                    const { bg, color } = heatColor(v, maxVal);
                    const display = fmtCell(v);
                    const tip = v !== null ? `${day} ${h}시: ${v.toFixed(2)}${unit}` : `${day} ${h}시: 데이터 없음`;
                    return `<td title="${tip}" style="background:${bg};color:${color};text-align:center;font-size:0.65rem;padding:3px 2px;">${display}</td>`;
                }).join('');
                return `<tr><th style="font-size:0.7rem;padding:3px 8px;white-space:nowrap;">${day}</th>${cells}</tr>`;
            }).join('');

            return `<div class="mb-5">
                <p class="is-size-7 mb-2" style="font-weight:600;">${r.host}
                    <span class="has-text-grey" style="font-weight:400; font-size:0.7rem;">— 최대 ${maxVal.toFixed(2)}${unit}</span>
                </p>
                <div style="overflow-x:auto;">
                    <table style="border-collapse:collapse;table-layout:fixed;">
                        <thead><tr><th style="min-width:30px;"></th>${headerCells}</tr></thead>
                        <tbody>${bodyRows}</tbody>
                    </table>
                </div>
            </div>`;
        }).join('');

        el.innerHTML = blocks || '<p class="has-text-grey is-size-7">데이터 없음</p>';
    }

    // ── 5. Top-N 장비 ─────────────────────────────────────────────
    function renderTopN(rows, metric) {
        const el = document.getElementById('analysisTopNContent');
        if (!el) return;

        if (!rows.length) { el.innerHTML = '<p class="has-text-grey is-size-7">데이터 없음</p>'; return; }

        const unit = METRIC_UNITS[metric] || '';
        const maxVal = rows[0]?.value || 1;
        const fmtV = v => unit === '%' ? v.toFixed(1) + '%' : unit === 'Mbps' ? v.toFixed(2) + ' Mbps' : v.toLocaleString();

        const items = rows.map((r, i) => {
            const barW = Math.round((r.value / maxVal) * 100);
            const rankColor = i === 0 ? '#dc2626' : i === 1 ? '#f97316' : i === 2 ? '#facc15' : '#94a3b8';
            const barColor = i === 0 ? '#ef4444' : i === 1 ? '#f97316' : i === 2 ? '#facc15' : '#60a5fa';
            return `<div class="mb-2 is-flex is-align-items-center" style="gap:0.75rem;">
                <span style="width:22px;text-align:right;font-weight:700;font-size:0.8rem;color:${rankColor};">${i + 1}</span>
                <span class="is-size-7" style="min-width:140px;font-weight:600;">${r.host}</span>
                <div style="flex:1;background:#f1f5f9;border-radius:4px;height:20px;overflow:hidden;">
                    <div style="width:${barW}%;background:${barColor};height:100%;border-radius:4px;"></div>
                </div>
                <span class="is-size-7" style="min-width:70px;text-align:right;font-weight:600;">${fmtV(r.value)}</span>
            </div>`;
        }).join('');

        el.innerHTML = `<div style="max-width:600px;">${items}</div>`;
    }

    // ── 6. 이동 평균 트렌드 차트 ─────────────────────────────────
    function renderSmoothed(rows, metric) {
        const el = document.getElementById('analysisSmoothedChart');
        if (!el) return;

        if (smoothedChart) {
            try { smoothedChart.destroy(); } catch (_) {}
            smoothedChart = null;
        }

        const unit = METRIC_UNITS[metric] || '';
        const validRows = rows.filter(r => r.points && r.points.length > 0);

        if (!validRows.length) {
            el.innerHTML = '<p class="has-text-grey is-size-7 has-text-centered p-5">데이터 없음</p>';
            return;
        }

        const series = validRows.map(r => ({
            name: r.host,
            data: r.points.map(p => ({ x: new Date(p.ts).getTime(), y: p.value })),
        }));

        smoothedChart = new ApexCharts(el, {
            chart: {
                type: 'line', height: 380,
                toolbar: { show: true },
                animations: { enabled: false },
                zoom: { type: 'x', enabled: true, autoScaleYaxis: true },
            },
            stroke: { width: 2, curve: 'smooth' },
            series,
            xaxis: {
                type: 'datetime',
                labels: { datetimeUTC: false, datetimeFormatter: { hour: 'MM/dd HH:mm' } },
            },
            yaxis: {
                title: { text: unit || metric },
                labels: { formatter: v => v == null ? '' : v.toFixed(1) },
            },
            tooltip: {
                x: { format: 'yyyy-MM-dd HH:mm' },
                y: { formatter: v => v != null ? `${v.toFixed(2)}${unit}` : '-' },
            },
            legend: { position: 'top', horizontalAlign: 'left', fontSize: '11px' },
            colors: ['#6366f1', '#f59e0b', '#10b981', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316'],
        });
        smoothedChart.render();
    }

    // ── 날짜 프리셋 ───────────────────────────────────────────────
    function applyPreset(range) {
        const now = new Date();
        const start = new Date(now);
        switch (range) {
            case '1w': start.setDate(now.getDate() - 7); break;
            case '2w': start.setDate(now.getDate() - 14); break;
            case '1m': start.setMonth(now.getMonth() - 1); break;
            case '3m': start.setMonth(now.getMonth() - 3); break;
        }
        const pad = n => String(n).padStart(2, '0');
        const fmt = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
        $('#analysisStartTime').val(fmt(start));
        $('#analysisEndTime').val(fmt(now));
        $('.analysis-preset').removeClass('is-active-preset');
        $(`.analysis-preset[data-range="${range}"]`).addClass('is-active-preset');
    }

    // ── 탭 진입 시 선택된 프록시 정보 표시 ───────────────────────
    function updateProxyInfo() {
        const pids = getSelectedProxyIds();
        if (!pids.length) {
            $('#analysisProxyInfo').text('선택 없음').removeClass('is-info').addClass('is-warning');
        } else {
            $('#analysisProxyInfo').text(`${pids.length}개 선택됨`).removeClass('is-warning').addClass('is-info');
        }
    }

    // ── 초기화 ────────────────────────────────────────────────────
    function init() {
        $('#runAnalysisBtn').off('click.analysis').on('click.analysis', runAnalysis);
        $(document).off('click.analysis-preset', '.analysis-preset').on('click.analysis-preset', '.analysis-preset', function () {
            applyPreset($(this).data('range'));
        });
        // 기본 1달 프리셋
        if (!$('#analysisStartTime').val()) applyPreset('1m');
    }

    const HistoryAnalysis = {
        onTabEnter() {
            updateProxyInfo();
        },
    };

    window.HistoryAnalysis = HistoryAnalysis;

    $(document).ready(init);
    $(document).off('pjax:complete.analysis').on('pjax:complete.analysis', function (e, url) {
        if (url && (url.includes('/history') || url.includes('/resource'))) init();
    });

})(jQuery, window);
