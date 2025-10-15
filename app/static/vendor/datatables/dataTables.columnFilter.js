/**
 * DataTables Column Filter Plugin
 * Adds individual column search inputs in header
 */
(function($) {
    'use strict';

    /**
     * Initialize column filters for a DataTable
     * @param {DataTable} dt - DataTable instance
     * @param {Object} options - Configuration options
     * @param {Array} options.columns - Array of column configs, each with { enabled: true/false, type: 'text'/'select'/null }
     */
    $.fn.dataTable.ColumnFilter = function(dt, options) {
        options = options || {};
        var columns = options.columns || [];
        
        // Default: enable text filter for all searchable columns
        dt.columns().every(function(idx) {
            var column = this;
            var columnDef = columns[idx] || {};
            
            // Skip if explicitly disabled or column is not searchable
            if (columnDef.enabled === false || !column.header()) {
                return;
            }
            
            var settings = dt.settings()[0];
            var colSettings = settings.aoColumns[idx];
            if (colSettings && colSettings.bSearchable === false) {
                return;
            }
            
            var header = $(column.header());
            
            // Check if filter already exists
            if (header.find('.dt-column-filter-wrapper').length > 0) {
                return;
            }
            
            // Create filter wrapper
            var filterWrapper = $('<div class="dt-column-filter-wrapper"></div>');
            var input = $('<input type="text" class="input is-small dt-column-filter" placeholder="필터...">');
            
            // Prevent sorting when clicking on input
            input.on('click', function(e) {
                e.stopPropagation();
            });
            
            // Debounced search
            var searchTimeout;
            input.on('keyup change', function() {
                var val = this.value;
                
                clearTimeout(searchTimeout);
                searchTimeout = setTimeout(function() {
                    if (column.search() !== val) {
                        column.search(val).draw();
                    }
                }, 300);
            });
            
            filterWrapper.append(input);
            header.append(filterWrapper);
        });
        
        return dt;
    };
    
    // Alias for easier usage
    $.fn.DataTable.ColumnFilter = $.fn.dataTable.ColumnFilter;
    
})(jQuery);
