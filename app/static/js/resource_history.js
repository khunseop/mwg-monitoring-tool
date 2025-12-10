$(document).ready(function() {
    function formatBytes(bytes, decimals = 2, perSecond = false) {
        if (bytes === null || bytes === undefined || isNaN(bytes)) return '';
        if (bytes < 0) bytes = 0;

        if (bytes === 0) {
            let str = '0 Bytes';
            if (perSecond) str += '/s';
            return str;
        }

        const k = 1024;
        const dm = decimals < 0 ? 0 : decimals;
        const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];

        let i = Math.floor(Math.log(bytes) / Math.log(k));
        if (i < 0) i = 0;
        if (i >= sizes.length) i = sizes.length - 1;

        let str = parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
        if (perSecond) str += '/s';
        return str;
    }

    function formatNumber(num) {
        if (num === null || num === undefined) return '';
        return num.toString().replace(/(\d)(?=(\d{3})+(?!\d))/g, '$1,');
    }

    const history = {
        chart: null,
        proxies: [],
        groups: []
    };

    // Initialize history proxy select
    function initHistoryProxySelect() {
        const $select = $('#ruHistoryProxySelect');
        $select.empty();
        $select.append('<option value="">전체</option>');
        (history.proxies || []).forEach(p => {
            $select.append(`<option value="${p.id}">${p.host}</option>`);
        });
        // Initialize TomSelect if available
        if (window.TomSelect && !$select[0]._tomSelect) {
            new TomSelect($select[0], {
                placeholder: '프록시 선택',
                allowEmptyOption: true
            });
        }
    }

    // Set default time range (last 24 hours)
    function setDefaultTimeRange() {
        const now = new Date();
        const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        
        const formatDateTimeLocal = (date) => {
            const year = date.getFullYear();
            const month = String(date.getMonth() + 1).padStart(2, '0');
            const day = String(date.getDate()).padStart(2, '0');
            const hours = String(date.getHours()).padStart(2, '0');
            const minutes = String(date.getMinutes()).padStart(2, '0');
            return `${year}-${month}-${day}T${hours}:${minutes}`;
        };
        
        $('#ruHistoryEndTime').val(formatDateTimeLocal(now));
        $('#ruHistoryStartTime').val(formatDateTimeLocal(yesterday));
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

    // Format interface MBPS for display
    function formatInterfaceMbps(interfaceMbps) {
        if (!interfaceMbps || typeof interfaceMbps !== 'object') return '';
        const parts = [];
        Object.keys(interfaceMbps).forEach(ifIndex => {
            const ifData = interfaceMbps[ifIndex];
            if (ifData && typeof ifData === 'object') {
                const name = ifData.name || `IF${ifIndex}`;
                const inMbps = typeof ifData.in_mbps === 'number' ? ifData.in_mbps.toFixed(2) : '0.00';
                const outMbps = typeof ifData.out_mbps === 'number' ? ifData.out_mbps.toFixed(2) : '0.00';
                parts.push(`${name}: ${inMbps}/${outMbps} Mbps`);
            }
        });
        return parts.join('<br>');
    }

    // Search history
    function searchHistory() {
        const proxyId = $('#ruHistoryProxySelect').val();
        const startTime = $('#ruHistoryStartTime').val();
        const endTime = $('#ruHistoryEndTime').val();
        const limit = parseInt($('#ruHistoryLimit').val(), 10) || 1000;

        if (!startTime || !endTime) {
            $('#ruHistoryError').text('시작 시간과 종료 시간을 모두 입력하세요.').show();
            return;
        }

        // datetime-local 입력은 로컬 시간대(한국 시간)로 입력되므로,
        // new Date()로 파싱하면 로컬 시간대로 해석되고,
        // toISOString()으로 UTC로 변환됩니다.
        // 백엔드에서 이 UTC 시간을 KST로 변환하여 데이터베이스의 KST 시간과 비교합니다.
        const startDateTime = new Date(startTime).toISOString();
        const endDateTime = new Date(endTime).toISOString();

        $('#ruHistoryLoading').show();
        $('#ruHistoryError').hide();
        $('#ruHistoryResults').hide();

        const params = {
            start_time: startDateTime,
            end_time: endDateTime,
            limit: limit
        };

        if (proxyId) {
            params.proxy_id = parseInt(proxyId, 10);
        }

        $.ajax({
            url: '/api/resource-usage/history',
            method: 'GET',
            data: params
        }).then(data => {
            $('#ruHistoryLoading').hide();
            if (!data || data.length === 0) {
                $('#ruHistoryError').text('조회된 데이터가 없습니다.').show();
                return;
            }

            displayHistoryResults(data);
        }).catch(err => {
            $('#ruHistoryLoading').hide();
            const errorMsg = err.responseJSON && err.responseJSON.detail 
                ? err.responseJSON.detail 
                : '이력 조회 중 오류가 발생했습니다.';
            $('#ruHistoryError').text(errorMsg).show();
        });
    }

    // Display history results
    function displayHistoryResults(data) {
        const $tbody = $('#ruHistoryTableBody');
        $tbody.empty();

        const proxyMap = {};
        (history.proxies || []).forEach(p => { proxyMap[p.id] = p.host; });

        data.forEach(row => {
            const proxyName = proxyMap[row.proxy_id] || `#${row.proxy_id}`;
            const tr = $('<tr>');
            tr.append(`<td>${formatDateTime(row.collected_at)}</td>`);
            tr.append(`<td>${proxyName}</td>`);
            tr.append(`<td>${row.cpu != null ? row.cpu.toFixed(2) : '-'}</td>`);
            tr.append(`<td>${row.mem != null ? row.mem.toFixed(2) : '-'}</td>`);
            tr.append(`<td>${row.cc != null ? formatNumber(row.cc) : '-'}</td>`);
            tr.append(`<td>${row.cs != null ? formatNumber(row.cs) : '-'}</td>`);
            tr.append(`<td>${row.http != null ? formatBytes(row.http, 2) : '-'}</td>`);
            tr.append(`<td>${row.https != null ? formatBytes(row.https, 2) : '-'}</td>`);
            tr.append(`<td>${row.ftp != null ? formatBytes(row.ftp, 2) : '-'}</td>`);
            tr.append(`<td>${formatInterfaceMbps(row.interface_mbps)}</td>`);
            $tbody.append(tr);
        });

        $('#ruHistoryCount').text(`총 ${data.length}건의 데이터가 조회되었습니다.`);
        $('#ruHistoryResults').show();

        // Draw chart if data exists
        if (data.length > 0) {
            drawHistoryChart(data);
        }
    }

    // Draw history chart
    function drawHistoryChart(data) {
        if (!window.ApexCharts) return;

        const proxyMap = {};
        (history.proxies || []).forEach(p => { proxyMap[p.id] = p.host; });

        // Group data by proxy
        const byProxy = {};
        data.forEach(row => {
            if (!byProxy[row.proxy_id]) {
                byProxy[row.proxy_id] = [];
            }
            byProxy[row.proxy_id].push(row);
        });

        // Prepare series for CPU and MEM
        const cpuSeries = [];
        const memSeries = [];

        Object.keys(byProxy).forEach(proxyId => {
            const rows = byProxy[proxyId].sort((a, b) => 
                new Date(a.collected_at) - new Date(b.collected_at)
            );
            const proxyName = proxyMap[proxyId] || `#${proxyId}`;
            
            const cpuData = rows.map(r => ({
                x: new Date(r.collected_at).getTime(),
                y: r.cpu != null ? r.cpu : null
            }));
            
            const memData = rows.map(r => ({
                x: new Date(r.collected_at).getTime(),
                y: r.mem != null ? r.mem : null
            }));

            cpuSeries.push({ name: `${proxyName} - CPU`, data: cpuData });
            memSeries.push({ name: `${proxyName} - MEM`, data: memData });
        });

        const chartEl = document.getElementById('ruHistoryChart');
        if (!chartEl) return;

        // Destroy existing chart
        if (history.chart) {
            history.chart.destroy();
        }

        // Create tabs for CPU and MEM
        const $chartWrap = $('#ruHistoryChartWrap');
        if (!$chartWrap.find('.tabs').length) {
            $chartWrap.prepend(`
                <div class="tabs is-boxed">
                    <ul>
                        <li class="is-active" data-tab="cpu"><a>CPU</a></li>
                        <li data-tab="mem"><a>MEM</a></li>
                    </ul>
                </div>
                <div id="ruHistoryChartContainer" style="margin-top: 10px;"></div>
            `);
            
            $chartWrap.find('.tabs li').on('click', function() {
                const tab = $(this).data('tab');
                $chartWrap.find('.tabs li').removeClass('is-active');
                $(this).addClass('is-active');
                renderHistoryChartTab(tab === 'cpu' ? cpuSeries : memSeries, tab);
            });
        }

        const $container = $('#ruHistoryChartContainer');
        $container.empty();
        const newChartEl = document.createElement('div');
        newChartEl.id = 'ruHistoryChartInner';
        newChartEl.style.width = '100%';
        newChartEl.style.height = '400px';
        $container.append(newChartEl);

        renderHistoryChartTab(cpuSeries, 'cpu');
        $('#ruHistoryChartWrap').show();
    }

    function renderHistoryChartTab(series, metric) {
        const chartEl = document.getElementById('ruHistoryChartInner');
        if (!chartEl || !window.ApexCharts) return;

        if (history.chart) {
            history.chart.destroy();
        }

        history.chart = new ApexCharts(chartEl, {
            chart: {
                type: 'line',
                height: 400,
                animations: { enabled: false },
                toolbar: { show: true }
            },
            series: series,
            stroke: { width: 2, curve: 'straight' },
            markers: { size: 3 },
            xaxis: {
                type: 'datetime',
                labels: { datetimeUTC: false }
            },
            yaxis: {
                title: { text: metric === 'cpu' ? 'CPU (%)' : 'MEM (%)' },
                decimalsInFloat: 1
            },
            tooltip: {
                shared: true,
                x: { format: 'yyyy-MM-dd HH:mm:ss' },
                y: {
                    formatter: function(val) {
                        return val != null ? val.toFixed(2) + '%' : 'N/A';
                    }
                }
            },
            legend: { show: true }
        });

        history.chart.render();
    }

    // Event handlers
    $('#ruHistorySearchBtn').on('click', searchHistory);

    // Load proxies on page load
    function loadProxies() {
        return $.getJSON('/api/proxies').then(function(proxies) {
            history.proxies = (proxies || []).filter(function(p) { return p.is_active; });
            initHistoryProxySelect();
            setDefaultTimeRange();
        }).catch(function(err) {
            console.error('Failed to load proxies:', err);
            $('#ruHistoryError').text('프록시 목록을 불러오는데 실패했습니다.').show();
        });
    }

    // Initialize when page loads
    loadProxies();
});
