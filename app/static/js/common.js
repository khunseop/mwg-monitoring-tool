(function(window){
	'use strict';

	const AppUtils = {
		// Show a simple alert-based error (can be replaced with Bulma toast later)
		showError(message){
			window.alert(message || '오류가 발생했습니다.');
		},
		// Toggle element visibility by adding/removing Bulma helper classes
		setVisible(selectorOrEl, visible){
			const el = (typeof selectorOrEl === 'string') ? document.querySelector(selectorOrEl) : selectorOrEl;
			if(!el) return;
			if(visible){ el.style.removeProperty('display'); }
			else { el.style.display = 'none'; }
		},
		// Safe JSON parse
		tryParse(json, fallback){
			try { return JSON.parse(json); } catch(e) { return (fallback === undefined ? null : fallback); }
		},
		// Format number with thousand separators
		formatNumber(value){
			if(value === null || value === undefined || value === '') return '';
			var num = Number(value);
			if(!Number.isFinite(num)) return String(value);
			try { return num.toLocaleString(); } catch(e){ return String(num); }
		},
		// Format bytes to human readable units (KiB, MiB, GiB)
		formatBytes(value){
			if(value === null || value === undefined || value === '') return '';
			var num = Number(value);
			if(!Number.isFinite(num)) return String(value);
			var abs = Math.abs(num);
			var units = ['B','KB','MB','GB','TB'];
			var idx = 0;
			while(abs >= 1024 && idx < units.length - 1){ abs /= 1024; idx++; }
			var sign = (num < 0) ? '-' : '';
			return sign + (abs >= 100 ? abs.toFixed(0) : abs >= 10 ? abs.toFixed(1) : abs.toFixed(2)) + ' ' + units[idx];
		},
		// Format seconds to human form (e.g., 1h 2m 3s)
		formatSeconds(value){
			if(value === null || value === undefined || value === '') return '';
			var sec = Number(value);
			if(!Number.isFinite(sec)) return String(value);
			sec = Math.max(0, sec);
			var h = Math.floor(sec / 3600);
			var m = Math.floor((sec % 3600) / 60);
			var s = Math.floor(sec % 60);
			var parts = [];
			if(h) parts.push(h + 'h');
			if(m) parts.push(m + 'm');
			parts.push(s + 's');
			return parts.join(' ');
		},
		// Format milliseconds to short human form (e.g., 850 ms, 1.2 s, 3.5 m)
		formatDurationMs(value){
			if(value === null || value === undefined || value === '') return '';
			var ms = Number(value);
			if(!Number.isFinite(ms)) return String(value);
			if(ms < 1000) return Math.round(ms) + ' ms';
			var s = ms / 1000;
			if(s < 60) return (s < 10 ? s.toFixed(1) : Math.round(s)) + ' s';
			var m = s / 60;
			if(m < 60) return (m < 10 ? m.toFixed(1) : Math.round(m)) + ' m';
			var h = m / 60;
			return (h < 10 ? h.toFixed(1) : Math.round(h)) + ' h';
		},
		// Parse traffic-log style datetime like: [17/Sep/2025:17:22:29 +0900]
		parseTrafficLogDateMs(str){
			if(!str || typeof str !== 'string') return null;
			var s = str.trim();
			if(s[0] === '[' && s[s.length-1] === ']') s = s.slice(1, -1);
			// DD/Mon/YYYY:HH:MM:SS +/-ZZZZ
			var m = s.match(/^(\d{1,2})\/([A-Za-z]{3})\/(\d{4}):(\d{2}):(\d{2}):(\d{2})\s+([+\-]\d{4})$/);
			if(!m) return null;
			var day = parseInt(m[1], 10);
			var monStr = m[2].toLowerCase();
			var year = parseInt(m[3], 10);
			var hh = parseInt(m[4], 10);
			var mm = parseInt(m[5], 10);
			var ss = parseInt(m[6], 10);
			var tz = m[7];
			var monMap = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11 };
			var month = monMap[monStr];
			if(month == null) return null;
			var sign = tz[0] === '-' ? -1 : 1;
			var tzh = parseInt(tz.slice(1,3), 10) || 0;
			var tzm = parseInt(tz.slice(3,5), 10) || 0;
			var offsetMs = sign * ((tzh * 60) + tzm) * 60 * 1000;
			var utcMs = Date.UTC(year, month, day, hh, mm, ss) - offsetMs;
			return utcMs;
		},
		// Format timestamp string/number to YYYY-MM-DD HH:mm:ss (local)
		formatDateTime(value){
			if(value === null || value === undefined || value === '') return '';
			var d = null;
			if(value instanceof Date) d = value;
			else if(typeof value === 'number') d = new Date(value);
			else if(typeof value === 'string'){
				var trimmed = value.trim();
				// If numeric-like string, treat as epoch ms/sec
				if(/^\d{10,13}$/.test(trimmed)){
					var n = Number(trimmed);
					if(trimmed.length === 10) n = n * 1000;
					d = new Date(n);
				} else {
					// Try traffic-log style date first
					var ms = AppUtils.parseTrafficLogDateMs(trimmed);
					if(ms != null){ d = new Date(ms); }
					else {
					var parsed = Date.parse(trimmed);
					if(Number.isFinite(parsed)) d = new Date(parsed);
					}
				}
			}
			if(!d || isNaN(d.getTime())) return String(value);
			function pad(n){ return n < 10 ? '0' + n : '' + n; }
			var y = d.getFullYear();
			var M = pad(d.getMonth() + 1);
			var day = pad(d.getDate());
			var h = pad(d.getHours());
			var m = pad(d.getMinutes());
			var s = pad(d.getSeconds());
			return y + '-' + M + '-' + day + ' ' + h + ':' + m + ':' + s;
		},
		// Render status code as colored tag HTML (2xx/3xx/4xx/5xx)
		renderStatusTag(value){
			if(value === null || value === undefined || value === '') return '';
			var code = Number(value);
			if(!Number.isFinite(code)) return String(value);
			var family = Math.floor(code / 100);
			var cls = 'is-light';
			if(family === 2) cls = 'is-success';
			else if(family === 3) cls = 'is-link';
			else if(family === 4) cls = 'is-warning';
			else if(family === 5) cls = 'is-danger';
			return '<span class="tag ' + cls + ' mono">' + code + '</span>';
		},
		// Render boolean as yes/no tag
		renderBoolTag(value){
			var v = (value === true || value === 'true' || value === '1' || value === 1 || value === 'Y');
			var cls = v ? 'is-success' : 'is-light';
			return '<span class="tag ' + cls + ' mono">' + (v ? 'Y' : 'N') + '</span>';
		}
	};

	window.AppUtils = AppUtils;

})(window);