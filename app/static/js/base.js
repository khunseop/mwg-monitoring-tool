$(document).ready(function() {
    // Navbar burger toggle
    $(document).on('click', '.navbar-burger', function() {
        const $this = $(this);
        const targetId = $this.attr('data-target');
        const willBeActive = !$this.hasClass('is-active');
        $this.toggleClass('is-active', willBeActive).attr('aria-expanded', willBeActive);
        $('#' + targetId).toggleClass('is-active', willBeActive);
        // Always collapse settings submenu when using burger
        setNavbarExpanded(false);
    });

    // Navbar expandable (hover-only for settings)
    const $navbar = $('.navbar');
    const desktopQuery = window.matchMedia('(min-width: 1024px)');
    let collapseTimer = null;

    function setNavbarExpanded(expanded) {
        $navbar.toggleClass('is-expanded', !!expanded);
    }

    // start collapsed
    setNavbarExpanded(false);

    function updateNavbarMode() {
        if (!desktopQuery.matches) {
            setNavbarExpanded(false);
        }
    }

    if (typeof desktopQuery.addEventListener === 'function') {
        desktopQuery.addEventListener('change', updateNavbarMode);
    } else if (typeof desktopQuery.addListener === 'function') {
        desktopQuery.addListener(updateNavbarMode);
    }
    updateNavbarMode();

    // open on hover over settings item or submenu
    $(document).on('mouseenter', '#navSettings, .navbar-submenu', function() {
        if (!desktopQuery.matches) return;
        if (collapseTimer) { clearTimeout(collapseTimer); collapseTimer = null; }
        setNavbarExpanded(true);
    });

    // close with a small delay when leaving entire navbar area
    $(document).on('mouseleave', '.navbar', function(e) {
        if (!desktopQuery.matches) return;
        const self = this;
        const related = e.relatedTarget;
        if (related && $.contains(self, related)) return;
        if (collapseTimer) clearTimeout(collapseTimer);
        collapseTimer = setTimeout(() => setNavbarExpanded(false), 500);
    });

    // Auto-collapse burger menu after clicking any navbar-item (mobile)
    $(document).on('click', '.navbar-item', function() {
        if (desktopQuery.matches) return;
        const $burger = $('.navbar-burger');
        const targetId = $burger.attr('data-target');
        if (!$burger.hasClass('is-active')) return;
        $burger.removeClass('is-active').attr('aria-expanded', false);
        $('#' + targetId).removeClass('is-active');
    });

    // Simple accordion toggle (avoid mixing inline display with CSS class)
    // Initialize: clear any inline display so CSS controls initial visibility
    $('.accordion').each(function(){
        $(this).find('.accordion-body').css('display', '');
    });
    $(document).on('click', '.accordion .accordion-header', function(){
        const $acc = $(this).closest('.accordion');
        const $body = $acc.find('.accordion-body').first();
        // Stop current animations and jump to end, then sync class with actual visibility
        $body.stop(true, true);
        const isVisible = $body.is(':visible');
        $acc.toggleClass('is-open', isVisible);
        const willOpen = !isVisible;
        if (willOpen) {
            $body.slideDown(150, function(){
                $acc.addClass('is-open');
                $body.css('display', '');
            });
        } else {
            $body.slideUp(150, function(){
                $acc.removeClass('is-open');
                $body.css('display', '');
            });
        }
    });
});

