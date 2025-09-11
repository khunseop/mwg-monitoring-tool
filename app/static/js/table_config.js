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
		lengthMenu: [[25, 50, 100], [25, 50, 100]],
		dom: 'lfrtip',
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
					return new window.DataTable(selectorOrElement, opts);
				}
				if (window.jQuery && window.jQuery.fn && window.jQuery.fn.DataTable){
					return window.jQuery(selectorOrElement).DataTable(opts);
				}
			}catch(e){ /* ignore */ }
			return null;
		},
		adjustColumns: function(dt){
			try { if (dt && dt.columns && dt.columns.adjust) { dt.columns.adjust(); } } catch (e) { /* ignore */ }
		}
	};

	window.TableConfig = TableConfig;

})(window);

