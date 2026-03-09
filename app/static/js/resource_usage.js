/**
 * Resource Usage 메인 모듈
 * 초기화 및 이벤트 바인딩
 */
(function(window) {
    'use strict';

    function initResourceUsage() {
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
        
        // 초기 빈 상태 표시
        $('#ruHeatmapWrap').hide();
        $('#ruEmptyState').show();

        // 이벤트 핸들러 (중복 바인딩 방지)
        $('#ruToggleBtn').off('click').on('click', function() {
            if (ru.intervalId) {
                polling.stopPolling();
            } else {
                polling.startPolling();
            }
        });
        
        $('#ruGroupSelect').off('change').on('change', function() {
            ru.lastCumulativeByProxy = {};
            ru.heatmapMaxByMetric = {}; // 그룹 변경 시 히트맵 스케일 리셋
            $('#ruTableBody').empty();
            state.saveState(undefined);
        });
        
        $('#ruProxySelect').off('change').on('change', function() { 
            // 프록시 선택 변경 시에는 스케일 유지 (같은 그룹 내에서 프록시만 변경)
            state.saveState(undefined); 
        });

        // 초기화: DeviceSelector 및 설정 로드
        Promise.all([
            window.DeviceSelector.init({
                groupSelect: '#ruGroupSelect',
                proxySelect: '#ruProxySelect',
                proxyTrigger: '#ruProxyTrigger',
                selectAll: '#ruSelectAll',
                selectionCounter: '#ruSelectionCounter',
                storageKey: 'ru_state', // ResourceUsageState에서 사용하는 키와 맞춤
                onData: function(data) {
                    ru.groups = data.groups || [];
                    ru.proxies = data.proxies || [];
                }
            }),
            state.loadConfig()
        ])
        .then(function() {
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
                    // 페이지별 콜백 등록
                    polling.registerPageCallback();
                    // 페이지 로드 시 수집이 실행 중이면 데이터 재동기화
                    polling.resyncDataOnPageReturn();
                } else if (running) {
                    // 프록시가 선택되어 있는지 확인
                    if (state.getSelectedProxyIds().length === 0) { 
                        polling.setRunning(false); 
                    } else { 
                        polling.startPolling(); 
                    }
                }
            } catch (e) { 
                console.error('State restoration failed:', e);
            }
        });
    }

    // 초기화
    $(document).ready(() => {
        initResourceUsage();
    });

    // PJAX 지원
    $(document).off('pjax:complete.ru').on('pjax:complete.ru', function(e, url) {
        if (url.includes('/resource') || url === '/') {
            initResourceUsage();
        }
    });

    // 페이지 가시성 변경 처리 (한 번만 등록)
    if (!window._ruGlobalEventsBound) {
        let lastVisibilityChange = Date.now();
        document.addEventListener('visibilitychange', function() {
            if (document.visibilityState === 'visible') {
                const timeSinceLastChange = Date.now() - lastVisibilityChange;
                // 30초 이상 경과 시 데이터 재동기화
                if (timeSinceLastChange > 30000 && window.ru && window.ru.taskId) {
                    window.ResourceUsagePolling.resyncDataOnPageReturn();
                }
            } else {
                lastVisibilityChange = Date.now();
            }
        });
        
        let lastFocusTime = Date.now();
        window.addEventListener('focus', function() {
            const timeSinceLastFocus = Date.now() - lastFocusTime;
            if (timeSinceLastFocus > 30000 && window.ru && window.ru.taskId) {
                window.ResourceUsagePolling.resyncDataOnPageReturn();
            }
            lastFocusTime = Date.now();
        });

        window.addEventListener('resize', function() {
            if (window._ruResizeTimeout) clearTimeout(window._ruResizeTimeout);
            window._ruResizeTimeout = setTimeout(function() {
                if (window.ru && window.ru.apex && typeof window.ru.apex.resize === 'function') {
                    window.ru.apex.resize();
                }
            }, 250);
        });

        window._ruGlobalEventsBound = true;
    }

})(window);
