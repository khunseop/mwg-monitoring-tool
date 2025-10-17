(function(){
	const API_BASE = '/api';
	let PROXIES = [];
	const STORAGE_KEY = 'tl_state_v1';
	let CURRENT_VIEW = 'remote';

	// Keep a global reference for the detail modal
	window.openTlModal = function(record) {
		const $body = $('#tlDetailBody');
		$body.empty();
		// The raw log line should be passed in the record
		const rawLine = record.__raw || 'No raw data available.';
		$body.append(`<tr><th style="width: 120px;">Raw Log</th><td><pre>${rawLine}</pre></td></tr>`);

		// You can still show parsed fields if they exist
		for (const key in record) {
			if (key !== '__raw') {
				let v = record[key];
				if(v === null || v === undefined) v = '';
				$body.append(`<tr><th>${key}</th><td>${String(v)}</td></tr>`);
			}
		}
		$('#tlDetailModal').addClass('is-active');
	};

	function setStatus(text, cls){
		const $tag = $('#tlStatus');
		$tag.text(text);
		$tag.removeClass().addClass('tag').addClass(cls || 'is-light');
	}

	function showError(msg){
		$('#tlError').text(msg).show();
	}

	function clearError(){ $('#tlError').hide().text(''); }

	function saveState(){
		try {
			const state = {
				view: CURRENT_VIEW,
				proxyId: $('#tlProxySelect').val() || '',
				query: ($('#tlQuery').val() || '').trim(),
				limit: $('#tlLimit').val() || '200',
				direction: $('#tlDirection').val() || 'tail',
			};
			localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
		} catch (e) {
			console.error("Failed to save state:", e);
		}
	}

	function restoreState(){
		try{
			const raw = localStorage.getItem(STORAGE_KEY);
			if(!raw) return;
			const state = JSON.parse(raw);
			if(state.view){ CURRENT_VIEW = state.view; }
			if(state.proxyId !== undefined){ $('#tlProxySelect').val(String(state.proxyId)); }
			if(state.query !== undefined){ $('#tlQuery').val(state.query); }
			if(state.limit !== undefined){ $('#tlLimit').val(state.limit); }
			if(state.direction !== undefined){ $('#tlDirection').val(state.direction); }
            // Don't restore data, just settings. User must click "조회"
		}catch(e){
            console.error("Failed to restore state:", e);
        }
	}

	async function fetchProxies(){
		const res = await fetch(`${API_BASE}/proxies?limit=500&offset=0`);
		if(!res.ok){ throw new Error('프록시 목록을 불러오지 못했습니다'); }
		return await res.json();
	}

	function populateProxySelect(proxies){
		const $sel = $('#tlProxySelect');
		$sel.find('option:not([value=""])').remove();
		const active = proxies.filter(p => p.is_active);
		active.forEach(p => {
			const labelBase = p.group_name ? `${p.host} (${p.group_name})` : p.host;
			const label = p.traffic_log_path ? labelBase : `${labelBase} · 경로 미설정`;
			$sel.append(`<option value="${p.id}">${label}</option>`);
		});
		if($sel.find('option').length === 1){
			$sel.append('<option disabled>활성화된 프록시가 없습니다</option>');
		}
	}

	async function loadLogs(){
		clearError();
		const proxyId = $('#tlProxySelect').val();
		if(!proxyId){ showError('프록시를 선택하세요'); return; }
		const selected = PROXIES.find(p => String(p.id) === String(proxyId));
		if(!selected){ showError('프록시 정보를 찾을 수 없습니다'); return; }
		if(!selected.traffic_log_path){
			showError('선택한 프록시에 트래픽 로그 경로가 설정되어 있지 않습니다. 설정 > 프록시 수정에서 경로를 지정하세요.');
			return;
		}
		const q = ($('#tlQuery').val() || '').trim();
		const limit = Math.max(1, Math.min(1000, parseInt($('#tlLimit').val() || '200', 10)));
		const direction = $('#tlDirection').val();
		const parsed = true; // Always request parsed data for the grid

		setStatus('조회 중...', 'is-info');
		window.trafficLogsGrid.clear();
		$('#tlEmptyState').hide();
		$('#tlLoadBtn').addClass('is-loading').prop('disabled', true);

		try{
			const params = new URLSearchParams();
			params.set('limit', String(limit));
			params.set('direction', direction);
			params.set('parsed', String(parsed));
			if(q.length > 0){ params.set('q', q); }
			const url = `${API_BASE}/traffic-logs/${encodeURIComponent(proxyId)}?${params.toString()}`;
			const res = await fetch(url);
			if(!res.ok){
				const err = await res.json().catch(()=>({detail:'에러'}));
				throw new Error(err.detail || '조회 실패');
			}
			const data = await res.json();

			if (data.records && data.records.length > 0) {
				// We need to add the raw log line to each record for the detail view
				const recordsWithRaw = data.records.map((record, index) => {
					// The backend sends raw_lines separately
					record.__raw = data.raw_lines[index] || '';
					return record;
				});
				window.trafficLogsGrid.updateData(data.headers, recordsWithRaw);
			} else {
				$('#tlEmptyState').show();
			}

			const suffix = data.truncated ? ' (truncated)' : '';
			setStatus(`완료 - ${data.count} 라인${suffix}`, 'is-success');
			saveState(); // Save settings on successful load
		}catch(e){
			showError(e.message || String(e));
			setStatus('실패', 'is-danger');
		}finally{
			$('#tlLoadBtn').removeClass('is-loading').prop('disabled', false);
		}
	}

	$(async function(){
		try{
			setStatus('프록시 목록 로딩...', 'is-light');
			const proxies = await fetchProxies();
			PROXIES = Array.isArray(proxies) ? proxies : [];
			populateProxySelect(PROXIES);
			setStatus('대기', 'is-light');
		}catch(e){
			showError('프록시 목록 로딩 실패');
			setStatus('실패', 'is-danger');
		}

		restoreState();

		function setView(view, write){
			CURRENT_VIEW = view;
			if(view === 'upload'){
				$('#tlRemoteSection').hide();
				$('#tlaSection').show();
				$('#tlTabs li').removeClass('is-active');
				$('#tlTabs [data-view="upload"]').parent().addClass('is-active');
			}else{
				$('#tlaSection').hide();
				$('#tlRemoteSection').show();
				$('#tlTabs li').removeClass('is-active');
				$('#tlTabs [data-view="remote"]').parent().addClass('is-active');
			}
			if(write){ saveState(); }
		}

		function applyViewFromQuery(){
			const params = new URLSearchParams(window.location.search);
			const view = (params.get('view') || CURRENT_VIEW || 'remote').toLowerCase();
			setView(view === 'upload' ? 'upload' : 'remote', false);
		}

		applyViewFromQuery();
		$('#tlTabs').on('click', 'a[data-view]', function(e){ e.preventDefault(); var v = $(this).data('view'); setView(String(v || 'remote'), true); });

		$('#tlProxySelect, #tlQuery, #tlLimit, #tlDirection').on('change keyup', saveState);
		$('#tlLoadBtn').on('click', loadLogs);

		window.addEventListener('storage', function(e) {
			if (e.key === STORAGE_KEY) {
				restoreState();
			}
		});
	});
})();