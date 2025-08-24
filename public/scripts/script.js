   document.addEventListener('DOMContentLoaded', () => {
  // Mobile Menu Toggle
  const mobileMenuBtn = document.getElementById('mobileMenuBtn');
  const mobileMenu = document.getElementById('mobileMenu');
  if (mobileMenuBtn && mobileMenu) {
    mobileMenuBtn.addEventListener('click', () => {
      mobileMenu.classList.toggle('hidden');
    });
  }

  // Sign-In Modal
  const signInBtn = document.getElementById('signInBtn');
  const signInModal = document.getElementById('signInModal');
  const closeModalBtn = document.getElementById('closeModalBtn');

  if (signInBtn) {
    signInBtn.addEventListener('click', (e) => {
      e.preventDefault();
      window.location.href = '/signin';
    });
  }

  if (closeModalBtn && signInModal) {
    closeModalBtn.addEventListener('click', () => {
      signInModal.classList.remove('show');
    });
  }

  if (signInModal) {
    signInModal.addEventListener('click', (e) => {
      if (e.target === signInModal) {
        signInModal.classList.remove('show');
      }
    });
  }
});