(function(){
	const API_BASE = '/api';
	let charts = {};
	const STORAGE_KEY = 'tla_result_v1';

	function setStatus(text, cls){
		const $tag = $('#tlaStatus');
		$tag.text(text);
		$tag.removeClass().addClass('tag').addClass(cls || 'is-light');
	}

	function showError(msg){ $('#tlaError').text(msg).show(); }
	function clearError(){ $('#tlaError').hide().text(''); }

	function humanBytes(v){ return (window.AppUtils && AppUtils.formatBytes) ? AppUtils.formatBytes(v) : String(v); }

	function copyTextToClipboard(text){
		if(!text) return;
		try{
			if(navigator.clipboard && navigator.clipboard.writeText){
				navigator.clipboard.writeText(String(text)).then(function(){ setStatus('복사됨: ' + String(text), 'is-success'); }).catch(function(){ /* noop */ });
				return;
			}
			var ta = document.createElement('textarea');
			ta.value = String(text);
			ta.style.position = 'fixed';
			ta.style.left = '-1000px';
			ta.style.top = '-1000px';
			document.body.appendChild(ta);
			ta.focus();
			ta.select();
			document.execCommand('copy');
			document.body.removeChild(ta);
			setStatus('복사됨: ' + String(text), 'is-success');
		}catch(e){ /* ignore */ }
	}

	function renderSummary(summary){
		$('#tlaTotalLines').text(summary.total_lines || 0);
		$('#tlaParsed').text(summary.parsed_lines || 0);
		$('#tlaUnparsed').text(summary.unparsed_lines || 0);
		$('#tlaClients').text(summary.unique_clients || 0);
		$('#tlaHosts').text(summary.unique_hosts || 0);
		$('#tlaBlocked').text(summary.blocked_requests || 0);
		$('#tlaRecv').text(humanBytes(summary.total_recv_bytes || 0));
		$('#tlaSent').text(humanBytes(summary.total_sent_bytes || 0));
		var start = summary.time_range_start || null;
		var end = summary.time_range_end || null;
		var fmt = function(x){
			if(!x) return '-';
			try{ return (window.AppUtils && AppUtils.formatDateTime) ? AppUtils.formatDateTime(x) : String(x); }catch(e){ return String(x); }
		};
		$('#tlaTimeStart').text(fmt(start));
		$('#tlaTimeEnd').text(fmt(end));
		$('#tlaSummary').show();
	}

	function ensureChart(id, type, options){
		if(!window.ApexCharts) return null;
		if(charts[id]){ try { charts[id].destroy(); } catch(e){} charts[id] = null; }
		const el = document.querySelector('#' + id);
		if(!el) return null;
		const base = { chart: { type, height: 280, animations: { dynamicAnimation: { speed: 250 } }, events: { dataPointSelection: function(event, chartCtx, config){ try { var w = (config && config.w) || (chartCtx && chartCtx.w) || null; var idx = (config && typeof config.dataPointIndex === 'number') ? config.dataPointIndex : -1; var labels = (w && w.globals && (w.globals.labels && w.globals.labels.length ? w.globals.labels : w.globals.categoryLabels)) || []; var label = (idx >= 0 && labels && labels[idx] != null) ? labels[idx] : ''; if(!label && w && w.config && w.config.xaxis && w.config.xaxis.categories){ label = w.config.xaxis.categories[idx] || ''; } if(label){ copyTextToClipboard(String(label)); } } catch(e){} } } }, legend: { show: false }, noData: { text: 'No data' }, dataLabels: { enabled: false } };
		const opts = Object.assign({}, base, options || {});
		charts[id] = new ApexCharts(el, opts);
		charts[id].render();
		return charts[id];
	}

	function toBarSeriesFromPairs(pairs){
		const categories = pairs.map(p => String(p[0]));
		const data = pairs.map(p => Number(p[1] || 0));
		return { categories, data };
	}

	function renderCharts(payload){
		if(!payload) return;
		const top = payload.top || {};
		// 1) 요청 상위 클라이언트
		const sClientReq = toBarSeriesFromPairs(top.clients_by_requests || []);
		ensureChart('tlaChartClientReq', 'bar', { series: [{ name: 'req', data: sClientReq.data }], xaxis: { categories: sClientReq.categories, labels: { rotate: -45 } } });
		// 2) 요청 상위 호스트
		const sHosts = toBarSeriesFromPairs(top.hosts_by_requests || []);
		ensureChart('tlaChartHosts', 'bar', { series: [{ name: 'req', data: sHosts.data }], xaxis: { categories: sHosts.categories, labels: { rotate: -45 } } });
		// 3) CL 수신 상위 클라이언트
		const sClientDown = toBarSeriesFromPairs(top.clients_by_recv_bytes || top.clients_by_download_bytes || []);
		ensureChart('tlaChartClientDown', 'bar', { series: [{ name: 'bytes', data: sClientDown.data }], xaxis: { categories: sClientDown.categories, labels: { rotate: -45 } }, yaxis: { labels: { formatter: v => humanBytes(v) } }, tooltip: { y: { formatter: v => humanBytes(v) } } });
		// 4) CL 송신 상위 클라이언트
		const sClientUp = toBarSeriesFromPairs(top.clients_by_sent_bytes || top.clients_by_upload_bytes || []);
		ensureChart('tlaChartClientUp', 'bar', { series: [{ name: 'bytes', data: sClientUp.data }], xaxis: { categories: sClientUp.categories, labels: { rotate: -45 } }, yaxis: { labels: { formatter: v => humanBytes(v) } }, tooltip: { y: { formatter: v => humanBytes(v) } } });
		// 5) 서버 수신 상위 호스트
		const sHostDown = toBarSeriesFromPairs(top.hosts_by_recv_bytes || top.hosts_by_download_bytes || []);
		ensureChart('tlaChartHostDown', 'bar', { series: [{ name: 'bytes', data: sHostDown.data }], xaxis: { categories: sHostDown.categories, labels: { rotate: -45 } }, yaxis: { labels: { formatter: v => humanBytes(v) } }, tooltip: { y: { formatter: v => humanBytes(v) } } });
		// 6) 서버 송신 상위 호스트
		const sHostUp = toBarSeriesFromPairs(top.hosts_by_sent_bytes || top.hosts_by_upload_bytes || []);
		ensureChart('tlaChartHostUp', 'bar', { series: [{ name: 'bytes', data: sHostUp.data }], xaxis: { categories: sHostUp.categories, labels: { rotate: -45 } }, yaxis: { labels: { formatter: v => humanBytes(v) } }, tooltip: { y: { formatter: v => humanBytes(v) } } });
		// 7) 요청 상위 URL
		const sUrls = toBarSeriesFromPairs(top.urls_by_requests || []);
		ensureChart('tlaChartUrls', 'bar', { series: [{ name: 'req', data: sUrls.data }], xaxis: { categories: sUrls.categories, labels: { rotate: -45, trim: true } } });

		$('#tlaCharts').show();
	}

	function saveResult(payload){
		try{ localStorage.setItem(STORAGE_KEY, JSON.stringify(payload)); }catch(e){}
	}

	function restoreResult(){
		try{
			const raw = localStorage.getItem(STORAGE_KEY);
			if(!raw) return;
			const data = JSON.parse(raw);
			if(!data || typeof data !== 'object') return;
			renderSummary(data.summary || {});
			renderCharts(data);
			setStatus('저장된 분석 결과', 'is-light');
		}catch(e){}
	}

	async function analyze(){
		clearError();
		const fileInput = document.getElementById('tlaFile');
		if(!fileInput || !fileInput.files || fileInput.files.length === 0){ showError('파일을 선택하세요'); return; }
		const file = fileInput.files[0];
		const topN = Math.max(1, Math.min(100, parseInt($('#tlaTopN').val() || '20', 10)));

		setStatus('업로드 중...', 'is-info');
		$('#tlaAnalyzeBtn').addClass('is-loading').prop('disabled', true);
		try{
			const form = new FormData();
			form.append('logfile', file);
			const url = `${API_BASE}/traffic-logs/analyze-upload?topN=${encodeURIComponent(String(topN))}`;
			const res = await fetch(url, { method: 'POST', body: form });
			if(!res.ok){
				const err = await res.json().catch(()=>({detail:'분석 실패'}));
				throw new Error(err.detail || '분석 실패');
			}
			const data = await res.json();
			renderSummary(data.summary || {});
			renderCharts(data);
			saveResult(data);
			setStatus('완료', 'is-success');
		}catch(e){
			showError(e.message || String(e));
			setStatus('실패', 'is-danger');
		}finally{
			$('#tlaAnalyzeBtn').removeClass('is-loading').prop('disabled', false);
		}
	}

	$(function(){
		$('#tlaFile').on('change', function(){
			const f = this.files && this.files[0];
			$('#tlaFileName').text(f ? (f.name + ' (' + (f.size||0) + ' bytes)') : '선택된 파일 없음');
		});
		$('#tlaAnalyzeBtn').on('click', analyze);
		restoreResult();
	});
})();

