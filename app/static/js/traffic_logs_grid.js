document.addEventListener('DOMContentLoaded', function () {
    const gridDiv = document.querySelector('#trafficLogsGrid');
    const gridOptions = {
        columnDefs: [], // Will be set dynamically
        defaultColDef: {
            resizable: true,
            sortable: true,
            filter: true,
            floatingFilter: true,
        },
        rowData: [],
        onCellClicked: params => {
            // Assuming a global function exists to handle the detail modal
            if (window.openTlModal && params.data) {
                window.openTlModal(params.data);
            }
        }
    };

    new agGrid.Grid(gridDiv, gridOptions);

    // API for other scripts to interact with the grid
    window.trafficLogsGrid = {
        gridOptions,
        updateData: function(headers, rows) {
            if (gridOptions.api) {
                const columnDefs = headers.map(header => ({
                    field: header,
                    headerName: header,
                }));
                // Add a special column for the raw log line for the detail view
                columnDefs.push({ field: '__raw', hide: true });

                gridOptions.api.setColumnDefs(columnDefs);
                gridOptions.api.setRowData(rows);
                gridDiv.style.display = 'block';
            }
        },
        clear: function() {
            if (gridOptions.api) {
                gridOptions.api.setRowData([]);
                gridDiv.style.display = 'none';
            }
        }
    };
});