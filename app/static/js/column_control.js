(function(window){
	'use strict';

	function debounce(fn, wait){
		var t; return function(){ var ctx=this, args=arguments; clearTimeout(t); t=setTimeout(function(){ fn.apply(ctx,args); }, wait); };
	}

	function coerceArray(value){
		if(value == null) return [];
		if(Array.isArray(value)) return value;
		return [value];
	}

	var ColumnControl = {
		_attachOnce: function(dt, options){
			options = options || {};
			try{
				var $ = window.jQuery;
				if(!dt || !dt.columns) return;
				var table = dt.table ? dt.table() : null;
				var container = table ? table.container() : null;
				var node = table ? table.node() : null;
				if(!$ || !node) return;
				var $container = $(container);
				var $table = $(node);
				// With scrollX/scrollY, DataTables renders a cloned THEAD inside scrollHead
				var $thead = $container.find('div.dataTables_scrollHead thead');
				if($thead.length === 0){ $thead = $table.find('thead'); }
				if($thead.length === 0) return;
				$thead.find('tr.cc-filters').remove();

				var totalCols = dt.columns().count();
				var skip = coerceArray(options.skipColumns || []);
				var types = options.types || {}; // {colIdx: 'text'|'select'}

				var $filterTr = $('<tr class="cc-filters"></tr>');
				for (var i = 0; i < totalCols; i++){
					if (skip.indexOf(i) !== -1){ $filterTr.append('<th></th>'); continue; }
					var controlType = types[i] || 'text';
					if (controlType === 'select'){
						$filterTr.append('<th><div class="select is-small"><select><option value=""></option></select></div></th>');
					} else {
						$filterTr.append('<th><input type="text" class="input is-small" placeholder="필터"></th>');
					}
				}
				$thead.append($filterTr);

				// Populate selects with unique column values when client-side
				try{
					if (!dt.settings()[0].oInit.serverSide){
						dt.columns().every(function(colIdx){
							if (skip.indexOf(colIdx) !== -1) return;
							var controlType = types[colIdx] || 'text';
							if (controlType !== 'select') return;
							var column = dt.column(colIdx);
							var unique = {};
							column.data().each(function(v){ var s = (v == null) ? '' : String(v); unique[s] = true; });
							var list = Object.keys(unique).sort();
							var th = $filterTr.find('th').eq(colIdx);
							var sel = th.find('select');
							list.forEach(function(val){ sel.append('<option value="'+$('<div>').text(val).html()+'">'+$('<div>').text(val).html()+'</option>'); });
						});
					}
				}catch(e){ /* ignore */ }

				// Bind events
				dt.columns().every(function(colIdx){
					if (skip.indexOf(colIdx) !== -1) return;
					var th = $filterTr.find('th').eq(colIdx);
					var input = th.find('input');
					var select = th.find('select');
					var apply = debounce(function(val){ dt.column(colIdx).search(val || '').draw(); }, 250);
					if (input.length){ input.on('keyup change', function(){ apply(this.value || ''); }); }
					if (select.length){ select.on('change', function(){ apply(this.value || ''); }); }
				});
			}catch(err){ /* ignore */ }
		},
		attach: function(dt, options){
			ColumnControl._attachOnce(dt, options);
		},
		bind: function(dt, options){
			try{
				ColumnControl._attachOnce(dt, options);
				if (dt && dt.on){
					dt.on('draw', function(){ ColumnControl._attachOnce(dt, options); });
				}
			}catch(e){ /* ignore */ }
		}
	};

	window.ColumnControl = ColumnControl;

})(window);

