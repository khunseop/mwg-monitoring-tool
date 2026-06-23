$(document).ready(function() {
    const history = {
        proxies: [],
        groups: [],
        storageKey: 'ru_history_state',
        lastData: [],
        charts: {}
    };

    // DeviceSelector 초기화
    function initDeviceSelector() {
        window.DeviceSelector.init({
            groupSelect: '#ruHistoryGroupSelect',
            proxySelect: '#ruHistoryProxySelect',
            proxyTrigger: '#ruHistoryProxyTrigger',
            deselectBtn: '#ruHistoryDeselectAllBtn',
            selectionCounter: '#ruHistorySelectionCounter',
            storageKey: history.storageKey,
            onData: function(data) {
                history.groups = data.groups || [];
                history.proxies = data.proxies || [];
                loadStatistics();
            }
        });
    }

    function getSelectedProxyIds() {
        const select = document.getElementById('ruHistoryProxySelect');
        if (select && select._tom) {
            return select._tom.getValue().map(v => parseInt(v, 10));
        }
        return ($(select).val() || []).map(v => parseInt(v, 10));
    }

    // Format datetime for display
    function formatDateTime(datetimeStr) {
        if (!datetimeStr) return '';
        const date = new Date(datetimeStr);
        return date.toLocaleString('ko-KR', {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
        });
    }

    // Format interface MBPS for display (bps로 변환)
    function formatInterfaceMbps(interfaceMbps) {
        if (!interfaceMbps || typeof interfaceMbps !== 'object') return '-';
        const utils = window.ResourceUsageUtils;
        const parts = [];
        Object.keys(interfaceMbps).forEach(ifName => {
            const ifData = interfaceMbps[ifName];
            if (ifData && typeof ifData === 'object') {
                const name = ifName.length > 20 ? ifName.substring(0, 17) + '...' : ifName;
                const inMbps = typeof ifData.in_mbps === 'number' ? ifData.in_mbps : 0;
                const outMbps = typeof ifData.out_mbps === 'number' ? ifData.out_mbps : 0;
                const bpsIn = utils.mbpsToBps(inMbps);
                const bpsOut = utils.mbpsToBps(outMbps);
                parts.push(`${name}: ${utils.formatBps(bpsIn, 2)}/${utils.formatBps(bpsOut, 2)}`);
            }
        });
        return parts.length > 0 ? parts.join(', ') : '-';
    }
    
    // Format traffic value (cumulative bytes to Mbps for display)
    function formatTrafficMbps(bytes, intervalSec = 60) {
        if (bytes === null || bytes === undefined || typeof bytes !== 'number') return '-';
        // This is cumulative, so we can't calculate Mbps without previous value
        // For display purposes, show as MB
        const mb = bytes / (1024 * 1024);
        return mb.toFixed(2) + ' MB';
    }

    // Convert datetime-local to UTC ISO string
    function convertKSTToUTC(datetimeLocal) {
        if (!datetimeLocal) return null;
        const [datePart, timePart] = datetimeLocal.split('T');
        const [year, month, day] = datePart.split('-').map(Number);
        const [hours, minutes] = timePart.split(':').map(Number);
        const kstDate = new Date(Date.UTC(year, month - 1, day, hours, minutes));
        const utcDate = new Date(kstDate.getTime() - 9 * 60 * 60 * 1000);
        return utcDate.toISOString();
    }
    
    // Search history with date range
    function searchHistory() {
        const proxyIds = getSelectedProxyIds();
        const startTime = $('#ruHistoryStartTime').val();
        const endTime = $('#ruHistoryEndTime').val();
        const limit = parseInt($('#ruHistoryLimit').val(), 10) || 500;

        if (proxyIds.length === 0) {
            alert('조회할 프록시를 선택하세요.');
            return;
        }

        const params = {
            limit: limit,
            offset: 0,
            proxy_ids: proxyIds.join(',')
        };

        if (startTime) params.start_time = convertKSTToUTC(startTime);
        if (endTime) params.end_time = convertKSTToUTC(endTime);

        loadHistoryData(params);
    }

    // Load all history (no date filter)
    function loadAllHistory() {
        const proxyIds = getSelectedProxyIds();
        const limit = parseInt($('#ruHistoryLimit').val(), 10) || 500;

        if (proxyIds.length === 0) {
            alert('프록시를 선택하세요.');
            return;
        }

        loadHistoryData({ limit: limit, offset: 0, proxy_ids: proxyIds.join(',') });
    }

    function loadHistoryData(params) {
        $('#ruHistoryLoading').show();
        $('#ruHistoryError').hide();
        $('#ruHistoryResults').hide();

        $.ajax({
            url: '/api/history',
            method: 'GET',
            data: params
        }).then(data => {
            $('#ruHistoryLoading').hide();
            if (!data || data.length === 0) {
                $('#ruHistoryError').text('조회된 데이터가 없습니다.').show();
                return;
            }
            history.lastData = data;
            displayHistoryResults(data);
        }).catch(err => {
            $('#ruHistoryLoading').hide();
            const errorMsg = err.responseJSON && err.responseJSON.detail
                ? err.responseJSON.detail
                : '이력 조회 중 오류가 발생했습니다.';
            $('#ruHistoryError').text(errorMsg).show();
        });
    }

    function displayHistoryResults(data) {
        $('#ruHistoryCount').text(`총 ${data.length}건의 데이터를 기반으로 그래프를 표시합니다.`);
        $('#ruHistoryResults').show();
        renderHistoryCharts();
    }


    // Load statistics
    function loadStatistics() {
        const proxyIds = getSelectedProxyIds();
        const params = proxyIds.length > 0 ? { proxy_ids: proxyIds.join(',') } : {};
        
        $.getJSON('/api/resource-usage/stats', params).then(function(stats) {
            $('#ruHistoryTotalCount').text(stats.total_count.toLocaleString());
            
            let statsText = '';
            if (stats.oldest_record) {
                statsText += `가장 오래된 레코드: ${formatDateTime(stats.oldest_record)}`;
            }
            if (stats.newest_record) {
                if (statsText) statsText += ' | ';
                statsText += `가장 최근 레코드: ${formatDateTime(stats.newest_record)}`;
            }
            if (Object.keys(stats.records_by_proxy).length > 0) {
                if (statsText) statsText += ' | ';
                const proxyMap = {};
                (history.proxies || []).forEach(p => { proxyMap[p.id] = p.host; });
                const parts = Object.keys(stats.records_by_proxy).map(pid => {
                    const host = proxyMap[pid] || `#${pid}`;
                    return `${host}: ${stats.records_by_proxy[pid].toLocaleString()}건`;
                });
                statsText += '프록시별: ' + parts.join(', ');
            }
            if (statsText) {
                $('#ruHistoryStatsText').html(statsText);
                $('#ruHistoryStatsDetails').show();
            } else {
                $('#ruHistoryStatsDetails').hide();
            }
        }).catch(function(err) {
            console.error('Failed to load statistics:', err);
        });
    }
    
    // Export function
    function exportHistory() {
        const proxyIds = getSelectedProxyIds();
        const startTime = $('#ruHistoryStartTime').val();
        const endTime = $('#ruHistoryEndTime').val();
        
        if (proxyIds.length === 0) {
            alert('내보낼 프록시를 선택하세요.');
            return;
        }

        const params = {
            proxy_ids: proxyIds.join(',')
        };
        if (startTime) {
            params.start_time = convertKSTToUTC(startTime);
        }
        if (endTime) {
            params.end_time = convertKSTToUTC(endTime);
        }
        
        // Build query string
        const queryString = Object.keys(params).map(key => 
            `${encodeURIComponent(key)}=${encodeURIComponent(params[key])}`
        ).join('&');
        
        // Open download link
        window.location.href = `/api/resource-usage/export?${queryString}`;
    }
    
    // Delete function
    function deleteHistory() {
        const $modal = $('#ruHistoryDeleteModal');
        const deleteOption = $modal.find('input[name="deleteOption"]:checked').val();
        const proxyId = $('#ruDeleteProxySelect').val();
        
        const deleteData = {};
        if (proxyId) {
            deleteData.proxy_id = parseInt(proxyId, 10);
        }
        
        if (deleteOption === 'older') {
            const days = parseInt($('#ruDeleteOlderDays').val(), 10);
            if (!days || days < 1) {
                alert('삭제할 기간을 입력하세요.');
                return;
            }
            deleteData.older_than_days = days;
        } else if (deleteOption === 'range') {
            const startTime = $('#ruDeleteStartTime').val();
            const endTime = $('#ruDeleteEndTime').val();
            if (!startTime || !endTime) {
                alert('시작 시간과 종료 시간을 모두 입력하세요.');
                return;
            }
            deleteData.start_time = convertKSTToUTC(startTime);
            deleteData.end_time = convertKSTToUTC(endTime);
        } else if (deleteOption === 'all') {
            if (!confirm('정말로 전체 로그를 삭제하시겠습니까? 이 작업은 되돌릴 수 없습니다.')) {
                return;
            }
        }
        
        $.ajax({
            url: '/api/resource-usage',
            method: 'DELETE',
            contentType: 'application/json',
            data: JSON.stringify(deleteData)
        }).then(function(response) {
            alert(response.message);
            $modal.removeClass('is-active');
            loadStatistics();
            // Clear current results
            $('#ruHistoryResults').hide();
        }).catch(function(err) {
            const errorMsg = err.responseJSON && err.responseJSON.detail 
                ? err.responseJSON.detail 
                : '로그 삭제 중 오류가 발생했습니다.';
            alert(errorMsg);
        });
    }
    
    // Initialize delete modal proxy select
    function initDeleteProxySelect() {
        const $select = $('#ruDeleteProxySelect');
        $select.empty();
        $select.append('<option value="">전체</option>');
        (history.proxies || []).forEach(p => {
            $select.append(`<option value="${p.id}">${p.host}</option>`);
        });
        if (window.TomSelect && !$select[0]._tomSelect) {
            new TomSelect($select[0], {
                placeholder: '프록시 선택',
                allowEmptyOption: true
            });
        }
    }

    function initResourceHistory() {
        // DeviceSelector 초기화
        initDeviceSelector();

        // Event handlers (중복 바인딩 방지)
        $('#ruHistorySearchBtn').off('click').on('click', searchHistory);
        $('#ruHistoryLoadAllBtn').off('click').on('click', loadAllHistory);
        $('#ruHistoryExportBtn').off('click').on('click', exportHistory);

        $('#ruHistoryDeleteBtn').off('click').on('click', function() {
            initDeleteProxySelect();
            $('#ruHistoryDeleteModal').addClass('is-active');
        });
        
        $('#ruHistoryDeleteModal').find('input[name="deleteOption"]').off('change').on('change', function() {
            const option = $(this).val();
            $('#ruDeleteOlderThan').toggle(option === 'older');
            $('#ruDeleteRange').toggle(option === 'range');
        });
        
        $('#ruHistoryDeleteConfirmBtn').off('click').on('click', deleteHistory);
        $('#ruHistoryDeleteCancelBtn, #ruHistoryDeleteModal .delete, #ruHistoryDeleteModal .modal-background').off('click').on('click', function() {
            $('#ruHistoryDeleteModal').removeClass('is-active');
        });
        
        // 시간 범위 프리셋 핸들러
        $('.ru-history-preset').off('click').on('click', function() {
            const range = $(this).data('range');
            const now = new Date();
            let start = new Date();

            switch(range) {
                case '1h': start.setHours(now.getHours() - 1); break;
                case '6h': start.setHours(now.getHours() - 6); break;
                case '12h': start.setHours(now.getHours() - 12); break;
                case '1d': start.setDate(now.getDate() - 1); break;
                case '7d': start.setDate(now.getDate() - 7); break;
            }

            // datetime-local 포맷으로 변환 (YYYY-MM-DDTHH:mm)
            const formatDate = (date) => {
                const pad = (n) => String(n).padStart(2, '0');
                return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
            };

            $('#ruHistoryStartTime').val(formatDate(start));
            $('#ruHistoryEndTime').val(formatDate(now));

            // 선택 상태 시각 피드백
            $('.ru-history-preset').removeClass('is-active-preset');
            $(this).addClass('is-active-preset');

            // 날짜 입력 변경 시 프리셋 선택 해제
            $('#ruHistoryStartTime, #ruHistoryEndTime').off('change.preset').on('change.preset', function() {
                $('.ru-history-preset').removeClass('is-active-preset');
            });

            // 프리셋 선택 후 즉시 조회
            searchHistory();
        });

        // Load statistics when proxy selection changes
        $('#ruHistoryProxySelect').off('change').on('change', loadStatistics);
    }

    /**
     * 이력 데이터를 기반으로 그래프 렌더링 (지표별/회선별 분리)
     */
    function renderHistoryCharts() {
        const data = history.lastData;
        const $container = $('#ruHistoryCharts');
        
        if (!data || data.length === 0) {
            $container.hide();
            return;
        }
        $container.show();
        $container.empty(); // 기존 차트 제거 및 컨테이너 초기화

        // 1. 데이터 가공 (프록시별 그룹화 및 시간순 정렬)
        const proxyMap = {};
        (history.proxies || []).forEach(p => { proxyMap[p.id] = p.host; });

        const sortedData = [...data].sort((a, b) => new Date(a.collected_at) - new Date(b.collected_at));
        
        const proxyGroups = {};
        const allInterfaceNames = new Set();

        sortedData.forEach(row => {
            const pid = row.proxy_id;
            if (!proxyGroups[pid]) proxyGroups[pid] = [];
            proxyGroups[pid].push(row);

            // 인터페이스 이름 수집 (key는 인덱스, 실제 이름은 .name 필드)
            const ifData = row.interface_mbps ? (typeof row.interface_mbps === 'string' ? JSON.parse(row.interface_mbps) : row.interface_mbps) : {};
            Object.values(ifData).forEach(info => { if (info && info.name) allInterfaceNames.add(info.name); });
        });

        // 헬퍼: 특정 필드 시리즈 생성
        const getSeries = (field) => {
            return Object.keys(proxyGroups).map(pid => {
                const host = proxyMap[pid] || `#${pid}`;
                return {
                    name: host,
                    data: proxyGroups[pid].map(row => ({
                        x: new Date(row.collected_at).getTime(),
                        y: row[field]
                    }))
                };
            });
        };

        // 헬퍼: 차트 박스 HTML 생성 및 추가
        const createChartBox = (id, title, fullWidth = false) => {
            const colClass = fullWidth ? 'is-12' : 'is-6';
            const html = `
                <div class="column ${colClass}">
                    <div class="box">
                        <h5 class="title is-6 mb-4">${title}</h5>
                        <div id="${id}" style="height: 300px;"></div>
                    </div>
                </div>
            `;
            $container.append(html);
        };

        // 2. 기본 지표별 그래프 생성
        const basicMetrics = [
            { key: 'cpu', title: 'CPU Usage (%)', unit: '%' },
            { key: 'mem', title: 'Memory Usage (%)', unit: '%' },
            { key: 'disk', title: 'Disk Usage (%)', unit: '%' },
            { key: 'cc', title: 'Client Count', unit: 'sess' },
            { key: 'cs', title: 'Connected Sockets', unit: 'sess' },
            { key: 'blocked', title: 'Connections Blocked', unit: 'count' },
            { key: 'http', title: 'HTTP Throughput (Mbps)', unit: 'Mbps' },
            { key: 'https', title: 'HTTPS Throughput (Mbps)', unit: 'Mbps' },
            { key: 'http2', title: 'HTTP2 Throughput (Mbps)', unit: 'Mbps' }
        ];

        // 차트 객체 초기화 (동적 생성 시 기존 참조는 의미 없음)
        history.charts = {};

        basicMetrics.forEach(m => {
            const chartId = `hist-chart-${m.key}`;
            createChartBox(chartId, m.title);
            renderHistoryLineChart(chartId, getSeries(m.key), m.unit);
        });

        // 3. 인터페이스별 그래프 생성 (ifName은 실제 인터페이스 이름, e.g. "eth0")
        Array.from(allInterfaceNames).sort().forEach(ifName => {
            const chartId = `hist-chart-if-${ifName.replace(/[^a-zA-Z0-9]/g, '_')}`;
            createChartBox(chartId, `Interface: ${ifName} (Mbps)`, true);

            const ifSeries = Object.keys(proxyGroups).map(pid => {
                const host = proxyMap[pid] || `#${pid}`;
                const inData = [];
                const outData = [];

                proxyGroups[pid].forEach(row => {
                    const ifData = row.interface_mbps ? (typeof row.interface_mbps === 'string' ? JSON.parse(row.interface_mbps) : row.interface_mbps) : {};
                    // ifData key는 인덱스이므로 .name으로 매칭
                    const info = Object.values(ifData).find(v => v && v.name === ifName);
                    const ts = new Date(row.collected_at).getTime();
                    if (info) {
                        inData.push({ x: ts, y: info.in_mbps || 0 });
                        outData.push({ x: ts, y: info.out_mbps || 0 });
                    }
                });

                return [
                    { name: `${host} IN`, data: inData },
                    { name: `${host} OUT`, data: outData }
                ];
            }).flat();

            renderHistoryLineChart(chartId, ifSeries, 'Mbps');
        });
    }

    function renderHistoryLineChart(elId, series, unit) {
        const options = {
            chart: {
                type: 'line',
                height: 300,
                toolbar: { show: true },
                animations: { enabled: false },
                zoom: { type: 'x', enabled: true, autoScaleYaxis: true }
            },
            stroke: { width: 2, curve: 'smooth' },
            series: series,
            xaxis: {
                type: 'datetime',
                labels: { datetimeUTC: false }
            },
            yaxis: {
                title: { text: unit },
                labels: { formatter: val => (val == null || isNaN(val)) ? '' : val.toFixed(1) }
            },
            tooltip: {
                x: { format: 'yyyy-MM-dd HH:mm:ss' },
                y: { formatter: val => `${(val != null && !isNaN(val)) ? val.toFixed(2) : '-'} ${unit}` }
            },
            legend: { position: 'top', horizontalAlign: 'left', fontSize: '11px' }
        };

        const el = document.getElementById(elId);
        if (el) {
            history.charts[elId] = new ApexCharts(el, options);
            history.charts[elId].render();
        }
    }

    window.renderHistoryCharts = renderHistoryCharts;

    // Initialize when page loads
    $(document).ready(() => {
        initResourceHistory();
    });

    // PJAX 페이지 전환 대응
    $(document).off('pjax:complete.rh').on('pjax:complete.rh', function(e, url) {
        if (url.includes('/history')) {
            initResourceHistory();
        }
    });
});

