// auth.js

// Supabase-based logout and protection helpers

// This helper is called from pages (e.g. dashboard.html) once supabaseClient exists
function wireLogoutButtonsWithSupabase(supabaseClient) {
  const logoutBtn = document.getElementById('logoutBtn');
  const logoutBtnProfile = document.getElementById('logoutBtnProfile');
  const logoutBtnMobile = document.getElementById('logoutBtnMobile');
  const logoutModal = document.getElementById('logoutModal');
  const cancelBtn = document.getElementById('cancelLogoutBtn');
  const confirmBtn = document.getElementById('confirmLogoutBtn');

  function openModal() {
    if (!logoutModal) return;
    logoutModal.classList.remove('hidden');
    logoutModal.classList.add('flex');
  }

  function closeModal() {
    if (!logoutModal) return;
    logoutModal.classList.add('hidden');
    logoutModal.classList.remove('flex');
  }

  const openButtons = [logoutBtn, logoutBtnProfile, logoutBtnMobile].filter(Boolean);
  openButtons.forEach(btn => btn.addEventListener('click', openModal));

  if (cancelBtn) {
    cancelBtn.addEventListener('click', closeModal);
  }

  if (confirmBtn) {
    confirmBtn.addEventListener('click', async () => {
      try {
        await supabaseClient.auth.signOut();
      } catch (e) {
        console.error('Error during sign out', e);
      } finally {
        closeModal();
        window.location.href = 'index.html';
      }
    });
  }
}

// Simple protection for dashboard.html if you want to use it on other pages later
async function protectDashboardPageWithSupabase(supabaseClient) {
  const path = window.location.pathname;
  if (path.endsWith('dashboard.html')) {
    const { data, error } = await supabaseClient.auth.getUser();
    if (error || !data.user) {
      window.location.href = 'signup.html';
    }
  }
}
