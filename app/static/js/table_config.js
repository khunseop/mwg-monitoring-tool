(function(window){
	'use strict';

	function deepMerge(target, source){
		if(!source) return target || {};
		target = target || {};
		Object.keys(source).forEach(function(key){
			var s = source[key];
			if(s && typeof s === 'object' && !Array.isArray(s)){
				target[key] = deepMerge(target[key] || {}, s);
			} else {
				target[key] = s;
			}
		});
		return target;
	}

	var LANGUAGE_KO = {
		search: '검색:',
		lengthMenu: '_MENU_ 개씩 보기',
		info: '총 _TOTAL_건 중 _START_–_END_',
		infoEmpty: '표시할 항목 없음',
		zeroRecords: '일치하는 항목이 없습니다.',
		paginate: { first: '처음', last: '마지막', next: '다음', previous: '이전' }
	};

	var DEFAULTS = {
		processing: true,
		paging: true,
		searching: true,
		ordering: true,
		info: true,
		responsive: false,
		scrollX: true,
		scrollCollapse: true,
		orderCellsTop: true,
		pageLength: 25,
		lengthMenu: [[10, 25, 50, 100], [10, 25, 50, 100]],
		// Place length + filter in top row, info + pagination in bottom row (Bulma 'level' containers)
		dom: "<'dt-top level is-mobile is-align-items-center is-justify-content-space-between'lf>t<'dt-bottom level is-mobile is-align-items-center is-justify-content-space-between'ip>",
		language: LANGUAGE_KO
	};

	var TableConfig = {
		language: LANGUAGE_KO,
		defaults: DEFAULTS,
		mergeDefaults: function(options){
			options = options || {};
			var merged = deepMerge({}, DEFAULTS);
			merged = deepMerge(merged, options);
			// Ensure language keys fall back to Korean defaults
			merged.language = deepMerge({}, LANGUAGE_KO);
			if (options.language) merged.language = deepMerge(merged.language, options.language);
			return merged;
		},
		init: function(selectorOrElement, options){
			var opts = TableConfig.mergeDefaults(options);
			try{
				var useJquery = (window.jQuery && window.jQuery.fn && window.jQuery.fn.DataTable);
				if (!useJquery) {
					if (typeof window.DataTable === 'function'){
						var dt_vanilla = new window.DataTable(selectorOrElement, opts);
						setTimeout(function(){ TableConfig.applyBulmaStyles(dt_vanilla); }, 0);
						dt_vanilla.on('draw', function(){ TableConfig.applyBulmaStyles(dt_vanilla); });
						return dt_vanilla;
					}
					return null;
				}

				var $table = window.jQuery(selectorOrElement);

				if (opts.columnFiltering) {
					var originalInitComplete = opts.initComplete;
					opts.initComplete = function(settings, json) {
						var api = this.api();
						var $tableWrapper = window.jQuery(api.table().container());

						var $visibleHeader = $tableWrapper.find('.dataTables_scrollHead thead');
						if (!$visibleHeader.length) {
							$visibleHeader = window.jQuery(api.table().header());
						}

						if ($visibleHeader.find('.dt-filter-row').length > 0) {
							return;
						}

						var $filterRow = window.jQuery('<tr class="dt-filter-row"></tr>');
						$visibleHeader.find('tr:first th').each(function() {
							$filterRow.append('<th></th>');
						});
						$visibleHeader.append($filterRow);

						$filterRow.find('th').each(function(index) {
							var title = window.jQuery($visibleHeader.find('tr:first th').eq(index)).text();
							window.jQuery(this).html('<input type="text" class="input is-small dt-filter-input" placeholder="' + title + ' 검색" />');
						});

						$filterRow.find('input').on('click', function(e) {
							e.stopPropagation();
						});

						api.columns().every(function() {
							var column = this;
							var $input = window.jQuery('input', $visibleHeader.find('.dt-filter-row th').eq(column.index()));

							if (!$input.length) return;

							var columnSettings = api.settings()[0].aoColumns[column.index()];
							if (!columnSettings.bSearchable) {
								$input.parent().html('');
								return;
							}

							var searchTimeout;
							$input.on('keyup change', function(e) {
								e.stopPropagation();
								var that = this;
								clearTimeout(searchTimeout);
								searchTimeout = setTimeout(function() {
									if (column.search() !== that.value) {
										column.search(that.value).draw();
									}
								}, 350);
							});

							var state = api.state.loaded();
							if (state && state.columns[column.index()] && state.columns[column.index()].search) {
								var searchTerm = state.columns[column.index()].search.search;
								if(searchTerm) {
									$input.val(searchTerm);
								}
							}
						});

						if (typeof originalInitComplete === 'function') {
							originalInitComplete.call(this, settings, json);
						}
					};
				}

				var dt = $table.DataTable(opts);
				setTimeout(function(){ TableConfig.applyBulmaStyles(dt); }, 0);
				$table.on('draw.dt', function(){ TableConfig.applyBulmaStyles(dt); });

				return dt;

			}catch(e){ /* ignore */ }
			return null;
		},
		adjustColumns: function(dt){
			try { if (dt && dt.columns && dt.columns.adjust) { dt.columns.adjust(); } } catch (e) { /* ignore */ }
		},
		applyBulmaStyles: function(dt){
			try{
				var container = dt && dt.table ? dt.table().container() : null;
				if(!container) return;
				var $c = (window.jQuery) ? window.jQuery(container) : null;
				if(!$c) return;
				// Search input -> Bulma input
				$c.find('div.dataTables_filter input').each(function(){
					var $inp = window.jQuery(this);
					$inp.addClass('input is-small');
				});
				// Length select -> wrap with Bulma select
				$c.find('div.dataTables_length').each(function(){
					var $wrap = window.jQuery(this);
					var $sel = $wrap.find('select');
					if ($sel.length && !$sel.data('bulma-wrapped')){
						var $bulma = window.jQuery('<div class="select is-small"></div>');
						$sel.after($bulma);
						$bulma.append($sel);
						$sel.data('bulma-wrapped', true);
					}
				});
				// Pagination buttons -> Bulma buttons style
				$c.find('div.dataTables_paginate a.paginate_button').each(function(){
					var $a = window.jQuery(this);
					$a.addClass('button is-small');
				});
			}catch(e){ /* ignore */ }
		}
	};

	window.TableConfig = TableConfig;

})(window);

