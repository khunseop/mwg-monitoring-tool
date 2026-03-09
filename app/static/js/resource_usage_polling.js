/**
 * Resource Usage 폴링/백그라운드 작업 모듈
 * 데이터 수집 시작/중지 및 동기화 로직
 */
(function(window) {
    'use strict';

    const ResourceUsagePolling = {
        /**
         * 최신 데이터 가져오기
         * @param {Array<number>} proxyIds - 프록시 ID 배열
         * @returns {Promise<Array>} 데이터 배열
         */
        fetchLatestForProxies(proxyIds) {
            const reqs = (proxyIds || []).map(id => $.getJSON(`/api/resource-usage/latest/${id}`).catch(() => null));
            return Promise.all(reqs).then(rows => rows.filter(r => r && r.id));
        },

        /**
         * 폴링 시작 (백그라운드 작업 시작)
         */
        async startPolling() {
            const ru = window.ru;
            const state = window.ResourceUsageState;
            const charts = window.ResourceUsageCharts;
            const heatmap = window.ResourceUsageHeatmap;
            
            if (ru.intervalId) return;
            
            const proxyIds = state.getSelectedProxyIds();
            if (proxyIds.length === 0) { 
                this.showRuError('프록시를 하나 이상 선택하세요.'); 
                return; 
            }
            
            const community = (ru.cachedConfig && ru.cachedConfig.community) ? ru.cachedConfig.community.toString() : 'public';
            const oids = (ru.cachedConfig && ru.cachedConfig.oids) ? ru.cachedConfig.oids : {};
            if (Object.keys(oids).length === 0) { 
                this.showRuError('설정된 OID가 없습니다. 설정 페이지를 확인하세요.'); 
                return; 
            }
            
            const intervalSec = parseInt($('#ruIntervalSec').val(), 10) || 60;
            
            try {
                // 백그라운드 수집 시작
                const response = await $.ajax({
                    url: '/api/resource-usage/background/start',
                    method: 'POST',
                    contentType: 'application/json',
                    data: JSON.stringify({
                        proxy_ids: proxyIds,
                        community: community,
                        oids: oids,
                        interval_sec: intervalSec
                    })
                });
                
                ru.taskId = response.task_id;
                this.setRunning(true);
                ru.intervalId = 'background'; // 백그라운드 작업 표시
                
                // 전역 상태도 업데이트
                if (window.ResourceUsageCollector) {
                    window.ResourceUsageCollector.setCollecting(true);
                    window.ResourceUsageCollector.taskId = response.task_id;
                }
                
                // 자원사용률 페이지에서만 콜백 등록
                this.registerPageCallback();
            } catch (error) {
                console.error('[resource_usage] Failed to start background collection:', error);
                this.showRuError('백그라운드 수집 시작에 실패했습니다.');
            }
        },

        /**
         * 폴링 중지 (백그라운드 작업 중지)
         */
        async stopPolling() {
            const ru = window.ru;
            if (!ru.taskId) {
                ru.intervalId = null;
                this.setRunning(false);
                return;
            }
            
            const taskIdToStop = ru.taskId;
            
            try {
                await $.ajax({
                    url: '/api/resource-usage/background/stop',
                    method: 'POST',
                    contentType: 'application/json',
                    data: JSON.stringify({ task_id: taskIdToStop })
                });
                
                ru.taskId = null;
                ru.intervalId = null;
                this.setRunning(false);
                
                // 전역 상태도 업데이트
                if (window.ResourceUsageCollector) {
                    window.ResourceUsageCollector.setCollecting(false);
                    window.ResourceUsageCollector.taskId = null;
                }
            } catch (error) {
                console.error('[resource_usage] Failed to stop background collection:', error);
                // 에러가 나도 로컬 상태는 업데이트
                ru.taskId = null;
                ru.intervalId = null;
                this.setRunning(false);
                
                if (window.ResourceUsageCollector) {
                    window.ResourceUsageCollector.setCollecting(false);
                    window.ResourceUsageCollector.taskId = null;
                }
            }
        },

        /**
         * 페이지 복귀 시 데이터 재동기화
         */
        async resyncDataOnPageReturn() {
            const ru = window.ru;
            const state = window.ResourceUsageState;
            const charts = window.ResourceUsageCharts;
            const heatmap = window.ResourceUsageHeatmap;
            
            // If collection is running, fetch latest data and resync
            if (ru.taskId && ru.intervalId === 'background') {
                const proxyIds = state.getSelectedProxyIds();
                if (proxyIds.length > 0) {
                    try {
                        const latestRows = await this.fetchLatestForProxies(proxyIds);
                        const valid = (latestRows || []).filter(r => r && r.proxy_id && r.collected_at);
                        if (valid.length > 0) {
                            // Reset cache before updating to prevent wrong deltas
                            ru.lastCumulativeByProxy = {};
                            // Update heatmap with fresh data
                            requestAnimationFrame(() => {
                                heatmap.updateTable(valid);
                            });
                        }
                    } catch (e) {
                        console.warn('[resource_usage] Failed to resync data on page return:', e);
                    }
                }
            }
        },

        /**
         * 에러 메시지 표시
         * @param {string} msg - 에러 메시지
         */
        showRuError(msg) {
            $('#ruError').text(msg).show();
        },

        /**
         * 에러 메시지 지우기
         */
        clearRuError() {
            $('#ruError').hide().text('');
        },

        /**
         * 실행 상태 설정
         * @param {boolean} running - 실행 중 여부
         */
        setRunning(running) {
            const state = window.ResourceUsageState;
            const $toggleBtn = $('#ruToggleBtn');
            if (running) {
                $toggleBtn.removeClass('is-primary').addClass('is-danger').text('중지');
                $('#ruIntervalSec').attr('disabled', true);
            } else {
                $toggleBtn.removeClass('is-danger').addClass('is-primary').text('시작');
                $('#ruIntervalSec').attr('disabled', false);
            }
            state.saveRunningState(running);
        },

        /**
         * 페이지별 콜백 등록 (자원사용률 페이지에서만 호출)
         */
        registerPageCallback() {
            const ru = window.ru;
            const state = window.ResourceUsageState;
            const charts = window.ResourceUsageCharts;
            const heatmap = window.ResourceUsageHeatmap;
            
            if (!window.ResourceUsageCollector) return;
            
            // 웹소켓을 통해 수집 완료 시 데이터 갱신 핸들러 등록
            const self = this;
            window.ResourceUsagePolling.onCollectionComplete = function(taskId, data) {
                if (taskId === ru.taskId) {
                    const currentProxyIds = state.getSelectedProxyIds();
                    self.fetchLatestForProxies(currentProxyIds).then(latestRows => {
                        const valid = (latestRows || []).filter(r => r && r.proxy_id && r.collected_at);
                        if (valid.length > 0) {
                            // 히트맵 업데이트 (백엔드에서 계산된 Mbps 사용)
                            requestAnimationFrame(() => {
                                heatmap.updateTable(valid);
                            });
                        }
                    }).catch(() => {});
                }
            };
        }
    };

    // 전역으로 노출 (웹소켓 핸들러에서 접근 가능하도록)
    window.ResourceUsagePolling = ResourceUsagePolling;
    window.setRunning = ResourceUsagePolling.setRunning.bind(ResourceUsagePolling);
})(window);
