(function(window, $) {
	'use strict';

	function defaultLabelForProxy(proxy) {
		var host = (proxy && proxy.host) ? proxy.host : '';
		var group = (proxy && proxy.group_name) ? (' (' + proxy.group_name + ')') : '';
		return host + group;
	}

	var DeviceSelector = {
		init: function(options) {
			options = options || {};
			var $group = $(options.groupSelect);
			var $proxy = $(options.proxySelect);
			var $selectAll = options.selectAll ? $(options.selectAll) : $();
			var allowAllGroups = (options.allowAllGroups === undefined) ? true : !!options.allowAllGroups;
			var labelForProxy = (typeof options.labelForProxy === 'function') ? options.labelForProxy : defaultLabelForProxy;
			var apiGroups = options.apiGroups || '/api/proxy-groups';
			var apiProxies = options.apiProxies || '/api/proxies';
			var state = { groups: [], proxies: [], ts: null };

			function populateGroups() {
				if ($group && $group.length) {
					$group.empty();
					if (allowAllGroups) { $group.append('<option value="">전체</option>'); }
					(state.groups || []).forEach(function(g) { $group.append('<option value="' + g.id + '">' + g.name + '</option>'); });
				}
			}

			function filteredProxies() {
				var gid = $group && $group.length ? $group.val() : '';
				if (!allowAllGroups && !gid) {
					gid = (state.groups && state.groups.length) ? String(state.groups[0].id) : '';
				}
				return (state.proxies || []).filter(function(p) {
					if (!p || !p.is_active) return false;
					if (!gid) return true;
					return String(p.group_id || '') === String(gid);
				});
			}

			function populateProxies() {
				var list = filteredProxies();
				$proxy.empty();
				list.forEach(function(p) { $proxy.append('<option value="' + p.id + '">' + labelForProxy(p) + '</option>'); });
				if (state.ts) {
					try {
						state.ts.clearOptions();
						list.forEach(function(p) { state.ts.addOption({ value: String(p.id), text: labelForProxy(p) }); });
						state.ts.refreshOptions(false);
					} catch (e) { /* ignore */ }
				}
			}

			function selectAllCurrentProxiesIfNone() {
				if (!$proxy || $proxy.length === 0) return;
				var current = $proxy.val() || [];
				if (current.length > 0) return;
				var vals = $proxy.find('option').map(function() { return $(this).val(); }).get();
				if (vals.length === 0) return;
				try {
					if (state.ts) { state.ts.setValue(vals, false); }
					else { $proxy.find('option').prop('selected', true); $proxy.trigger('change'); }
				} catch (e) { /* ignore */ }
			}

			function selectCurrentGroupProxies() {
				if (!$proxy || $proxy.length === 0) return;
				var vals = $proxy.find('option').map(function() { return $(this).val(); }).get();
				try {
					if (state.ts) { state.ts.setValue(vals, false); }
					else { $proxy.find('option').prop('selected', true); $proxy.trigger('change'); }
				} catch (e) { /* ignore */ }
			}

			function enhanceMultiSelect() {
				if (!$proxy || $proxy.length === 0) return;
				if (window.TomSelect) {
					try {
						var ts = new TomSelect($proxy[0], {
							plugins: { remove_button: { title: '제거' } },
							create: false,
							persist: true,
							maxOptions: 10000,
							closeAfterSelect: false,
							hideSelected: true,
							maxItems: null,
							dropdownParent: 'body',
							render: {
								option: function(data, escape) { return '<div style="white-space:nowrap;">' + (data.text || '') + '</div>'; },
								item: function(data, escape) { return '<div style="white-space:nowrap;">' + (data.text || '') + '</div>'; }
							},
							onInitialize: function() { $proxy[0]._tom = this; },
							onChange: function() { try { $proxy.trigger('change'); } catch (e) { /* ignore */ } }
						});
						state.ts = ts;
					} catch (e) { /* ignore */ }
				}
			}

			function enhanceGroupSelect() {
				if (!$group || $group.length === 0) return;
				if (window.TomSelect) {
					try {
						// Single-select Tom Select for group dropdown
						var gts = new TomSelect($group[0], {
							create: false,
							persist: true,
							maxItems: 1,
							allowEmptyOption: allowAllGroups,
							dropdownParent: 'body',
							render: {
								option: function(data, escape) { return '<div style="white-space:nowrap;">' + (data.text || '') + '</div>'; },
								item: function(data, escape) { return '<div style="white-space:nowrap;">' + (data.text || '') + '</div>'; }
							},
							onInitialize: function() { $group[0]._tom = this; },
						onChange: function() { try { $group.trigger('change'); } catch (e) { /* ignore */ } },
							onDropdownClose: function() { selectAllCurrentProxiesIfNone(); }
						});
						state.gts = gts;
					} catch (e) { /* ignore */ }
				}
			}

			function bindEvents() {
				if ($group && $group.length) {
					$group.off('.devicesel').on('change.devicesel', function() {
						populateProxies();
						// Auto-select all proxies in the currently filtered group
						var allVals = $proxy.find('option').map(function() { return $(this).val(); }).get();
					try {
						if (state.ts) { state.ts.setValue(allVals, false); }
						else { $proxy.find('option').prop('selected', true); $proxy.trigger('change'); }
					} catch (e) { /* ignore */ }
					});
					// If user clicks the group select without changing value, still reconcile proxies for the visible group
					$group.on('click.devicesel', function() { selectCurrentGroupProxies(); });
				}
				if ($selectAll && $selectAll.length) {
					$selectAll.off('.devicesel').on('change.devicesel', function() {
						var checked = $(this).is(':checked');
						var vals = $proxy.find('option').map(function() { return $(this).val(); }).get();
					try {
						if (state.ts) { state.ts.setValue(checked ? vals : [], false); }
						else { $proxy.find('option').prop('selected', checked); $proxy.trigger('change'); }
					} catch (e) { /* ignore */ }
					});
				}
			}

			var p1 = $.getJSON(apiGroups).then(function(data) { state.groups = Array.isArray(data) ? data : []; populateGroups(); });
			var p2 = $.getJSON(apiProxies).then(function(data) { state.proxies = Array.isArray(data) ? data : []; });
			return Promise.all([p1, p2]).then(function() { 
				populateProxies(); 
				enhanceGroupSelect();
				enhanceMultiSelect(); 
				bindEvents(); 
				if (!allowAllGroups) {
					// If no value has been set externally, default to first group once
					var currentVal = '';
					try { currentVal = ($group && $group.length) ? ($group[0]._tom ? $group[0]._tom.getValue() : $group.val()) : ''; } catch (e) { currentVal = $group.val(); }
					if (!currentVal) {
						var first = (state.groups && state.groups.length) ? String(state.groups[0].id) : '';
						if (first) {
							try { if (state.gts) { state.gts.setValue(first, false); } else { $group.val(first).trigger('change'); } } catch (e) { /* ignore */ }
						}
					}
				}
				try { if (typeof options.onData === 'function') { options.onData({ groups: state.groups, proxies: state.proxies }); } } catch (e) { /* ignore */ }
			});
		}
	};

	window.DeviceSelector = DeviceSelector;

})(window, jQuery);

