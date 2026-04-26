/**
 * Staff Authentication
 * Roles: system_admin (highest, cannot be removed), admin, cashier, kitchen_staff
 * Attributes: id_number, full_name, password
 */

const STAFF_SESSION_KEY = 'quicktap_staff_session';
const SALT_LENGTH = 16;
const ITERATIONS = 100000;
const KEY_LENGTH = 32;

async function hashPassword(password, salt) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const saltBytes = typeof salt === 'string' ? hexToBytes(salt) : salt;
  const derived = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt: saltBytes,
      iterations: ITERATIONS
    },
    keyMaterial,
    KEY_LENGTH * 8
  );
  return bytesToHex(new Uint8Array(derived));
}

function generateSalt() {
  const arr = new Uint8Array(SALT_LENGTH);
  crypto.getRandomValues(arr);
  return bytesToHex(arr);
}

function bytesToHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex) {
  const arr = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) arr[i / 2] = parseInt(hex.substr(i, 2), 16);
  return arr;
}

window.getStaffSession = function() {
  try {
    const raw = sessionStorage.getItem(STAFF_SESSION_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (_) { return null; }
};

window.setStaffSession = function(staff) {
  sessionStorage.setItem(STAFF_SESSION_KEY, JSON.stringify(staff));
};

window.logSystemAction = async function(action, details, staffOverride) {
  try {
    const db = getDB();
    if (!db) return;
    const staff = staffOverride || getStaffSession();
    if (!staff) return;
    await db.from('admin_logs').insert({
      admin_id: staff.id,
      admin_name: staff.full_name,
      action: String(action || 'Activity'),
      details: details ? String(details) : null
    });
  } catch (e) {
    console.warn('[Staff] Activity log failed:', e);
  }
};

window.clearStaffSession = function() {
  sessionStorage.removeItem(STAFF_SESSION_KEY);
};

window.isStaffLoggedIn = function() {
  return !!getStaffSession();
};

window.getStaffRole = function() {
  const s = getStaffSession();
  return s ? s.role : null;
};

window.canAccessAdmin = function() {
  const r = getStaffRole();
  return r === 'system_admin' || r === 'admin';
};

window.canAccessCashier = function() {
  return ['system_admin', 'admin', 'cashier'].includes(getStaffRole());
};

window.canAccessKitchen = function() {
  return ['system_admin', 'admin', 'cashier', 'kitchen_staff'].includes(getStaffRole());
};

window.canRegisterStaff = function() {
  return ['system_admin', 'admin'].includes(getStaffRole());
};

window.canRemoveStaff = function(staff) {
  if (staff && staff.is_system_admin) return false;
  return ['system_admin', 'admin'].includes(getStaffRole());
};

window.staffLogin = async function(idNumber, password) {
  const db = getDB();
  if (!db) throw new Error('Database not ready');

  const { data: staff, error: fetchErr } = await db
    .from('staff')
    .select('*')
    .eq('id_number', String(idNumber).trim())
    .single();

  if (fetchErr || !staff) return { ok: false, message: 'Invalid ID number or password' };
  if (staff.archived === true) return { ok: false, message: 'Account is archived. Please contact an admin.' };
  if (!staff.salt || !staff.password_hash) return { ok: false, message: 'Account not properly configured' };

  const hash = await hashPassword(password, staff.salt);
  if (hash !== staff.password_hash) return { ok: false, message: 'Invalid ID number or password' };

  const session = {
    id: staff.id,
    id_number: staff.id_number,
    full_name: staff.full_name,
    role: staff.role,
    is_system_admin: !!staff.is_system_admin
  };
  setStaffSession(session);
  if (window.logSystemAction) {
    await logSystemAction('Staff login', `${session.full_name} (${session.role})`, session);
  }
  return { ok: true, staff: session };
};

/** First-time setup: create system admin when no staff exist. No auth required. */
window.staffRegisterSystemAdmin = async function(idNumber, fullName, password) {
  const db = getDB();
  if (!db) throw new Error('Database not ready');

  const { data: existing } = await db.from('staff').select('id').limit(1);
  if (existing && existing.length > 0) throw new Error('Staff already exist. Use staff login.');

  const id = String(idNumber).trim();
  const name = String(fullName).trim();
  if (!id || !name || !password) throw new Error('ID number, full name, and password are required');
  if (password.length < 6) throw new Error('Password must be at least 6 characters');

  const salt = generateSalt();
  const password_hash = await hashPassword(password, salt);

  const { error } = await db.from('staff').insert({
    id_number: id,
    full_name: name,
    password_hash,
    salt,
    plain_password: password, // Store plain password for admin viewing
    role: 'system_admin',
    is_system_admin: true
  });

  if (error) throw error;
  return { ok: true };
};

window.staffRegister = async function(idNumber, fullName, password, role, username, email) {
  if (!canRegisterStaff()) throw new Error('Not allowed to register staff');

  const db = getDB();
  if (!db) throw new Error('Database not ready');

  const id = String(idNumber).trim();
  const name = String(fullName).trim();
  const user = username ? String(username).trim() : null;
  const mail = email ? String(email).trim() : null;

  if (!id || !name || !password || !role) throw new Error('ID number, full name, password, and role are required');
  if (password.length < 6) throw new Error('Password must be at least 6 characters');

  const allowedRoles = ['admin', 'cashier', 'kitchen_staff'];
  if (!allowedRoles.includes(role)) throw new Error('Invalid role');

  // Check for existing ID number
  const { data: existingId } = await db
    .from('staff')
    .select('id')
    .eq('id_number', id)
    .maybeSingle();
  if (existingId) return { ok: false, message: 'Staff account already exists (ID Number duplicate).' };

  // Check for existing Username if provided
  if (user) {
    const { data: existingUser } = await db
      .from('staff')
      .select('id')
      .eq('username', user)
      .maybeSingle();
    if (existingUser) return { ok: false, message: 'Staff account already exists (Username duplicate).' };
  }

  // Check for existing Email if provided
  if (mail) {
    const { data: existingEmail } = await db
      .from('staff')
      .select('id')
      .eq('email', mail)
      .maybeSingle();
    if (existingEmail) return { ok: false, message: 'Staff account already exists (Email duplicate).' };
  }

  const salt = generateSalt();
  const password_hash = await hashPassword(password, salt);

  const payload = {
    id_number: id,
    full_name: name,
    password_hash,
    salt,
    plain_password: password, // Store plain password for admin viewing
    role
  };
  if (user) payload.username = user;
  if (mail) payload.email = mail;

  const { error } = await db.from('staff').insert(payload);

  if (error) {
    if (error.code === '23505') return { ok: false, message: 'Staff account already exists.' };
    throw error;
  }
  return { ok: true };
};

/** Public login page (project root index.html), works when staff apps live under /staffs/... */
window.getStaffPortalIndexHref = function () {
  const p = window.location.pathname || "";
  const mark = "/staffs/";
  const idx = p.indexOf(mark);
  if (idx === -1) return "../index.html";
  const base = p.slice(0, idx);
  return (base || "") + "/index.html";
};

window.staffLogout = async function (opts) {
  stopAdminInactivityLogout();
  const sess = getStaffSession();
  const reason = opts && opts.reason;
  if (window.logSystemAction && sess) {
    try {
      const action = reason === 'inactivity' ? 'Session timeout' : 'Staff logout';
      const details =
        reason === 'inactivity'
          ? 'Logged out automatically after a period of inactivity'
          : `${sess.full_name} (${sess.role})`;
      await logSystemAction(action, details, sess);
    } catch (_) {}
  }
  clearStaffSession();
  let href = getStaffPortalIndexHref();
  if (reason === 'inactivity') {
    href += (href.indexOf('?') >= 0 ? '&' : '?') + 'logout=inactivity';
  }
  window.location.replace(href);
};

/** Default admin idle timeout (ms). Override before loading staff-auth: window.QUICKTAP_ADMIN_INACTIVITY_MS = 20 * 60 * 1000 */
const DEFAULT_ADMIN_INACTIVITY_MS = 5 * 60 * 1000;

let adminInactivityTimer = null;
let adminInactivityMs = DEFAULT_ADMIN_INACTIVITY_MS;
let adminInactivityHandler = null;
let adminInactivityThrottleUntil = 0;

function isAdminAppPath() {
  const path = window.location.pathname || '';
  return path.indexOf('staffs/admin') !== -1 || /admin\.html/i.test(path);
}

window.stopAdminInactivityLogout = function () {
  if (adminInactivityTimer) {
    clearTimeout(adminInactivityTimer);
    adminInactivityTimer = null;
  }
  if (adminInactivityHandler) {
    const h = adminInactivityHandler;
    const events = ['keydown', 'mousedown', 'touchstart', 'scroll', 'click', 'wheel', 'visibilitychange'];
    events.forEach((ev) => {
      try {
        if (ev === 'scroll') document.removeEventListener(ev, h, { capture: true });
        else document.removeEventListener(ev, h);
      } catch (_) {}
    });
    adminInactivityHandler = null;
  }
  adminInactivityThrottleUntil = 0;
};

/**
 * Auto-logout admin users after idle period. Only runs on the admin dashboard.
 * @param {number} [ms] — idle duration in milliseconds (default 5 min or window.QUICKTAP_ADMIN_INACTIVITY_MS)
 */
window.initAdminInactivityLogout = function (ms) {
  window.stopAdminInactivityLogout();
  if (!isAdminAppPath()) return;
  if (typeof window.canAccessAdmin !== 'function' || !window.canAccessAdmin()) return;
  if (typeof window.isStaffLoggedIn !== 'function' || !window.isStaffLoggedIn()) return;

  const fromGlobal =
    typeof window.QUICKTAP_ADMIN_INACTIVITY_MS === 'number' && window.QUICKTAP_ADMIN_INACTIVITY_MS > 0
      ? window.QUICKTAP_ADMIN_INACTIVITY_MS
      : null;
  adminInactivityMs =
    Number(ms) > 0 ? Number(ms) : fromGlobal != null ? fromGlobal : DEFAULT_ADMIN_INACTIVITY_MS;

  const schedule = () => {
    if (adminInactivityTimer) clearTimeout(adminInactivityTimer);
    adminInactivityTimer = setTimeout(async () => {
      adminInactivityTimer = null;
      if (typeof window.canAccessAdmin !== 'function' || !window.canAccessAdmin()) return;
      if (typeof window.isStaffLoggedIn !== 'function' || !window.isStaffLoggedIn()) return;
      try {
        await window.staffLogout({ reason: 'inactivity' });
      } catch (_) {
        clearStaffSession();
        const base = getStaffPortalIndexHref();
        window.location.replace(base + (base.indexOf('?') >= 0 ? '&' : '?') + 'logout=inactivity');
      }
    }, adminInactivityMs);
  };

  const THROTTLE_MS = 2000;
  adminInactivityHandler = function () {
    if (document.visibilityState === 'hidden') return;
    const now = Date.now();
    if (now < adminInactivityThrottleUntil) return;
    adminInactivityThrottleUntil = now + THROTTLE_MS;
    schedule();
  };

  const events = ['keydown', 'mousedown', 'touchstart', 'scroll', 'click', 'wheel', 'visibilitychange'];
  events.forEach((ev) => {
    const opts = ev === 'scroll' ? { capture: true, passive: true } : { passive: true };
    try {
      document.addEventListener(ev, adminInactivityHandler, opts);
    } catch (_) {
      document.addEventListener(ev, adminInactivityHandler);
    }
  });

  schedule();
};

let staffBackGuardInstalled = false;

/**
 * Keeps staff on their dashboard when using the browser back button.
 * Login uses location.replace so index is not stacked; this traps any remaining history edge cases.
 * Only logout should return to index.html.
 */
window.initStaffBackGuard = function () {
  if (staffBackGuardInstalled) return;
  if (typeof window.isStaffLoggedIn !== 'function' || !window.isStaffLoggedIn()) return;
  const path = window.location.pathname || '';
  if (path.indexOf('staffs/') === -1) return;
  staffBackGuardInstalled = true;
  try {
    window.history.pushState({ __qtStaff: 1 }, '', window.location.href);
  } catch (_) {}
  window.addEventListener('popstate', function () {
    if (typeof window.isStaffLoggedIn !== 'function' || !window.isStaffLoggedIn()) return;
    try {
      window.history.pushState({ __qtStaff: 1 }, '', window.location.href);
    } catch (_) {}
  });
};

if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', function () {
    if (typeof window.initStaffBackGuard === 'function') window.initStaffBackGuard();
    if (typeof window.initAdminInactivityLogout === 'function') window.initAdminInactivityLogout();
  });
}

/** Check if staff table is empty (first-time setup) */
window.needsStaffSetup = async function() {
  const db = getDB();
  if (!db) return false;
  const { data } = await db.from('staff').select('id').limit(1);
  return !data || data.length === 0;
};
