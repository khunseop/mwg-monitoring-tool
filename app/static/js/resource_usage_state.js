/**
 * Resource Usage 상태 관리 모듈
 * 전역 상태 객체 및 localStorage 관리
 */
(function(window) {
    'use strict';

    const STORAGE_KEY = 'ru_state_v1';
    const LEGEND_STORAGE_KEY = 'ru_legend_v1';
    const BUFFER_STORAGE_KEY = 'ru_buffer_v1';
    const RUN_STORAGE_KEY = 'ru_running_v1';

    const ResourceUsageState = {
        /**
         * 전역 상태 객체 초기화
         */
        ru: {
            intervalId: null,
            taskId: null, // 백그라운드 작업 ID
            lastCumulativeByProxy: {},
            proxies: [],
            groups: [],
            charts: {}, // { [metricKey]: ApexChartsInstance }
            seriesMap: {}, // { [metricKey]: proxyId[] in series order }
            chartDpr: (window.devicePixelRatio || 1),
            // timeseries buffer: { [proxyId]: { metricKey: [{x:ms, y:number}] } }
            tsBuffer: {},
            bufferWindowMs: 60 * 60 * 1000, // last 1 hour
            bufferMaxPoints: 600,
            timeBucketMs: 1000, // quantize to seconds to align x-axis across proxies
            legendState: {}, // { [metricKey]: { [proxyId]: hiddenBoolean } }
            _wsHandlerAdded: false, // 웹소켓 핸들러 추가 여부
            lastData: [], // 최신 데이터 저장
            cachedConfig: null // 캐시된 설정
        },

        /**
         * 상태 저장
         * @param {Array} itemsForSave - 저장할 아이템 배열
         */
        saveState(itemsForSave) {
            try {
                const state = {
                    groupId: $('#ruGroupSelect').val() || '',
                    proxyIds: this.getSelectedProxyIds(),
                    items: Array.isArray(itemsForSave) ? itemsForSave : undefined,
                    savedAt: Date.now()
                };
                localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
            } catch (e) { /* ignore */ }
        },

        /**
         * 상태 복원
         * @returns {Promise} 복원 완료 Promise
         */
        restoreState() {
            try {
                const raw = localStorage.getItem(STORAGE_KEY);
                if (!raw) return Promise.resolve();
                const state = JSON.parse(raw);
                if (state.groupId !== undefined) {
                    const groupEl = document.getElementById('ruGroupSelect');
                    const gtom = groupEl && groupEl._tom ? groupEl._tom : null;
                    if (gtom) { gtom.setValue(state.groupId || '', true); }
                    else {
                        $('#ruGroupSelect').val(state.groupId);
                        $('#ruGroupSelect').trigger('change');
                    }
                }
                let proxyAppliedPromise = Promise.resolve();
                if (Array.isArray(state.proxyIds)) {
                    const strIds = state.proxyIds.map(id => String(id));
                    proxyAppliedPromise = new Promise(resolve => {
                        const applyProxySelection = function() {
                            const proxyEl = document.getElementById('ruProxySelect');
                            const ptom = proxyEl && proxyEl._tom ? proxyEl._tom : null;
                            if (ptom) { ptom.setValue(strIds, true); }
                            else {
                                $('#ruProxySelect option').each(function() {
                                    $(this).prop('selected', strIds.includes($(this).val()));
                                });
                                $('#ruProxySelect').trigger('change');
                            }
                            resolve();
                        };
                        // Defer to allow DeviceSelector's group change to populate proxies first
                        setTimeout(applyProxySelection, 0);
                    });
                }
                return proxyAppliedPromise;
            } catch (e) { return Promise.resolve(); }
        },

        /**
         * 선택된 프록시 ID 배열 반환
         * @returns {Array<number>} 프록시 ID 배열
         */
        getSelectedProxyIds() {
            return ($('#ruProxySelect').val() || []).map(v => parseInt(v, 10));
        },

        /**
         * 설정 로드
         * @returns {Promise} 설정 로드 Promise
         */
        loadConfig() {
            return $.getJSON('/api/resource-config').then(cfg => {
                this.ru.cachedConfig = cfg;
            });
        },

        /**
         * 범례 상태 로드
         * @returns {Object} 범례 상태 객체
         */
        loadLegendState() {
            try {
                const raw = localStorage.getItem(LEGEND_STORAGE_KEY);
                if (!raw) return {};
                const obj = JSON.parse(raw);
                return (obj && typeof obj === 'object') ? obj : {};
            } catch (e) { return {}; }
        },

        /**
         * 범례 상태 저장
         */
        saveLegendState() {
            try {
                localStorage.setItem(LEGEND_STORAGE_KEY, JSON.stringify(this.ru.legendState || {}));
            } catch (e) { /* ignore */ }
        },

        /**
         * 버퍼 상태 로드
         * @returns {Object} 버퍼 상태 객체
         */
        loadBufferState() {
            try {
                const raw = localStorage.getItem(BUFFER_STORAGE_KEY);
                if (!raw) return {};
                const obj = JSON.parse(raw);
                if (!obj || typeof obj !== 'object') return {};
                // sanitize to expected structure
                const out = {};
                Object.keys(obj).forEach(pid => {
                    const byMetric = obj[pid] || {};
                    out[pid] = { cpu: [], mem: [], cc: [], cs: [], http: [], https: [], ftp: [] };
                    // Process basic metrics
                    Object.keys(out[pid]).forEach(m => {
                        const arr = Array.isArray(byMetric[m]) ? byMetric[m] : [];
                        // keep within window and type-safe
                        out[pid][m] = arr.filter(p => p && typeof p.x === 'number' && typeof p.y === 'number');
                    });
                    // Process interface metrics (dynamic keys starting with if_)
                    Object.keys(byMetric).forEach(m => {
                        if (m.startsWith('if_') && !out[pid][m]) {
                            const arr = Array.isArray(byMetric[m]) ? byMetric[m] : [];
                            out[pid][m] = arr.filter(p => p && typeof p.x === 'number' && typeof p.y === 'number');
                        }
                    });
                });
                return out;
            } catch (e) { return {}; }
        },

        /**
         * 버퍼 상태 저장
         */
        saveBufferState() {
            try {
                const out = {};
                Object.keys(this.ru.tsBuffer || {}).forEach(pid => {
                    const byMetric = this.ru.tsBuffer[pid] || {};
                    out[pid] = {};
                    Object.keys(byMetric).forEach(m => {
                        const arr = Array.isArray(byMetric[m]) ? byMetric[m] : [];
                        // store a bounded slice to control size
                        const tail = arr.slice(-this.ru.bufferMaxPoints);
                        out[pid][m] = tail;
                    });
                });
                localStorage.setItem(BUFFER_STORAGE_KEY, JSON.stringify(out));
            } catch (e) { /* ignore */ }
        },

        /**
         * 실행 상태 저장
         * @param {boolean} running - 실행 중 여부
         */
        saveRunningState(running) {
            try {
                localStorage.setItem(RUN_STORAGE_KEY, running ? '1' : '0');
            } catch (e) { /* ignore */ }
        },

        /**
         * 실행 상태 로드
         * @returns {boolean} 실행 중 여부
         */
        loadRunningState() {
            try {
                return localStorage.getItem(RUN_STORAGE_KEY) === '1';
            } catch (e) { return false; }
        }
    };

    // 전역으로 노출
    window.ru = ResourceUsageState.ru;
    window.ResourceUsageState = ResourceUsageState;
})(window);
