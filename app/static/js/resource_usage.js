/**
 * Resource Usage 메인 모듈
 * 초기화 및 이벤트 바인딩
 */
$(document).ready(function() {
    const ru = window.ru;
    const state = window.ResourceUsageState;
    const polling = window.ResourceUsagePolling;
    const charts = window.ResourceUsageCharts;
    const heatmap = window.ResourceUsageHeatmap;

    // 초기화: 범례 및 버퍼 상태 로드
    ru.legendState = state.loadLegendState();
    ru.tsBuffer = state.loadBufferState();
    
    // 히트맵 상태 복원 (설정 로드 후에 복원)
    let restoredHeatmapData = null;
    const heatmapState = state.loadHeatmapState();
    if (heatmapState) {
        ru.lastData = heatmapState.lastData || [];
        ru.heatmapMaxByMetric = heatmapState.maxByMetric || {};
        ru.lastCumulativeByProxy = heatmapState.lastCumulativeByProxy || {};
        restoredHeatmapData = ru.lastData.length > 0 ? ru.lastData : null;
    }
    
    // 차트 DOM 초기화
    charts.ensureApexChartsDom();

    // 이벤트 핸들러
    $('#ruStartBtn').on('click', function() { polling.startPolling(); });
    $('#ruStopBtn').on('click', function() { polling.stopPolling(); });
    
    $('#ruGroupSelect').on('change', function() {
        ru.lastCumulativeByProxy = {};
        ru.heatmapMaxByMetric = {}; // 그룹 변경 시 히트맵 스케일 리셋
        $('#ruTableBody').empty();
        state.saveState(undefined);
    });
    
    $('#ruProxySelect').on('change', function() { 
        // 프록시 선택 변경 시에는 스케일 유지 (같은 그룹 내에서 프록시만 변경)
        state.saveState(undefined); 
    });

    // 페이지 가시성 변경 처리 (탭 전환, 최소화 등)
    let lastVisibilityChange = Date.now();
    document.addEventListener('visibilitychange', function() {
        if (document.visibilityState === 'visible') {
            const timeSinceLastChange = Date.now() - lastVisibilityChange;
            // 30초 이상 경과 시 데이터 재동기화
            if (timeSinceLastChange > 30000) {
                polling.resyncDataOnPageReturn();
            }
        } else {
            lastVisibilityChange = Date.now();
        }
    });
    
    // 페이지 포커스 처리 (다른 탭/창에서 복귀 시)
    let lastFocusTime = Date.now();
    window.addEventListener('focus', function() {
        const timeSinceLastFocus = Date.now() - lastFocusTime;
        // 30초 이상 경과 시 데이터 재동기화
        if (timeSinceLastFocus > 30000 && ru.taskId) {
            polling.resyncDataOnPageReturn();
        }
        lastFocusTime = Date.now();
    });
    
    // 초기 빈 상태 표시
    $('#ruHeatmapWrap').hide();
    $('#ruEmptyState').show();
    
    // 초기화: DeviceSelector 및 설정 로드
    Promise.all([
        DeviceSelector.init({
            groupSelect: '#ruGroupSelect',
            proxySelect: '#ruProxySelect',
            selectAll: '#ruSelectAll',
            onData: function(data) {
                ru.groups = data.groups || [];
                ru.proxies = data.proxies || [];
            }
        }),
        state.loadConfig()
    ]).then(function() {
        return state.restoreState();
    }).then(function() {
        // 복원된 히트맵 데이터가 있으면 표시 (설정 로드 후)
        if (restoredHeatmapData && restoredHeatmapData.length > 0) {
            requestAnimationFrame(() => {
                heatmap.updateTable(restoredHeatmapData);
            });
        }
        
        // 복원 후 실행 상태 확인 및 처리
        try {
            const running = state.loadRunningState();
            // 백그라운드 작업 상태 확인
            if (window.ResourceUsageCollector && window.ResourceUsageCollector.taskId) {
                ru.taskId = window.ResourceUsageCollector.taskId;
                polling.setRunning(true);
                ru.intervalId = 'background';
                // 페이지 로드 시 수집이 실행 중이면 데이터 재동기화
                polling.resyncDataOnPageReturn();
            } else if (running) {
                // 프록시가 선택되어 있는지 확인
                if (state.getSelectedProxyIds().length === 0) { 
                    charts.renderAllCharts(); 
                    polling.setRunning(false); 
                } else { 
                    polling.startPolling(); 
                }
            } else { 
                charts.renderAllCharts(); 
            }
        } catch (e) { 
            charts.renderAllCharts(); 
        }
    });

    // 차트 관련 이벤트 핸들러
    $('#ruChartsWrap').on('click', '.ru-chart-zoom-btn', function(e) {
        e.stopPropagation();
        const metric = $(this).data('metric');
        if (metric) charts.openModal(metric);
    });
    
    $('#ruChartsWrap').on('click', '.ru-chart-toggle-btn', function(e) {
        e.stopPropagation();
        const metric = $(this).data('metric');
        if (metric) charts.toggleChart(metric);
    });
    
    $('#ruChartsWrap').on('click', '.ru-chart-panel .title', function() {
        const metric = $(this).data('metric');
        if (metric) charts.toggleChart(metric);
    });
    
    $('#ruChartHeightSlider').on('input', function() {
        const newHeight = parseInt($(this).val(), 10);
        charts.updateChartHeight(newHeight);
    });
    
    let allExpanded = false;
    $('#ruToggleAllCharts').on('click', function() {
        allExpanded = !allExpanded;
        charts.toggleAllCharts(allExpanded);
        $(this).text(allExpanded ? '전체 접기' : '전체 펼치기');
    });

    // 모달 닫기 이벤트
    $('#ruChartModal').find('.modal-background, .delete').on('click', function() {
        charts.closeModal();
    });
});
