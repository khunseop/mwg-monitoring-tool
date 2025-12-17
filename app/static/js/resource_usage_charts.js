/**
 * Resource Usage 타임시리즈 차트 모듈
 * 차트 생성, 렌더링, 버퍼 관리 로직
 */
(function(window) {
    'use strict';

    const ResourceUsageCharts = {
        /**
         * 데이터를 타임시리즈 버퍼에 추가
         * @param {Array} rows - 데이터 행 배열
         */
        bufferAppendBatch(rows) {
            const ru = window.ru;
            const utils = window.ResourceUsageUtils;
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
                            mbpsValue = utils.calculateTrafficMbps(v, prevCumulative, intervalSec);
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
        },

        /**
         * ApexCharts DOM 요소 초기화
         * @param {boolean} isModal - 모달 여부
         * @param {string} metricKey - 메트릭 키
         * @param {number} height - 차트 높이
         * @returns {boolean} 성공 여부
         */
        ensureApexChartsDom(isModal = false, metricKey = null, height = 300) {
            const ru = window.ru;
            const utils = window.ResourceUsageUtils;
            const selector = isModal ? `#ruModalChart` : '#ruChartsWrap';
            const $wrap = $(selector);
            if ($wrap.length === 0) return false;

            if (!isModal) {
                if ($wrap.data('initialized')) return true;
                const basicMetrics = ['cpu','mem','cc','cs','http','https','ftp'];
                const basicTitles = { cpu: 'CPU', mem: 'MEM', cc: 'CC', cs: 'CS', http: 'HTTP', https: 'HTTPS', ftp: 'FTP' };
                
                // Get configured interfaces from config
                const interfaceOids = (ru.cachedConfig && ru.cachedConfig.interface_oids) ? ru.cachedConfig.interface_oids : {};
                const configuredInterfaceNames = Object.keys(interfaceOids);
                
                const metrics = [...basicMetrics, ...configuredInterfaceNames.map(ifName => `if_${ifName}`)];
                const titles = { ...basicTitles };
                configuredInterfaceNames.forEach(ifName => {
                    titles[`if_${ifName}`] = utils.abbreviateInterfaceName(ifName);
                });
                
                // Add header with controls (only once)
                if (!$wrap.find('.ru-charts-header').length) {
                    const header = `
                        <div class="column is-12 ru-charts-header mb-3">
                            <div class="level mb-0">
                                <div class="level-left">
                                    <div class="level-item">
                                        <label class="label mb-0 mr-3">그래프 높이:</label>
                                        <input type="range" id="ruChartHeightSlider" min="150" max="500" value="${height}" step="50" style="width: 200px; margin: 0 10px;">
                                        <span id="ruChartHeightValue">${height}px</span>
                                    </div>
                                </div>
                                <div class="level-right">
                                    <div class="level-item">
                                        <button class="button is-small" id="ruToggleAllCharts">전체 펼치기</button>
                                    </div>
                                </div>
                            </div>
                        </div>`;
                    $wrap.prepend(header);
                } else {
                    // Update height value if header exists
                    $('#ruChartHeightSlider').val(height);
                    $('#ruChartHeightValue').text(height + 'px');
                }
                
                // Remove existing chart panels but keep header
                $wrap.find('.ru-chart-panel').parent().remove();
                metrics.forEach(m => {
                    const panel = `
                        <div class="column is-6">
                            <div class="ru-chart-panel" id="ruChartPanel-${m}" data-collapsed="true" style="border:1px solid var(--border-color,#e5e7eb); border-radius:6px; padding:8px; margin-bottom:1rem;">
                                <div class="level" style="margin-bottom:6px;">
                                    <div class="level-left">
                                        <h5 class="title is-6" style="margin:0; cursor:pointer;" data-metric="${m}">${titles[m]}</h5>
                                    </div>
                                    <div class="level-right">
                                        <a class="button is-small ru-chart-toggle-btn" data-metric="${m}" title="접기/펼치기">▼</a>
                                        <a class="button is-small ru-chart-zoom-btn" data-metric="${m}" title="확대">확대</a>
                                    </div>
                                </div>
                                <div class="ru-chart-content" id="ruChartContent-${m}" style="display:none;">
                                    <div id="ruApex-${m}" style="width:100%; height:${height}px;"></div>
                                </div>
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
        },

        /**
         * 프록시별 일관된 색상 할당
         * @param {number} proxyId - 프록시 ID
         * @returns {string} 색상 코드
         */
        colorForProxy(proxyId) {
            const ru = window.ru;
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
        },

        /**
         * 모든 차트 렌더링
         */
        renderAllCharts() {
            const ru = window.ru;
            const state = window.ResourceUsageState;
            if (!window.ApexCharts) return;
            const currentHeight = parseInt($('#ruChartHeightSlider').val(), 10) || 300;
            this.ensureApexChartsDom(false, null, currentHeight);
            
            // Get configured interfaces from config
            const interfaceOids = (ru.cachedConfig && ru.cachedConfig.interface_oids) ? ru.cachedConfig.interface_oids : {};
            const configuredInterfaceNames = Object.keys(interfaceOids);
            
            const basicMetrics = ['cpu','mem','cc','cs','http','https','ftp'];
            const interfaceMetrics = configuredInterfaceNames.map(ifName => `if_${ifName}`);
            const metrics = [...basicMetrics, ...interfaceMetrics];
            
            metrics.forEach(m => this.renderMetricChart(m, false));
        },

        /**
         * 특정 메트릭 차트 렌더링
         * @param {string} metricKey - 메트릭 키
         * @param {boolean} isModal - 모달 여부
         */
        renderMetricChart(metricKey, isModal = false) {
            const ru = window.ru;
            const utils = window.ResourceUsageUtils;
            const state = window.ResourceUsageState;
            const height = isModal ? $(window).height() * 0.7 : (parseInt($('#ruChartHeightSlider').val(), 10) || 300);
            const elId = isModal ? `ruApexModal-${metricKey}` : `ruApex-${metricKey}`;
            const el = document.getElementById(elId);
            if (!el) return;

            const selectedProxyIds = state.getSelectedProxyIds();
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
                if (values.some(v => typeof v === 'number')) {
                    const proxyMeta = (ru.proxies || []).find(p => String(p.id) === String(proxyId));
                    const proxyLabel = proxyMeta ? proxyMeta.host : `#${proxyId}`;
                    const paired = labelsMs.map((ms, i) => ({ x: ms, y: values[i] }));
                    series.push({ name: proxyLabel, data: paired });
                    seriesProxyMap.push(proxyId);
                }
            });

            // deterministic colors based on proxy order
            const colors = seriesProxyMap.map(pid => this.colorForProxy(pid));
            ru.seriesMap[metricKey] = seriesProxyMap;

            const options = {
                chart: {
                    type: 'line', height: height, animations: { enabled: false }, toolbar: { show: false },
                    events: {
                        legendClick: function(chartContext, seriesIndex, config) {
                            const proxyId = ru.seriesMap[metricKey] && ru.seriesMap[metricKey][seriesIndex];
                            if (proxyId != null) {
                                const prev = !!(ru.legendState[metricKey] && ru.legendState[metricKey][proxyId]);
                                ru.legendState[metricKey] = ru.legendState[metricKey] || {};
                                ru.legendState[metricKey][proxyId] = !prev;
                                state.saveLegendState();
                            }
                        },
                        mouseMove: function(event, chartContext, config) {
                            if (config.seriesIndex < 0) {
                                (chartContext.w.globals.series || []).forEach((s, i) => {
                                    chartContext.updateSeries([{ data: s }], false);
                                });
                                chartContext.w.globals.dom.el.style.cursor = 'default';
                                return;
                            }
                            const seriesIndex = config.seriesIndex;
                            (chartContext.w.globals.series || []).forEach((s, i) => {
                                const newOpacity = (i === seriesIndex) ? 1 : 0.3;
                                chartContext.w.globals.dom.el.querySelector(`.apexcharts-series[seriesName="${s.name.replace(/"/g, '\\"')}"]`).style.opacity = newOpacity;
                            });
                            chartContext.w.globals.dom.el.style.cursor = 'pointer';
                        },
                        mouseLeave: function(event, chartContext, config) {
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
                                return val.toFixed(1) + ' Mbps';
                            }
                            if (metricKey === 'cc' || metricKey === 'cs') { return utils.abbreviateNumber(val); }
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
                                return val.toFixed(2) + ' Mbps';
                            }
                            if (metricKey === 'cc' || metricKey === 'cs') { return utils.formatNumber(Math.round(val)); }
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
        },

        /**
         * 차트 접기/펼치기 토글
         * @param {string} metricKey - 메트릭 키
         */
        toggleChart(metricKey) {
            const $panel = $(`#ruChartPanel-${metricKey}`);
            const $content = $(`#ruChartContent-${metricKey}`);
            const $btn = $panel.find('.ru-chart-toggle-btn');
            const isCollapsed = $panel.data('collapsed') === true;
            
            if (isCollapsed) {
                $content.slideDown(200);
                $btn.text('▲');
                $panel.data('collapsed', false);
            } else {
                $content.slideUp(200);
                $btn.text('▼');
                $panel.data('collapsed', true);
            }
        },

        /**
         * 모든 차트 접기/펼치기 토글
         * @param {boolean} expand - 펼치기 여부 (undefined면 토글)
         */
        toggleAllCharts(expand) {
            const $panels = $('#ruChartsWrap .ru-chart-panel');
            const self = this;
            $panels.each(function() {
                const metric = $(this).attr('id').replace('ruChartPanel-', '');
                const isCollapsed = $(this).data('collapsed') === true;
                if (expand === undefined) {
                    self.toggleChart(metric);
                } else if (expand && isCollapsed) {
                    self.toggleChart(metric);
                } else if (!expand && !isCollapsed) {
                    self.toggleChart(metric);
                }
            });
        },

        /**
         * 차트 높이 업데이트
         * @param {number} newHeight - 새로운 높이
         */
        updateChartHeight(newHeight) {
            const ru = window.ru;
            $('#ruChartsWrap .ru-chart-content').each(function() {
                const $content = $(this);
                if ($content.is(':visible')) {
                    const metric = $content.attr('id').replace('ruChartContent-', '');
                    const chart = ru.charts[metric];
                    if (chart) {
                        chart.updateOptions({ chart: { height: newHeight } }, false, true);
                    }
                    $content.find(`#ruApex-${metric}`).css('height', newHeight + 'px');
                }
            });
            $('#ruChartHeightValue').text(newHeight + 'px');
        },

        /**
         * 모달 열기
         * @param {string} metricKey - 메트릭 키
         */
        openModal(metricKey) {
            const ru = window.ru;
            const titles = { cpu: 'CPU', mem: 'MEM', cc: 'CC', cs: 'CS', http: 'HTTP', https: 'HTTPS', ftp: 'FTP' };
            if (metricKey.startsWith('if_')) {
                const ifName = metricKey.replace('if_', '');
                $('#ruModalTitle').text(`${ifName} 회선사용률`);
            } else {
                $('#ruModalTitle').text(titles[metricKey] || 'Chart');
            }
            const modalHeight = $(window).height() * 0.7;
            this.ensureApexChartsDom(true, metricKey, modalHeight);
            this.renderMetricChart(metricKey, true);
            $('#ruChartModal').addClass('is-active');
        },

        /**
         * 모달 닫기
         */
        closeModal() {
            const ru = window.ru;
            $('#ruChartModal').removeClass('is-active');
            if (ru.modalChart) {
                ru.modalChart.destroy();
                ru.modalChart = null;
            }
            $('#ruModalChart').empty();
        }
    };

    // 전역으로 노출
    window.ResourceUsageCharts = ResourceUsageCharts;
})(window);
