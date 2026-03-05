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
			var $trigger = $(options.proxyTrigger || '#ruProxyTrigger'); 
			var allowAllGroups = (options.allowAllGroups === undefined) ? true : !!options.allowAllGroups;
			var labelForProxy = (typeof options.labelForProxy === 'function') ? options.labelForProxy : defaultLabelForProxy;
			var apiGroups = options.apiGroups || '/api/proxy-groups';
			var apiProxies = options.apiProxies || '/api/proxies';
			var state = { groups: [], proxies: [], ts: null };
			var storageKey = options.storageKey || null;

			function saveToStorage() {
				if (!storageKey || !state.ts) return;
				try {
					var current = JSON.parse(localStorage.getItem(storageKey) || '{}');
					current.proxyIds = state.ts.getValue().map(function(v) { return parseInt(v, 10); });
					if ($group.length) {
						current.groupId = $group.val();
					}
					localStorage.setItem(storageKey, JSON.stringify(current));
				} catch (e) { /* ignore */ }
			}

			function restoreFromStorage() {
				if (!storageKey) return;
				try {
					var saved = JSON.parse(localStorage.getItem(storageKey) || '{}');
					if (saved.groupId && $group.length) {
						$group.val(saved.groupId);
						populateProxies();
					}
					if (saved.proxyIds && Array.isArray(saved.proxyIds) && state.ts) {
						state.ts.setValue(saved.proxyIds.map(String), false);
					} else {
						selectCurrentGroupProxies();
					}
				} catch (e) { /* ignore */ }
			}

			function updateCounter() {
				if (!$counter.length) return;
				var filtered = filteredProxies();
				var totalCount = filtered.length;
				var allSelectedIds = state.ts ? state.ts.getValue() : ($proxy.val() || []);
				if (!Array.isArray(allSelectedIds)) {
					allSelectedIds = allSelectedIds ? [allSelectedIds] : [];
				}
				
				var filteredIds = filtered.map(function(p) { return String(p.id); });
				var selectedInCurrentGroup = allSelectedIds.filter(function(id) {
					return filteredIds.indexOf(String(id)) !== -1;
				});
				var selectedCount = selectedInCurrentGroup.length;
				$counter.text(selectedCount + ' / ' + totalCount);
			}

			function populateGroups() {
				if ($group && $group.length) {
					var currentVal = $group.val();
					$group.empty();
					if (allowAllGroups) { $group.append('<option value="">전체</option>'); }
					if (state.groups && state.groups.length > 0) {
						state.groups.forEach(function(g) { $group.append('<option value="' + g.id + '">' + g.name + '</option>'); });
					} else if (!allowAllGroups) {
						$group.append('<option value="">전체</option>');
					}
					if (currentVal) $group.val(currentVal);
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
							var tsOptions = list.map(function(p) {
								return { value: String(p.id), text: labelForProxy(p) };
							});
							state.ts.addOptions(tsOptions);
						}
						state.ts.refreshOptions(false);
					} catch (e) { 
						console.error('[DeviceSelector] TomSelect refresh failed:', e);
					}
				}
			}

			function selectCurrentGroupProxies() {
				if (!$proxy || $proxy.length === 0) return;
				var list = filteredProxies();
				var vals = list.map(function(p) { return String(p.id); });
				try {
					if (state.ts) { 
						state.ts.setValue(vals, false); 
					} else { 
						$proxy.find('option').prop('selected', true); 
						$proxy.trigger('change'); 
					}
				} catch (e) { /* ignore */ }
			}

			function positionDropdown() {
				if (!state.ts || !state.ts.isOpen || !$trigger.length) return;
				
				// 트리거 버튼의 부모(relative container) 기준 위치 고정
				$(state.ts.dropdown).css({
					top: '32px',
					left: '0',
					width: '300px',
					position: 'absolute',
					zIndex: 9999,
					display: 'block',
					visibility: 'visible',
					pointerEvents: 'auto'
				});
			}

			function enhanceMultiSelect() {
				if (!$proxy || $proxy.length === 0) return;
				if (window.TomSelect) {
					try {
						if (state.ts && state.ts.destroy) {
							try { state.ts.destroy(); } catch (e) { /* ignore */ }
							state.ts = null;
						}
						
						// 트리거 버튼의 부모를 드롭다운의 부모로 설정하여 상대 좌표 유지
						var $container = $trigger.parent();
						
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
							dropdownParent: $container[0], // body 대신 컨테이너에 직접 삽입
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
								// 기본 position 기능을 커스텀으로 완전 교체
								this.position = function() {
									positionDropdown();
								};
							},
							onChange: function() { 
								try { 
									$proxy.trigger('change'); 
									updateCounter();
									saveToStorage();
									// 체크 시 위치 고정
									positionDropdown();
								} catch (e) { /* ignore */ } 
							},
							onDropdownOpen: function() {
								positionDropdown();
								// 애니메이션 등 예외 상황 대비 이중 확인
								setTimeout(positionDropdown, 0);
							}
						});
						state.ts = ts;
						restoreFromStorage();
					} catch (e) { 
						console.error('[DeviceSelector] TomSelect init failed:', e);
					}
				}
			}

			function bindEvents() {
				if ($group && $group.length) {
					$group.off('.devicesel').on('change.devicesel', function() {
						populateProxies();
						selectCurrentGroupProxies();
						updateCounter();
						saveToStorage();
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
								// 드롭다운을 열기 전에 기존의 모든 TomSelect 드롭다운을 닫음 (충돌 방지)
								$('.ts-dropdown').css({ visibility: 'hidden', display: 'none' });
								state.ts.open();
								positionDropdown();
							}
						}
					});
				}
				// 윈도우 리사이즈/스크롤 시 드롭다운 위치 재조정
				$(window).off('.devicesel-pos').on('resize.devicesel-pos scroll.devicesel-pos', function() {
					if (state.ts && state.ts.isOpen) {
						positionDropdown();
					}
				});
				
				// 문서 클릭 시 드롭다운 닫기 (이벤트 전파 방지 때문)
				$(document).off('.devicesel-close').on('click.devicesel-close', function(e) {
					if (state.ts && state.ts.isOpen) {
						var $target = $(e.target);
						if (!$target.closest('.ts-wrapper, .ts-dropdown, ' + (options.proxyTrigger || '#ruProxyTrigger')).length) {
							state.ts.close();
						}
					}
				});
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
