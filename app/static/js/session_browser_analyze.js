(function(){
	const API_BASE = '/api';
	const STORAGE_KEY = 'sb_analyze_v1';
	let charts = {};

	function setStatus(text, cls){
		const $tag = $('#sbAnalyzeStatus');
		$tag.text(text);
		$tag.removeClass().addClass('tag').addClass(cls || 'is-light');
	}
	function showError(msg){ $('#sbAnalyzeError').text(msg).show(); }
	function clearError(){ $('#sbAnalyzeError').hide().text(''); }

	function humanBytes(v){ return (window.AppUtils && AppUtils.formatBytes) ? AppUtils.formatBytes(v) : String(v); }
	function fmtDt(x){ try{ return (window.AppUtils && AppUtils.formatDateTime) ? AppUtils.formatDateTime(x) : String(x || '-'); } catch(e){ return String(x||'-'); } }

	function copyTextToClipboard(text){
		if(!text) return;
		try{
			if(navigator.clipboard && navigator.clipboard.writeText){
				navigator.clipboard.writeText(String(text)).then(function(){ setStatus('복사됨: ' + String(text), 'is-success'); }).catch(function(){});
				return;
			}
			var ta = document.createElement('textarea');
			ta.value = String(text);
			ta.style.position = 'fixed'; ta.style.left = '-1000px'; ta.style.top = '-1000px';
			document.body.appendChild(ta); ta.focus(); ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
			setStatus('복사됨: ' + String(text), 'is-success');
		}catch(e){}
	}

	function ensureChart(id, type, options){
		if(!window.ApexCharts) return null;
		if(charts[id]){ try{ charts[id].destroy(); }catch(e){} charts[id] = null; }
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

	function renderSummary(payload){
		const summary = payload.summary || {};
		const hosts = payload.target_hosts || [];

		// New fields for analysis metadata
		$('#sbAnalyzedAt').text(payload.analyzed_at ? fmtDt(payload.analyzed_at) : '-');
		$('#sbTargetHosts').text(hosts.length > 0 ? hosts.join(', ') : '-');

		// Existing summary fields
		$('#sbTotSessions').text(summary.total_sessions || 0);
		$('#sbClients').text(summary.unique_clients || 0);
		$('#sbHosts').text(summary.unique_hosts || 0);
		$('#sbRecv').text(humanBytes(summary.total_recv_bytes || 0));
		$('#sbSent').text(humanBytes(summary.total_sent_bytes || 0));
		$('#sbTimeStart').text(summary.time_range_start ? fmtDt(summary.time_range_start) : '-');
		$('#sbTimeEnd').text(summary.time_range_end ? fmtDt(summary.time_range_end) : '-');
		$('#sbSummary').show();
	}

	function renderCharts(payload){
		if(!payload) return;
		const top = payload.top || {};
		const sClientReq = toBarSeriesFromPairs(top.clients_by_requests || []);
		ensureChart('sbChartClientReq', 'bar', { series: [{ name: 'req', data: sClientReq.data }], xaxis: { categories: sClientReq.categories, labels: { rotate: -45 } } });
		const sHosts = toBarSeriesFromPairs(top.hosts_by_requests || []);
		ensureChart('sbChartHosts', 'bar', { series: [{ name: 'req', data: sHosts.data }], xaxis: { categories: sHosts.categories, labels: { rotate: -45 } } });
		const sClientDown = toBarSeriesFromPairs(top.clients_by_cl_recv_bytes || top.clients_by_download_bytes || []);
		ensureChart('sbChartClientDown', 'bar', { series: [{ name: 'bytes', data: sClientDown.data }], xaxis: { categories: sClientDown.categories, labels: { rotate: -45 } }, yaxis: { labels: { formatter: v => humanBytes(v) } }, tooltip: { y: { formatter: v => humanBytes(v) } } });
		const sClientUp = toBarSeriesFromPairs(top.clients_by_cl_sent_bytes || top.clients_by_upload_bytes || []);
		ensureChart('sbChartClientUp', 'bar', { series: [{ name: 'bytes', data: sClientUp.data }], xaxis: { categories: sClientUp.categories, labels: { rotate: -45 } }, yaxis: { labels: { formatter: v => humanBytes(v) } }, tooltip: { y: { formatter: v => humanBytes(v) } } });
		const sHostDown = toBarSeriesFromPairs(top.hosts_by_srv_recv_bytes || top.hosts_by_download_bytes || []);
		ensureChart('sbChartHostDown', 'bar', { series: [{ name: 'bytes', data: sHostDown.data }], xaxis: { categories: sHostDown.categories, labels: { rotate: -45 } }, yaxis: { labels: { formatter: v => humanBytes(v) } }, tooltip: { y: { formatter: v => humanBytes(v) } } });
		const sHostUp = toBarSeriesFromPairs(top.hosts_by_srv_sent_bytes || top.hosts_by_upload_bytes || []);
		ensureChart('sbChartHostUp', 'bar', { series: [{ name: 'bytes', data: sHostUp.data }], xaxis: { categories: sHostUp.categories, labels: { rotate: -45 } }, yaxis: { labels: { formatter: v => humanBytes(v) } }, tooltip: { y: { formatter: v => humanBytes(v) } } });
		$('#sbCharts').show();
	}

	function saveResult(payload){ try{ localStorage.setItem(STORAGE_KEY, JSON.stringify(payload)); }catch(e){} }
	function restoreResult(){
		try{
			const raw = localStorage.getItem(STORAGE_KEY);
			if(!raw) return;
			const data = JSON.parse(raw);
			if(!data || typeof data !== 'object') return;
			renderSummary(data); // Pass the full object
			renderCharts(data);
			setStatus('저장된 분석 결과', 'is-light');
			$('#sbAnalyzeSection').show();
		}catch(e){}
	}

	function clearResult(){ try{ localStorage.removeItem(STORAGE_KEY); }catch(e){} }

	async function runAnalyze(opts){
		clearError();
		try{
			const pids = (opts && Array.isArray(opts.proxyIds)) ? opts.proxyIds : [];
			if(pids.length === 0){ showError('프록시를 선택하세요.'); return; }
			const topN = Math.max(1, Math.min(100, parseInt((opts && opts.topN) ? String(opts.topN) : '20', 10)));
			setStatus('분석 중...', 'is-info');
			const qs = $.param({ proxy_ids: pids.join(','), topN: topN });
			const res = await fetch(`${API_BASE}/session-browser/analyze?${qs}`);
			if(!res.ok){ const err = await res.json().catch(()=>({detail:'분석 실패'})); throw new Error(err.detail || '분석 실패'); }
			const data = await res.json();
			renderSummary(data); // Pass the full object
			renderCharts(data);
			clearResult(); // Clear previous results only on success
			saveResult(data);
			$('#sbAnalyzeSection').show();
			setStatus('완료', 'is-success');
		}catch(e){ showError(e.message || String(e)); setStatus('실패', 'is-danger'); }
	}

	// Expose to other scripts
	window.SbAnalyze = {
		run: runAnalyze,
		restore: restoreResult,
		showSection: function(){ $('#sbAnalyzeSection').show(); }
	};

	$(function(){ restoreResult(); });
})();