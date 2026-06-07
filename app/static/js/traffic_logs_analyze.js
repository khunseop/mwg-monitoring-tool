/**
 * Traffic Log 분석 모듈 - 서버 DB 기반 전체 통계 분석
 */
(function(window, $) {
    'use strict';

    const TrafficLogAnalysis = {
        charts: {},
        lastData: null,

        /**
         * 서버 DB 데이터 기반 분석 (전체 데이터, Top N 제한 없음)
         */
        analyzeFromServer(proxyIds) {
            if (!proxyIds || proxyIds.length === 0) {
                this.showEmpty('분석할 프록시를 선택하세요.');
                return;
            }
            const pIdsParam = Array.isArray(proxyIds) ? proxyIds.join(',') : proxyIds;

            $('#tlaRunAnalysisBtn').addClass('is-loading');
            $('#tlaAnalyzeStatus').text('분석 중...').show();
            $('#tlaEmptyState').hide();
            $('#tlaDashboard').hide();

            $.get(`/api/traffic-logs/analyze?proxy_ids=${pIdsParam}`)
                .done((data) => {
                    this.lastData = data;
                    this.renderFromServerData(data);
                    $('#tlaAnalyzeStatus').text(`분석 완료 (${(data.summary.total || 0).toLocaleString()}건)`);
                    setTimeout(() => $('#tlaAnalyzeStatus').hide(), 4000);
                })
                .fail((xhr) => {
                    const msg = (xhr.responseJSON && xhr.responseJSON.detail) || '분석 실패';
                    this.showEmpty(msg);
                    $('#tlaAnalyzeStatus').text('분석 실패').show();
                })
                .always(() => {
                    $('#tlaRunAnalysisBtn').removeClass('is-loading');
                });
        },

        showEmpty(msg) {
            $('#tlaDashboard').hide();
            $('#tlaEmptyStateMsg').text(msg || '분석할 로그 데이터가 없습니다.');
            $('#tlaEmptyState').show();
        },

        renderAnomalies(anomalies) {
            const $section = $('#tla-anomaly-section');
            const $list = $('#tla-anomaly-list');
            $list.empty();

            if (!anomalies || anomalies.length === 0) {
                $section.hide();
                return;
            }

            const hasCritical = anomalies.some(a => a.severity === 'critical');
            const borderColor = hasCritical ? '#dc2626' : '#d97706';
            const dotColor = hasCritical ? '#dc2626' : '#d97706';
            $section.css('border-left', `4px solid ${borderColor}`);
            $('#tla-anomaly-severity-dot').css('background', dotColor);
            $('#tla-anomaly-count').text(`${anomalies.length}건`).removeClass('is-danger is-warning').addClass(hasCritical ? 'is-danger' : 'is-warning');

            anomalies.forEach((a, i) => {
                const isCrit = a.severity === 'critical';
                const tagClass = isCrit ? 'is-danger' : 'is-warning';
                const isLast = i === anomalies.length - 1;
                $list.append(`
                    <div class="is-flex is-align-items-center py-2" style="${isLast ? '' : 'border-bottom: 1px solid var(--color-border);'} gap: 0.65rem;">
                        <span class="tag ${tagClass} is-small" style="min-width: 60px; justify-content: center; flex-shrink: 0;">${this.esc(a.label)}</span>
                        <code class="is-size-7" style="min-width: 105px; flex-shrink: 0;">${this.esc(a.subject)}</code>
                        <span class="is-size-7 has-text-grey">${this.esc(a.detail)}</span>
                    </div>`);
            });

            $section.show();
        },

        renderFromServerData(data) {
            if (!data || !data.summary) {
                this.showEmpty('분석 데이터가 없습니다.');
                return;
            }
            const s = data.summary;
            const fmt = (v) => (window.AppUtils && AppUtils.formatBytes) ? AppUtils.formatBytes(v) : String(v);

            // 요약 카드
            $('#stat-total-req').text((s.total || 0).toLocaleString());
            $('#stat-blocked-req').text((s.blocked || 0).toLocaleString());
            $('#stat-unique-clients').text((s.unique_clients || 0).toLocaleString());
            $('#stat-unique-hosts').text((s.unique_hosts || 0).toLocaleString());
            $('#stat-total-recv').text(fmt(s.total_recv_bytes || 0));
            $('#stat-total-sent').text(fmt(s.total_sent_bytes || 0));

            // 차트
            const proxyDist = {};
            (data.proxies || []).forEach(x => { proxyDist[x.proxy] = x.count; });
            this.renderPieChart('chart-proxy-req', proxyDist, '프록시');

            const statusDist = {};
            (data.statuses || []).forEach(x => { statusDist[x.status] = x.count; });
            this.renderPieChart('chart-status-code', statusDist, '상태 코드', true);

            const hostMap = {};
            (data.hosts || []).slice(0, 20).forEach(x => { hostMap[x.host] = x.requests; });
            this.renderBarChart('chart-top-hosts', hostMap, '호스트 (Top 20)');

            const clientMap = {};
            (data.clients || []).slice(0, 20).forEach(x => { clientMap[x.client_ip] = x.requests; });
            this.renderBarChart('chart-top-clients', clientMap, '클라이언트 (Top 20)');

            // 전체 통계 테이블
            this.renderFullTable(
                'tla-hosts-tbody',
                data.hosts || [],
                (row) => `<td>${this.esc(row.host)}</td><td class="has-text-right">${(row.requests || 0).toLocaleString()}</td><td class="has-text-right">${fmt(row.recv_bytes)}</td><td class="has-text-right">${fmt(row.sent_bytes)}</td>`
            );
            this.renderFullTable(
                'tla-clients-tbody',
                data.clients || [],
                (row) => `<td>${this.esc(row.client_ip)}</td><td class="has-text-right">${(row.requests || 0).toLocaleString()}</td><td class="has-text-right">${fmt(row.recv_bytes)}</td><td class="has-text-right">${fmt(row.sent_bytes)}</td>`
            );

            // 이상 징후
            this.renderAnomalies(data.anomalies || []);

            // 행 수 표시
            $('#tla-hosts-count').text(`${(data.hosts || []).length.toLocaleString()}개`);
            $('#tla-clients-count').text(`${(data.clients || []).length.toLocaleString()}개`);

            $('#tlaEmptyState').hide();
            $('#tlaDashboard').show();
        },

        renderFullTable(tbodyId, rows, rowRenderer) {
            const $tbody = $(`#${tbodyId}`);
            $tbody.empty();
            if (!rows || rows.length === 0) {
                $tbody.append('<tr><td colspan="4" class="has-text-centered has-text-grey is-size-7">데이터 없음</td></tr>');
                return;
            }
            rows.forEach(row => {
                $tbody.append(`<tr>${rowRenderer(row)}</tr>`);
            });
        },

        esc(str) {
            return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        },

        exportHostsCsv() {
            if (!this.lastData || !this.lastData.hosts) { alert('먼저 분석을 실행하세요.'); return; }
            const fmt = (v) => String(v || 0);
            const headers = ['호스트', '요청 수', '수신(Bytes)', '송신(Bytes)'];
            const rows = this.lastData.hosts.map(r => [r.host, r.requests, r.recv_bytes, r.sent_bytes]);
            this.downloadCsv(headers, rows, 'tla_hosts_stats.csv');
        },

        exportClientsCsv() {
            if (!this.lastData || !this.lastData.clients) { alert('먼저 분석을 실행하세요.'); return; }
            const headers = ['클라이언트 IP', '요청 수', '수신(Bytes)', '송신(Bytes)'];
            const rows = this.lastData.clients.map(r => [r.client_ip, r.requests, r.recv_bytes, r.sent_bytes]);
            this.downloadCsv(headers, rows, 'tla_clients_stats.csv');
        },

        exportStatusesCsv() {
            if (!this.lastData || !this.lastData.statuses) { alert('먼저 분석을 실행하세요.'); return; }
            const headers = ['상태 코드', '요청 수'];
            const rows = this.lastData.statuses.map(r => [r.status, r.count]);
            this.downloadCsv(headers, rows, 'tla_status_stats.csv');
        },

        downloadCsv(headers, rows, filename) {
            const bom = '﻿';
            const lines = [headers.map(h => `"${h}"`).join(',')];
            rows.forEach(row => {
                lines.push(row.map(v => `"${String(v || '').replace(/"/g, '""')}"`).join(','));
            });
            const blob = new Blob([bom + lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url; a.download = filename; a.click();
            URL.revokeObjectURL(url);
        },

        renderPieChart(elId, dataMap, label, isDonut = false) {
            const labels = Object.keys(dataMap);
            const series = Object.values(dataMap);
            if (!labels.length) return;

            const options = {
                chart: { type: isDonut ? 'donut' : 'pie', height: 300 },
                labels, series,
                legend: { position: 'bottom' },
                dataLabels: { enabled: true, formatter: (val) => val.toFixed(1) + "%" }
            };

            if (this.charts[elId]) {
                this.charts[elId].updateOptions(options);
            } else {
                const el = document.getElementById(elId);
                if (!el) return;
                this.charts[elId] = new ApexCharts(el, options);
                this.charts[elId].render();
            }
        },

        renderBarChart(elId, dataMap, title) {
            const sorted = Object.entries(dataMap).sort((a, b) => b[1] - a[1]);
            const categories = sorted.map(x => x[0]);
            const data = sorted.map(x => x[1]);
            if (!categories.length) return;

            const options = {
                chart: { type: 'bar', height: 350, toolbar: { show: false } },
                plotOptions: { bar: { horizontal: true } },
                series: [{ name: '요청 수', data }],
                xaxis: { categories },
                title: { text: title, align: 'center', style: { fontSize: '14px' } }
            };

            if (this.charts[elId]) {
                this.charts[elId].updateOptions(options);
            } else {
                const el = document.getElementById(elId);
                if (!el) return;
                this.charts[elId] = new ApexCharts(el, options);
                this.charts[elId].render();
            }
        },

        /**
         * 파일 업로드 분석 (기존 기능 유지)
         */
        initUploadAnalysis() {
            $('#tlaFileInput').off('change').on('change', function() {
                const file = this.files[0];
                $('#tlaFileName').text(file ? file.name : '선택된 파일 없음');
            });

            $('#tlaRunBtn').off('click').on('click', () => {
                const fileInput = document.getElementById('tlaFileInput');
                if (!fileInput.files.length) {
                    alert('분석할 로그 파일을 선택하세요.');
                    return;
                }

                const formData = new FormData();
                formData.append('logfile', fileInput.files[0]);
                $('#tlaRunBtn').addClass('is-loading');

                $.ajax({
                    url: '/api/traffic-logs/analyze-upload',
                    method: 'POST',
                    data: formData,
                    processData: false,
                    contentType: false,
                    success: (res) => {
                        if (res.records) {
                            window.LOG_RECORDS = res.records;
                            switchTlTab('analyze');
                        }
                    },
                    error: (xhr) => {
                        alert('파일 분석 실패: ' + (xhr.responseJSON?.detail || '알 수 없는 오류'));
                    },
                    complete: () => { $('#tlaRunBtn').removeClass('is-loading'); }
                });
            });
        }
    };

    window.TrafficLogAnalysis = TrafficLogAnalysis;

    $(document).ready(() => {
        TrafficLogAnalysis.initUploadAnalysis();

        $('#tlaRunAnalysisBtn').off('click').on('click', () => {
            const $ps = $('#tlProxySelect');
            let proxyIds = [];
            if ($ps[0] && $ps[0].tomselect) {
                proxyIds = $ps[0].tomselect.getValue();
            } else {
                proxyIds = $ps.val() || [];
            }
            TrafficLogAnalysis.analyzeFromServer(proxyIds);
        });

        $('#tlaExportHostsBtn').off('click').on('click', () => TrafficLogAnalysis.exportHostsCsv());
        $('#tlaExportClientsBtn').off('click').on('click', () => TrafficLogAnalysis.exportClientsCsv());
    });

})(window, jQuery);
