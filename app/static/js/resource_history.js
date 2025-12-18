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
        gridApi: null
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
        if (!interfaceMbps || typeof interfaceMbps !== 'object') return '-';
        const parts = [];
        Object.keys(interfaceMbps).forEach(ifName => {
            const ifData = interfaceMbps[ifName];
            if (ifData && typeof ifData === 'object') {
                const name = ifName.length > 20 ? ifName.substring(0, 17) + '...' : ifName;
                const inMbps = typeof ifData.in_mbps === 'number' ? ifData.in_mbps.toFixed(2) : '0.00';
                const outMbps = typeof ifData.out_mbps === 'number' ? ifData.out_mbps.toFixed(2) : '0.00';
                parts.push(`${name}: ${inMbps}/${outMbps}`);
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
        const proxyId = $('#ruHistoryProxySelect').val();
        const startTime = $('#ruHistoryStartTime').val();
        const endTime = $('#ruHistoryEndTime').val();
        const limit = parseInt($('#ruHistoryLimit').val(), 10) || 500;
        
        history.currentPage = 1;
        history.pageSize = limit;

        const params = {
            limit: limit,
            offset: 0
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

        loadHistoryData(params);
    }
    
    // Load all history (no date filter)
    function loadAllHistory() {
        const proxyId = $('#ruHistoryProxySelect').val();
        const limit = parseInt($('#ruHistoryLimit').val(), 10) || 500;
        
        history.currentPage = 1;
        history.pageSize = limit;

        const params = {
            limit: limit,
            offset: 0
        };

        if (proxyId) {
            params.proxy_id = parseInt(proxyId, 10);
        }

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

    // Display history results
    function displayHistoryResults(data, append = false) {
        const proxyMap = {};
        (history.proxies || []).forEach(p => { proxyMap[p.id] = p.host; });

        // 데이터 변환 (ag-grid 형식으로)
        const rowData = data.map(row => ({
            collected_at: row.collected_at,
            proxy_name: proxyMap[row.proxy_id] || `#${row.proxy_id}`,
            cpu: row.cpu,
            mem: row.mem,
            cc: row.cc,
            cs: row.cs,
            http: row.http,
            https: row.https,
            ftp: row.ftp,
            interface_mbps: row.interface_mbps
        }));

        // ag-grid 초기화 또는 업데이트
        const gridDiv = document.querySelector('#ruHistoryTableGrid');
        if (gridDiv && window.agGrid) {
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
                    enableFilter: true,
                    enableSorting: true,
                    animateRows: false,
                    suppressRowClickSelection: false,
                    headerHeight: 50,
                    overlayNoRowsTemplate: '<div style="padding: 20px; text-align: center; color: var(--color-text-muted);">조회된 데이터가 없습니다.</div>',
                    onGridReady: function(params) {
                        history.gridApi = params.api;
                        // 컬럼 너비 자동 조절
                        setTimeout(function() {
                            if (history.gridApi) {
                                const allColumnIds = [];
                                history.gridApi.getColumns().forEach(function(column) {
                                    allColumnIds.push(column.getColId());
                                });
                                if (history.gridApi.autoSizeColumns) {
                                    history.gridApi.autoSizeColumns(allColumnIds, { skipHeader: false });
                                } else if (history.gridApi.sizeColumnsToFit) {
                                    history.gridApi.sizeColumnsToFit();
                                }
                            }
                        }, 200);
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
        const proxyId = $('#ruHistoryProxySelect').val();
        const params = proxyId ? { proxy_id: parseInt(proxyId, 10) } : {};
        
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
        const proxyId = $('#ruHistoryProxySelect').val();
        const startTime = $('#ruHistoryStartTime').val();
        const endTime = $('#ruHistoryEndTime').val();
        
        const params = {};
        if (proxyId) {
            params.proxy_id = parseInt(proxyId, 10);
        }
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

    // Event handlers
    $('#ruHistorySearchBtn').on('click', searchHistory);
    $('#ruHistoryLoadAllBtn').on('click', loadAllHistory);
    $('#ruHistoryExportBtn').on('click', exportHistory);
    $('#ruHistoryDeleteBtn').on('click', function() {
        initDeleteProxySelect();
        $('#ruHistoryDeleteModal').addClass('is-active');
    });
    
    $('#ruHistoryDeleteModal').find('input[name="deleteOption"]').on('change', function() {
        const option = $(this).val();
        $('#ruDeleteOlderThan').toggle(option === 'older');
        $('#ruDeleteRange').toggle(option === 'range');
    });
    
    $('#ruHistoryDeleteConfirmBtn').on('click', deleteHistory);
    $('#ruHistoryDeleteCancelBtn, #ruHistoryDeleteModal .delete, #ruHistoryDeleteModal .modal-background').on('click', function() {
        $('#ruHistoryDeleteModal').removeClass('is-active');
    });
    
    $('#ruHistoryPrevBtn').on('click', function() {
        if (!$(this).hasClass('is-disabled')) {
            loadPrevPage();
        }
    });
    $('#ruHistoryNextBtn').on('click', function() {
        if (!$(this).hasClass('is-disabled')) {
            loadNextPage();
        }
    });
    
    // Load statistics when proxy selection changes
    $('#ruHistoryProxySelect').on('change', loadStatistics);

    // Load proxies on page load
    function loadProxies() {
        return $.getJSON('/api/proxies').then(function(proxies) {
            history.proxies = (proxies || []).filter(function(p) { return p.is_active; });
            initHistoryProxySelect();
            initDeleteProxySelect();
            loadStatistics(); // Load statistics on page load
        }).catch(function(err) {
            console.error('Failed to load proxies:', err);
            $('#ruHistoryError').text('프록시 목록을 불러오는데 실패했습니다.').show();
        });
    }

    // Initialize when page loads
    loadProxies();
});
