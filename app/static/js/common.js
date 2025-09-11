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
		}
	};

	window.AppUtils = AppUtils;

})(window);