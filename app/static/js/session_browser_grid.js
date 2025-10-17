document.addEventListener('DOMContentLoaded', function () {
    const gridDiv = document.querySelector('#sessionBrowserGrid');
    const gridOptions = {
        columnDefs: [
            { field: "host", headerName: "프록시", sortable: true, filter: true },
            { field: "creation_time", headerName: "생성시각", sortable: true, filter: true, valueFormatter: params => params.value ? new Date(params.value).toLocaleString() : '' },
            { field: "protocol", headerName: "프로토콜", sortable: true, filter: true },
            { field: "user_name", headerName: "사용자", sortable: true, filter: true },
            { field: "client_ip", headerName: "클라이언트 IP", sortable: true, filter: true },
            { field: "server_ip", headerName: "서버 IP", sortable: true, filter: true },
            { field: "cl_bytes_received", headerName: "CL 수신", sortable: true, filter: 'agNumberColumnFilter', valueFormatter: params => (window.AppUtils && AppUtils.formatBytes) ? AppUtils.formatBytes(params.value) : params.value },
            { field: "cl_bytes_sent", headerName: "CL 송신", sortable: true, filter: 'agNumberColumnFilter', valueFormatter: params => (window.AppUtils && AppUtils.formatBytes) ? AppUtils.formatBytes(params.value) : params.value },
            { field: "age_seconds", headerName: "Age(s)", sortable: true, filter: 'agNumberColumnFilter' },
            { field: "url", headerName: "URL", sortable: true, filter: true }
        ],
        defaultColDef: {
            resizable: true,
            sortable: true,
            filter: true,
            floatingFilter: true, // Add floating filters for easier use
        },
        rowModelType: 'infinite',
        datasource: null, // Will be set later
        cacheBlockSize: 100,
        maxBlocksInCache: 10,
        getRowId: params => params.data.id, // Crucial for infinite row model
        onCellClicked: params => {
            if (params.data && params.data.id) {
                // Fetch full row from backend to avoid relying on client cache
                $.getJSON(`/api/session-browser/item/${params.data.id}`)
                    .done(function(item){
                        fillDetailModal(item || {});
                        openSbModal();
                    })
                    .fail(function(){
                        // Assuming a global `showErr` function exists
                        if(window.showErr) showErr('상세를 불러오지 못했습니다.');
                    });
            }
        }
    };

    new agGrid.Grid(gridDiv, gridOptions);

    function createDatasource(proxyIds, force) {
        return {
            getRows: function (params) {
                const { startRow, endRow, sortModel, filterModel } = params;
                // The 'force' parameter is now part of the main request body
                // It tells the backend whether to re-collect from devices or just serve from cache
                 fetch('/api/session-browser/data', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        startRow,
                        endRow,
                        sortModel,
                        filterModel,
                        proxy_ids: proxyIds,
                        force: force // Pass the force flag here
                    })
                })
                .then(response => response.json())
                .then(data => {
                    if (data.error) {
                        params.failCallback();
                        if(window.showErr) showErr(data.error);
                    } else {
                        params.successCallback(data.rows, data.lastRow);
                    }
                })
                .catch(() => {
                    params.failCallback();
                    if(window.showErr) showErr('데이터를 불러오는데 실패했습니다.');
                });
            }
        };
    }

    // API for other scripts to interact with the grid
    window.sessionBrowserGrid = {
        gridOptions,
        loadData: function(proxyIds, force = false) {
             if (!gridOptions.api) {
                 console.error("AG-Grid API not available.");
                 return;
             }
             // When loading new data (e.g., after collect or proxy change),
             // we create a new datasource and set it.
             const datasource = createDatasource(proxyIds, force);
             gridOptions.api.setDatasource(datasource);
        }
    };
});