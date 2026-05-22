// Supabase Client Initialization
// Supabase credentials
const SUPABASE_URL = 'https://kaxwbggjjzakpazqqgmq.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtheHdiZ2dqanpha3BhenFxZ21xIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njk0MTUwOTUsImV4cCI6MjA4NDk5MTA5NX0.ln0c395fRs-N4NVOTamhGxaYGz0OCdg96r4LlCm1VnE';

// Wait for Supabase to load from CDN then initialize
function initializeSupabase() {
  if (typeof window.supabase === 'undefined') {
    console.error('[v0] Supabase JS SDK not loaded from CDN');
    setTimeout(initializeSupabase, 100);
    return;
  }

  const { createClient } = window.supabase;
  if (SUPABASE_URL && SUPABASE_ANON_KEY) {
    try {
      window.db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
      console.log('[v0] Supabase initialized successfully');
      window.dbReady = true;
      // Trigger any waiting callbacks
      if (window.onSupabaseReady) {
        window.onSupabaseReady();
      }
    } catch (error) {
      console.error('[v0] Error initializing Supabase:', error);
    }
  } else {
    console.warn('[v0] Supabase credentials not configured');
  }
}

// Helper function for getting database reference
window.getDB = () => {
  if (!window.db) {
    console.warn('[v0] Database not initialized yet');
    return null;
  }
  return window.db;
};

// Initialize when document is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializeSupabase);
} else {
  initializeSupabase();
}
