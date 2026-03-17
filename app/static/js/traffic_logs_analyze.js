/**
 * Traffic Log 분석 모듈
 * 조회된 로그 또는 업로드된 로그의 통계 분석 및 시각화
 */
(function(window, $) {
    'use strict';

    const TrafficLogAnalysis = {
        charts: {},

        /**
         * 로그 레코드 배열을 분석하여 통계 데이터 생성
         * @param {Array} records - 파싱된 로그 레코드 배열
         */
        analyze(records) {
            if (!records || records.length === 0) {
                $('#tlaDashboard').hide();
                $('#tlaEmptyState').show();
                return;
            }

            $('#tlaEmptyState').hide();
            $('#tlaDashboard').show();

            const stats = {
                total: records.length,
                blocked: 0,
                uniqueClients: new Set(),
                uniqueHosts: new Set(),
                proxyDistribution: {},
                statusDistribution: {},
                hostCounts: {},
                clientCounts: {}
            };

            records.forEach(rec => {
                // 차단 여부: action_names에 'Block'이 포함되어 있거나 block_id가 있는 경우
                const action = String(rec.action_names || '');
                const blockId = String(rec.block_id || '');
                const isBlocked = action.toLowerCase().includes('block') || (blockId !== '' && blockId !== '0');
                
                if (isBlocked) stats.blocked++;

                // 고유 클라이언트 및 호스트
                if (rec.client_ip) {
                    stats.uniqueClients.add(rec.client_ip);
                    stats.clientCounts[rec.client_ip] = (stats.clientCounts[rec.client_ip] || 0) + 1;
                }
                if (rec.url_host) {
                    stats.uniqueHosts.add(rec.url_host);
                    stats.hostCounts[rec.url_host] = (stats.hostCounts[rec.url_host] || 0) + 1;
                }

                // 프록시별 분포
                const proxyLabel = this.getProxyName(rec.proxy_id);
                stats.proxyDistribution[proxyLabel] = (stats.proxyDistribution[proxyLabel] || 0) + 1;

                // 상태 코드 분포
                const status = rec.response_statuscode || 'Unknown';
                stats.statusDistribution[status] = (stats.statusDistribution[status] || 0) + 1;
            });

            this.renderSummary(stats);
            this.renderCharts(stats);
        },

        /**
         * 프록시 ID로 표시용 이름 가져오기
         */
        getProxyName(proxyId) {
            if (!proxyId) return 'Unknown';
            if (window.PROXIES && Array.isArray(window.PROXIES)) {
                const p = window.PROXIES.find(x => String(x.id) === String(proxyId));
                if (p) return p.host;
            }
            return `#${proxyId}`;
        },

        /**
         * 요약 카드 렌더링
         */
        renderSummary(stats) {
            $('#stat-total-req').text(stats.total.toLocaleString());
            $('#stat-blocked-req').text(stats.blocked.toLocaleString());
            $('#stat-unique-clients').text(stats.uniqueClients.size.toLocaleString());
            $('#stat-unique-hosts').text(stats.uniqueHosts.size.toLocaleString());
        },

        /**
         * 차트 시각화
         */
        renderCharts(stats) {
            // 1. 프록시별 요청 분포 (Pie)
            this.renderPieChart('chart-proxy-req', stats.proxyDistribution, '프록시');

            // 2. 상태 코드 분포 (Donut)
            this.renderPieChart('chart-status-code', stats.statusDistribution, '상태 코드', true);

            // 3. Top 호스트 (Bar)
            this.renderBarChart('chart-top-hosts', stats.hostCounts, '호스트', 10);

            // 4. Top 클라이언트 (Bar)
            this.renderBarChart('chart-top-clients', stats.clientCounts, '클라이언트', 10);
        },

        renderPieChart(elId, dataMap, label, isDonut = false) {
            const labels = Object.keys(dataMap);
            const series = Object.values(dataMap);

            const options = {
                chart: { type: isDonut ? 'donut' : 'pie', height: 300 },
                labels: labels,
                series: series,
                legend: { position: 'bottom' },
                dataLabels: { enabled: true, formatter: (val) => val.toFixed(1) + "%" }
            };

            if (this.charts[elId]) {
                this.charts[elId].updateOptions(options);
            } else {
                this.charts[elId] = new ApexCharts(document.getElementById(elId), options);
                this.charts[elId].render();
            }
        },

        renderBarChart(elId, dataMap, title, limit = 10) {
            const sorted = Object.entries(dataMap)
                .sort((a, b) => b[1] - a[1])
                .slice(0, limit);

            const categories = sorted.map(x => x[0]);
            const data = sorted.map(x => x[1]);

            const options = {
                chart: { type: 'bar', height: 350, toolbar: { show: false } },
                plotOptions: { bar: { horizontal: true } },
                series: [{ name: '요청 수', data: data }],
                xaxis: { categories: categories },
                title: { text: `Top ${limit} ${title}`, align: 'center', style: { fontSize: '14px' } }
            };

            if (this.charts[elId]) {
                this.charts[elId].updateOptions(options);
            } else {
                this.charts[elId] = new ApexCharts(document.getElementById(elId), options);
                this.charts[elId].render();
            }
        },

        /**
         * 파일 업로드 분석 초기화
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
                        // 업로드된 데이터로 분석 실행
                        if (res.records) {
                            // 전역 레코드 업데이트 및 탭 전환
                            window.LOG_RECORDS = res.records;
                            switchTlTab('analyze');
                            this.analyze(res.records);
                        }
                    },
                    error: (xhr) => {
                        alert('파일 분석 실패: ' + (xhr.responseJSON?.detail || '알 수 없는 오류'));
                    },
                    complete: () => {
                        $('#tlaRunBtn').removeClass('is-loading');
                    }
                });
            });
        }
    };

    window.TrafficLogAnalysis = TrafficLogAnalysis;

    $(document).ready(() => {
        TrafficLogAnalysis.initUploadAnalysis();
    });

})(window, jQuery);
