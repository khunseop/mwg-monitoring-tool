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
        $('#ruCopyBtn').off('click').on('click', function() {
            heatmap.copyCurrentValues();
        });
        
        $('#ruGroupSelect').off('change').on('change', function() {
            ru.lastCumulativeByProxy = {};
            ru.heatmapMaxByMetric = {};
            ru.lastData = [];
            state.saveState(undefined);
            // 그룹 변경 후 DeviceSelector가 프록시 목록을 갱신하면 skeleton 표시
            setTimeout(() => { heatmap.showSkeleton(); if (window.updateRuSelectionSummary) updateRuSelectionSummary(); }, 150);
        });

        $('#ruProxySelect').off('change').on('change', function() {
            state.saveState(undefined);
            heatmap.showSkeleton();
            if (window.updateRuSelectionSummary) updateRuSelectionSummary();
        });

        $('#ruHeatmapHeightSlider').off('input').on('input', function() {
            if (ru.apex && ru.lastData && ru.lastData.length > 0) {
                heatmap.updateTable(ru.lastData);
            }
        });

        // 초기화: DeviceSelector 및 설정 로드
        Promise.all([
            window.DeviceSelector.init({
                groupSelect: '#ruGroupSelect',
                proxySelect: '#ruProxySelect',
                proxyTrigger: '#ruProxyTrigger',
                deselectBtn: '#ruDeselectAllBtn',
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
            // 선택 필터 요약 초기 표시
            if (window.updateRuSelectionSummary) updateRuSelectionSummary();
            
            // 수집 상태 확인: 서버에서 이미 수집 중이면 콜백 등록 및 데이터 동기화
            try {
                if (window.ResourceUsageCollector && window.ResourceUsageCollector.taskId) {
                    ru.taskId = window.ResourceUsageCollector.taskId;
                    ru.intervalId = 'background';
                    polling.registerPageCallback();
                    polling.resyncDataOnPageReturn();
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
