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
            
            // 콘솔 로그 최적화: 디버그 모드일 때만 출력하거나 간소화
            // 너무 많은 로그로 인한 성능 저하 방지
            const DEBUG_MODE = false; // 필요시 true로 변경하여 디버깅
            if (DEBUG_MODE && rows && rows.length > 0) {
                // 첫 번째 행만 간단히 로그 출력
                const row = rows[0];
                const logParts = [`[resource_usage] Collected ${rows.length} rows, proxy_id=${row.proxy_id}`];
                if (row.cpu !== null && row.cpu !== undefined) logParts.push(`cpu=${row.cpu.toFixed(2)}%`);
                if (row.mem !== null && row.mem !== undefined) logParts.push(`mem=${row.mem.toFixed(2)}%`);
                console.log(logParts.join(' '));
            }
            
            // 사용 중인 프록시 ID 수집 (메모리 정리를 위해)
            const activeProxyIds = new Set((rows || []).map(row => row.proxy_id));
            
            (rows || []).forEach(row => {
                const proxyId = row.proxy_id;
                const rawTs = row.collected_at ? new Date(row.collected_at).getTime() : now;
                // quantize to bucket to align across proxies in same cycle
                const ts = Math.floor(rawTs / ru.timeBucketMs) * ru.timeBucketMs;
                ru.tsBuffer[proxyId] = ru.tsBuffer[proxyId] || { cpu: [], mem: [], cc: [], cs: [], http: [], https: [], ftp: [] };
                
                // Initialize interface buffers dynamically (now keyed by interface name with in/out)
                // 설정에서 인터페이스 목록을 가져와서 버퍼 초기화 (데이터가 없어도 초기화)
                const interfaceOids = (ru.cachedConfig && ru.cachedConfig.interface_oids) ? ru.cachedConfig.interface_oids : {};
                const configuredInterfaceNames = Object.keys(interfaceOids);
                
                configuredInterfaceNames.forEach(ifName => {
                    const inKey = `if_${ifName}_in`;
                    const outKey = `if_${ifName}_out`;
                    if (!ru.tsBuffer[proxyId][inKey]) {
                        ru.tsBuffer[proxyId][inKey] = [];
                    }
                    if (!ru.tsBuffer[proxyId][outKey]) {
                        ru.tsBuffer[proxyId][outKey] = [];
                    }
                });
                
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
                
                // Add interface data to buffer (per interface, keyed by name from config)
                if (row.interface_mbps && typeof row.interface_mbps === 'object') {
                    // Get configured interfaces from config to map interface names
                    const interfaceOids = (ru.cachedConfig && ru.cachedConfig.interface_oids) ? ru.cachedConfig.interface_oids : {};
                    const configuredInterfaceNames = Object.keys(interfaceOids);
                    
                    Object.keys(row.interface_mbps).forEach(ifKey => {
                        const ifData = row.interface_mbps[ifKey];
                        if (ifData && typeof ifData === 'object') {
                            // 인터페이스 이름 결정: name 필드가 있으면 사용, 없으면 키 사용
                            // configuredInterfaceNames에 있는 이름과 매칭
                            let ifName = ifData.name || ifKey;
                            // configuredInterfaceNames에 없으면 키가 이름일 수 있음
                            if (!configuredInterfaceNames.includes(ifName) && configuredInterfaceNames.includes(ifKey)) {
                                ifName = ifKey;
                            }
                            
                            // configuredInterfaceNames에 있는 인터페이스만 버퍼에 저장 (in/out 별도)
                            if (configuredInterfaceNames.includes(ifName)) {
                                const inMbps = typeof ifData.in_mbps === 'number' ? ifData.in_mbps : 0;
                                const outMbps = typeof ifData.out_mbps === 'number' ? ifData.out_mbps : 0;
                                
                                // IN 데이터 저장
                                const inKey = `if_${ifName}_in`;
                                let inArr = ru.tsBuffer[proxyId][inKey] || [];
                                const inLast = inArr[inArr.length - 1];
                                if (inLast && inLast.x === ts) {
                                    inArr[inArr.length - 1] = { x: ts, y: inMbps };
                                } else {
                                    inArr.push({ x: ts, y: inMbps });
                                }
                                ru.tsBuffer[proxyId][inKey] = inArr;
                                if (inArr.length > ru.bufferMaxPoints) {
                                    inArr.shift();
                                }
                                
                                // OUT 데이터 저장
                                const outKey = `if_${ifName}_out`;
                                let outArr = ru.tsBuffer[proxyId][outKey] || [];
                                const outLast = outArr[outArr.length - 1];
                                if (outLast && outLast.x === ts) {
                                    outArr[outArr.length - 1] = { x: ts, y: outMbps };
                                } else {
                                    outArr.push({ x: ts, y: outMbps });
                                }
                                ru.tsBuffer[proxyId][outKey] = outArr;
                                if (outArr.length > ru.bufferMaxPoints) {
                                    outArr.shift();
                                }
                            }
                        }
                    });
                }
            });
            // prune old points (defensively skip null/invalid)
            const cutoff = now - ru.bufferWindowMs;
            // 사용하지 않는 프록시 버퍼 제거 (메모리 누수 방지)
            Object.keys(ru.tsBuffer).forEach(proxyId => {
                if (!activeProxyIds.has(parseInt(proxyId, 10))) {
                    // 오래된 프록시 버퍼 제거 (30분 이상 사용하지 않음)
                    const byMetric = ru.tsBuffer[proxyId] || {};
                    let hasRecentData = false;
                    Object.keys(byMetric).forEach(k => {
                        const arr = Array.isArray(byMetric[k]) ? byMetric[k] : [];
                        if (arr.length > 0) {
                            const lastPoint = arr[arr.length - 1];
                            if (lastPoint && typeof lastPoint.x === 'number' && lastPoint.x >= cutoff) {
                                hasRecentData = true;
                            }
                        }
                    });
                    if (!hasRecentData) {
                        delete ru.tsBuffer[proxyId];
                    }
                } else {
                    // 활성 프록시의 경우 오래된 포인트만 제거
                    const byMetric = ru.tsBuffer[proxyId] || {};
                    Object.keys(byMetric).forEach(k => {
                        const arr = Array.isArray(byMetric[k]) ? byMetric[k] : [];
                        byMetric[k] = arr.filter(p => p && typeof p.x === 'number' && p.x >= cutoff);
                    });
                }
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
                // 설정이 로드되지 않았으면 초기화하지 않음 (설정에 등록된 인터페이스 정보 필요)
                if (!ru.cachedConfig) {
                    return false;
                }
                
                // 이미 초기화되었고 설정이 변경되지 않았으면 스킵
                const currentConfigHash = JSON.stringify(ru.cachedConfig.interface_oids || {});
                const lastConfigHash = $wrap.data('configHash');
                if ($wrap.data('initialized') && lastConfigHash === currentConfigHash) {
                    return true;
                }
                
                const basicMetrics = ['cpu','mem','cc','cs','http','https','ftp'];
                const basicTitles = { cpu: 'CPU', mem: 'MEM', cc: 'CC', cs: 'CS', http: 'HTTP', https: 'HTTPS', ftp: 'FTP' };
                
                // Get configured interfaces from config
                const interfaceOids = (ru.cachedConfig && ru.cachedConfig.interface_oids) ? ru.cachedConfig.interface_oids : {};
                const configuredInterfaceNames = Object.keys(interfaceOids);
                
                // Interface metrics: in and out separately
                const interfaceMetrics = [];
                configuredInterfaceNames.forEach(ifName => {
                    const displayName = utils.abbreviateInterfaceName(ifName);
                    interfaceMetrics.push(`if_${ifName}_in`);
                    interfaceMetrics.push(`if_${ifName}_out`);
                });
                
                const metrics = [...basicMetrics, ...interfaceMetrics];
                const titles = { ...basicTitles };
                configuredInterfaceNames.forEach(ifName => {
                    const displayName = utils.abbreviateInterfaceName(ifName);
                    titles[`if_${ifName}_in`] = `${displayName} IN`;
                    titles[`if_${ifName}_out`] = `${displayName} OUT`;
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
                // 이전 차트 인스턴스 정리 (메모리 누수 방지)
                $wrap.find('.ru-chart-panel').each(function() {
                    const metric = $(this).attr('id')?.replace('ruChartPanel-', '');
                    if (metric && ru.charts && ru.charts[metric]) {
                        try {
                            ru.charts[metric].destroy();
                        } catch (e) {
                            console.warn('[resource_usage_charts] Failed to destroy chart:', e);
                        }
                        delete ru.charts[metric];
                    }
                });
                $wrap.find('.ru-chart-panel').parent().remove();
                $wrap.find('.ru-interface-separator').remove();
                
                // 기본 메트릭과 인터페이스 메트릭 분리
                const basicMetricsList = metrics.filter(m => basicMetrics.includes(m));
                const interfaceMetricsList = metrics.filter(m => m.startsWith('if_'));
                
                // 기본 메트릭 차트 생성 (모두 접힌 상태)
                basicMetricsList.forEach(m => {
                    const isCollapsed = true; // 모든 기본 메트릭은 접힌 상태
                    const panel = `
                        <div class="column is-6">
                            <div class="ru-chart-panel" id="ruChartPanel-${m}" data-collapsed="${isCollapsed}" style="border:1px solid var(--border-color,#e5e7eb); border-radius:6px; padding:8px; margin-bottom:1rem;">
                                <div class="level" style="margin-bottom:6px;">
                                    <div class="level-left">
                                        <h5 class="title is-6" style="margin:0; cursor:pointer;" data-metric="${m}">${titles[m]}</h5>
                                    </div>
                                    <div class="level-right">
                                        <a class="button is-small ru-chart-toggle-btn" data-metric="${m}" title="접기/펼치기">${isCollapsed ? '▼' : '▲'}</a>
                                        <a class="button is-small ru-chart-zoom-btn" data-metric="${m}" title="확대">확대</a>
                                    </div>
                                </div>
                                <div class="ru-chart-content" id="ruChartContent-${m}" style="display:${isCollapsed ? 'none' : 'block'};">
                                    <div id="ruApex-${m}" style="width:100%; height:${height}px;"></div>
                                </div>
                            </div>
                        </div>`;
                    $wrap.append(panel);
                });
                
                // 인터페이스 메트릭 구분선 추가
                if (interfaceMetricsList.length > 0) {
                    const separator = `
                        <div class="column is-12 ru-interface-separator" style="margin: 2rem 0 1rem 0;">
                            <hr style="background-color: var(--border-color,#e5e7eb); height: 2px; border: none;">
                            <h4 class="title is-5" style="margin-top: 1rem;">회선사용량 인터페이스</h4>
                        </div>`;
                    $wrap.append(separator);
                }
                
                // 인터페이스 메트릭 차트 생성 (모두 접힌 상태)
                interfaceMetricsList.forEach(m => {
                    const isCollapsed = true; // 모든 인터페이스 메트릭도 접힌 상태
                    const panel = `
                        <div class="column is-6">
                            <div class="ru-chart-panel" id="ruChartPanel-${m}" data-collapsed="${isCollapsed}" style="border:1px solid var(--border-color,#e5e7eb); border-radius:6px; padding:8px; margin-bottom:1rem;">
                                <div class="level" style="margin-bottom:6px;">
                                    <div class="level-left">
                                        <h5 class="title is-6" style="margin:0; cursor:pointer;" data-metric="${m}">${titles[m]}</h5>
                                    </div>
                                    <div class="level-right">
                                        <a class="button is-small ru-chart-toggle-btn" data-metric="${m}" title="접기/펼치기">${isCollapsed ? '▼' : '▲'}</a>
                                        <a class="button is-small ru-chart-zoom-btn" data-metric="${m}" title="확대">확대</a>
                                    </div>
                                </div>
                                <div class="ru-chart-content" id="ruChartContent-${m}" style="display:${isCollapsed ? 'none' : 'block'};">
                                    <div id="ruApex-${m}" style="width:100%; height:${height}px;"></div>
                                </div>
                            </div>
                        </div>`;
                    $wrap.append(panel);
                });
                $wrap.data('initialized', true);
                $wrap.data('configHash', currentConfigHash); // 설정 해시 저장
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
            // Interface metrics: in and out separately
            const interfaceMetrics = [];
            configuredInterfaceNames.forEach(ifName => {
                interfaceMetrics.push(`if_${ifName}_in`);
                interfaceMetrics.push(`if_${ifName}_out`);
            });
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
                
                // 디버깅: 인터페이스 메트릭의 경우 버퍼 상태 확인
                if (metricKey.startsWith('if_')) {
                    if (arr.length === 0) {
                        console.log(`[resource_usage_charts] No data in buffer for ${metricKey}, proxyId=${proxyId}, available keys:`, Object.keys(byMetric).filter(k => k.startsWith('if_')));
                    }
                }
                
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
                            if (!chartContext || !chartContext.w || !chartContext.w.globals || !chartContext.w.globals.dom || !chartContext.w.globals.dom.el) {
                                return;
                            }
                            if (config.seriesIndex < 0) {
                                (chartContext.w.globals.series || []).forEach((s, i) => {
                                    chartContext.updateSeries([{ data: s }], false);
                                });
                                chartContext.w.globals.dom.el.style.cursor = 'default';
                                return;
                            }
                            const seriesIndex = config.seriesIndex;
                            (chartContext.w.globals.series || []).forEach((s, i) => {
                                const seriesEl = chartContext.w.globals.dom.el.querySelector(`.apexcharts-series[seriesName="${s.name.replace(/"/g, '\\"')}"]`);
                                if (seriesEl) {
                                    const newOpacity = (i === seriesIndex) ? 1 : 0.3;
                                    seriesEl.style.opacity = newOpacity;
                                }
                            });
                            chartContext.w.globals.dom.el.style.cursor = 'pointer';
                        },
                        mouseLeave: function(event, chartContext, config) {
                            if (!chartContext || !chartContext.w || !chartContext.w.globals || !chartContext.w.globals.dom || !chartContext.w.globals.dom.el) {
                                return;
                            }
                            const series = chartContext.w.globals.series || [];
                            if (series.length === 0) return;
                            series.forEach((s, i) => {
                                const seriesEl = chartContext.w.globals.dom.el.querySelector(`.apexcharts-series[seriesName="${s.name.replace(/"/g, '\\"')}"]`);
                                if (seriesEl) {
                                    seriesEl.style.opacity = 1;
                                }
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
                            if (metricKey.startsWith('if_')) { 
                                // 회선사용률은 bps로 표시
                                const bps = utils.mbpsToBps(val);
                                return utils.formatBps(bps, 1);
                            }
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
                            if (metricKey.startsWith('if_')) { 
                                // 회선사용률은 bps로 표시
                                const bps = utils.mbpsToBps(val);
                                return utils.formatBps(bps, 2);
                            }
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
                // 옵션 변경이 필요한 경우에만 업데이트 (성능 최적화)
                const needsOptionsUpdate = !ru._chartOptionsCache || 
                    ru._chartOptionsCache[metricKey] !== JSON.stringify({ height, colors: colors.length });
                
                if (needsOptionsUpdate) {
                    chartInstance.updateOptions({ ...options, colors }, false, false);
                    if (!ru._chartOptionsCache) ru._chartOptionsCache = {};
                    ru._chartOptionsCache[metricKey] = JSON.stringify({ height, colors: colors.length });
                }
                // 시리즈 데이터만 업데이트 (애니메이션 비활성화로 성능 개선)
                // 이전 시리즈 데이터 참조를 정리하여 메모리 누수 방지
                try {
                    chartInstance.updateSeries(series, false);
                } catch (e) {
                    console.warn(`[resource_usage_charts] Failed to update series for ${metricKey}:`, e);
                    // 업데이트 실패 시 차트 재생성
                    try {
                        chartInstance.destroy();
                    } catch (destroyErr) {
                        // ignore
                    }
                    const newChart = new ApexCharts(el, { ...options, series });
                    if (isModal) {
                        ru.modalChart = newChart;
                    } else {
                        ru.charts[metricKey] = newChart;
                    }
                    newChart.render();
                }
            }
        },

        /**
         * 차트 접기/펼치기 토글
         * @param {string} metricKey - 메트릭 키
         * @param {boolean} forceExpand - 강제로 펼치기 (undefined면 토글)
         */
        toggleChart(metricKey, forceExpand) {
            const $panel = $(`#ruChartPanel-${metricKey}`);
            const $content = $(`#ruChartContent-${metricKey}`);
            const $btn = $panel.find('.ru-chart-toggle-btn');
            
            if (!$panel.length || !$content.length) return;
            
            // forceExpand가 지정되면 그대로 사용, 없으면 현재 상태 확인 후 토글
            let shouldCollapse;
            if (forceExpand !== undefined) {
                shouldCollapse = !forceExpand;
            } else {
                // 현재 상태 확인 (HTML 속성에서 읽기)
                const collapsedAttr = $panel.attr('data-collapsed');
                const currentCollapsed = collapsedAttr === 'true';
                shouldCollapse = !currentCollapsed;
            }
            
            if (shouldCollapse) {
                // 접기
                $content.slideUp(200);
                $btn.text('▼');
                $panel.attr('data-collapsed', 'true');
                $panel.data('collapsed', true);
            } else {
                // 펼치기
                $content.slideDown(200);
                $btn.text('▲');
                $panel.attr('data-collapsed', 'false');
                $panel.data('collapsed', false);
            }
        },

        /**
         * 모든 차트 접기/펼치기 토글
         * @param {boolean} expand - 펼치기 여부 (undefined면 토글)
         */
        toggleAllCharts(expand) {
            const $panels = $('#ruChartsWrap .ru-chart-panel');
            if ($panels.length === 0) return;
            
            let shouldExpand;
            
            if (expand !== undefined) {
                // expand 값이 지정되면 그대로 사용
                shouldExpand = expand;
            } else {
                // expand가 undefined면 현재 상태 확인 후 토글
                let allCollapsed = true;
                $panels.each(function() {
                    const isCollapsed = $(this).attr('data-collapsed') === 'true';
                    if (!isCollapsed) {
                        allCollapsed = false;
                        return false; // break
                    }
                });
                shouldExpand = allCollapsed;
            }
            
            // 모든 차트를 한 번에 처리 (화살표 함수로 this 바인딩)
            $panels.each((index, element) => {
                const metric = $(element).attr('id').replace('ruChartPanel-', '');
                if (metric) {
                    this.toggleChart(metric, shouldExpand);
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
                const ifName = metricKey.replace(/^if_/, '').replace(/_in$|_out$/, '');
                const direction = metricKey.endsWith('_in') ? 'IN' : (metricKey.endsWith('_out') ? 'OUT' : '');
                const utils = window.ResourceUsageUtils;
                const displayName = utils.abbreviateInterfaceName(ifName);
                $('#ruModalTitle').text(`${displayName} ${direction} 회선사용률`);
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
                try {
                    ru.modalChart.destroy();
                } catch (e) {
                    console.warn('[resource_usage_charts] Failed to destroy modal chart:', e);
                }
                ru.modalChart = null;
            }
            $('#ruModalChart').empty();
        },
        
        /**
         * 모든 차트 인스턴스 정리 (메모리 누수 방지)
         */
        cleanupAllCharts() {
            const ru = window.ru;
            // 일반 차트 정리
            if (ru.charts) {
                Object.keys(ru.charts).forEach(metricKey => {
                    const chart = ru.charts[metricKey];
                    if (chart && typeof chart.destroy === 'function') {
                        try {
                            chart.destroy();
                        } catch (e) {
                            console.warn(`[resource_usage_charts] Failed to destroy chart ${metricKey}:`, e);
                        }
                    }
                });
                ru.charts = {};
            }
            
            // 히트맵 차트 정리
            if (ru.apex) {
                try {
                    ru.apex.destroy();
                } catch (e) {
                    console.warn('[resource_usage_charts] Failed to destroy heatmap chart:', e);
                }
                ru.apex = null;
            }
            
            // 모달 차트 정리
            if (ru.modalChart) {
                try {
                    ru.modalChart.destroy();
                } catch (e) {
                    console.warn('[resource_usage_charts] Failed to destroy modal chart:', e);
                }
                ru.modalChart = null;
            }
        }
    };

    // 전역으로 노출
    window.ResourceUsageCharts = ResourceUsageCharts;
})(window);
