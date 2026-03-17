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
        proxies: [],
        groups: [],
        currentPage: 1,
        pageSize: 500,
        totalCount: 0,
        hasMore: false,
        gridApi: null,
        storageKey: 'ru_history_state'
    };

    // DeviceSelector 초기화
    function initDeviceSelector() {
        window.DeviceSelector.init({
            groupSelect: '#ruHistoryGroupSelect',
            proxySelect: '#ruHistoryProxySelect',
            proxyTrigger: '#ruHistoryProxyTrigger',
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

        history.currentPage = 1;
        history.pageSize = limit;

        const params = {
            limit: limit,
            offset: 0,
            proxy_ids: proxyIds.join(',') // 다중 프록시 조회를 위해 쉼표로 구분된 ID 목록 전달
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

        history.currentPage = 1;
        history.pageSize = limit;

        const params = {
            limit: limit,
            offset: 0,
            proxy_ids: proxyIds.join(',') // 다중 프록시 조회를 위해 쉼표로 구분된 ID 목록 전달
        };

        loadHistoryData(params);
    }
    
    // Load history data with pagination
    function loadHistoryData(params, append = false) {
        $('#ruHistoryLoading').show();
        $('#ruHistoryError').hide();
        if (!append) {
            $('#ruHistoryResults').hide();
        }

        $.ajax({
            url: '/api/resource-usage/history',
            method: 'GET',
            data: params
        }).then(data => {
            $('#ruHistoryLoading').hide();
            if (!data || data.length === 0) {
                if (!append) {
                    $('#ruHistoryError').text('조회된 데이터가 없습니다.').show();
                    $('#ruHistoryResults').hide();
                }
                return;
            }

            history.totalCount = data.length;
            history.hasMore = data.length === params.limit;
            displayHistoryResults(data, append);
        }).catch(err => {
            $('#ruHistoryLoading').hide();
            const errorMsg = err.responseJSON && err.responseJSON.detail 
                ? err.responseJSON.detail 
                : '이력 조회 중 오류가 발생했습니다.';
            $('#ruHistoryError').text(errorMsg).show();
        });
    }
    
    // Load next page
    function loadNextPage() {
        history.currentPage++;
        const proxyId = $('#ruHistoryProxySelect').val();
        const startTime = $('#ruHistoryStartTime').val();
        const endTime = $('#ruHistoryEndTime').val();
        const limit = history.pageSize;
        const offset = (history.currentPage - 1) * limit;

        const params = {
            limit: limit,
            offset: offset
        };

        if (startTime) {
            params.start_time = convertKSTToUTC(startTime);
        }
        if (endTime) {
            params.end_time = convertKSTToUTC(endTime);
        }
        if (proxyId) {
            params.proxy_id = parseInt(proxyId, 10);
        }

        loadHistoryData(params, false);
    }
    
    // Load previous page
    function loadPrevPage() {
        if (history.currentPage <= 1) return;
        
        history.currentPage--;
        const proxyId = $('#ruHistoryProxySelect').val();
        const startTime = $('#ruHistoryStartTime').val();
        const endTime = $('#ruHistoryEndTime').val();
        const limit = history.pageSize;
        const offset = (history.currentPage - 1) * limit;

        const params = {
            limit: limit,
            offset: offset
        };

        if (startTime) {
            params.start_time = convertKSTToUTC(startTime);
        }
        if (endTime) {
            params.end_time = convertKSTToUTC(endTime);
        }
        if (proxyId) {
            params.proxy_id = parseInt(proxyId, 10);
        }

        loadHistoryData(params, false);
    }

    function updateFilterCount() {
        if (!history.gridApi) return;
        try {
            var filterModel = history.gridApi.getFilterModel();
            var filterCount = 0;
            if (filterModel) {
                // 필터 모델에서 실제로 값이 있는 필터의 수를 계산
                for (var colId in filterModel) {
                    if (filterModel.hasOwnProperty(colId)) {
                        var filter = filterModel[colId];
                        // 필터가 있고 값이 있는지 확인
                        if (filter && typeof filter === 'object') {
                            // agTextColumnFilter의 경우 filter 속성 확인
                            if (filter.filter && String(filter.filter).trim() !== '') {
                                filterCount++;
                            }
                            // agNumberColumnFilter의 경우 filter, filterTo, filterTo 등 확인
                            else if (filter.filter !== undefined && filter.filter !== null && filter.filter !== '') {
                                filterCount++;
                            }
                            else if (filter.filterTo !== undefined && filter.filterTo !== null && filter.filterTo !== '') {
                                filterCount++;
                            }
                            else if (filter.type && filter.type !== 'equals') {
                                // 다른 필터 타입들
                                filterCount++;
                            }
                        }
                    }
                }
            }
            // resource_history.html에는 필터 수 표시 요소가 없을 수 있으므로, 콘솔에만 출력하거나 나중에 추가 가능
            // var $filterCount = $('#ruHistoryFilterCount');
            // if (filterCount > 0) {
            //     $filterCount.text('필터: ' + filterCount).show();
            // } else {
            //     $filterCount.hide();
            // }
        } catch (e) {
            console.error('Failed to update filter count:', e);
        }
    }

    // Display history results
    function displayHistoryResults(data, append = false) {
        const proxyMap = {};
        (history.proxies || []).forEach(p => { proxyMap[p.id] = p.host; });

        // 데이터 변환 (ag-grid 형식으로)
        const rowData = data.map(row => ({
            collected_at: row.collected_at,
            proxy_id: row.proxy_id,
            proxy_name: proxyMap[row.proxy_id] || `#${row.proxy_id}`,
            cpu: row.cpu,
            mem: row.mem,
            disk: row.disk,
            cc: row.cc,
            cs: row.cs,
            blocked: row.blocked,
            http: row.http,
            https: row.https,
            http2: row.http2,
            interface_mbps: row.interface_mbps
        }));

        // ag-grid 초기화 또는 업데이트
        const gridDiv = document.querySelector('#ruHistoryTableGrid');
        if (gridDiv && window.agGrid) {
            // PJAX 대응: 엘리먼트가 비어있으면 API 리셋
            if (gridDiv.innerHTML === "") {
                history.gridApi = null;
            }

            if (!history.gridApi) {
                // 초기화
                const gridOptions = {
                    columnDefs: window.AgGridConfig ? window.AgGridConfig.getResourceHistoryColumns() : [],
                    rowData: rowData,
                    defaultColDef: {
                        sortable: true,
                        filter: 'agTextColumnFilter',
                        filterParams: { applyButton: true, clearButton: true },
                        resizable: true,
                        minWidth: 100
                    },
                    rowModelType: 'clientSide',
                    pagination: true,
                    paginationPageSize: history.pageSize,
                    suppressPaginationPanel: true, // 커스텀 페이지네이션 사용
                    enableFilter: true,
                    enableSorting: true,
                    animateRows: false,
                    suppressRowClickSelection: true,
                    headerHeight: 40,
                    rowHeight: 35,
                    overlayNoRowsTemplate: '<div style="padding: 20px; text-align: center; color: var(--color-text-muted); font-size: 0.875rem;">조회된 데이터가 없습니다.</div>',
                    onGridReady: function(params) {
                        history.gridApi = params.api;
                        // 초기 로드 시 컬럼 너비 최적화
                        setTimeout(() => {
                            if (history.gridApi) history.gridApi.sizeColumnsToFit();
                        }, 100);
                        updateFilterCount();
                    },
                    onFilterChanged: function() {
                        updateFilterCount();
                    }
                };

                try {
                    if (typeof window.agGrid.createGrid === 'function') {
                        history.gridApi = window.agGrid.createGrid(gridDiv, gridOptions);
                    } else if (window.agGrid.Grid) {
                        history.gridApi = new window.agGrid.Grid(gridDiv, gridOptions);
                    }
                } catch (e) {
                    console.error('[ResourceHistory] ag-grid init failed:', e);
                }
            } else {
                // 데이터 업데이트
                history.gridApi.setGridOption('rowData', rowData);
            }
        } else {
            console.warn('[ResourceHistory] ag-grid not available or grid div not found');
        }

        const totalDisplayed = rowData.length;
        const pageInfo = `페이지 ${history.currentPage} (${totalDisplayed}건 표시)`;
        $('#ruHistoryCount').text(`총 ${totalDisplayed}건의 데이터가 표시됩니다.`);
        $('#ruHistoryPaginationInfo').text(pageInfo);
        
        // Show/hide pagination
        if (history.hasMore || history.currentPage > 1) {
            $('#ruHistoryPagination').show();
            $('#ruHistoryPrevBtn').toggleClass('is-disabled', history.currentPage <= 1);
            $('#ruHistoryNextBtn').toggleClass('is-disabled', !history.hasMore);
        } else {
            $('#ruHistoryPagination').hide();
        }
        
        $('#ruHistoryResults').show();
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
        
        $('#ruHistoryClearFiltersBtn').off('click').on('click', () => {
            if (history.gridApi) {
                history.gridApi.setFilterModel(null);
                // 필터 초기화 피드백
                const originalText = $('#ruHistoryClearFiltersBtn').text();
                $('#ruHistoryClearFiltersBtn').text('초기화 완료');
                setTimeout(() => $('#ruHistoryClearFiltersBtn').text(originalText), 1500);
            }
        });

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
        
        $('#ruHistoryPrevBtn').off('click').on('click', function() {
            if (!$(this).hasClass('is-disabled')) {
                loadPrevPage();
            }
        });
        $('#ruHistoryNextBtn').off('click').on('click', function() {
            if (!$(this).hasClass('is-disabled')) {
                loadNextPage();
            }
        });
        
        // Load statistics when proxy selection changes
        $('#ruHistoryProxySelect').off('change').on('change', loadStatistics);
    }

    // Initialize when page loads
    $(document).ready(() => {
        initResourceHistory();
    });

    // PJAX 페이지 전환 대응
    $(document).off('pjax:complete.rh').on('pjax:complete.rh', function(e, url) {
        if (url.includes('/resource/history')) {
            initResourceHistory();
        }
    });
});

// 전역 함수: 자원이력에서 로그조회로 바로가기
window.analyzeLogFromHistory = function(proxyId, collectedAt) {
    if (!proxyId || !collectedAt) return;
    
    try {
        // collectedAt format: ISO string (e.g., "2026-03-17T05:30:00Z" or "2026-03-17T14:30:00")
        const date = new Date(collectedAt);
        
        // MWG 로그 시간 포맷으로 변환 (e.g., "17/Mar/2026:14:30")
        const day = String(date.getDate()).padStart(2, '0');
        const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        const month = months[date.getMonth()];
        const year = date.getFullYear();
        const hours = String(date.getHours()).padStart(2, '0');
        const minutes = String(date.getMinutes()).padStart(2, '0');
        
        // 분 단위까지만 검색어로 사용하여 해당 시간대의 로그를 넓게 잡음
        const searchTime = `${day}/${month}/${year}:${hours}:${minutes}`;
        
        // 로그조회 페이지로 리다이렉트 (파라미터 전달)
        // limit을 5000으로 늘려 충분한 로그가 수집되도록 유도
        const url = `/traffic-logs?proxy_id=${proxyId}&q=${encodeURIComponent(searchTime)}&limit=5000`;
        
        // PJAX 환경 호환성 검사 및 네비게이션
        if (window.location.pathname !== '/traffic-logs') {
            const $item = $(`.navbar-item[href="/traffic-logs"]`);
            if ($item.length > 0) {
                // pjax 네비게이션 트리거
                $item.attr('href', url);
                $item.click();
                // 원래 url로 복구 (다음 클릭을 위해)
                setTimeout(() => $item.attr('href', '/traffic-logs'), 100);
            } else {
                window.location.href = url;
            }
        }
    } catch (e) {
        console.error("Failed to parse date for log analysis:", e);
    }
};

