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
			var labelForProxy = (typeof options.labelForProxy === 'function') ? options.labelForProxy : defaultLabelForProxy;
			var apiGroups = options.apiGroups || '/api/proxy-groups';
			var apiProxies = options.apiProxies || '/api/proxies';
			var allowAllGroup = (options.allowAllGroup === undefined) ? true : !!options.allowAllGroup;
			var autoSelectOnGroupChange = (options.autoSelectOnGroupChange === undefined) ? true : !!options.autoSelectOnGroupChange;
			var enableSelectAll = (options.enableSelectAll === undefined) ? true : !!options.enableSelectAll;
			var state = { groups: [], proxies: [], ts: null };

			function populateGroups() {
				if ($group && $group.length) {
					$group.empty();
					if (allowAllGroup) {
						$group.append('<option value="">전체</option>');
					}
					(state.groups || []).forEach(function(g) { $group.append('<option value="' + g.id + '">' + g.name + '</option>'); });
					// If disallowing all-group and nothing is selected, default to first group
					try {
						if (!allowAllGroup) {
							var current = $group.val();
							if (!current && state.groups && state.groups.length > 0) {
								$group.val(String(state.groups[0].id));
							}
						}
					} catch (e) { /* ignore */ }
				}
			}

			function filteredProxies() {
				var gid = $group && $group.length ? $group.val() : '';
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
							allowEmptyOption: true,
							dropdownParent: 'body',
							render: {
								option: function(data, escape) { return '<div style="white-space:nowrap;">' + (data.text || '') + '</div>'; },
								item: function(data, escape) { return '<div style="white-space:nowrap;">' + (data.text || '') + '</div>'; }
							},
							onInitialize: function() { $group[0]._tom = this; },
							onChange: function() { try { $group.trigger('change'); } catch (e) { /* ignore */ } }
						});
						state.gts = gts;
					} catch (e) { /* ignore */ }
				}
			}

			function bindEvents() {
				if ($group && $group.length) {
					$group.off('.devicesel').on('change.devicesel', function() {
						populateProxies();
						// Optionally auto-select all proxies when group changes
						if (autoSelectOnGroupChange) {
							var allVals = $proxy.find('option').map(function() { return $(this).val(); }).get();
							try {
								if (state.ts) { state.ts.setValue(allVals, true); }
								else { $proxy.find('option').prop('selected', true); $proxy.trigger('change'); }
							} catch (e) { /* ignore */ }
						}
					});
				}
				if ($selectAll && $selectAll.length) {
					if (!enableSelectAll) {
						try { $selectAll.closest('label').hide(); } catch (e) { /* ignore */ }
						// Do not bind events when disabled
						return;
					}
					$selectAll.off('.devicesel').on('change.devicesel', function() {
						var checked = $(this).is(':checked');
						var vals = $proxy.find('option').map(function() { return $(this).val(); }).get();
						try {
							if (state.ts) { state.ts.setValue(checked ? vals : [], true); }
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
				try { if (typeof options.onData === 'function') { options.onData({ groups: state.groups, proxies: state.proxies }); } } catch (e) { /* ignore */ }
			});
		}
	};

	window.DeviceSelector = DeviceSelector;

})(window, jQuery);

