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
		scrollY: 480,
		scrollCollapse: true,
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
				if (typeof window.DataTable === 'function'){
					var dt = new window.DataTable(selectorOrElement, opts);
					setTimeout(function(){ TableConfig.applyBulmaStyles(dt); }, 0);
					dt.on('draw', function(){ TableConfig.applyBulmaStyles(dt); });
					return dt;
				}
				if (window.jQuery && window.jQuery.fn && window.jQuery.fn.DataTable){
					var $el = window.jQuery(selectorOrElement);
					var dtj = $el.DataTable(opts);
					setTimeout(function(){ TableConfig.applyBulmaStyles(dtj); }, 0);
					$el.on('draw.dt', function(){ TableConfig.applyBulmaStyles(dtj); });
					return dtj;
				}
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

