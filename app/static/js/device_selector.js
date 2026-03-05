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
			var $counter = options.selectionCounter ? $(options.selectionCounter) : $();
			var $trigger = $('#ruProxyTrigger'); 
			var allowAllGroups = (options.allowAllGroups === undefined) ? true : !!options.allowAllGroups;
			var labelForProxy = (typeof options.labelForProxy === 'function') ? options.labelForProxy : defaultLabelForProxy;
			var apiGroups = options.apiGroups || '/api/proxy-groups';
			var apiProxies = options.apiProxies || '/api/proxies';
			var state = { groups: [], proxies: [], ts: null };

			function updateCounter() {
				if (!$counter.length) return;
				var filtered = filteredProxies();
				var totalCount = filtered.length;
				var filteredIds = filtered.map(function(p) { return String(p.id); });
				var allSelectedIds = state.ts ? state.ts.getValue() : ($proxy.val() || []);
				
				var selectedInCurrentGroup = allSelectedIds.filter(function(id) {
					return filteredIds.indexOf(String(id)) !== -1;
				});
				var selectedCount = selectedInCurrentGroup.length;
				$counter.text(selectedCount + ' / ' + totalCount);
			}

			function populateGroups() {
				if ($group && $group.length) {
					$group.empty();
					if (allowAllGroups) { $group.append('<option value="">전체</option>'); }
					if (state.groups && state.groups.length > 0) {
						state.groups.forEach(function(g) { $group.append('<option value="' + g.id + '">' + g.name + '</option>'); });
					} else if (!allowAllGroups) {
						$group.append('<option value="">전체</option>');
					}
				}
			}

			function filteredProxies() {
				var gid = $group && $group.length ? $group.val() : '';
				if (!allowAllGroups && !gid && state.groups && state.groups.length > 0) {
					gid = String(state.groups[0].id);
					$group.val(gid);
				}
				var filtered = (state.proxies || []).filter(function(p) {
					if (!p || !p.is_active) return false;
					if (!gid || gid === '') return true;
					var pGroupId = p.group_id ? String(p.group_id) : '';
					return pGroupId === String(gid);
				});
				return filtered;
			}

			function populateProxies() {
				var list = filteredProxies();
				$proxy.empty();
				if (list.length === 0) {
					$proxy.append('<option value="" disabled>프록시가 없습니다</option>');
				} else {
					list.forEach(function(p) { 
						$proxy.append('<option value="' + p.id + '">' + labelForProxy(p) + '</option>'); 
					});
				}
				if (state.ts) {
					try {
						state.ts.clearOptions();
						if (list.length > 0) {
							list.forEach(function(p) { 
								state.ts.addOption({ value: String(p.id), text: labelForProxy(p) }); 
							});
						}
						state.ts.refreshOptions(false);
					} catch (e) { 
						console.error('[DeviceSelector] TomSelect refresh failed:', e);
					}
				}
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
						if (state.ts && state.ts.destroy) {
							try { state.ts.destroy(); } catch (e) { /* ignore */ }
							state.ts = null;
						}
						var ts = new TomSelect($proxy[0], {
							plugins: { 
								remove_button: { title: '제거' },
								checkbox_options: {}
							},
							create: false,
							persist: true,
							maxOptions: 10000,
							closeAfterSelect: false,
							hideSelected: false,
							maxItems: null,
							dropdownParent: 'body', 
							allowEmptyOption: false,
							render: {
								option: function(data, escape) { 
									return '<div class="is-flex is-align-items-center" style="padding: 0.5rem;">' +
										'<span style="white-space:nowrap;">' + (data.text || '') + '</span>' +
										'</div>'; 
								},
								item: function(data, escape) { return '<div style="display:none;">' + (data.text || '') + '</div>'; }
							},
							onInitialize: function() { 
								$proxy[0]._tom = this; 
								updateCounter();
								var self = this;
								this.position = function() {
									var offset = $trigger.offset();
									var height = $trigger.outerHeight();
									$(self.dropdown).css({
										top: (offset.top + height) + 'px',
										left: offset.left + 'px',
										width: '300px'
									});
								};
							},
							onChange: function() { 
								try { 
									$proxy.trigger('change'); 
									updateCounter();
								} catch (e) { /* ignore */ } 
							}
						});
						state.ts = ts;
					} catch (e) { 
						console.error('[DeviceSelector] TomSelect init failed:', e);
					}
				}
			}

			function bindEvents() {
				if ($group && $group.length) {
					$group.off('.devicesel').on('change.devicesel', function() {
						populateProxies();
						var allVals = $proxy.find('option').map(function() { return $(this).val(); }).get().filter(function(v) { return v && v !== ''; });
						try {
							if (state.ts && allVals.length > 0) { 
								state.ts.setValue(allVals, false); 
							} else if (allVals.length > 0) { 
								$proxy.find('option').prop('selected', true); 
								$proxy.trigger('change'); 
							}
						} catch (e) { /* ignore */ }
						updateCounter();
					});
				}
				if ($trigger.length) {
					$trigger.off('click').on('click', function(e) {
						e.preventDefault();
						e.stopPropagation();
						if (state.ts) {
							if (state.ts.isOpen) { 
								state.ts.close(); 
							} else { 
								state.ts.open();
								state.ts.position();
							}
						}
					});
				}
			}

			var p1 = $.getJSON(apiGroups).then(function(data) { 
				state.groups = Array.isArray(data) ? data : []; 
				populateGroups(); 
			}).catch(function(err) {
				state.groups = [];
				populateGroups();
			});
			var p2 = $.getJSON(apiProxies).then(function(data) { 
				state.proxies = Array.isArray(data) ? data : []; 
			}).catch(function(err) {
				state.proxies = [];
			});
			return Promise.all([p1, p2]).then(function() { 
				populateProxies(); 
				enhanceMultiSelect(); 
				bindEvents(); 
				if (!allowAllGroups) {
					var currentVal = $group.val();
					if (!currentVal) {
						if (state.groups && state.groups.length > 0) {
							var first = String(state.groups[0].id);
							$group.val(first).trigger('change');
						} else {
							populateProxies();
						}
					}
				}
				try { 
					if (typeof options.onData === 'function') { 
						options.onData({ groups: state.groups, proxies: state.proxies }); 
					} 
				} catch (e) { /* ignore */ }
			});
		}
	};

	window.DeviceSelector = DeviceSelector;

})(window, jQuery);
