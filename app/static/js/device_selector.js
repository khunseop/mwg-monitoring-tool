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
					if (state.groups && state.groups.length > 0) {
						state.groups.forEach(function(g) { $group.append('<option value="' + g.id + '">' + g.name + '</option>'); });
					} else if (!allowAllGroups) {
						// 그룹이 없고 allowAllGroups가 false면 빈 옵션 추가 (프록시는 그룹 필터 없이 표시)
						$group.append('<option value="">전체</option>');
					}
				}
			}

			function filteredProxies() {
				var gid = $group && $group.length ? $group.val() : '';
				// allowAllGroups가 false이고 그룹이 있으면 첫 번째 그룹을 기본값으로 사용
				if (!allowAllGroups && !gid && state.groups && state.groups.length > 0) {
					gid = String(state.groups[0].id);
					// 그룹 선택도 업데이트
					try {
						if (state.gts) {
							state.gts.setValue(gid, false);
						} else {
							$group.val(gid);
						}
					} catch (e) { /* ignore */ }
				}
				var filtered = (state.proxies || []).filter(function(p) {
					if (!p || !p.is_active) return false;
					// gid가 없거나 빈 문자열이면 모든 활성 프록시 반환
					if (!gid || gid === '') return true;
					// gid가 있으면 해당 그룹의 프록시만 반환
					var pGroupId = p.group_id ? String(p.group_id) : '';
					return pGroupId === String(gid);
				});
				console.log('[DeviceSelector] filteredProxies - groupId:', gid, 'filtered:', filtered.length, 'total:', state.proxies.length, 'active:', state.proxies.filter(function(p) { return p && p.is_active; }).length);
				return filtered;
			}

			function populateProxies() {
				var list = filteredProxies();
				console.log('[DeviceSelector] populateProxies - filtered list:', list.length, 'total proxies:', state.proxies.length);
				$proxy.empty();
				if (list.length === 0) {
					// 프록시가 없을 때는 placeholder만 표시 (선택 불가)
					$proxy.append('<option value="" disabled>프록시가 없습니다</option>');
				} else {
					list.forEach(function(p) { 
						$proxy.append('<option value="' + p.id + '">' + labelForProxy(p) + '</option>'); 
					});
				}
				if (state.ts) {
					try {
						state.ts.clearOptions();
						if (list.length === 0) {
							// TomSelect에서는 빈 옵션을 추가하지 않음 (placeholder만 표시)
							state.ts.clearOptions();
						} else {
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
						// 기존 TomSelect 인스턴스가 있으면 제거
						if (state.ts && state.ts.destroy) {
							try { state.ts.destroy(); } catch (e) { /* ignore */ }
							state.ts = null;
						}
						var ts = new TomSelect($proxy[0], {
							plugins: { remove_button: { title: '제거' } },
							create: false,
							persist: true,
							maxOptions: 10000,
							closeAfterSelect: false,
							hideSelected: true,
							maxItems: null,
							dropdownParent: 'body',
							allowEmptyOption: false,
							placeholder: '프록시를 선택하세요',
							render: {
								option: function(data, escape) { return '<div style="white-space:nowrap;">' + (data.text || '') + '</div>'; },
								item: function(data, escape) { return '<div style="white-space:nowrap;">' + (data.text || '') + '</div>'; },
								no_results: function(data, escape) { return '<div class="no-results">일치하는 프록시가 없습니다</div>'; }
							},
							onInitialize: function() { 
								$proxy[0]._tom = this; 
								console.log('[DeviceSelector] TomSelect initialized');
							},
							onChange: function() { 
								try { 
									$proxy.trigger('change'); 
									console.log('[DeviceSelector] Proxy selection changed:', this.getValue());
								} catch (e) { /* ignore */ } 
							}
						});
						state.ts = ts;
						console.log('[DeviceSelector] TomSelect created successfully');
					} catch (e) { 
						console.error('[DeviceSelector] TomSelect init failed:', e);
					}
				} else {
					console.warn('[DeviceSelector] TomSelect not available');
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
						console.log('[DeviceSelector] Group changed:', $group.val());
						populateProxies();
						// Auto-select all proxies in the currently filtered group
						var allVals = $proxy.find('option').map(function() { return $(this).val(); }).get().filter(function(v) { return v && v !== ''; });
						console.log('[DeviceSelector] Auto-selecting proxies:', allVals.length);
						try {
							if (state.ts && allVals.length > 0) { 
								state.ts.setValue(allVals, false); 
							} else if (allVals.length > 0) { 
								$proxy.find('option').prop('selected', true); 
								$proxy.trigger('change'); 
							}
						} catch (e) { 
							console.error('[DeviceSelector] Failed to auto-select proxies:', e);
						}
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

			var p1 = $.getJSON(apiGroups).then(function(data) { 
				state.groups = Array.isArray(data) ? data : []; 
				console.log('[DeviceSelector] Loaded groups:', state.groups.length);
				populateGroups(); 
			}).catch(function(err) {
				console.error('[DeviceSelector] Failed to load groups:', err);
				state.groups = [];
				populateGroups();
			});
			var p2 = $.getJSON(apiProxies).then(function(data) { 
				state.proxies = Array.isArray(data) ? data : []; 
				console.log('[DeviceSelector] Loaded proxies:', state.proxies.length, 'active:', state.proxies.filter(function(p) { return p && p.is_active; }).length);
			}).catch(function(err) {
				console.error('[DeviceSelector] Failed to load proxies:', err);
				state.proxies = [];
			});
			return Promise.all([p1, p2]).then(function() { 
				console.log('[DeviceSelector] Data loaded - groups:', state.groups.length, 'proxies:', state.proxies.length);
				populateProxies(); 
				enhanceGroupSelect();
				enhanceMultiSelect(); 
				bindEvents(); 
				if (!allowAllGroups) {
					// If no value has been set externally, default to first group once
					var currentVal = '';
					try { 
						currentVal = ($group && $group.length) ? ($group[0]._tom ? $group[0]._tom.getValue() : $group.val()) : ''; 
					} catch (e) { 
						currentVal = $group.val(); 
					}
					console.log('[DeviceSelector] Current group value:', currentVal);
					if (!currentVal) {
						if (state.groups && state.groups.length > 0) {
							// 그룹이 있으면 첫 번째 그룹 선택
							var first = String(state.groups[0].id);
							console.log('[DeviceSelector] Setting default group to:', first);
							try { 
								if (state.gts) { 
									state.gts.setValue(first, false); 
								} else { 
									$group.val(first).trigger('change'); 
								} 
							} catch (e) { 
								console.error('[DeviceSelector] Failed to set default group:', e);
							}
						} else {
							// 그룹이 없으면 빈 값으로 두고 모든 프록시 표시
							console.log('[DeviceSelector] No groups available, showing all active proxies');
							populateProxies();
						}
					}
				}
				try { 
					if (typeof options.onData === 'function') { 
						options.onData({ groups: state.groups, proxies: state.proxies }); 
					} 
				} catch (e) { 
					console.error('[DeviceSelector] onData callback failed:', e);
				}
			});
		}
	};

	window.DeviceSelector = DeviceSelector;

})(window, jQuery);

