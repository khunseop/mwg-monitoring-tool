$(document).ready(function() {
    // Navbar burger toggle
    $(document).on('click', '.navbar-burger', function() {
        const $this = $(this);
        const targetId = $this.attr('data-target');
        const willBeActive = !$this.hasClass('is-active');
        $this.toggleClass('is-active', willBeActive).attr('aria-expanded', willBeActive);
        $('#' + targetId).toggleClass('is-active', willBeActive);
    });

    // Bulma dropdown: enable click toggle for mobile-only settings dropdown
    $(document).on('click', '#settingsDropdownMobile > .navbar-link', function(e) {
        e.preventDefault();
        e.stopPropagation();
        const $parent = $(this).closest('.navbar-item.has-dropdown');
        $parent.toggleClass('is-active');
    });

    // Auto-collapse burger menu after clicking any navbar-item (mobile)
    $(document).on('click', '.navbar-item', function() {
        const desktopQuery = window.matchMedia('(min-width: 1024px)');
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

document.addEventListener("DOMContentLoaded", () => {
    // 모든 모달 열기 버튼
    const openModalButtons = document.querySelectorAll(".modal-open");
    // 모든 모달 닫기 트리거 (.delete, .modal-background, .modal-close)
    const closeModalTriggers = document.querySelectorAll(".modal .delete, .modal .modal-background, .modal .modal-close");
  
    function openModal(modal) {
      modal.classList.add("is-active");
    }
  
    function closeModal(modal) {
      modal.classList.remove("is-active");
    }
  
    function closeAllModals() {
      document.querySelectorAll(".modal.is-active")
        .forEach(m => m.classList.remove("is-active"));
    }
  
    // 열기 버튼 클릭 → 해당 모달 열기
    openModalButtons.forEach(btn => {
      btn.addEventListener("click", () => {
        const target = btn.dataset.target;
        const modal = document.getElementById(target);
        if (modal) openModal(modal);
      });
    });
  
    // 닫기 트리거 클릭 → 모달 닫기
    closeModalTriggers.forEach(trigger => {
      trigger.addEventListener("click", () => {
        const modal = trigger.closest(".modal");
        closeModal(modal);
      });
    });
  
    // ESC 키 → 모든 모달 닫기
    document.addEventListener("keydown", event => {
      if (event.key === "Escape") {
        closeAllModals();
      }
    });
  });
