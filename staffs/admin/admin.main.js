// Admin Main Logic
console.log("Admin Main JS v4 Loaded - Fix ID Collision")

let db
let adminLogsUnsub = null
let cashierMonitorUnsub = null
let catalogUnsub = null
let promoRenderToken = 0
let adminAutoRefreshTimer = null
const ADMIN_AUTO_REFRESH_MS = 450

function isAdminPageVisible(pageId) {
  const el = document.getElementById(pageId)
  return !!(el && el.style.display !== 'none')
}

function scheduleAdminAutoRefresh() {
  if (adminAutoRefreshTimer) clearTimeout(adminAutoRefreshTimer)
  adminAutoRefreshTimer = setTimeout(() => {
    adminAutoRefreshTimer = null
    refreshAllRealTimeViews()
  }, ADMIN_AUTO_REFRESH_MS)
}

// Declare getDB function or import it
function getDB() {
  return window.db
}

async function safeUpdateRowAdmin(table, match, payload) {
  let currentPayload = { ...payload }
  const tryUpdate = async () => {
    let query = db.from(table).update(currentPayload)
    Object.entries(match || {}).forEach(([key, value]) => {
      query = query.eq(key, value)
    })
    return await query
  }
  let { error } = await tryUpdate()
  let attempts = 0
  while (error && attempts < 6) {
    const msg = String(error.message || "")
    let removed = false
    for (const col of Object.keys(currentPayload)) {
      const colHit = msg.includes(`'${col}'`) || msg.includes(`\"${col}\"`) || msg.includes(` ${col} `)
      const missing = msg.includes("does not exist") || msg.includes("schema cache") || msg.includes("Could not find")
      if (colHit && missing) {
        delete currentPayload[col]
        removed = true
        break
      }
    }
    if (!removed || Object.keys(currentPayload).length === 0) break
    ;({ error } = await tryUpdate())
    attempts++
  }
  if (error) throw error
  return true
}

// Initialize Supabase reference when database is ready
function initializeAdmin() {
  db = getDB()
  if (!db) {
    console.error('[v0] Database not available');
    setTimeout(initializeAdmin, 100);
    return;
  }
  
  console.log('[v0] Admin initialized');
  loadMenu()
  loadSizesDatalist()
  cleanupArchivedStaff()
  if (typeof window.loadPromos === 'function') {
    window.loadPromos()
  }
  if (typeof window.initCalendar === 'function') {
    window.initCalendar()
  }
  
  subscribeToBookings()
  subscribeToAdminLogsRealtime()
  subscribeToCashierMonitoringRealtime()
  subscribeToAdminCatalogRealtime()

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) scheduleAdminAutoRefresh()
  })

  // Initial page display
  if (typeof window.showPage === 'function') {
    window.showPage('analytics')
  }
}

async function cleanupArchivedStaff() {
  try {
    const cutoff = new Date()
    cutoff.setFullYear(cutoff.getFullYear() - 1)
    await db.from('staff').delete().eq('archived', true).lt('archived_at', cutoff.toISOString())
  } catch (e) {
    // Ignore if archive columns don't exist yet
  }
}

// Subscribe to real-time updates for all customer transactions
let bookingUnsub = null
let ordersUnsub = null
let salesUnsub = null

function subscribeToBookings() {
  if (bookingUnsub) return

  // 1. Subscribe to Bookings (Reservations/Pre-orders)
  bookingUnsub = db.channel('admin-bookings-channel')
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'bookings' },
      (payload) => {
        console.log('[v0] Booking update received:', payload)
        scheduleAdminAutoRefresh()
        
        // Show notification for new bookings
        if (payload.eventType === 'INSERT') {
            showMessage("New booking received!", "success")
        }
      }
    )
    .subscribe()

  // 2. Subscribe to Pending Orders (Active Kiosk/Walk-in Orders)
  if (!ordersUnsub) {
    ordersUnsub = db.channel('admin-orders-channel')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'pending_orders' },
        (payload) => {
          console.log('[v0] Order update received:', payload)
          scheduleAdminAutoRefresh()
          
          if (payload.eventType === 'INSERT') {
              showMessage("New active order received!", "info")
          }
        }
      )
      .subscribe()
  }

  // 3. Subscribe to Sales (Completed Transactions)
  if (!salesUnsub) {
    salesUnsub = db.channel('admin-sales-channel')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'sales' },
        (payload) => {
          console.log('[v0] Sales update received:', payload)
          scheduleAdminAutoRefresh()
        }
      )
      .subscribe()
  }
}

function subscribeToAdminCatalogRealtime() {
  if (!db) return
  if (catalogUnsub && typeof catalogUnsub.unsubscribe === 'function') {
    catalogUnsub.unsubscribe()
    catalogUnsub = null
  }
  catalogUnsub = db
    .channel('admin-catalog-sync')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'products' }, () => scheduleAdminAutoRefresh())
    .on('postgres_changes', { event: '*', schema: 'public', table: 'promos' }, () => scheduleAdminAutoRefresh())
    .on('postgres_changes', { event: '*', schema: 'public', table: 'staff' }, () => scheduleAdminAutoRefresh())
    .on('postgres_changes', { event: '*', schema: 'public', table: 'customers' }, () => scheduleAdminAutoRefresh())
    .subscribe()
}

function refreshAllRealTimeViews() {
  if (isAdminPageVisible('bookings')) {
    if (typeof window.renderBookingsList === 'function') window.renderBookingsList()
    if (typeof window.renderCalendar === 'function') window.renderCalendar()
    if (typeof renderPendingRequests === 'function') {
      try {
        renderPendingRequests(currentRequestType, currentRequestStatus)
      } catch (_) {}
    }
  }

  if (isAdminPageVisible('analytics')) {
    if (typeof runDashboard === 'function') runDashboard()
    const transTab = document.getElementById('analyticsTransactionsTab')
    if (transTab && transTab.style.display !== 'none' && typeof fetchTransactions === 'function') fetchTransactions()
  }

  if (isAdminPageVisible('sales')) {
    if (typeof window.renderSales === 'function') window.renderSales()
    if (typeof window.renderProductSales === 'function') window.renderProductSales()
  }

  if (isAdminPageVisible('menu') && typeof loadMenu === 'function') loadMenu()

  if (isAdminPageVisible('promos') && typeof window.loadPromos === 'function') window.loadPromos()

  if (isAdminPageVisible('staff')) {
    const act = document.getElementById('activeStaffPanel')
    const arch = document.getElementById('archiveStaffPanel')
    const mon = document.getElementById('monitorStaffPanel')
    if (act && act.style.display !== 'none' && typeof window.loadStaffList === 'function') window.loadStaffList()
    else if (arch && arch.style.display !== 'none' && typeof window.loadArchivedStaffList === 'function') window.loadArchivedStaffList()
    else if (mon && mon.style.display !== 'none' && typeof window.loadAdminLogs === 'function') window.loadAdminLogs()
  }

  if (isAdminPageVisible('monitorings')) {
    const adminBtn = document.getElementById('monTabAdminLogs')
    const cashBtn = document.getElementById('monTabCashier')
    if (adminBtn && adminBtn.classList.contains('active') && typeof window.loadAdminLogs === 'function') window.loadAdminLogs()
    if (cashBtn && cashBtn.classList.contains('active') && typeof window.loadCashierMonitoring === 'function') window.loadCashierMonitoring()
  }

  if (isAdminPageVisible('reports') && typeof window.renderReports === 'function') window.renderReports()

  if (isAdminPageVisible('settings') && typeof window.loadPaymentSettings === 'function') window.loadPaymentSettings()

  if (typeof renderTodos === 'function' && typeof selectedTodoDate !== 'undefined' && selectedTodoDate) renderTodos()
}

// --- ADMIN LOGS ---
window.logAdminAction = async function(action, details) {
  try {
    const s = typeof getStaffSession === 'function' ? getStaffSession() : null
    if (!s) return
    const dbRef = db || getDB()
    if (!dbRef) return
    await dbRef.from('admin_logs').insert({
      admin_id: s.id,
      admin_name: s.full_name,
      action,
      details: details ? String(details) : null
    })
  } catch (e) { console.warn('[Admin] Log failed:', e) }
}

// --- CASHIER MONITORING ---
window.applyCashierMonitorRange = function() {
  const rangeEl = document.getElementById('cashierMonitorRange')
  const startEl = document.getElementById('cashierMonitorStart')
  const endEl = document.getElementById('cashierMonitorEnd')
  if (!rangeEl || !startEl || !endEl) {
    if (typeof loadCashierMonitoring === 'function') loadCashierMonitoring()
    return
  }

  const today = new Date()
  let startDate = new Date(today)
  let endDate = new Date(today)
  const range = rangeEl.value || 'daily'

  if (range === 'weekly') {
    const day = today.getDay()
    const diff = (day + 6) % 7
    startDate.setDate(today.getDate() - diff)
    endDate = new Date(startDate)
    endDate.setDate(startDate.getDate() + 6)
  } else if (range === 'monthly') {
    startDate = new Date(today.getFullYear(), today.getMonth(), 1)
    endDate = new Date(today.getFullYear(), today.getMonth() + 1, 0)
  }

  startEl.value = startDate.toISOString().slice(0, 10)
  endEl.value = endDate.toISOString().slice(0, 10)
  if (typeof loadCashierMonitoring === 'function') loadCashierMonitoring()
}

// --- MONITORINGS (CASHIER TRANSACTIONS) ---
function formatCashierActivityDetail(str) {
  if (!str) return '';
  
  // 1. Clean technical ISO timestamps first (e.g. 2026-03-25T15:52:59.987Z -> 15:52:59)
  const isoRegex = /\d{4}-\d{2}-\d{2}T(\d{2}:\d{2}:\d{2})(?:\.\d+)?Z?/g;
  let processed = str.replace(isoRegex, (match, time) => time);

  // 2. Remove "ORDER" and "ORDER_ID" labels entirely as requested
  processed = processed.replace(/(ORDER|ORDER_ID):\s*/gi, '');

  // 3. Try to extract key-value pairs (handles both "key:val | key:val" and "key:val key:val")
  // This regex looks for word:value patterns
  const kvRegex = /(\w+):([^|]+?)(?=\s+\w+:|$|\|)/g;
  const matches = [...processed.matchAll(kvRegex)];
  
  if (matches.length > 0) {
    let html = '<table style="width: 100%; font-size: 0.75rem; border-collapse: collapse; margin-top: 4px; background: #fff; border: 1px solid #eee;">';
    matches.forEach(m => {
      const key = m[1].trim();
      const value = m[2].trim();
      html += `<tr>
        <td style="padding: 4px 8px; color: #888; font-weight: bold; width: 40%; border: 1px solid #eee; background: #fafafa; text-transform: uppercase; font-size: 0.65rem;">${key}</td>
        <td style="padding: 4px 8px; color: #333; border: 1px solid #eee;">${value}</td>
      </tr>`;
    });
    html += '</table>';
    
    // Check for any descriptive text that wasn't a key-value pair
    const leftover = processed.replace(kvRegex, '').replace(/\|/g, '').trim();
    if (leftover && leftover.length > 2) {
      return `<div style="margin-bottom:4px; font-size:0.8rem; color:#555;">${leftover}</div>` + html;
    }
    return html;
  }
  
  return processed;
}

function formatAutoRemarks(remarks) {
  if (!remarks) return '';
  if (!remarks.startsWith('Auto:')) return remarks;
  
  const clean = remarks.replace('Auto:', '').trim();
  
  // 1. Clean technical ISO timestamps first (e.g. 2026-03-25T15:52:59.987Z -> 15:52:59)
  const isoRegex = /\d{4}-\d{2}-\d{2}T(\d{2}:\d{2}:\d{2})(?:\.\d+)?Z?/g;
  const processedRemarks = clean.replace(isoRegex, (match, time) => time);

  // 2. Remove "ORDER" / "ORDER_ID" references
  const finalClean = processedRemarks.replace(/(ORDER|ORDER_ID):\s*/gi, '');

  const parts = finalClean.split('|').map(p => p.trim()).filter(p => p);
  
  let html = '<table style="width: 100%; font-size: 0.7rem; border-collapse: collapse; background: #fdfdfd; border: 1px solid #eee; border-radius: 4px; overflow: hidden;">';
  let hasRows = false;

  parts.forEach(part => {
    // Check if it's a simple key:value pair
    const colonCount = (part.match(/:/g) || []).length;
    
    if (colonCount === 1) {
      const [key, val] = part.split(':');
      html += `<tr>
        <td style="padding: 4px 8px; color: #999; font-weight: bold; border-bottom: 1px solid #eee; width: 35%; background: #fcfcfc; text-transform: uppercase; font-size: 0.6rem;">${key.trim()}</td>
        <td style="padding: 4px 8px; color: #444; border-bottom: 1px solid #eee;">${val.trim()}</td>
      </tr>`;
      hasRows = true;
    } else if (part.length > 0) {
      html += `<tr><td colspan="2" style="padding: 4px 8px; color: #777; font-style: italic; border-bottom: 1px solid #eee; background: #fff;">${part}</td></tr>`;
      hasRows = true;
    }
  });
  
  html += '</table>';
  return hasRows ? html : finalClean;
}

window.loadCashierMonitoring = async function() {
  const container = document.getElementById('cashierMonitorContainer')
  if (!container) return
  container.innerHTML = '<p>Loading...</p>'
  const selectEl = document.getElementById('cashierMonitorUser')
  let startEl = document.getElementById('cashierMonitorStart')
  let endEl = document.getElementById('cashierMonitorEnd')
  const today = new Date()
  const todayStr = today.toISOString().slice(0, 10)
  const start = (startEl && startEl.value) || todayStr
  const end = (endEl && endEl.value) || todayStr
  const selectedCashier = selectEl ? selectEl.value : ''

  try {
    // 1. Get ONLY staff with role 'cashier'
    // This automatically excludes Administrators and Kitchen Staff
    const { data: staffDataRaw } = await db.from('staff').select('id, full_name, id_number, role').eq('role', 'cashier')
    const staffData = staffDataRaw || []
    
    // Find the primary cashier (Ralph Bayya) to attribute Admin transactions to
    const primaryCashier = staffData.find(s => s.full_name.toLowerCase().includes('ralph bayya')) || staffData[0]

    const cashierIds = staffData.map(s => s.id)
    const cashierIdNumbers = staffData.map(s => s.id_number).filter(id => id)
    const cashierNames = staffData.map(s => s.full_name)
    const cashierNameMap = {}
    staffData.forEach(s => cashierNameMap[s.id] = s.full_name)

    let sales = null
    let error = null
    let hasRemarks = true
    let hasItems = true
    let filterColumn = 'date'
    const startTs = new Date(`${start}T00:00:00`)
    const endTs = new Date(`${end}T23:59:59.999`)
    
    // 2. Fetch logs for this period
    const { data: logsData } = await db.from('admin_logs')
      .select('*')
      .gte('created_at', startTs.toISOString())
      .lte('created_at', endTs.toISOString())
      .order('created_at', { ascending: false });

    // 3. Fetch sales for this period
    const runQuery = async (cols) => {
      let query = db.from('sales').select(cols.join(', '))
      // Fetch broader range and filter more precisely in JS if needed, but for now we try both columns
      if (filterColumn === 'date') {
        query = query.gte('date', start).lte('date', end)
      } else {
        query = query.gte('timestamp', startTs.toISOString()).lte('timestamp', endTs.toISOString())
      }
      return await query
    }

    let selectCols = ['id', 'total', 'amount', 'cashier_id', 'cashier_name', 'timestamp', 'cashier_remarks', 'items', 'date', 'type', 'insufficient_payment', 'total_order_amount', 'amount_due', 'booking_id']
    for (let attempt = 0; attempt < 4; attempt++) {
      ;({ data: sales, error } = await runQuery(selectCols))
      if (!error) break
      const msg = String(error.message || '')
      let removed = false
      const possibleCols = ['cashier_remarks', 'items', 'date', 'type', 'insufficient_payment', 'total_order_amount', 'amount_due', 'booking_id']
      for (const col of possibleCols) {
        if ((msg.includes(col) || msg.includes('does not exist')) && selectCols.includes(col)) {
           selectCols = selectCols.filter(c => c !== col)
           removed = true
           if (col === 'cashier_remarks') hasRemarks = false
           if (col === 'items') hasItems = false
           if (col === 'date' && filterColumn === 'date') filterColumn = 'timestamp'
        }
      }
      if (!removed) break
    }
    if (error) throw error

    // 4. Filter data to ONLY show cashier transactions and activity
    let filteredSales = (sales || []).filter(s => {
      // Point: System admin activities should NOT show in cashier monitoring
      // Only include transactions originally performed by a cashier
      const isCashier = cashierIds.includes(s.cashier_id) || 
                       cashierIdNumbers.includes(s.cashier_id) || 
                       cashierNames.includes(s.cashier_name)
      return isCashier
    })

    if (selectedCashier) {
      filteredSales = filteredSales.filter(s => {
        const key = s.cashier_id || s.cashier_name || 'Unassigned'
        const name = s.cashier_name || ''
        return key === selectedCashier || name === selectedCashier
      })
    }

    // Filter logs to ONLY show cashier activities
    const filteredLogs = (logsData || []).filter(l => {
      // Only include logs originally performed by a cashier
      const isCashier = cashierIds.includes(l.admin_id) || 
                       cashierIdNumbers.includes(l.admin_id) || 
                       cashierNames.includes(l.admin_name)
      return isCashier
    })

    // Group logs by staff member
    const cashierLogs = {};
    filteredLogs.forEach(log => {
      const key = log.admin_id || log.admin_name || 'Unknown';
      if (!cashierLogs[key]) cashierLogs[key] = [];
      cashierLogs[key].push(log);
    });

    // 5. Update Cashier Dropdown
    if (selectEl) {
      const byKey = {}
      // ONLY use staffData which contains cashiers
      staffData && staffData.forEach(s => { byKey[s.id] = s.full_name })
      
      selectEl.innerHTML = '<option value="">All Cashiers</option>' +
        Object.entries(byKey).sort((a, b) => (a[1] || '').localeCompare(b[1] || ''))
          .map(([k, label]) => `<option value="${k}">${label}</option>`).join('')
      if (selectedCashier) selectEl.value = selectedCashier
    }

    const summaryEl = document.getElementById('cashierMonitorSummary')
    const dailyEl = document.getElementById('cashierMonitorDaily')
    if (summaryEl) summaryEl.innerHTML = ''
    if (dailyEl) dailyEl.innerHTML = ''
    
    if (filteredSales.length === 0 && filteredLogs.length === 0) {
      if (summaryEl) summaryEl.innerHTML = '<p style="color: var(--coffee-dark); text-align:center; padding: 20px;">No cashier activity found in this date range.</p>'
      container.innerHTML = ''
      return
    }

    // 6. Calculate Totals for Forecasting
    const rangeEl = document.getElementById('cashierMonitorRange')
    const rangeLabel = rangeEl && rangeEl.options[rangeEl.selectedIndex]
      ? rangeEl.options[rangeEl.selectedIndex].textContent
      : 'Daily'
    const grandTotalSales = filteredSales.reduce((sum, s) => sum + Number(s.total || s.amount || 0), 0)
    const grandCount = filteredSales.length

    if (summaryEl) {
      summaryEl.innerHTML = `
        <div class="cashier-monitor-header" style="background: white; padding: 24px; border-radius: 16px; box-shadow: 0 4px 20px rgba(0,0,0,0.08); margin-bottom: 24px; border-left: 6px solid var(--accent-warm); display: flex; flex-direction: column; gap: 20px;">
          <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 24px;">
            <div class="cashier-monitor-period">
              <span style="display: block; font-size: 0.75rem; color: #888; text-transform: uppercase; letter-spacing: 0.1em; margin-bottom: 4px;">Monitoring Period</span>
              <div style="display: flex; align-items: baseline; gap: 8px;">
                <strong style="font-size: 1.4rem; color: var(--coffee-dark);">${rangeLabel}</strong>
                <span class="cashier-monitor-range" style="font-size: 0.85rem; color: #aaa;">(${start} to ${end})</span>
              </div>
            </div>
            
            <div style="display: flex; gap: 40px; flex-wrap: wrap;">
              <div class="cashier-monitor-metric" style="background: #fff9f5; padding: 12px 20px; border-radius: 12px; border: 1px solid #fee2d5;">
                <span style="display: block; font-size: 0.7rem; color: #a0522d; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 2px;">Total Sales</span>
                <strong style="font-size: 1.6rem; color: var(--accent-warm);">PHP ${grandTotalSales.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong>
              </div>
              <div class="cashier-monitor-metric" style="background: #f8f9fa; padding: 12px 20px; border-radius: 12px; border: 1px solid #e9ecef;">
                <span style="display: block; font-size: 0.7rem; color: #6c757d; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 2px;">Transaction Count</span>
                <strong style="font-size: 1.6rem; color: var(--coffee-dark);">${grandCount}</strong>
              </div>
            </div>
          </div>
          <div style="padding-top: 15px; border-top: 1px solid #f0f0f0; display: flex; align-items: center; gap: 10px; font-size: 0.85rem; color: #666;">
            <span style="background: #fffbe6; color: #856404; padding: 4px 10px; border-radius: 20px; border: 1px solid #ffeeba; font-weight: 600;">Forecasting Tip</span>
            Use these totals to predict peak hours and staffing needs for the next ${rangeLabel.toLowerCase()}.
          </div>
        </div>
      `
    }

    // 7. Grouping for Display
    const groups = {}
    // First, initialize groups for all active cashiers in staffData
    staffData.forEach(s => {
      groups[s.id] = { label: s.full_name, rows: [], logs: [], total: 0, count: 0, id_number: s.id_number }
    })

    filteredSales.forEach(s => {
      // Find which group this sale belongs to
      let groupKey = s.cashier_id
      // If s.cashier_id is an id_number, find the UUID
      if (!groups[groupKey]) {
        const staffByNum = staffData.find(st => st.id_number === s.cashier_id)
        if (staffByNum) groupKey = staffByNum.id
        else {
           // Try by name
           const staffByName = staffData.find(st => st.full_name === s.cashier_name)
           if (staffByName) groupKey = staffByName.id
        }
      }

      if (!groups[groupKey]) {
        // Fallback for unassigned or missing staff record
        const key = s.cashier_id || s.cashier_name || 'Unassigned'
        const label = s.cashier_name || s.cashier_id || 'Unassigned'
        groups[groupKey] = { label, rows: [], logs: [], total: 0, count: 0 }
      }

      groups[groupKey].rows.push(s)
      groups[groupKey].count += 1
      groups[groupKey].total += Number(s.total || s.amount || 0)
    })

    Object.keys(cashierLogs).forEach(key => {
      let groupKey = key
      if (!groups[groupKey]) {
        const staffByNum = staffData.find(st => st.id_number === key)
        if (staffByNum) groupKey = staffByNum.id
        else {
           const staffByName = staffData.find(st => st.full_name === key)
           if (staffByName) groupKey = staffByName.id
        }
      }

      if (!groups[groupKey]) {
        const logEntry = cashierLogs[key][0];
        const label = logEntry.admin_name || logEntry.admin_id || key;
        groups[groupKey] = { label, rows: [], logs: [], total: 0, count: 0 }
      }
      groups[groupKey].logs = cashierLogs[key]
    })

    container.innerHTML = Object.values(groups)
      .filter(g => (g.rows && g.rows.length > 0) || (g.logs && g.logs.length > 0)) // Only show cashiers with activity
      .sort((a, b) => a.label.localeCompare(b.label))
      .map(group => {
        // Create unified activity list for interleaved sorting
        const activity = [];
        
        // Add sales to activity
        group.rows.forEach(s => {
          // Robust timestamp detection
          const ts = s.timestamp || s.sale_date || (s.date ? `${s.date}T00:00:00.000Z` : '');
          activity.push({
            type: 'sale',
            timestamp: ts,
            data: s
          });
        });
        
        // Add logs to activity
        group.logs.forEach(l => {
          const ts = l.created_at || '';
          activity.push({
            type: 'log',
            timestamp: ts,
            data: l
          });
        });
        
        // Sort activity by timestamp descending (recent on top)
        activity.sort((a, b) => {
          const timeA = new Date(a.timestamp).getTime();
          const timeB = new Date(b.timestamp).getTime();
          return timeB - timeA;
        });

        const activityRows = activity.map(item => {
          if (item.type === 'sale') {
            const s = item.data;
            let ts = '-';
            if (s.timestamp) {
              const d = new Date(s.timestamp);
              ts = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
            }
            let txId = s.id ? `#${s.id}` : (s.booking_id ? `#B${s.booking_id}` : '-');
            let typeBadge = "";
            let leftColor = 'transparent';
            
            if (s.type === 'preorder' || s.booking_id) {
              leftColor = '#0d47a1'; // Blue
              typeBadge = '<span style="background: #e3f2fd; color: #0d47a1; padding: 2px 8px; border-radius: 4px; font-size: 0.7rem; font-weight: bold; margin-left: 5px;">PRE-ORDER</span>';
            } else if (s.type === 'kiosk_order') {
              leftColor = '#2e7d32'; // Green
              typeBadge = '<span style="background: #f1f8e9; color: #2e7d32; padding: 2px 8px; border-radius: 4px; font-size: 0.7rem; font-weight: bold; margin-left: 5px;">KIOSK</span>';
            }
            
            let items = [];
            if (hasItems && s.items) {
              try {
                items = typeof s.items === 'string' ? JSON.parse(s.items) : s.items;
                if (!Array.isArray(items)) items = [];
              } catch (_) { items = []; }
            }
            const qty = items.reduce((sum, i) => sum + Number(i.quantity || i.qty || 0), 0);
            const productList = items.length
              ? items.map(i => `<div style="margin-bottom: 2px;">• ${Number(i.quantity || i.qty || 1)}x ${i.name || i.product || 'Item'}</div>`).join("")
              : '-';
            const remarks = hasRemarks && s.cashier_remarks ? String(s.cashier_remarks) : '';
            
            // Refined amount details logic
            let amountDetails = `<strong>PHP ${Number(s.total || s.amount || 0).toFixed(2)}</strong>`;
            
            // If it's a pre-order record with 0.00 total but items exist, calculate it
            let actualTotal = Number(s.total || s.amount || 0);
            if (s.type === 'preorder' && actualTotal === 0 && items.length > 0) {
               actualTotal = items.reduce((sum, i) => {
                 const lineTotal = Number(i.amount || 0) || (Number(i.price || 0) * Number(i.quantity || i.qty || 1));
                 return sum + lineTotal;
               }, 0);
               amountDetails = `<strong>PHP ${actualTotal.toFixed(2)}</strong> <span style="font-size: 0.7rem; color: #888; display: block;">(Calculated)</span>`;
            }

            if (s.type === 'preorder' && s.total_order_amount > 0) {
               const paid = actualTotal;
               const due = Number(s.amount_due || 0);
               const fullTotal = Number(s.total_order_amount || 0);
               
               if (due > 0) {
                 amountDetails = `
                   <div style="color: #d9534f;">Paid: ₱${paid.toFixed(2)}</div>
                   <div style="color: #f0ad4e; font-size: 0.8rem;">Due: ₱${due.toFixed(2)}</div>
                   <div style="border-top: 1px solid #eee; margin-top: 4px; padding-top: 4px; font-size: 0.75rem; color: #888;">Total: ₱${fullTotal.toFixed(2)}</div>
                 `
               } else {
                 amountDetails = `
                   <div style="color: #2e7d32;">Paid: ₱${paid.toFixed(2)}</div>
                   <div style="font-size: 0.75rem; color: #5cb85c;">(Fully Paid)</div>
                 `
               }
            }

            const formattedRemarks = formatAutoRemarks(remarks);
            
            return `<tr style="border-bottom: 1px solid #f5f5f5;">
                <td class="monitor-td" style="font-size: 0.85rem; color: #666; font-weight: normal; border-left: 4px solid ${leftColor}; padding-left: 16px;">${ts}</td>
                <td class="monitor-td" style="font-family: 'Courier New', monospace; font-size: 0.85rem; font-weight: normal;">${txId}${typeBadge}</td>
                <td class="monitor-td" style="text-align: center; font-weight: normal;">${qty || '-'}</td>
                <td class="monitor-td" style="font-size: 0.85rem; line-height: 1.4; font-weight: normal;">${productList}</td>
                <td class="monitor-td" style="white-space: nowrap; font-weight: normal;">${amountDetails}</td>
                <td class="monitor-td monitor-remarks" style="font-size: 0.8rem; color: #777; font-weight: normal;">${formattedRemarks}</td>
              </tr>`;
          } else {
            const l = item.data;
            const d = new Date(l.created_at);
            const ts = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
            const formattedDetails = formatCashierActivityDetail(l.details);
            
            return `<tr style="background: #fafafa; border-bottom: 1px solid #eee;">
              <td class="monitor-td" style="font-size: 0.8rem; color: #999; font-weight: normal; border-left: 4px solid #eee; padding-left: 16px;">${ts}</td>
              <td class="monitor-td" style="font-weight: normal;">
                <span style="background: #eee; color: #666; padding: 2px 6px; border-radius: 4px; font-size: 0.65rem; font-weight: bold; text-transform: uppercase;">CASHIER ACTION</span>
              </td>
              <td class="monitor-td" style="text-align: center; color: #ccc;">-</td>
              <td class="monitor-td" style="font-weight: normal;">
                <div style="display: flex; align-items: center; gap: 6px; color: #555; font-size: 0.85rem; font-weight: normal;">
                  ${l.action}
                </div>
              </td>
              <td class="monitor-td" style="font-size: 0.8rem; color: #888; font-weight: normal;">${formattedDetails || ''}</td>
              <td class="monitor-td" style="text-align: center; color: #ccc;">-</td>
            </tr>`;
          }
        }).join('');

        return `
          <div class="cashier-monitor-group" style="margin-bottom: 40px; border: 1px solid #e0e0e0; border-radius: 16px; overflow: hidden; background: white; box-shadow: 0 4px 12px rgba(0,0,0,0.03);">
            <div class="cashier-monitor-group-header" style="background: linear-gradient(to right, #fdfaf8, #ffffff); padding: 20px 24px; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #eee;">
              <div class="cashier-monitor-title" style="display: flex; align-items: center; gap: 12px;">
                <div style="width: 40px; height: 40px; background: var(--accent-warm); color: white; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-weight: bold; font-size: 1.2rem;">${group.label.charAt(0)}</div>
                <div>
                  <span style="display: block; font-size: 0.75rem; color: #888; text-transform: uppercase; letter-spacing: 0.05em;">Cashier</span>
                  <strong style="font-size: 1.1rem; color: var(--coffee-dark);">${group.label}</strong>
                </div>
              </div>
              <div style="display: flex; gap: 30px;">
                <div class="cashier-monitor-metric">
                  <span style="display: block; font-size: 0.7rem; color: #999; text-transform: uppercase;">Transactions</span>
                  <strong style="font-size: 1.2rem; color: var(--coffee-dark);">${group.count}</strong>
                </div>
                <div class="cashier-monitor-metric">
                  <span style="display: block; font-size: 0.7rem; color: #999; text-transform: uppercase;">Total Sales</span>
                  <strong style="font-size: 1.2rem; color: var(--accent-warm);">PHP ${group.total.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong>
                </div>
              </div>
            </div>
            <div style="overflow-x: auto;">
              <table class="monitor-table" style="width: 100%; border-collapse: collapse;">
                <thead>
                  <tr style="background: #f8f9fa; border-bottom: 2px solid #eee;">
                    <th style="padding: 14px 20px; text-align: left; font-size: 0.7rem; text-transform: uppercase; color: #999; letter-spacing: 0.1em; width: 120px;">Date</th>
                    <th style="padding: 14px 20px; text-align: left; font-size: 0.7rem; text-transform: uppercase; color: #999; letter-spacing: 0.1em; width: 180px;">ID / Type</th>
                    <th style="padding: 14px 20px; text-align: center; font-size: 0.7rem; text-transform: uppercase; color: #999; letter-spacing: 0.1em; width: 80px;">Qty</th>
                    <th style="padding: 14px 20px; text-align: left; font-size: 0.7rem; text-transform: uppercase; color: #999; letter-spacing: 0.1em;">Action / Product</th>
                    <th style="padding: 14px 20px; text-align: left; font-size: 0.7rem; text-transform: uppercase; color: #999; letter-spacing: 0.1em; width: 180px;">Total / Details</th>
                    <th style="padding: 14px 20px; text-align: left; font-size: 0.7rem; text-transform: uppercase; color: #999; letter-spacing: 0.1em;">Remarks</th>
                  </tr>
                </thead>
                <tbody>
                  ${activityRows || ''}
                  ${(!activityRows) ? '<tr><td colspan="6" style="padding: 40px; text-align: center; color: #bbb; font-style: italic;">No activity recorded for this cashier.</td></tr>' : ''}
                </tbody>
              </table>
            </div>
          </div>
        `
      }).join('')
  } catch (err) {
    console.error("Error loading cashier monitoring:", err)
    container.innerHTML = `<p style="color:red">Error: ${err.message}</p>`
  }
}

// --- ADMIN LOGS PAGE ---
window.loadAdminLogs = async function() {
  const staffPanelVisible = (() => {
    const p = document.getElementById('monitorStaffPanel')
    return !!p && p.style.display !== 'none'
  })()
  const container = staffPanelVisible
    ? document.getElementById('staffAdminLogsBody')
    : document.getElementById('adminLogsContainer')
  if (!container) return
  container.innerHTML = staffPanelVisible
    ? '<tr><td colspan="3" style="text-align:center; padding:16px;">Loading...</td></tr>'
    : '<p>Loading...</p>'

  const selectEl = staffPanelVisible
    ? document.getElementById('monitorAdminSelect')
    : document.getElementById('adminLogsUser')
  let startEl = staffPanelVisible
    ? document.getElementById('monitorStartDate')
    : document.getElementById('adminLogsStart')
  let endEl = staffPanelVisible
    ? document.getElementById('monitorEndDate')
    : document.getElementById('adminLogsEnd')
  const today = new Date()
  const todayStr = today.toISOString().slice(0, 10)
  const start = (startEl && startEl.value) || todayStr
  const end = (endEl && endEl.value) || todayStr
  const selectedAdmin = selectEl ? selectEl.value : ''

  try {
    // Fetch staff for role filtering
    const { data: staffRows, error: staffErr } = await db.from('staff').select('id, full_name, role, id_number, username, email')
    if (staffErr) throw staffErr

    let logs
    const { data: rawLogs, error } = await db.from('admin_logs')
      .select('*')
      .gte('created_at', start + 'T00:00:00')
      .lte('created_at', end + 'T23:59:59')
      .order('created_at', { ascending: false })
      .limit(500)
    if (error) throw error
    
    logs = (rawLogs || [])
    let displayRows = []
    if (staffPanelVisible) {
      const roleWantedRaw = selectedAdmin || 'admin'
      const roleWanted = roleWantedRaw === 'kitchen_staff' ? 'cashier' : roleWantedRaw
      const roleMap = {}
      const staffByRole = (staffRows || []).filter((s) => {
        const r = String(s.role || '').toLowerCase()
        if (roleWanted === 'admin') return r === 'admin' || r === 'system_admin'
        return r === roleWanted
      })
      const allowedIds = new Set(staffByRole.map((s) => String(s.id || '').toLowerCase()))
      const allowedNames = new Set(staffByRole.map((s) => String(s.full_name || '').toLowerCase()))
      const allowedNumbers = new Set(staffByRole.map((s) => String(s.id_number || '').toLowerCase()))

      ;(staffRows || []).forEach((s) => {
        const role = String(s.role || '').toLowerCase()
        roleMap[String(s.id || '').toLowerCase()] = role
        roleMap[String(s.full_name || '').toLowerCase()] = role
        roleMap[String(s.id_number || '').toLowerCase()] = role
        roleMap[String(s.username || '').toLowerCase()] = role
        roleMap[String(s.email || '').toLowerCase()] = role
      })
      const roleLogs = logs.filter((l) => {
        const byId = roleMap[String(l.admin_id || '').toLowerCase()]
        const byName = roleMap[String(l.admin_name || '').toLowerCase()]
        const role = byId || byName || ''
        if (roleWanted === 'admin') return role === 'admin' || role === 'system_admin'
        return role === roleWanted
      })
      displayRows.push(...roleLogs.map((l) => ({
        ts: new Date(l.created_at).toLocaleString(),
        user: l.admin_name || l.admin_id || '-',
        details: l.action || l.details || '-',
      })))

      // For cashier/kitchen filters, also include sales activity so role filter visibly changes.
      if (roleWanted !== 'admin') {
        const { data: salesRows, error: salesErr } = await db
          .from('sales')
          .select('timestamp, sale_date, cashier_id, cashier_name, total, type')
          .gte('timestamp', start + 'T00:00:00')
          .lte('timestamp', end + 'T23:59:59')
          .order('timestamp', { ascending: false })
          .limit(500)
        if (!salesErr) {
          const filteredSales = (salesRows || []).filter((s) => {
            const cid = String(s.cashier_id || '').toLowerCase()
            const cname = String(s.cashier_name || '').toLowerCase()
            return allowedIds.has(cid) || allowedNumbers.has(cid) || allowedNames.has(cname)
          })
          displayRows.push(...filteredSales.map((s) => ({
            ts: new Date(s.timestamp || s.sale_date || Date.now()).toLocaleString(),
            user: s.cashier_name || s.cashier_id || '-',
            details: `Sale ${s.type ? `(${s.type})` : ''} - PHP ${Number(s.total || 0).toFixed(2)}`,
          })))
        }
      }
      displayRows.sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime())
    } else {
      const allowedAdminNames = (staffRows || [])
        .filter((s) => ['admin', 'system_admin'].includes(String(s.role || '').toLowerCase()))
        .map((s) => s.full_name)
      const allowedAdminIds = (staffRows || [])
        .filter((s) => ['admin', 'system_admin'].includes(String(s.role || '').toLowerCase()))
        .map((s) => s.id)
      logs = logs.filter((l) => allowedAdminNames.includes(l.admin_name) || allowedAdminIds.includes(l.admin_id))
      if (selectedAdmin) {
        logs = logs.filter(l => l.admin_id === selectedAdmin || l.admin_name === selectedAdmin)
      }
      displayRows = logs.map((l) => ({
        ts: new Date(l.created_at).toLocaleString(),
        user: l.admin_name || '-',
        details: l.action || l.details || '-',
        fullDetails: l.details || '',
      }))
    }

    if (selectEl && !staffPanelVisible) {
      const byId = {}
      if (staffRows) {
        staffRows
          .filter((s) => ['admin', 'system_admin'].includes(String(s.role || '').toLowerCase()))
          .forEach(a => { byId[a.id] = a.full_name })
      }
      
      selectEl.innerHTML = '<option value="">All Admins</option>' +
        Object.entries(byId).sort((a, b) => (a[1] || '').localeCompare(b[1] || ''))
          .map(([id, name]) => `<option value="${id}">${name}</option>`).join('')
      if (selectedAdmin) selectEl.value = selectedAdmin
    }
    const hasRows = staffPanelVisible ? displayRows.length > 0 : logs.length > 0
    if (!hasRows) {
      container.innerHTML = staffPanelVisible
        ? '<tr><td colspan="3" style="text-align:center; color: var(--coffee-dark);">No logs in date range.</td></tr>'
        : '<p style="color: var(--coffee-dark);">No admin logs in date range.</p>'
      return
    }
    const rows = displayRows.map(l => {
      if (staffPanelVisible) {
        return `<tr><td style="padding:8px; border-bottom:1px solid #eee;">${l.ts}</td><td style="padding:8px; border-bottom:1px solid #eee;">${l.user || '-'}</td><td style="padding:8px; border-bottom:1px solid #eee;">${l.details || '-'}</td></tr>`
      }
      return `<tr><td style="padding:8px; border-bottom:1px solid #eee; color: var(--coffee-dark);">${l.ts}</td><td style="padding:8px; border-bottom:1px solid #eee; color: var(--coffee-dark);">${l.user}</td><td style="padding:8px; border-bottom:1px solid #eee; color: var(--coffee-dark);">${l.details}</td><td style="padding:8px; border-bottom:1px solid #eee; color: var(--coffee-medium);">${l.fullDetails || ''}</td></tr>`
    }).join('')
    if (staffPanelVisible) {
      container.innerHTML = rows
    } else {
      container.innerHTML = `
        <table style="width:100%; border-collapse:collapse; color: var(--coffee-dark);">
          <thead><tr><th style="text-align:left; padding:8px; border-bottom:2px solid var(--coffee-dark);">Time</th><th style="padding:8px; border-bottom:2px solid var(--coffee-dark);">Admin</th><th style="padding:8px; border-bottom:2px solid var(--coffee-dark);">Action</th><th style="padding:8px; border-bottom:2px solid var(--coffee-dark);">Details</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      `
    }
  } catch (e) {
    container.innerHTML = staffPanelVisible
      ? `<tr><td colspan="3" style="color:var(--danger); text-align:center;">Error: ${e.message}</td></tr>`
      : `<p style="color:var(--danger);">Error: ${e.message}. Ensure admin_logs table exists (run sql/cashier_monitoring_and_admin_logs.sql).</p>`
  }
}

// --- STAFF MANAGEMENT ---
let currentStaffRoleFilter = 'all'
let currentArchivedStaffRoleFilter = 'all'

window.filterStaffRole = function(role, btn) {
  currentStaffRoleFilter = role || 'all'
  document.querySelectorAll('.staff-type-icon-btn').forEach((b) => b.classList.remove('active'))
  if (btn) btn.classList.add('active')
  loadStaffList()
}

window.toggleStaffPasswordDisplay = function(uniqueId) {
  const valueEl = document.getElementById(`staffPwdValue-${uniqueId}`)
  const btnEl = document.getElementById(`staffPwdBtn-${uniqueId}`)
  if (!valueEl || !btnEl) return
  const encoded = valueEl.dataset.password || ""
  const plain = encoded ? decodeURIComponent(encoded) : ""
  const currentlyMasked = valueEl.textContent === "****"
  if (currentlyMasked) {
    valueEl.textContent = plain || "No password set"
    btnEl.textContent = "Hide"
  } else {
    valueEl.textContent = "****"
    btnEl.textContent = "Show"
  }
}

window.loadStaffList = async function() {
  const container = document.getElementById('staffListContainer')
  if (!container) return
  
  try {
    const { data, error } = await db.from('staff').select('*').eq('archived', false).order('full_name')
    if (error) throw error
    const rows = (data || []).filter((s) => {
      if (currentStaffRoleFilter === 'all') return true
      if (currentStaffRoleFilter === 'admin') return ['admin', 'system_admin'].includes(String(s.role || '').toLowerCase())
      return String(s.role || '').toLowerCase() === currentStaffRoleFilter
    })
    
    container.innerHTML = rows.map(s => `
      <tr>
        <td>
          <div style="font-weight: 800; font-size: 1.1rem;">${s.full_name}</div>
          <div style="font-size: 0.9rem; color: #666;">${s.role.toUpperCase()}</div>
        </td>
        <td>
          <div style="font-size: 0.95rem;"><strong>ID:</strong> ${s.id_number || '-'}</div>
          <div style="font-size: 0.95rem;">
            <strong>Password:</strong>
            <span id="staffPwdValue-active-${s.id}" data-password="${encodeURIComponent(String(s.plain_password || s.password || ""))}">****</span>
            <button id="staffPwdBtn-active-${s.id}" type="button" class="card-btn" style="padding:2px 8px; margin-left:6px;" onclick="toggleStaffPasswordDisplay('active-${s.id}')">Show</button>
          </div>
        </td>
        <td class="actions-cell">
          <div style="display:flex; gap:10px;">
            <button onclick="toggleStaffEdit('${s.id}', true)" class="card-btn edit-btn">Edit</button>
            <button onclick="removeStaff('${s.id}')" class="card-btn archive-btn">Archive</button>
          </div>
        </td>
      </tr>
      <tr id="staffEdit-${s.id}" style="display:none; background:#f8f4e1;">
        <td colspan="3" style="padding:12px;">
          <div style="display:grid; grid-template-columns: repeat(3, minmax(180px, 1fr)); gap:8px; align-items:center;">
            <input id="editStaffName-${s.id}" value="${(s.full_name || '').replace(/"/g, '&quot;')}" placeholder="Full name" />
            <input id="editStaffId-${s.id}" value="${(s.id_number || '').replace(/"/g, '&quot;')}" placeholder="ID number" />
            <select id="editStaffRole-${s.id}" data-system-admin="${String(s.role || '').toLowerCase() === 'system_admin' ? 'true' : 'false'}">
              <option value="cashier" ${String(s.role || '').toLowerCase() === 'cashier' ? 'selected' : ''}>Cashier</option>
              <option value="kitchen_staff" ${String(s.role || '').toLowerCase() === 'kitchen_staff' ? 'selected' : ''}>Kitchen Staff</option>
              <option value="admin" ${['admin', 'system_admin'].includes(String(s.role || '').toLowerCase()) ? 'selected' : ''}>Admin</option>
            </select>
            <input id="editStaffUsername-${s.id}" value="${(s.username || '').replace(/"/g, '&quot;')}" placeholder="Username" />
            <input id="editStaffEmail-${s.id}" value="${(s.email || '').replace(/"/g, '&quot;')}" placeholder="Email" />
            <div style="display:flex; gap:6px;">
              <input id="editStaffPassword-${s.id}" type="password" placeholder="New password (optional)" style="flex:1;" />
              <button type="button" onclick="togglePasswordVisibility('editStaffPassword-${s.id}', this)" class="card-btn" style="padding:6px 10px;">👁️</button>
            </div>
          </div>
          <div style="display:flex; gap:8px; margin-top:10px; align-items:center;">
            <button onclick="saveStaffEdit('${s.id}')" class="card-btn edit-btn">Save</button>
            <button onclick="toggleStaffEdit('${s.id}', false)" class="card-btn archive-btn">Cancel</button>
            <span id="staffEditMsg-${s.id}" style="font-weight:700;"></span>
          </div>
        </td>
      </tr>
    `).join('')
  } catch (e) {
    container.innerHTML = `<tr><td colspan="3" style="text-align:center; color:red;">Error: ${e.message}</td></tr>`
  }
}

window.filterArchivedStaffRole = function(role, btn) {
  currentArchivedStaffRoleFilter = role || 'all'
  document.querySelectorAll('#archiveStaffPanel .staff-type-icon-btn').forEach((b) => b.classList.remove('active'))
  if (btn) btn.classList.add('active')
  loadArchivedStaffList()
}

window.loadArchivedStaffList = async function() {
  const container = document.getElementById('archivedStaffList')
  if (!container) return
  
  try {
    const { data, error } = await db.from('staff').select('*').eq('archived', true).order('full_name')
    if (error) throw error
    const rows = (data || []).filter((s) => {
      if (currentArchivedStaffRoleFilter === 'all') return true
      if (currentArchivedStaffRoleFilter === 'admin') return ['admin', 'system_admin'].includes(String(s.role || '').toLowerCase())
      return String(s.role || '').toLowerCase() === currentArchivedStaffRoleFilter
    })
    
    container.innerHTML = rows.map(s => `
      <tr>
        <td>
          <div style="font-weight: 800; font-size: 1.1rem;">${s.full_name}</div>
          <div style="font-size: 0.9rem; color: #666;">${s.role.toUpperCase()}</div>
        </td>
        <td>
          <div style="font-size: 0.95rem;"><strong>ID:</strong> ${s.id_number || '-'}</div>
          <div style="font-size: 0.95rem;">
            <strong>Password:</strong>
            <span id="staffPwdValue-arch-${s.id}" data-password="${encodeURIComponent(String(s.plain_password || s.password || ""))}">****</span>
            <button id="staffPwdBtn-arch-${s.id}" type="button" class="card-btn" style="padding:2px 8px; margin-left:6px;" onclick="toggleStaffPasswordDisplay('arch-${s.id}')">Show</button>
          </div>
        </td>
        <td class="actions-cell">
          <div style="display:flex; gap:10px; justify-content:flex-end;">
            <button onclick="deleteArchivedStaff('${s.id}')" class="staff-action-icon" title="Delete permanently">🗑️</button>
            <button onclick="restoreStaff('${s.id}')" class="staff-action-icon" title="Restore">↩️</button>
          </div>
        </td>
      </tr>
    `).join('')
  } catch (e) {
    container.innerHTML = `<tr><td colspan="3" style="text-align:center; color:red;">Error: ${e.message}</td></tr>`
  }
}

window.deleteArchivedStaff = async function(id) {
  if (!confirm("Delete archived user permanently?")) return
  try {
    const { error } = await db.from("staff").delete().eq("id", id)
    if (error) throw error
    showMessage("Archived user deleted.", "success")
    loadArchivedStaffList()
  } catch (e) {
    showMessage("Failed to delete archived user.", "error")
  }
}

window.updateActiveUsersPreview = async function() {
  const list = document.getElementById('activeUsersPreviewList')
  if (!list) return
  
  try {
    const { data } = await db.from('staff').select('*').eq('archived', false).limit(5)
    list.innerHTML = data.map(s => `
      <div style="display: flex; align-items: center; gap: 15px;">
        <span style="font-size: 1.2rem;">${['admin','system_admin'].includes(String(s.role || '').toLowerCase()) ? '⭐' : (String(s.role || '').toLowerCase() === 'cashier' ? '🪪' : '👨‍🍳')}</span>
        <span style="font-weight: 700;">${s.full_name}</span>
      </div>
    `).join('')
  } catch (e) {}
}

window.toggleStaffEdit = function(id, show) {
  const row = document.getElementById(`staffEdit-${id}`)
  if (row) row.style.display = show ? 'table-row' : 'none'
  const msgEl = document.getElementById(`staffEditMsg-${id}`)
  if (msgEl) msgEl.textContent = ''
}

window.togglePasswordVisibility = function(inputId, btn) {
  const input = document.getElementById(inputId)
  if (!input) return
  if (input.type === 'password') {
    input.type = 'text'
    btn.textContent = '🙈'
  } else {
    input.type = 'password'
    btn.textContent = '👁️'
  }
}

window.saveStaffEdit = async function(id) {
  const nameEl = document.getElementById(`editStaffName-${id}`)
  const idEl = document.getElementById(`editStaffId-${id}`)
  const userEl = document.getElementById(`editStaffUsername-${id}`)
  const emailEl = document.getElementById(`editStaffEmail-${id}`)
  const roleEl = document.getElementById(`editStaffRole-${id}`)
  const pwdEl = document.getElementById(`editStaffPassword-${id}`)
  const msgEl = document.getElementById(`staffEditMsg-${id}`)
  if (!nameEl || !idEl || !roleEl || !msgEl) return

  const fullName = nameEl.value.trim()
  const idNumber = idEl.value.trim()
  const username = userEl ? userEl.value.trim() : null
  const email = emailEl ? emailEl.value.trim() : null
  const isSystemAdmin = roleEl.dataset.systemAdmin === 'true'
  const role = isSystemAdmin ? 'system_admin' : roleEl.value
  const newPassword = pwdEl ? pwdEl.value : ''

  if (!fullName || !idNumber) {
    msgEl.textContent = 'Full name and ID number are required.'
    msgEl.style.color = 'var(--danger)'
    return
  }

  try {
    // Check for duplicates
    const { data: dupId } = await db.from('staff').select('id').eq('id_number', idNumber).neq('id', id).maybeSingle()
    if (dupId) throw new Error('ID number already exists.')

    if (username) {
      const { data: dupUser } = await db.from('staff').select('id').eq('username', username).neq('id', id).maybeSingle()
      if (dupUser) throw new Error('Username already exists.')
    }

    if (email) {
      const { data: dupEmail } = await db.from('staff').select('id').eq('email', email).neq('id', id).maybeSingle()
      if (dupEmail) throw new Error('Email already exists.')
    }

    const updates = { full_name: fullName, id_number: idNumber, role }
    updates.username = username || null
    updates.email = email || null
    
    if (newPassword) {
      if (typeof hashPassword !== 'function' || typeof generateSalt !== 'function') {
        throw new Error('Password utilities not available. Reload the page and try again.')
      }
      const salt = generateSalt()
      const password_hash = await hashPassword(newPassword, salt)
      updates.password_hash = password_hash
      updates.salt = salt
      updates.plain_password = newPassword // Store plain password for admin viewing
    }
    const { error } = await db.from('staff').update(updates).eq('id', id)
    if (error) {
      if (error.code === '23505') throw new Error('Username or ID number already exists.')
      throw error
    }
    if (window.logAdminAction) {
      await logAdminAction('Updated staff', `${fullName} (${idNumber})`)
    }
    const sess = typeof getStaffSession === 'function' ? getStaffSession() : null
    if (sess && sess.id === id) {
      sess.full_name = fullName
      sess.id_number = idNumber
      sess.role = role
      setStaffSession(sess)
      const staffDisplay = document.getElementById('staffNameDisplay')
      if (staffDisplay) staffDisplay.textContent = sess.full_name + ' (' + sess.role + ')'
    }
    msgEl.textContent = 'Staff updated.'
    msgEl.style.color = 'var(--success)'
    if (pwdEl) pwdEl.value = ''
    loadStaffList()
  } catch (e) {
    msgEl.textContent = e.message || 'Update failed.'
    msgEl.style.color = 'var(--danger)'
  }
}

window.registerStaffSubmit = async function() {
  const id = document.getElementById('regStaffId')?.value?.trim()
  const name = document.getElementById('regStaffName')?.value?.trim()
  const email = document.getElementById('regStaffEmail')?.value?.trim()
  const pwd = document.getElementById('regStaffPassword')?.value
  const role = document.getElementById('regStaffRole')?.value
  const msgEl = document.getElementById('staffMessage')
  
  // Staff username will be their first name
  const user = name ? name.split(' ')[0].toLowerCase() : ''
  
  if (!msgEl) return
  if (!id || !name || !pwd) {
    msgEl.textContent = 'Please fill ID number, full name, and password'
    msgEl.style.color = 'var(--danger)'
    msgEl.style.display = 'block'
    return
  }
  if (pwd.length < 6) {
    msgEl.textContent = 'Password must be at least 6 characters'
    msgEl.style.color = 'var(--danger)'
    msgEl.style.display = 'block'
    return
  }
  
  try {
    const res = await staffRegister(id, name, pwd, role, user, email)
    if (!res.ok) {
      msgEl.textContent = res.message || 'Registration failed'
      msgEl.style.color = 'var(--danger)'
      msgEl.style.display = 'block'
      return
    }
    
    if (window.logAdminAction) await logAdminAction('Registered staff', `${name} (${id}) - ${role}`)
    msgEl.textContent = 'Staff registered successfully.'
    msgEl.style.color = 'var(--success)'
    msgEl.style.display = 'block'
    
    // Clear form
    document.getElementById('regStaffId').value = ''
    document.getElementById('regStaffName').value = ''
    document.getElementById('regStaffUsername').value = ''
    document.getElementById('regStaffEmail').value = ''
    document.getElementById('regStaffPassword').value = ''
    
    loadStaffList()
  } catch (e) {
    msgEl.textContent = e.message || 'Registration failed'
    msgEl.style.color = 'var(--danger)'
    msgEl.style.display = 'block'
  }
}

window.removeStaff = async function(id) {
  if (!confirm('Archive this staff account?')) return
  try {
    await safeUpdateRowAdmin('staff', { id }, { archived: true, archived_at: new Date().toISOString() })
    if (window.logAdminAction) await logAdminAction('Archived staff', `id: ${id}`)
    loadStaffList()
    loadArchivedStaffList()
    const msgEl = document.getElementById('staffMessage')
    if (msgEl) { msgEl.textContent = 'Staff archived.'; msgEl.style.color = 'var(--success)'; msgEl.style.display = 'block'; }
  } catch (e) {
    const msgEl = document.getElementById('staffMessage')
    if (msgEl) { msgEl.textContent = e.message || 'Failed to archive'; msgEl.style.color = 'var(--danger)'; msgEl.style.display = 'block'; }
  }
}

window.restoreStaff = async function(id) {
  try {
    await safeUpdateRowAdmin('staff', { id }, { archived: false, archived_at: null })
    if (window.logAdminAction) await logAdminAction('Restored staff', `id: ${id}`)
    loadStaffList()
    loadArchivedStaffList()
    const msgEl = document.getElementById('staffMessage')
    if (msgEl) { msgEl.textContent = 'Staff restored.'; msgEl.style.color = 'var(--success)'; msgEl.style.display = 'block'; }
  } catch (e) {
    const msgEl = document.getElementById('staffMessage')
    if (msgEl) { msgEl.textContent = e.message || 'Failed to restore'; msgEl.style.color = 'var(--danger)'; msgEl.style.display = 'block'; }
  }
}

// Preview Promo Image from File
window.previewPromoImage = (input) => {
  const file = input.files[0]
  const previewImg = document.getElementById("promoPreviewImage")
  const noImg = document.getElementById("promoPreviewNoImage")

  if (file) {
    const reader = new FileReader()
    reader.onload = (e) => {
      previewImg.src = e.target.result
      previewImg.style.display = "block"
      noImg.style.display = "none"
      updatePromoPreview()
    }
    reader.readAsDataURL(file)
  } else {
    previewImg.style.display = "none"
    noImg.style.display = "flex"
    updatePromoPreview()
  }
}

// Update Promo Preview
window.updatePromoPreview = () => {
  const content = document.getElementById("promoContent").value.trim() || "No description available."
  const validFrom = document.getElementById("promoFrom").value
  const validUntil = document.getElementById("promoUntil").value
  
  const descEl = document.getElementById("previewPromoDescription")
  const expiryEl = document.getElementById("previewPromoValidation")
  
  if (descEl) descEl.textContent = content
  
  if (expiryEl) {
    if (validFrom && validUntil) {
      expiryEl.textContent = `Validation Date: ${new Date(validFrom).toLocaleDateString()} - ${new Date(validUntil).toLocaleDateString()}`
    } else if (validUntil) {
      expiryEl.textContent = `Validation Date: ${new Date(validUntil).toLocaleDateString()}`
    } else {
      expiryEl.textContent = "Validation Date: N/A"
    }
  }
}

// Start initialization when DOM is ready
document.addEventListener("DOMContentLoaded", () => {
  // Staff name display and logout
  const staffDisplay = document.getElementById('staffNameDisplay')
  if (staffDisplay && getStaffSession) {
    const s = getStaffSession()
    if (s) staffDisplay.textContent = s.full_name + ' (' + s.role + ')'
  }
  // Hide Staff nav if user cannot register staff
  const navStaff = document.getElementById('navStaff')
  if (navStaff && typeof canRegisterStaff === 'function' && !canRegisterStaff()) navStaff.style.display = 'none'

  // Wait a bit for Supabase to initialize
  if (window.dbReady) {
    initializeAdmin()
  } else {
    window.onSupabaseReady = initializeAdmin
  }
});

// Helper function to map category IDs to names
function getCategoryName(id) {
  const cats = { 1: "Coffee", 2: "Non-coffee", 3: "Frappe", 4: "Soda", 5: "Pastries" }
  return cats[id] || "Unknown"
}

// Helper function to map category names to IDs
function getCategoryId(name) {
  const cats = { "Coffee": 1, "Non-coffee": 2, "Frappe": 3, "Soda": 4, "Pastries": 5 }
  return cats[name] || 0
}

// Message display
function showMessage(msg, type) {
  const container =
    document.getElementById("statusMessage") ||
    document.getElementById("promoStatusMessage") ||
    document.getElementById("staffMessage") ||
    document.getElementById("settingsMessage")

  if (!container) return
  container.innerHTML = `<div class="message ${type}">${msg}</div>`
  setTimeout(() => (container.innerHTML = ""), 3500)
}

// Category ID base for auto-assignment
const CATEGORY_ID_BASE = { 1: 100, 2: 200, 3: 300, 4: 400, 5: 500 }

// Current menu filter and search
let currentMenuFilter = "all"
let currentMenuSearch = ""
let menuArchiveMode = false

// Search menu products
window.filterMenuBySearch = () => {
  currentMenuSearch = document.getElementById("menuSearch").value.toLowerCase().trim()
  loadMenu()
}

// Filter menu by category
window.filterMenu = (category, isArchive = false) => {
  currentMenuFilter = category
  menuArchiveMode = isArchive
  document.querySelectorAll(".cat-pill").forEach((b) => b.classList.remove("active"))
  // Find the button with matching text or 'all'
  document.querySelectorAll(".cat-pill").forEach((b) => {
    if (b.textContent.trim().toLowerCase() === category.toLowerCase()) {
      b.classList.add("active")
    }
  })
  loadMenu()
}

window.openAddProductModal = () => {
  window.resetForm()
  document.getElementById("addProductModal").style.display = "flex"
  updateProductPreview() // Initialize preview with default values
}

window.closeProductModal = () => {
  document.getElementById("addProductModal").style.display = "none"
}

// Load sizes for datalist
async function loadSizesDatalist() {
  const datalist = document.getElementById("sizeList")
  if (!datalist) return

  try {
    const { data, error } = await db.from("products").select("size")
    if (error) throw error
    datalist.innerHTML = ""
    const sizes = new Set()
    data.forEach((d) => {
      if (d.size) sizes.add(d.size.trim())
    })
    sizes.forEach((size) => {
      const option = document.createElement("option")
      option.value = size
      datalist.appendChild(option)
    })
  } catch (err) {
    console.error("Error loading sizes:", err)
  }
}



// Handle category change
window.handleCategoryChange = () => {
  const category = document.getElementById("productCategory").value
  const productName = document.getElementById("productName").value
  // Update the product preview with the new category
  updateProductPreview(productName, category, document.getElementById("previewImage").src, [])
}

// Preview Image from File
window.previewImage = (input) => {
  const file = input.files[0]
  const previewImg = document.getElementById("previewImage")
  const noImg = document.getElementById("previewNoImage")

  if (file) {
    const reader = new FileReader()
    reader.onload = (e) => {
      previewImg.src = e.target.result
      previewImg.style.display = "block"
      noImg.style.display = "none"
      // Update the product preview with the new image
      const productName = document.getElementById("productName").value
      const category = document.getElementById("productCategory").value
      updateProductPreview(productName, category, e.target.result, [])
    }
    reader.readAsDataURL(file)
  } else {
    previewImg.style.display = "none"
    noImg.style.display = "flex"
    // Update the product preview to clear the image
    const productName = document.getElementById("productName").value
    const category = document.getElementById("productCategory").value
    updateProductPreview(productName, category, "", [])
  }
}

// Navigation (Show Page)
window.toggleSidebar = function() {
  const sidebar = document.querySelector('.sidebar')
  sidebar.classList.toggle('collapsed')
}

window.showPage = (pg) => {
  document.querySelectorAll('.page').forEach(p => p.style.display='none')
  
  // Update sidebar active state
  document.querySelectorAll('.sidebar-nav .nav-item').forEach(btn => {
    btn.classList.remove('active')
    const page = btn.getAttribute('data-page')
    if (page === pg) {
      btn.classList.add('active')
    }
  })

  const page = document.getElementById(pg)
  if(page) page.style.display='block'

  if (pg === 'bookings') {
    switchRequestTab('booking')
    renderCalendar()
  }
  if (pg === 'analytics') {
    if (typeof window.unlockAnalyticsDateInputs === 'function') window.unlockAnalyticsDateInputs()
    if (typeof runDashboard === 'function') runDashboard()
  }
  if (pg === 'reports') {
    if (typeof renderReports === 'function') renderReports()
  }
  if (pg === 'settings') window.loadPaymentSettings()
  if (pg === 'staff') switchStaffTab('active')
  if (pg === 'promos' && typeof window.loadPromos === 'function') window.loadPromos()
  if (pg === 'menu' && typeof loadMenu === 'function') loadMenu()
}

// Staff Tab Logic
window.switchStaffTab = (tab) => {
  document.querySelectorAll('.staff-panel').forEach(p => p.style.display = 'none')
  document.querySelectorAll('.staff-tab').forEach(t => t.classList.remove('active'))
  
  if (tab === 'active') {
    document.getElementById('activeStaffPanel').style.display = 'block'
    document.querySelector('.staff-tab[onclick*="active"]').classList.add('active')
    loadStaffList()
  } else if (tab === 'archive') {
    document.getElementById('archiveStaffPanel').style.display = 'block'
    document.querySelector('.staff-tab[onclick*="archive"]').classList.add('active')
    loadArchivedStaffList()
  } else if (tab === 'monitor') {
    document.getElementById('monitorStaffPanel').style.display = 'block'
    document.querySelector('.staff-tab[onclick*="monitor"]').classList.add('active')
    loadAdminLogs()
  }
}

// Reservations Tab Logic
window.switchRequestTab = (type) => {
  document.querySelectorAll('.request-tab').forEach(t => t.classList.remove('active'))
  document.querySelector(`.request-tab[onclick*="${type}"]`).classList.add('active')
  renderPendingRequests(type)
}

// Modal Logic
window.toggleAddForm = () => {
  const modal = document.getElementById('addProductModal')
  if (modal.style.display === 'none' || !modal.style.display) {
    window.openAddProductModal()
  } else {
    window.closeProductModal()
  }
}

window.openPromoModal = () => {
  resetPromoForm()
  const modal = document.getElementById('promoModal')
  if (modal) modal.style.display = 'flex'
}

window.closePromoModal = () => {
  document.getElementById('promoModal').style.display = 'none'
}

window.openAddUserModal = () => {
  document.getElementById('addUserModal').style.display = 'flex'
  updateActiveUsersPreview()
}

window.closeAddUserModal = () => {
  document.getElementById('addUserModal').style.display = 'none'
}

// Stub for missing functions or to be implemented
window.renderCalendar = () => {
  console.log("Render calendar logic goes here")
}

window.renderPendingRequests = (type) => {
  console.log(`Render pending ${type} requests`)
}

window.updateActiveUsersPreview = () => {
  console.log("Update active users preview")
}

  window.showMonitoringsTab = function(tab) {
    const adminPanel = document.getElementById('monitoringsAdminLogs')
    const cashierPanel = document.getElementById('monitoringsCashier')
    const adminBtn = document.getElementById('monTabAdminLogs')
    const cashierBtn = document.getElementById('monTabCashier')
  if (tab === 'adminLogs') {
    if (adminPanel) adminPanel.style.display = 'block'
    if (cashierPanel) cashierPanel.style.display = 'none'
    if (adminBtn) adminBtn.classList.add('active')
    if (cashierBtn) cashierBtn.classList.remove('active')
    if (window.loadAdminLogs) loadAdminLogs()
  } else {
    if (adminPanel) adminPanel.style.display = 'none'
    if (cashierPanel) cashierPanel.style.display = 'block'
    if (adminBtn) adminBtn.classList.remove('active')
      if (cashierBtn) cashierBtn.classList.add('active')
      if (window.loadCashierMonitoring) loadCashierMonitoring()
    }
  }

  function subscribeToAdminLogsRealtime() {
    if (!db) return
    if (adminLogsUnsub && typeof adminLogsUnsub.unsubscribe === 'function') adminLogsUnsub.unsubscribe()
    adminLogsUnsub = db.channel('admin-logs-realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'admin_logs' }, () => {
        scheduleAdminAutoRefresh()
      })
      .subscribe()
  }

  function subscribeToCashierMonitoringRealtime() {
    if (!db) return
    if (cashierMonitorUnsub && typeof cashierMonitorUnsub.unsubscribe === 'function') cashierMonitorUnsub.unsubscribe()
    cashierMonitorUnsub = db.channel('cashier-monitoring-realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'sales' }, (payload) => {
        console.log("[Realtime] Sales change detected:", payload.eventType)
        scheduleAdminAutoRefresh()
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'admin_logs' }, (payload) => {
        console.log("[Realtime] Admin log change detected:", payload.eventType)
        scheduleAdminAutoRefresh()
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'bookings' }, (payload) => {
        console.log("[Realtime] Booking change detected:", payload.eventType)
        scheduleAdminAutoRefresh()
      })
      .subscribe()
  }
  
  // --- PROMOS MANAGEMENT ---
window.loadPromos = async function() {
  const currentToken = ++promoRenderToken
  const promoList = document.getElementById("promoList")
  if (!promoList) return
  promoList.innerHTML = `
    <div class="promo-add-card" onclick="openPromoModal()">
      <span>+</span>
    </div>
  `

  try {
    const { data: promos, error } = await db.from("promos").select("*").order("created_at", { ascending: false })
    if (error) throw error
    if (currentToken !== promoRenderToken) return

    // Filter out expired promos (hide on the due date)
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const activePromos = (promos || []).filter((p) => {
      if (!p.valid_until) return true // No expiry date = always active
      const expiryDate = new Date(p.valid_until)
      if (Number.isNaN(expiryDate.getTime())) return true
      expiryDate.setHours(0, 0, 0, 0)
      return expiryDate >= today // Keep promo visible through its valid_until date
    })

    // Remove duplicate promo entries with identical visible content
    const dedupedPromos = []
    const seenPromoKeys = new Set()
    const normalizeText = (v) => String(v || "")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .replace(/[^a-z0-9 ]/g, "")
      .trim()

    const normalizeImage = (url) => {
      const raw = String(url || "").trim()
      if (!raw) return ""
      try {
        const u = new URL(raw, window.location.origin)
        const path = u.pathname || ""
        return path.split("/").pop().toLowerCase()
      } catch (_) {
        return raw.split("?")[0].split("#")[0].split("/").pop().toLowerCase()
      }
    }

    activePromos.forEach((p) => {
      const contentKey = normalizeText(p.content)
      const imageKey = normalizeImage(p.image_url)
      // Strict dedupe: one card per promo message text.
      // Use image only when content is blank.
      const key = contentKey ? `content:${contentKey}` : `image:${imageKey}`
      if (!key) return
      if (!seenPromoKeys.has(key)) {
        seenPromoKeys.add(key)
        dedupedPromos.push(p)
      }
    })

    if (dedupedPromos.length === 0) {
      promoList.innerHTML = `
        <div class="promo-add-card" onclick="openPromoModal()">
          <span>+</span>
        </div>
        <div class="empty-menu" style="min-width:260px;">No active promos found.</div>
      `
      return
    }

    const escapeHtml = (value) => String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;")

    const formatPromoDate = (v) => {
      if (!v) return "N/A"
      const d = new Date(v)
      return Number.isNaN(d.getTime()) ? "N/A" : d.toLocaleDateString()
    }

    dedupedPromos.forEach((p) => {
      const card = document.createElement("div")
      card.className = "promo-mini-card"
      card.setAttribute("onclick", `editPromo('${p.id}')`)
      card.innerHTML = `
        <div class="promo-mini-image-wrap">
          ${p.image_url
            ? `<img src="${escapeHtml(p.image_url)}" alt="Promo image" onerror="this.style.display='none'">`
            : `<div class="promo-no-image">No Photo</div>`
          }
        </div>
        <div class="promo-mini-details">
          <p class="promo-mini-description">Description: ${escapeHtml(p.content || "No description available.")}</p>
          <p class="promo-mini-validation">Validation Date: ${formatPromoDate(p.valid_until)}</p>
        </div>
      `
      promoList.appendChild(card)
    })

  } catch (err) {
    console.error("Error loading promos:", err)
    promoList.innerHTML = `
      <div class="promo-add-card" onclick="openPromoModal()">
        <span>+</span>
      </div>
      <div class="empty-menu" style="min-width:300px;color:red;">Error loading promos: ${err.message || "Unknown error"}</div>
    `
  }
}

window.editPromo = async function(id) {
    try {
        const { data, error } = await db.from("promos").select("*").eq("id", id).single()
        if (error) throw error
        
        document.getElementById("promoContent").value = data.content || ""
        document.getElementById("promoFrom").value = data.valid_from || ""
        document.getElementById("promoUntil").value = data.valid_until || ""
        
        // Handle photo preview
        const previewImg = document.getElementById("promoPreviewImage")
        const noImg = document.getElementById("promoPreviewNoImage")
        if (data.image_url) {
          previewImg.src = data.image_url
          previewImg.style.display = "block"
          noImg.style.display = "none"
        } else {
          previewImg.style.display = "none"
          noImg.style.display = "flex"
        }
        
        const todayStr = getLocalDateYMD()
        const vf = String(data.valid_from || "").trim()
        const vu = String(data.valid_until || "").trim()
        const fromEl = document.getElementById("promoFrom")
        const untilEl = document.getElementById("promoUntil")
        if (fromEl) {
          if (vf && vf < todayStr) fromEl.removeAttribute("min")
          else fromEl.min = todayStr
        }
        if (untilEl) {
          if (vu && vu < todayStr) untilEl.removeAttribute("min")
          else untilEl.min = todayStr
        }

        document.getElementById("promoEditId").value = data.id
        
        const addBtn = document.getElementById("addPromoBtn")
        if (addBtn) addBtn.textContent = "Save"
        
        updatePromoPreview()
        document.getElementById("promoModal").style.display = "flex"
    } catch(err) {
        console.error("Error getting promo:", err)
        showMessage("Error loading promo details", "error")
    }
}

window.deletePromo = async function(id) {
    if(!confirm("Are you sure you want to delete this promo?")) return
    
    try {
        const { error } = await db.from("promos").delete().eq("id", id)
        if (error) throw error
        if (window.logAdminAction) await logAdminAction('Deleted promo', `id: ${id}`)
        showMessage("Promo deleted successfully", "success")
        loadPromos()
    } catch(err) {
        console.error("Error deleting promo:", err)
        showMessage("Error deleting promo", "error")
    }
}

/** Local calendar YYYY-MM-DD (not UTC) — used for promo picker min = today (yesterday and earlier locked). */
function getLocalDateYMD(d = new Date()) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, "0")
  const day = String(d.getDate()).padStart(2, "0")
  return `${y}-${m}-${day}`
}

function resetPromoForm() {
    const el = (id) => document.getElementById(id)
    if (el("promoContent")) el("promoContent").value = ""
    if (el("promoFrom")) el("promoFrom").value = ""
    if (el("promoUntil")) el("promoUntil").value = ""
    if (el("promo_photo")) el("promo_photo").value = ""
    
    const previewImg = el("promoPreviewImage")
    const noImg = el("promoPreviewNoImage")
    if (previewImg) previewImg.style.display = "none"
    if (noImg) noImg.style.display = "flex"
    
    // Promo: lock yesterday and all earlier dates; first selectable day is today
    const todayStr = getLocalDateYMD()
    const fromInput = el("promoFrom")
    const untilInput = el("promoUntil")
    if (fromInput) fromInput.min = todayStr
    if (untilInput) untilInput.min = todayStr
    
    if (el("promoEditId")) el("promoEditId").value = ""
    if (el("addPromoBtn")) el("addPromoBtn").style.display = "inline-block"
    if (el("updatePromoBtn")) el("updatePromoBtn").style.display = "none"
    if (el("cancelPromoBtn")) el("cancelPromoBtn").style.display = "none"
    
    if (typeof updatePromoPreview === 'function') updatePromoPreview()
}

window.addPromoSubmit = async function addPromoSubmit() {
  console.log("[Admin] addPromoSubmit initiated");
  const addBtn = document.getElementById("addPromoBtn")
  if (!addBtn) return
  if (!db) {
    console.error("[Admin] Database (db) not initialized");
    showMessage("Database not ready yet. Please try again.", "error")
    return
  }

  const content = document.getElementById("promoContent").value.trim()
  const valid_from = document.getElementById("promoFrom").value
  const valid_until = document.getElementById("promoUntil").value
  const photoFile = document.getElementById("promo_photo").files[0]

  if (!content) {
    showMessage("Please enter content", "error")
    return
  }

  const today = new Date()
  today.setHours(0, 0, 0, 0)
  
  const parseValidDate = (v) => {
    if (!v) return null
    const s = String(v).trim()
    if (!s) return null
    const d = new Date(s)
    if (Number.isNaN(d.getTime())) return null
    return d
  }

  const fromDate = parseValidDate(valid_from)
  const untilDate = parseValidDate(valid_until)
  
  // Point: valid from/until should be today or forward
  if (fromDate) {
    fromDate.setHours(0, 0, 0, 0)
    if (fromDate < today) {
      showMessage("Valid from date cannot be in the past", "error")
      return
    }
  }

  if (untilDate) {
    untilDate.setHours(0, 0, 0, 0)
    if (untilDate < today) {
      showMessage("Valid until date cannot be in the past", "error")
      return
    }
    if (fromDate && untilDate < fromDate) {
      showMessage("Valid until date cannot be before valid from date", "error")
      return
    }
  }

  addBtn.disabled = true
  const prevText = addBtn.textContent
  addBtn.textContent = "Adding..."

  try {
    let imageUrl = null
    if (photoFile) {
        console.log("[Admin] Uploading promo photo...");
        const timestamp = Date.now()
        const fileName = `promo_${timestamp}`
        const { error: uploadError } = await db.storage.from('product-photos').upload(fileName, photoFile)
        
        if (uploadError) {
             console.warn("Storage upload failed, trying Base64 fallback:", uploadError)
             imageUrl = await resizeImage(photoFile, 800, 0.7)
        } else {
             const { data: { publicUrl } } = db.storage.from('product-photos').getPublicUrl(fileName)
             imageUrl = publicUrl
        }
    }

    const basePayload = {
      content,
      title: content.slice(0, 60),
      valid_from: fromDate ? fromDate.toISOString().split("T")[0] : null,
      valid_until: untilDate ? untilDate.toISOString().split("T")[0] : null,
    }
    if (imageUrl) basePayload.image_url = imageUrl

    console.log("[Admin] Inserting promo payload:", basePayload)

    const payloadAttempts = [
      basePayload,
      { content, title: content.slice(0, 60), ...(imageUrl ? { image_url: imageUrl } : {}) },
      { content, ...(imageUrl ? { image_url: imageUrl } : {}) },
      { content }
    ]

    let error = null
    for (const attempt of payloadAttempts) {
      const res = await db.from("promos").insert([attempt])
      if (!res.error) {
        error = null
        break
      }
      error = res.error
      console.warn("[Admin] Promo insert attempt failed:", error.message || error)
    }
    
    if (error) throw error
    
    if (window.logAdminAction) await logAdminAction("Added promo", content)
    showMessage("Promo added successfully", "success")
    resetPromoForm()
    loadPromos()
  } catch (err) {
    console.error("Error adding promo:", err)
    showMessage("Error adding promo: " + (err.message || err.details || "Unknown error"), "error")
  } finally {
    addBtn.disabled = false
    addBtn.textContent = prevText || "Add Promo"
  }
}

function attachPromoHandlers() {
  // NOTE: Add Promo click is already handled via HTML onclick="addPromoSubmit()".
  // Attaching another listener here would double-submit.
  const updateBtn = document.getElementById("updatePromoBtn")
  if (updateBtn && !updateBtn.__qt_bound) {
    updateBtn.__qt_bound = true
    updateBtn.addEventListener("click", async () => {
      const id = document.getElementById("promoEditId").value
      const content = document.getElementById("promoContent").value.trim()
      const valid_from = document.getElementById("promoFrom").value
      const valid_until = document.getElementById("promoUntil").value
      const photoFile = document.getElementById("promo_photo").files[0]

      if (!id || !content) {
        showMessage("Please enter content", "error")
        return
      }

      const today = new Date()
      today.setHours(0, 0, 0, 0)
      
      const parseValidDate = (v) => {
        if (!v) return null
        const s = String(v).trim()
        if (!s) return null
        const d = new Date(s)
        if (Number.isNaN(d.getTime())) return null
        return d
      }

      const fromDate = parseValidDate(valid_from)
      const untilDate = parseValidDate(valid_until)
      
      if (fromDate) {
        fromDate.setHours(0, 0, 0, 0)
        if (fromDate < today) {
          showMessage("Valid from date cannot be in the past", "error")
          return
        }
      }

      if (untilDate) {
        untilDate.setHours(0, 0, 0, 0)
        if (untilDate < today) {
          showMessage("Valid until date cannot be in the past", "error")
          return
        }
        if (fromDate && untilDate < fromDate) {
          showMessage("Valid until date cannot be before valid from date", "error")
          return
        }
      }

      updateBtn.disabled = true
      const prevText = updateBtn.textContent
      updateBtn.textContent = "Updating..."

      try {
        let imageUrl = null
        if (photoFile) {
            const timestamp = Date.now()
            const fileName = `promo_${timestamp}`
            const { error: uploadError } = await db.storage.from('product-photos').upload(fileName, photoFile)
            
            if (uploadError) {
                 console.warn("Storage upload failed, trying Base64 fallback:", uploadError)
                 imageUrl = await resizeImage(photoFile, 800, 0.7)
            } else {
                 const { data: { publicUrl } } = db.storage.from('product-photos').getPublicUrl(fileName)
                 imageUrl = publicUrl
            }
        }

        const updateData = { 
            content, 
            valid_from: fromDate ? fromDate.toISOString().split('T')[0] : null,
            valid_until: untilDate ? untilDate.toISOString().split('T')[0] : null 
        }
        if (imageUrl) updateData.image_url = imageUrl

        let { error } = await db.from("promos").update(updateData).eq("id", id)
        
        // Fallback for column errors during update
        if (error && (error.message.includes("valid_from") || error.code === "PGRST204" || error.message.includes("Could not find column"))) {
            console.warn("[Admin] Column error during update, retrying without extended fields");
            const fallbackUpdate = { content };
            if (imageUrl) fallbackUpdate.image_url = imageUrl;
            const retry = await db.from("promos").update(fallbackUpdate).eq("id", id);
            error = retry.error;
        }

        if (error) throw error
        
        if (window.logAdminAction) await logAdminAction("Updated promo", content)
        showMessage("Promo updated successfully", "success")
        resetPromoForm()
        loadPromos()
      } catch (err) {
        console.error("Error updating promo:", err)
        showMessage("Error updating promo: " + (err && err.message ? err.message : "Unknown error"), "error")
      } finally {
        updateBtn.disabled = false
        updateBtn.textContent = prevText || "Update Promo"
      }
    })
  }

  const cancelBtn = document.getElementById("cancelPromoBtn")
  if (cancelBtn && !cancelBtn.__qt_bound) {
    cancelBtn.__qt_bound = true
    cancelBtn.addEventListener("click", resetPromoForm)
  }

  resetPromoForm()
}

// Promo Event Listeners (works even if DOMContentLoaded already fired)
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", attachPromoHandlers)
else attachPromoHandlers()

// --- MENU MANAGEMENT ---
async function loadMenu() {
  const menuList = document.getElementById("menuList")
  if (!menuList) return
  menuList.innerHTML = ""

  try {
    let query = db.from("products").select("*")
    if (menuArchiveMode) {
      query = query.eq("archived", true)
    } else {
      query = query.eq("archived", false)
    }

    const { data, error } = await query
    if (error) {
      console.error("[v0] Error loading menu:", error)
      return
    }
    const allData = data || []
    // The filtering by archive status is now done in the database query, so visibleData is no longer needed.
    // const visibleData = allData.filter((d) => (menuArchiveMode ? d.archived === true : d.archived !== true))
    
    if (!allData || allData.length === 0) {
      menuList.innerHTML = menuArchiveMode
        ? '<div class="empty-menu">No archived products.</div>'
        : '<div class="empty-menu">No products added yet.</div>'
      return
    }

    // Group products by name
    const grouped = {}
    allData.forEach((d) => {
      const name = String(d.name || "").trim()
      const key = name.toLowerCase()

      if (!grouped[key]) {
        grouped[key] = {
          name: name,
          category_id: d.category_id,
          image_url: d.image_url || "",
          description: d.description || "",
          sizes: [],
        }
      }
      if (!grouped[key].image_url && d.image_url) {
        grouped[key].image_url = d.image_url
      }
      if (!grouped[key].description && d.description) {
        grouped[key].description = d.description
      }
      grouped[key].sizes.push({
        docId: d.id,
        size: d.size || "",
        price: Number(d.price || 0),
        id: d.id,
      })
    })

    const sortedGroups = Object.values(grouped).sort((a, b) => {
      const ca = Number(a.category_id || 0)
      const cb = Number(b.category_id || 0)
      if (ca !== cb) return ca - cb
      return a.name.localeCompare(b.name)
    })

    let filteredGroups =
      currentMenuFilter === "all"
        ? sortedGroups
        : sortedGroups.filter((g) => {
            const catName = getCategoryName(Number(g.category_id)).toLowerCase();
            return catName === currentMenuFilter.toLowerCase();
          })

    if (currentMenuSearch) {
      filteredGroups = filteredGroups.filter((g) => g.name.toLowerCase().includes(currentMenuSearch))
    }

    if (filteredGroups.length === 0) {
      menuList.innerHTML = currentMenuSearch
        ? '<div class="empty-menu">No products match your search.</div>'
        : '<div class="empty-menu">No products in this category.</div>'
      return
    }

    filteredGroups.forEach((group) => {
      const card = document.createElement("div")
      card.className = "product-card"
      group.sizes.sort((a, b) => a.price - b.price)
      
      const firstId = group.sizes[0]?.docId || Math.random().toString(36).substr(2, 9)

      const photoHTML = group.image_url
        ? `<img src="${group.image_url}" alt="${group.name}" class="product-photo" onerror="this.style.display='none'">`
        : '<div class="no-photo">No Photo</div>'

            const sizesHTML = group.sizes
        .map((s) => {
          const actionButtons = menuArchiveMode
            ? `<button onclick="restoreVariant('${s.docId}', '${group.name.replace(/'/g, "\\'")}')" class="btn-edit-sm">Restore</button>`
            : `<button onclick="deleteVariant('${s.docId}', '${group.name.replace(/'/g, "\\'")}')" class="btn-delete-sm">Archive</button>`
          return `
        <div class="size-row">
          <span class="size-label">${s.size || "Default"}</span>
          <span class="size-price">\u20B1${s.price.toFixed(2)}</span>
          <div class="size-actions">
            ${actionButtons}
          </div>
        </div>
      `
        })
        .join("")

      const productActions = menuArchiveMode
        ? `<button onclick="restoreEntireProduct('${group.name.replace(/'/g, "\\'")}')" class="btn-edit">Restore Product</button>`
        : `
            <button onclick="editDescription('${group.name.replace(/'/g, "\\'")}')" class="btn-edit">Edit</button>
            <button onclick="deleteEntireProduct('${group.name.replace(/'/g, "\\'")}')" class="btn-delete">Archive All</button>`

      card.innerHTML = `
        <div class="product-photo-container">
          ${photoHTML}
        </div>
        <div class="product-info">
          <span class="product-category">${getCategoryName(Number(group.category_id)).toUpperCase()}</span>
          <h4 class="product-name">${group.name}</h4>
          <div class="product-description-container">
            <p class="product-description" id="desc-${firstId}">${group.description || "No description available."}</p>
            ${String(group.description || "").trim() ? `<button type="button" onclick="toggleDescription(this, 'desc-${firstId}')" class="btn-read-more">Show More</button>` : ""}
          </div>
          <div class="product-actions">
            ${productActions}
          </div>
        </div>
        <div class="sizes-list">
          <div class="sizes-header">
            <span>SIZE</span>
            <span>PRICE</span>
          </div>
          ${sizesHTML}
        </div>
      `
      menuList.appendChild(card)
      if (String(group.description || "").trim()) {
        scheduleProductReadMoreVisibility(card, `desc-${firstId}`)
      }
    })
  } catch (err) {
    console.error("[v0] Error loading menu:", err)
  }
}

// Generate next product ID based on category
async function getNextProductId(category_id) {
  const base = CATEGORY_ID_BASE[category_id] || 100
  try {
      // 1. Find max ID within the category
      const { data, error } = await db
        .from("products")
        .select("id")
        .eq("category_id", category_id)
      
      if (error) throw error
      
      let maxId = base - 1
      if (data) {
        data.forEach((d) => {
            const pid = Number(d.id || 0)
            if (pid > maxId) maxId = pid
        })
      }
      
      let nextId = maxId + 1

      // 2. Safety Check: Ensure this ID is not taken by ANY product (cross-category collision check)
      // This handles cases where an ID exists but has the wrong category_id
      let isTaken = true
      while (isTaken) {
          const { data: checkData } = await db.from("products").select("id").eq("id", nextId).single()
          if (checkData) {
              // ID exists! Increment and try again
              console.warn(`Collision detected for ID ${nextId}. Incrementing...`)
              nextId++
          } else {
              isTaken = false
          }
      }
      
      return nextId
  } catch (e) {
      console.warn("Error getting next product ID (using base):", e)
      return base
  }
}

// Reset form to default state
window.resetForm = function () {
  const editDocId = document.getElementById("editDocId")
  const productName = document.getElementById("productName")
  const productCategory = document.getElementById("productCategory")
  const description = document.getElementById("description")
  const productPhoto = document.getElementById("product_photo")
  const pricesEditList = document.getElementById("pricesEditList")
  const modalPricesList = document.getElementById("modalPricesList")
  const saveProductBtn = document.getElementById("saveProductBtn")

  if (editDocId) editDocId.value = ""
  if (productName) productName.value = ""
  if (productCategory) productCategory.value = "Coffee"
  if (description) description.value = ""
  if (productPhoto) productPhoto.value = ""
  // Preserve existing product photo across description-only saves.
  window.currentEditImageUrl = ""
  if (pricesEditList) {
    pricesEditList.innerHTML = ""
    window.addNewVariantRow()
  }
  if (modalPricesList) modalPricesList.innerHTML = ""
  if (saveProductBtn) {
    saveProductBtn.disabled = false
    saveProductBtn.textContent = "Save"
  }

  const preview = document.getElementById("previewImage")
  const placeholder = document.getElementById("previewNoImage")
  if (preview) {
    preview.src = ""
    preview.style.display = "none"
  }
  if (placeholder) placeholder.style.display = "flex"

  if (typeof window.focusDescriptionView === "function") window.focusDescriptionView()
  updateProductPreview()
}

// Update Product Preview
window.updateProductPreview = (productName = "Product Name", category = "Coffee", imageUrl = "", prices = []) => {
  const previewProductName = document.getElementById("previewProductName")
  const previewProductCategory = document.getElementById("previewProductCategory")
  if (previewProductName) previewProductName.textContent = productName
  if (previewProductCategory) previewProductCategory.textContent = category
  
  const previewImg = document.getElementById("previewImage")
  const noImg = document.getElementById("previewNoImage")
  if (imageUrl) {
    previewImg.src = imageUrl
    previewImg.style.display = "block"
    noImg.style.display = "none"
  } else {
    previewImg.src = ""
    previewImg.style.display = "none"
    noImg.style.display = "flex"
  }

  const modalPricesList = document.getElementById("modalPricesList")
  if (modalPricesList) {
    modalPricesList.innerHTML = prices.map(p => `
      <div class="modal-price-item">
        <span>${p.size || "N/A"}</span>
        <span>₱${p.price.toFixed(2)}</span>
      </div>
    `).join("")
  }
}

// Manage views in the right panel
window.focusDescriptionView = () => {
  document.getElementById("descriptionView").style.display = "block"
  document.getElementById("pricesEditView").style.display = "none"
}

window.focusPriceEdit = () => {
  document.getElementById("descriptionView").style.display = "none"
  document.getElementById("pricesEditView").style.display = "block"
}

function scheduleProductReadMoreVisibility(card, descId) {
  const desc = document.getElementById(descId)
  const btn = card.querySelector(".btn-read-more")
  if (!desc || !btn) return
  const measure = () => {
    if (desc.classList.contains("expanded")) return
    const overflow = desc.scrollHeight > desc.clientHeight + 1
    btn.style.display = overflow ? "block" : "none"
  }
  requestAnimationFrame(() => requestAnimationFrame(measure))
}

window.toggleDescription = (btn, id) => {
  const desc = document.getElementById(id)
  if (desc.classList.contains('expanded')) {
    desc.classList.remove('expanded')
    btn.textContent = 'Show More'
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const overflow = desc.scrollHeight > desc.clientHeight + 1
      btn.style.display = overflow ? "block" : "none"
    }))
  } else {
    desc.classList.add('expanded')
    btn.textContent = 'Show Less'
    btn.style.display = "block"
  }
}

// Edit description or general product info
window.editDescription = async (productName) => {
  try {
    const db = getDB()
    const { data, error } = await db.from("products").select("*").eq("name", productName).limit(1).single()
    if (error) throw error

    window.resetForm()
    document.getElementById("productName").value = data.name
    document.getElementById("productCategory").value = getCategoryName(Number(data.category_id))
    document.getElementById("description").value = data.description || ""
    document.getElementById("editDocId").value = data.name
    
    if (data.image_url) {
      const preview = document.getElementById("previewImage")
      const placeholder = document.getElementById("previewNoImage")
      preview.src = data.image_url
      preview.style.display = "block"
      placeholder.style.display = "none"
    }
    window.currentEditImageUrl = data.image_url || ""

    await populateModalPrices(productName)

    document.getElementById("addProductModal").style.display = "flex"
    document.getElementById("description").focus()
  } catch (err) {
    console.error("Error loading product for description edit:", err)
    showMessage("Error loading product details", "error")
  }
}

// Update saveProduct to handle UPDATE_ALL_BY_NAME
window.saveProduct = async () => {
  const productNameEl = document.getElementById("productName")
  const productCategoryEl = document.getElementById("productCategory")
  const descriptionEl = document.getElementById("description")
  const photoEl = document.getElementById("product_photo")
  const editId = document.getElementById("editDocId").value

  const product_name = productNameEl.value.trim()
  const category_name = productCategoryEl.value
  const category_id = getCategoryId(category_name)
  const description = descriptionEl.value.trim()

  if (!product_name || !category_name) {
    showMessage("Please fill in all required fields (Product Name, Category).", "error")
    return
  }

  const btn = document.getElementById("saveProductBtn")
  btn.disabled = true
  const prevText = btn.textContent
  btn.textContent = "Saving..."

  try {
    let imageUrl = null
    if (photoEl.files.length > 0) {
      const photoFile = photoEl.files[0]
      const timestamp = Date.now()
      const fileName = `product_${timestamp}`
      const { error: uploadError } = await db.storage.from('product-photos').upload(fileName, photoFile)
      
      if (uploadError) {
        console.warn("Storage upload failed, trying Base64 fallback:", uploadError)
        imageUrl = await resizeImage(photoFile, 800, 0.7)
      } else {
        const { data: { publicUrl } } = db.storage.from('product-photos').getPublicUrl(fileName)
        imageUrl = publicUrl
      }
    }
    const preservedImageUrl =
      imageUrl ||
      window.currentEditImageUrl ||
      (document.getElementById("previewImage")?.style.display !== "none" ? document.getElementById("previewImage")?.src : "") ||
      ""

    // Handle variants (sizes and prices)
    const variants = []
    const priceEditRows = document.querySelectorAll("#pricesEditList .price-edit-row")
    priceEditRows.forEach(row => {
      const sizeInput = row.querySelector(".input-size")
      const priceInput = row.querySelector(".input-price")
      const variantId = row.dataset.id

      const size = sizeInput ? sizeInput.value.trim() : ""
      const price = parseFloat(priceInput ? priceInput.value : "0")

      if (size && !isNaN(price)) {
        variants.push({ id: variantId, size, price })
      }
    })

    // If no variants are explicitly added, create a default one
    if (variants.length === 0) {
      variants.push({ id: "NEW", size: "Regular", price: 0 })
    }

    // Update existing product or add new product
    if (editId && editId !== "NEW") {
      // Update existing product (name, category, description, image)
      const baseUpdate = { name: product_name, category_id, description }
      if (preservedImageUrl) baseUpdate.image_url = preservedImageUrl
      
      console.log("[System Log] Updating existing product group:", editId, "to", product_name)
      
      // Update all variants by name (sync common info)
      const { error: updateError } = await db.from("products").update(baseUpdate).eq("name", editId)
      if (updateError) throw updateError

      // Fetch all variant IDs associated with the new name to manage size changes
      const { data: existingVariants, error: selectError } = await db.from("products").select("id").eq("name", product_name)
      if (selectError) throw selectError

      const existingVariantIds = (existingVariants || []).map(v => String(v.id))
      const currentVariantIds = variants.filter(v => v.id && v.id !== "NEW").map(v => String(v.id))

      console.log("[System Log] Managing variants. Existing:", existingVariantIds, "Current:", currentVariantIds)

      // Delete removed variants
      for (const oldId of existingVariantIds) {
        if (!currentVariantIds.includes(oldId)) {
          await db.from("products").delete().eq("id", oldId)
        }
      }

      for (const v of variants) {
        const vData = { name: product_name, category_id, description, size: v.size, price: v.price }
        if (preservedImageUrl) vData.image_url = preservedImageUrl // Keep existing/new image across all variants
        
        if (!v.id || v.id === "NEW" || v.id === "undefined") {
          console.log("[System Log] Adding new variant:", v.size)
          vData.id = await getNextProductId(category_id)
          const { error: insErr } = await db.from("products").insert([vData])
          if (insErr) throw insErr
        } else {
          console.log("[System Log] Updating variant ID:", v.id)
          const { error: updErr } = await db.from("products").update(vData).eq("id", v.id)
          if (updErr) throw updErr
        }
      }
    } else {
      // Add new product with its variants
      for (const v of variants) {
        const vData = { name: product_name, category_id, description, size: v.size, price: v.price }
        if (preservedImageUrl) vData.image_url = preservedImageUrl
        vData.id = await getNextProductId(category_id)
        await db.from("products").insert([vData])
      }
    }

    if (window.logAdminAction) await logAdminAction("Saved product", product_name)
    showMessage("Product saved successfully!", "success")
    document.getElementById("editDocId").value = product_name // Update for potential repeated saves
    window.currentEditImageUrl = preservedImageUrl || ""
    closeProductModal()
    loadMenu()
  } catch (err) {
    console.error("Error saving product:", err)
    showMessage("Error saving product: " + (err.message || "Unknown error"), "error")
  } finally {
    btn.disabled = false
    btn.textContent = prevText || "Save"
  }
}

// Add size to existing product
window.addSizeToProduct = async (productName, categoryId) => {
  window.resetForm()
  document.getElementById("productName").value = productName
  document.getElementById("productCategory").value = getCategoryName(categoryId)
  document.getElementById("editDocId").value = productName // Use product name as editId for variants
  
  await populateModalPrices(productName)
  updateProductPreview(productName, getCategoryName(categoryId), "", []) // Update preview with existing data
  addNewVariantRow() // Add a new empty row for the new size
  
  document.getElementById("addProductModal").style.display = "flex"
  focusPriceEdit() // Automatically switch to price edit view
}

// Edit a specific product variant (size/price)
window.editVariant = async (id) => {
  try {
    const db = getDB()
    const { data, error } = await db.from("products").select("*").eq("id", id).single()
    if (error) throw error

    window.resetForm()
    
    // Set basic info
    document.getElementById("editDocId").value = data.name // Use product name as editId for variants
    document.getElementById("productName").value = data.name
    document.getElementById("productCategory").value = getCategoryName(Number(data.category_id))
    document.getElementById("description").value = data.description || ""

    // Set photo
    let imageUrl = data.image_url || ""
    if (imageUrl) {
      const preview = document.getElementById("previewImage")
      const placeholder = document.getElementById("previewNoImage")
      preview.src = imageUrl
      preview.style.display = "block"
      placeholder.style.display = "none"
    }
    window.currentEditImageUrl = imageUrl || ""

    // Populate prices list in left panel and edit list
    await populateModalPrices(data.name)
    updateProductPreview(data.name, getCategoryName(Number(data.category_id)), imageUrl, []) // Update preview with existing data

    document.getElementById("addProductModal").style.display = "flex"
    focusPriceEdit() // Automatically switch to price edit view
  } catch (err) {
    console.error("Error loading variant for edit:", err)
    showMessage("Failed to load product details.", "error")
  }
}

// Helper to populate the prices list in the redesigned modal
async function populateModalPrices(productName) {
  const modalPricesList = document.getElementById("modalPricesList")
  const pricesEditList = document.getElementById("pricesEditList")
  if (!modalPricesList && !pricesEditList) return

  try {
    const { data, error } = await db
      .from("products")
      .select("*")
      .eq("name", productName)
      .or("archived.is.null,archived.eq.false")
      .order("price")
    if (error) throw error

    if (modalPricesList) modalPricesList.innerHTML = ""
    if (pricesEditList) pricesEditList.innerHTML = ""

    if (data && data.length > 0) {
      data.forEach((p) => {
        if (modalPricesList) {
          modalPricesList.innerHTML += `
            <div class="modal-price-item">
              <span>${p.size || "N/A"}</span>
              <span>₱${p.price.toFixed(2)}</span>
            </div>
          `
        }
        if (pricesEditList) {
          pricesEditList.innerHTML += `
            <div class="price-edit-row" data-id="${p.id}">
              <input type="text" class="input-size" value="${p.size || ""}" placeholder="Size (e.g., Small, 16oz)">
              <input type="number" class="input-price" value="${p.price}" step="0.01" placeholder="Price">
              <button class="btn-remove-variant" onclick="removeVariantRow(this)">-</button>
            </div>
          `
        }
      })
    } else {
      if (modalPricesList) modalPricesList.innerHTML = "<div class='modal-price-item'><span>No prices set</span></div>"
    }
  } catch (err) {
    console.error("Error populating modal prices:", err)
    if (modalPricesList) modalPricesList.innerHTML = "<div class='modal-price-item' style='color:red;'>Error loading prices</div>"
  }
}

window.focusPriceEdit = async () => {
  const productName = document.getElementById("productName").value
  if (!productName) return showMessage("Please set a product name first.", "error")
  
  // Load editable rows
  await populateModalPrices(productName)
  const pricesEditList = document.getElementById("pricesEditList")
  if (pricesEditList) {
    pricesEditList.scrollIntoView({ behavior: "smooth", block: "center" })
    const firstSizeInput = pricesEditList.querySelector(".input-size")
    if (firstSizeInput) firstSizeInput.focus()
  }
}

window.focusDescriptionView = () => {
  // No specific action needed here for now, as description is always visible
}

async function populatePricesEditList(productName) {
  const container = document.getElementById("pricesEditList")
  if (!container) return
  container.innerHTML = "Loading..."
  
  try {
    const db = getDB()
    const { data, error } = await db.from("products")
      .select("id, size, price")
      .eq("name", productName)
      .eq("archived", false)
      .order("price", { ascending: true })
    
    if (error) throw error
    
    container.innerHTML = data.map(s => `
      <div class="price-edit-row" data-id="${s.id}">
        <input type="text" class="input-size" value="${s.size || ""}" placeholder="Size (e.g. 16oz)">
        <input type="number" class="input-price" value="${s.price}" placeholder="Price">
        <button class="btn-remove-variant" onclick="this.parentElement.remove()">×</button>
      </div>
    `).join("")
    
    if (data.length === 0) addNewVariantRow()
  } catch (e) {
    console.error("Error populating edit list:", e)
    container.innerHTML = "Error loading variants."
  }
}

window.addNewVariantRow = () => {
  const container = document.getElementById("pricesEditList")
  if (!container) return
  const row = document.createElement("div")
  row.className = "price-edit-row"
  row.setAttribute("data-id", "NEW")
  row.innerHTML = `
    <input type="text" class="input-size" placeholder="Size (e.g. 16oz)">
    <input type="number" class="input-price" placeholder="Price">
    <button class="btn-remove-variant" onclick="this.parentElement.remove()">×</button>
  `
  container.appendChild(row)
}

window.removeVariantRow = (btn) => {
  if (!btn || !btn.parentElement) return
  btn.parentElement.remove()
}

// Update saveProduct to handle the dynamic prices list


// Update closeProductModal to reset views
window.closeProductModal = () => {
  document.getElementById("addProductModal").style.display = "none"
  window.focusDescriptionView()
}

// Archive a specific product variant
window.deleteVariant = async (id, productName) => {
  if (!confirm(`Archive this size from ${productName}?`)) return

  try {
    const db = getDB()
    const { error } = await db.from("products").update({ archived: true, archived_at: new Date().toISOString() }).eq("id", id)
    if (error) throw error
    if (window.logAdminAction) await logAdminAction('Archived product variant', `${productName} id:${id}`)

    loadMenu()
  } catch (err) {
    console.error("Error archiving variant:", err)
    alert("Failed to archive product size.")
  }
}

window.restoreVariant = async (id, productName) => {
  try {
    const db = getDB()
    const { error } = await db.from("products").update({ archived: false, archived_at: null }).eq("id", id)
    if (error) throw error
    if (window.logAdminAction) await logAdminAction('Restored product variant', `${productName} id:${id}`)
    loadMenu()
  } catch (err) {
    console.error("Error restoring variant:", err)
    alert("Failed to restore product size.")
  }
}

// Change photo for all variants of a product (by shared name)
window.editProductPhoto = (productName) => {
  const input = document.createElement("input")
  input.type = "file"
  input.accept = "image/*"
  input.onchange = async (e) => {
    const file = e.target.files && e.target.files[0]
    if (!file) return
    
    try {
      const db = getDB()
      const timestamp = Date.now()
      const sanitizedName = String(productName || "product").replace(/[^a-z0-9]/gi, "_").toLowerCase()
      const fileName = `${sanitizedName}_${timestamp}`
      
      const { error: uploadError } = await db.storage.from('product-photos').upload(fileName, file)
      if (uploadError) throw uploadError
      
      const { data: urlData } = db.storage.from('product-photos').getPublicUrl(fileName)
      const publicUrl = urlData?.publicUrl
      
      const { error: updErr } = await db.from("products").update({ image_url: publicUrl }).eq("name", productName)
      if (updErr) throw updErr
      
      loadMenu()
    } catch (err) {
      console.error("Error changing product photo:", err)
      alert("Failed to change photo: " + (err.message || "Unknown error"))
    }
  }
  input.click()
}

// Archive all variants of a product (by shared name)
window.deleteEntireProduct = async (productName) => {
  if (!confirm(`Archive ALL variants of "${productName}"?`)) return
  try {
    const db = getDB()
    const { error } = await db.from("products").update({ archived: true, archived_at: new Date().toISOString() }).eq("name", productName)
    if (error) throw error
    if (window.logAdminAction) await logAdminAction('Archived product', productName)
    loadMenu()
  } catch (err) {
    console.error("Error archiving product group:", err)
    alert("Failed to archive product.")
  }
}

window.restoreEntireProduct = async (productName) => {
  try {
    const db = getDB()
    const { error } = await db.from("products").update({ archived: false, archived_at: null }).eq("name", productName)
    if (error) throw error
    if (window.logAdminAction) await logAdminAction('Restored product', productName)
    loadMenu()
  } catch (err) {
    console.error("Error restoring product group:", err)
    alert("Failed to restore product.")
  }
}

// Update resetForm to clear the dynamic list
function resizeImage(file, maxWidth = 400, quality = 0.5) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = (event) => {
      const img = new Image();
      img.src = event.target.result;
      img.onload = () => {
        const canvas = document.createElement('canvas');
        let width = img.width;
        let height = img.height;

        if (width > maxWidth) {
          height = height * (maxWidth / width);
          width = maxWidth;
        }

        canvas.width = width;
        canvas.height = height;

        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.onerror = reject;
    };
    reader.onerror = reject;
  });
}

// --- CALENDAR LOGIC (Simplified) ---
let currentCalendarDate = new Date()

window.initCalendar = () => {
    window.renderCalendar(currentCalendarDate)
}

window.prevMonth = () => {
    currentCalendarDate.setMonth(currentCalendarDate.getMonth() - 1)
    window.renderCalendar(currentCalendarDate)
}

window.nextMonth = () => {
    currentCalendarDate.setMonth(currentCalendarDate.getMonth() + 1)
    window.renderCalendar(currentCalendarDate)
}

let selectedTodoDate = null

window.renderCalendar = async (date = new Date()) => {
    const calendarBody = document.getElementById("calendarBody")
    const monthYear = document.getElementById("monthYear")
    if (!calendarBody || !monthYear) return

    const year = date.getFullYear()
    const month = date.getMonth()
    
    monthYear.textContent = new Date(year, month).toLocaleString('default', { month: 'long', year: 'numeric' })
    
    // Get bookings and todos for this month to mark dots
    const startOfMonth = new Date(year, month, 1).toISOString()
    const endOfMonth = new Date(year, month + 1, 0).toISOString()
    
    let bookings = []
    let todos = []

    try {
        const { data: bData } = await db.from("bookings")
            .select("date, status")
            .gte("date", startOfMonth.split('T')[0])
            .lte("date", endOfMonth.split('T')[0])
        bookings = bData || []
        
        const { data: tData } = await db.from("todos")
            .select("date, completed")
            .gte("date", startOfMonth.split('T')[0])
            .lte("date", endOfMonth.split('T')[0])
        todos = tData || []
    } catch (e) {
        console.warn("Error fetching calendar events", e)
    }

    const eventsByDate = {}
    bookings.forEach(b => {
        if (!eventsByDate[b.date]) eventsByDate[b.date] = { hasBooking: false, hasTodo: false }
        if (b.status !== 'rejected' && b.status !== 'cancelled') eventsByDate[b.date].hasBooking = true
    })
    todos.forEach(t => {
        if (!eventsByDate[t.date]) eventsByDate[t.date] = { hasBooking: false, hasTodo: false }
        if (!t.completed) eventsByDate[t.date].hasTodo = true
    })

    calendarBody.innerHTML = ""
    
    const firstDay = new Date(year, month, 1).getDay()
    const daysInMonth = new Date(year, month + 1, 0).getDate()
    
    let dateCnt = 1
    for (let i = 0; i < 6; i++) {
        const row = document.createElement("tr")
        for (let j = 0; j < 7; j++) {
            const cell = document.createElement("td")
            if (i === 0 && j < firstDay) {
                // empty
            } else if (dateCnt > daysInMonth) {
                // empty
            } else {
                const currentDateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(dateCnt).padStart(2, '0')}`
                cell.textContent = dateCnt
                
                // Add dots
                const dots = document.createElement("div")
                dots.className = "calendar-dots"
                if (eventsByDate[currentDateStr]?.hasBooking) {
                    const d = document.createElement("span")
                    d.style.backgroundColor = "#e91e63" // Pink for booking
                    dots.appendChild(d)
                }
                if (eventsByDate[currentDateStr]?.hasTodo) {
                    const d = document.createElement("span")
                    d.style.backgroundColor = "#2196f3" // Blue for note
                    dots.appendChild(d)
                }
                cell.appendChild(dots)

                // Selection logic
                if (selectedTodoDate === currentDateStr) {
                    cell.classList.add("selected")
                }
                
                cell.onclick = () => selectDate(currentDateStr, cell)
                dateCnt++
            }
            row.appendChild(cell)
        }
        calendarBody.appendChild(row)
        if (dateCnt > daysInMonth) break
    }
}

function selectDate(dateStr, cellElement) {
    selectedTodoDate = dateStr
    document.querySelectorAll("#calendar td").forEach(td => td.classList.remove("selected"))
    if (cellElement) cellElement.classList.add("selected")
    
    document.getElementById("todoSection").style.display = "block"
    document.getElementById("selectedDateDisplay").textContent = dateStr
    
    document.getElementById("todoInput").disabled = false
    document.getElementById("addTodoBtn").disabled = false
    
    renderTodos()
}

// --- BOOKINGS ---
window.renderBookingsList = async () => {
  const tbody = document.getElementById("bookingsBody")
  if (!tbody) return
  
  const filterStatus = document.getElementById("bookingStatusFilter")?.value || "all"
  const filterType = document.getElementById("bookingTypeFilter")?.value || "all"
  const searchQuery = document.getElementById("bookingSearch")?.value?.toLowerCase() || ""

  try {
    // 1. Fetch data from both tables
    const [bookingsRes, ordersRes] = await Promise.all([
      db.from("bookings").select("*").order("created_at", { ascending: false }),
      db.from("pending_orders").select("*").order("created_at", { ascending: false })
    ])

    if (bookingsRes.error) throw bookingsRes.error
    if (ordersRes.error) throw ordersRes.error

    const allData = []

    // 2. Unify data
    if (bookingsRes.data) {
      bookingsRes.data.forEach(d => allData.push({ ...d, source: 'bookings' }))
    }
    if (ordersRes.data) {
      ordersRes.data.forEach(d => allData.push({ ...d, source: 'pending_orders', type: 'active_orders' }))
    }

    tbody.innerHTML = ""
    
    if (allData.length === 0) {
      tbody.innerHTML = '<tr><td colspan="9" style="text-align:center; padding:40px; color:#999;">No customer transactions found.</td></tr>'
      return
    }

    let hasPendingGlobal = false
    const filteredData = allData.filter((d) => {
      const status = d.status || 'pending'
      if (status === 'pending') hasPendingGlobal = true
      
      const isArchived = d.archived === true
      const type = d.type || ""
      
      // Status filtering logic
      let matchStatus = false
      if (filterStatus === "all") {
        // "All Active" = not archived AND not in terminal states
        matchStatus = !isArchived && !['completed', 'rejected', 'cancelled'].includes(status)
      } else if (filterStatus === "archived") {
        matchStatus = isArchived || ['completed', 'rejected', 'cancelled'].includes(status)
      } else {
        matchStatus = (status === filterStatus)
      }

      // Type filtering logic
      let matchType = true
      if (filterType === "booking") {
        matchType = (type !== "preorder" && type !== "active_orders")
      } else if (filterType === "preorder") {
        matchType = (type === "preorder")
      }

      // Search filtering logic
      let matchSearch = true
      if (searchQuery) {
        const itemsRaw = d.items || "[]"
        let itemsText = ""
        try {
          const parsedItems = typeof itemsRaw === 'string' ? JSON.parse(itemsRaw) : itemsRaw
          itemsText = (parsedItems || []).map(i => i.name || "").join(" ").toLowerCase()
        } catch(e) {}
        
        const searchData = [
          d.customer_id,
          d.customer_name,
          d.id,
          status,
          type,
          itemsText
        ].join(" ").toLowerCase()
        
        matchSearch = searchData.includes(searchQuery)
      }

      return matchStatus && matchType && matchSearch
    })

    const warningEl = document.getElementById("pendingWarning")
    if (warningEl) {
      warningEl.style.display = hasPendingGlobal ? "block" : "none"
    }

    if (filteredData.length === 0) {
      tbody.innerHTML = '<tr><td colspan="9" style="text-align:center; padding:40px; color:#999;">No matches for current filters.</td></tr>'
      return
    }

    // Sort: 1. Most recent date (desc), 2. Most recent time (desc), 3. Status priority
    const priorityOrder = { pending: 0, accepted: 1, confirmed: 2, preparing: 3, ready: 4, cancelled: 5, completed: 6, rejected: 7 }
    filteredData.sort((a, b) => {
      // 1. Sort by Date (Most recent first)
      const dateA = a.date || a.created_at?.slice(0, 10) || "0000-00-00"
      const dateB = b.date || b.created_at?.slice(0, 10) || "0000-00-00"
      if (dateA !== dateB) return dateB.localeCompare(dateA)

      // 2. Sort by Time (Most recent first)
      const timeA = a.time || a.created_at?.slice(11, 16) || "00:00"
      const timeB = b.time || b.created_at?.slice(11, 16) || "00:00"
      if (timeA !== timeB) return timeB.localeCompare(timeA)

      // 3. Sort by Status Priority
      const statusA = priorityOrder[a.status?.toLowerCase()] !== undefined ? priorityOrder[a.status?.toLowerCase()] : 999
      const statusB = priorityOrder[b.status?.toLowerCase()] !== undefined ? priorityOrder[b.status?.toLowerCase()] : 999
      return statusA - statusB
    })

    // Fetch customer names
    const customerIds = [...new Set(filteredData.map(b => b.customer_id).filter(Boolean))]
    const { data: customersData } = customerIds.length > 0 
      ? await db.from("customers").select("id, name, email").in("id", customerIds)
      : { data: [] }
    
    const customerMap = {}
    if (customersData) {
      customersData.forEach(c => { map[c.id] = c.name || c.email || c.id })
    }

    filteredData.forEach((d) => {
      const name = d.customer_name || customerMap[d.customer_id] || d.customer_id || "Guest"
      const dateStr = d.date || d.created_at?.slice(0, 10) || ""
      const timeStr = d.time || d.created_at?.slice(11, 16) || ""
      const type = d.type || ""
      
      let typeDisplay = "Booking"
      if (type === "preorder") typeDisplay = "Pre-order"
      else if (type === "active_orders") typeDisplay = "Active Order"
    
      let paymentInfo = "Cash"
      if (d.payment_method === 'online') {
          paymentInfo = `<span style="color:#2196F3; font-weight:bold;">Online</span>`
          if (d.proof_of_payment) {
              paymentInfo += `<br><a href="${d.proof_of_payment}" target="_blank" style="font-size:0.85em; text-decoration:underline;">View Receipt</a>`
          } else {
              paymentInfo += `<br><span style="font-size:0.85em; color:red;">No Receipt</span>`
          }
      } else if (d.payment_method === 'cash') {
          paymentInfo = "Cash"
      } else if (d.source === 'pending_orders') {
          paymentInfo = d.is_paid ? "Paid" : "Unpaid"
      }
      
      let itemsDetails = ""
      let calculatedTotal = Number(d.total || 0)
      try {
          const itemsRaw = typeof d.items === 'string' ? JSON.parse(d.items || "[]") : (d.items || [])
          if (Array.isArray(itemsRaw)) {
            itemsDetails = itemsRaw.map(it => `<div style="font-size:0.9em;">• ${it.qty || it.quantity || 1}x ${it.name}</div>`).join("")
            // Point 6 Fallback: If total is 0, calculate it from items
            if (calculatedTotal === 0 && itemsRaw.length > 0) {
              calculatedTotal = itemsRaw.reduce((sum, it) => sum + (Number(it.price || 0) * Number(it.qty || it.quantity || 1)), 0)
            }
          } else {
            itemsDetails = String(d.items || "-")
          }
      } catch (e) { itemsDetails = String(d.items || "-") }

      const totalDisplay = calculatedTotal > 0 ? `₱${Number(calculatedTotal).toLocaleString(undefined, { minimumFractionDigits: 2 })}` : "—"
      const rawStatus = d.status || "pending"
      const rejectionReasonRaw = String(d.rejection_reason || d.rejectionReason || d.notes || "")
      const autoScheduleRejected =
        String(rawStatus).toLowerCase() === "rejected" &&
        rejectionReasonRaw.toLowerCase().includes("schedule unavailable")
      let displayStatus = rawStatus.toUpperCase()
      let badgeClassStatus = rawStatus.toLowerCase()
      
      // Point 2 & 4: Partial Payment should display as Completed
      if (rawStatus === 'partial_payment' || rawStatus === 'PARTIAL_PAYMENT') {
          displayStatus = 'COMPLETED'
          badgeClassStatus = 'completed'
      }
      
      // If status is PAID or ACCEPTED, show as PREPARING to match kitchen dashboard
      if (rawStatus === 'paid' || rawStatus === 'PAID' || rawStatus === 'accepted' || rawStatus === 'ACCEPTED') {
          displayStatus = 'PREPARING'
          badgeClassStatus = 'preparing'
      }
      
      const tr = document.createElement("tr")
      
      let actionBtns = ""
      const isTerminal = ['completed', 'rejected', 'cancelled'].includes(rawStatus) || d.archived === true
      
      if (isTerminal) {
        // Archived/Terminal states: Only Delete button
        const sourceTable = d.source === 'pending_orders' ? 'pending_orders' : 'bookings'
        actionBtns = `<div class="booking-actions">
          <button onclick="deleteBooking('${d.id}', '${sourceTable}')" class="btn-action btn-remove" title="Delete record">Delete</button>
        </div>`
      } else if (rawStatus === "accepted" || rawStatus === "ACCEPTED" || rawStatus === "preparing" || rawStatus === "ready" || rawStatus === "paid" || rawStatus === "PAID") {
        // Specifically for Accepted/Preparing/Ready/Paid: Cancel and Reschedule (Kitchen handles Completion)
        // Point: Ready status should ONLY have Cancel as action (no Reschedule)
        const isReady = rawStatus.toLowerCase() === 'ready';

        if (d.source === 'pending_orders') {
          actionBtns = `<div class="booking-actions">
            <button onclick="updateOrderStatus('${d.id}', 'rejected')" class="btn-action btn-reject" title="Cancel Order">Cancel</button>
          </div>`
        } else {
          actionBtns = `<div class="booking-actions">
            <button onclick="openRejectModal('${d.id}', 'bookings')" class="btn-action btn-reject" title="Cancel Booking">Cancel</button>
            ${isReady ? '' : `<button onclick="rescheduleBooking('${d.id}', '${d.date}', '${d.time}')" class="btn-action btn-reschedule" title="Reschedule">Reschedule</button>`}
          </div>`
        }
      } else {
        // Pending status: Accept, Reject, Reschedule
        if (d.source === 'pending_orders') {
          actionBtns = `<div class="booking-actions">
            <button onclick="updateOrderStatus('${d.id}', 'accepted')" class="btn-action btn-accept" title="Accept">Accept</button>
            <button onclick="updateOrderStatus('${d.id}', 'rejected')" class="btn-action btn-reject" title="Reject">Reject</button>
          </div>`
        } else {
          actionBtns = `<div class="booking-actions">
            <button onclick="updateBookingStatus('${d.id}', 'accepted')" class="btn-action btn-accept" title="Accept">Accept</button>
            <button onclick="openRejectModal('${d.id}', 'bookings')" class="btn-action btn-reject" title="Reject">Reject</button>
            <button onclick="rescheduleBooking('${d.id}', '${d.date}', '${d.time}')" class="btn-action btn-reschedule" title="Reschedule">Reschedule</button>
          </div>`
        }
      }
      
      tr.innerHTML = `
        <td><strong>${name}</strong></td>
        <td>${dateStr}</td>
        <td>${timeStr}</td>
        <td><span class="type-tag ${type}">${typeDisplay}</span></td>
        <td>${paymentInfo}</td>
        <td class="items-cell">${itemsDetails}</td>
        <td style="font-weight:bold;">${totalDisplay}</td>
        <td>
          <span class="badge badge-${badgeClassStatus}">${displayStatus}</span>
          ${autoScheduleRejected ? '<div style="margin-top:4px;"><span style="display:inline-block; padding:2px 8px; border-radius:999px; background:#af8f6f; color:#fff; font-size:11px; font-weight:700;">Auto: Schedule Unavailable</span></div>' : ''}
        </td>
        <td>${actionBtns}</td>
      `
      tbody.appendChild(tr)
    })
  } catch (err) {
    console.error("[v0] Error loading transactions:", err)
    tbody.innerHTML = `<tr><td colspan="9" style="text-align:center; padding:40px; color:var(--danger);">Error loading customer transactions.</td></tr>`
  }
}

window.openRejectModal = (bookingId, source = 'bookings') => {
  const modal = document.getElementById("rejectModal")
  if (modal) {
      document.getElementById("rejectBookingId").value = bookingId
      document.getElementById("rejectSource").value = source
      // Set default selection
      const radios = document.getElementsByName("rejectReason")
      radios.forEach(r => r.checked = false)
      if (radios.length > 0) {
        radios[0].checked = true
      }
      // Hide custom reason input
      const otherInput = document.getElementById("rejectReasonOther")
      if (otherInput) otherInput.style.display = "none"
      modal.style.display = "flex"
  }
}

window.closeRejectModal = () => {
    const modal = document.getElementById("rejectModal")
    if (modal) modal.style.display = "none"
}

window.updateRejectReason = () => {
    const selectedReason = document.querySelector('input[name="rejectReason"]:checked')?.value
    const otherInput = document.getElementById("rejectReasonOther")
    if (otherInput) {
      if (String(selectedReason || "").toLowerCase() === "other") {
          otherInput.style.display = "inline-block"
          otherInput.focus()
      } else {
          otherInput.style.display = "none"
          otherInput.value = ""
      }
    }
}

window.confirmReject = async () => {
    console.log("[v0] confirmReject called");
    const bookingId = document.getElementById("rejectBookingId").value
    const source = document.getElementById("rejectSource").value || 'bookings'
    const selectedReason = document.querySelector('input[name="rejectReason"]:checked')
    
    if (!selectedReason) {
        showMessage("Please select a rejection reason.", "error")
        return
    }
    
    let reason = selectedReason.value
    if (String(reason || "").toLowerCase() === "other") {
        const otherInput = document.getElementById("rejectReasonOther")
        reason = (otherInput && otherInput.value.trim()) || "Admin Rejected"
        if (!reason || reason === "Admin Rejected") {
            showMessage("Please enter a custom reason.", "error")
            return
        }
    }
    
    const table = source === 'pending_orders' ? 'pending_orders' : 'bookings'
    
    try {
      // 1. Fetch the original items to update them with the reason inside the JSON
      const { data: original, error: fetchErr } = await db.from(table).select("*").eq("id", bookingId).single()
      if (fetchErr) throw fetchErr
      
      let items = original.items
      if (typeof items === 'string') {
          try { 
              const parsed = JSON.parse(items)
              // Attach reason to the items JSON as well for redundancy
              if (Array.isArray(parsed)) {
                  parsed.forEach(i => i.rejection_reason = reason)
                  items = JSON.stringify(parsed)
              }
          } catch(e) {}
      }

      // 2. Perform the update
      await safeUpdateRowAdmin(table, { id: bookingId }, { 
          status: "rejected",
          rejection_reason: reason,
          rejectionReason: reason,
          insufficient_notes: reason,
          notes: reason,
          items: items, // Save updated items JSON
          archived: true,
          archived_at: new Date().toISOString()
      })

      showMessage(`${source === 'pending_orders' ? 'Order' : 'Booking'} rejected.`, "success")
      window.closeRejectModal()
      window.renderBookingsList()
    } catch (err) {
      console.error("[v0] Error rejecting record:", err)
      showMessage(`Failed to reject ${source === 'pending_orders' ? 'order' : 'booking'}.`, "error")
    }
}

function buildAutoCashierRemark({ source, paymentMethod, itemCount, total, discount, insufficient }) {
  const parts = []
  parts.push(source || "transaction")
  if (paymentMethod) parts.push("payment:" + paymentMethod)
  if (Number.isFinite(itemCount)) parts.push("items:" + itemCount)
  if (Number.isFinite(total)) parts.push("total:" + Number(total).toFixed(2))
  if (Number.isFinite(discount) && Number(discount) > 0) parts.push("discount:" + Number(discount).toFixed(2))
  if (insufficient) parts.push("insufficient")
  return "Auto: " + parts.join(" | ")
}

async function recordBookingSale(booking) {
    if (!booking || booking.type !== 'preorder') return;
    const bookingId = booking.id;
    
    // Check if already in sales to avoid double counting
    const { data: existingSales } = await db.from("sales").select("id").eq("booking_id", bookingId);
    if (existingSales && existingSales.length > 0) {
        console.log("[System Log] Pre-order already in Sales:", bookingId);
        return;
    }

    console.log("[System Log] Recording Pre-order in Sales:", bookingId);
    let items = booking.items;
    if (typeof items === 'string') {
      try { items = JSON.parse(items) } catch (e) { items = [] }
    }
    items = Array.isArray(items) ? items : [];

    const salesItems = items.map(i => ({
      id: i.id || i.product_id || "",
      name: i.name || "Unknown",
      category_id: i.category_id || null,
      quantity: Number(i.quantity || i.qty || 1),
      amount: (Number(i.price || 0) || (Number(i.amount || 0) / Number(i.quantity || i.qty || 1))) * (Number(i.quantity || i.qty || 1))
    }));

    const dateStr = new Date().toISOString().slice(0, 10);
    let total = Number(booking.total || 0);

    // Get staff session for cashier_id/name
    const sess = typeof getStaffSession === 'function' ? getStaffSession() : null;

    // Fallback: Calculate total from items if it's 0 or missing
    if (total === 0 && salesItems.length > 0) {
      total = salesItems.reduce((sum, item) => sum + item.amount, 0);
    }

    const itemCount = salesItems.reduce((sum, i) => sum + Number(i.quantity || 0), 0);
    const cashierRemark = buildAutoCashierRemark({
      source: "preorder",
      paymentMethod: booking.payment_method || "cash",
      itemCount,
      total: total,
      discount: Number(booking.discount || 0),
      insufficient: booking.insufficient_payment === true
    });

    const salesPayload = {
      items: JSON.stringify(salesItems),
      total: total,
      amount: total,
      timestamp: new Date().toISOString(),
      sale_date: new Date().toISOString(),
      date: dateStr,
      payment_method: booking.payment_method || 'cash',
      status: 'completed',
      type: 'preorder',
      booking_id: bookingId,
      ...(sess && { cashier_id: sess.id, cashier_name: sess.full_name }),
      cashier_remarks: cashierRemark
    };

    const tryInsertSales = async (payload) => {
      const { error } = await db.from("sales").insert(payload);
      return error || null;
    };

    let currentPayload = { ...salesPayload };
    let salesErr = await tryInsertSales(currentPayload);
    let attempt = 0;
    while (salesErr && attempt < 10) {
      const msg = String(salesErr.message || "");
      let removedField = false;
      const columns = ['discount', 'items', 'total', 'timestamp', 'date', 'amount', 'sale_date', 'payment_method', 'status', 'type', 'booking_id', 'cashier_id', 'cashier_name'];
      for (const col of columns) {
        const colNameInMsg = msg.includes(`"${col}"`) || msg.includes(`'${col}'`) || msg.includes(` ${col} `);
        const doesNotExist = msg.includes("does not exist") || msg.includes("Could not find");
        const isGenerated = msg.includes("cannot insert a non-DEFAULT value");
        if (colNameInMsg && (doesNotExist || isGenerated) && currentPayload[col] !== undefined) {
          delete currentPayload[col];
          removedField = true;
          break;
        }
      }
      if (!removedField) break;
      salesErr = await tryInsertSales(currentPayload);
      attempt++;
    }
    
    if (!salesErr) console.log("[System Log] Pre-order Sales Record Success");
    else console.error("[System Log] Pre-order Sales Record Failed:", salesErr);
}

window.updateBookingStatus = async (bookingId, newStatus) => {
  if (newStatus === 'rejected') {
    window.openRejectModal(bookingId, 'bookings')
    return
  }
  if (newStatus === 'accepted') {
    try {
        // 1. Get the booking details first
        const { data: bookingData, error: fetchError } = await db.from("bookings").select("*").eq("id", bookingId).single()
        if (fetchError) throw fetchError
        if (!bookingData) throw new Error("Booking not found")

        const date = bookingData.date
        const time = bookingData.time

        // 2. Query for conflicts (same date + same time slot)
        // Pre-orders are excluded from slot conflict checks.
        
        let conflictFound = false
        const toReject = []

        if (bookingData.type !== 'preorder') {
            const { data: conflicts, error: conflictError } = await db.from("bookings")
                .select("*")
                .eq("date", date)
                .eq("time", time)
            
            if (conflictError) throw conflictError

            conflicts.forEach(otherData => {
                if (otherData.id === bookingId) return // Skip self

                // Ignore pre-orders (they can coexist)
                if (otherData.type === 'preorder') return

                if (otherData.status === 'accepted') {
                    conflictFound = true
                } else if (otherData.status === 'pending') {
                    toReject.push(otherData.id)
                }
            })
        }

        if (conflictFound) {
            showMessage("Cannot accept: Another booking is already accepted for this slot.", "error")
            return
        }

        // 3. Reject pending conflicts
        if (toReject.length > 0) {
            await Promise.all(toReject.map(id => 
                db.from("bookings").update({
                    status: 'rejected',
                    rejection_reason: "Schedule Unavailable",
                    notes: "Schedule Unavailable"
                }).eq("id", id)
            ))
        }

        // 4. Accept current booking
        const { error: updateError } = await db.from("bookings").update({ status: 'accepted' }).eq("id", bookingId)
        if (updateError) throw updateError
        if (window.logAdminAction) await logAdminAction('Booking status', `Accepted booking #${bookingId}`)

        // NEW: Record online pre-orders in Sales when accepted
        const { data: acceptedBooking } = await db.from("bookings").select("*").eq("id", bookingId).single()
        if (acceptedBooking && acceptedBooking.type === 'preorder' && acceptedBooking.payment_method === 'online') {
            console.log("[System Log] Recording Online Pre-order in Sales (Accepted):", bookingId)
            await recordBookingSale(acceptedBooking)
        }

        showMessage("Booking accepted! Conflicting pending bookings rejected.", "success")
        window.renderBookingsList()
        if (typeof window.renderPendingRequests === "function") {
          window.renderPendingRequests(currentRequestType, currentRequestStatus)
        }
        if (typeof window.renderCalendar === "function") {
          window.renderCalendar(currentCalendarDate)
        }

    } catch (err) {
        console.error("[v0] Error updating booking status:", err)
        showMessage("Failed to update booking status.", "error")
    }
  } else {
    try {
      const payload = { status: newStatus }
      if (["completed", "rejected", "cancelled"].includes(newStatus)) {
        payload.archived = true
        payload.archived_at = new Date().toISOString()
      }
      await safeUpdateRowAdmin("bookings", { id: bookingId }, payload)
      if (window.logAdminAction) await logAdminAction('Booking status', `#${bookingId} → ${newStatus}`)

      // Record sale and award points if completed
      if (newStatus === 'completed') {
        const { data: booking } = await db.from("bookings").select("*").eq("id", bookingId).single()
        if (booking && booking.type === 'preorder') {
          // 1. Record in Sales
          await recordBookingSale(booking);

          // 2. Record in Orders History
          let items = booking.items
          if (typeof items === 'string') {
            try { items = JSON.parse(items) } catch (e) { items = [] }
          }
          items = Array.isArray(items) ? items : []
          
          const ordersPayload = items.map(i => ({
            customer_id: String(booking.customer_id || "preorder"),
            product_id: i.id || i.product_id || "",
            name: i.name || "Unknown",
            quantity: Number(i.quantity || i.qty || 1),
            price: Number(i.price || 0) || (Number(i.amount || 0) / Number(i.quantity || i.qty || 1)) || 0,
            category_id: i.category_id || null,
            timestamp: new Date(),
            payment_method: booking.payment_method || 'cash',
            status: 'completed'
          }))
          
          await db.from("orders").insert(ordersPayload)

          // 3. Award Points
          let custId = null
          if (booking.customer_id) {
            const { data: c } = await db.from("customers")
              .select("id, loyalty_points, loyalty_card")
              .or(`email.eq.${booking.customer_id},contact.eq.${booking.customer_id}`)
              .maybeSingle()
            if (c) custId = c
          }

          if (custId) {
            const points = 1
            const newPoints = (custId.loyalty_points || 0) + points
            await db.from("customers").update({ loyalty_points: newPoints }).eq("id", custId.id)
            await db.from("loyalty_history").insert({
              customer_id: custId.id,
              loyalty_card: custId.loyalty_card,
              points: points,
              source: "preorder",
              order_id: bookingId,
              total: Number(booking.total || 0),
              timestamp: new Date()
            })
          }
        }
      }

      showMessage(`Booking ${newStatus}!`, "success")
      window.renderBookingsList()
      if (typeof window.renderPendingRequests === "function") {
        window.renderPendingRequests(currentRequestType, currentRequestStatus)
      }
      if (typeof window.renderCalendar === "function") {
        window.renderCalendar(currentCalendarDate)
      }
    } catch (err) {
      console.error("[v0] Error updating booking:", err)
      showMessage("Failed to update booking.", "error")
    }
  }
}

window.toggleArchiveBooking = (bookingId, archiveStatus) => {
  db.from("bookings")
    .update({ archived: archiveStatus })
    .eq("id", bookingId)
    .then(({ error }) => {
      if (error) throw error
      const action = archiveStatus ? "archived" : "restored"
      showMessage(`Booking ${action}!`, "success")
      window.renderBookingsList()
    })
    .catch((err) => {
      console.error("[v0] Error updating booking archive status:", err)
      showMessage("Failed to update booking.", "error")
    })
}

window.updateOrderStatus = async (orderId, newStatus) => {
  if (newStatus === 'rejected') {
    window.openRejectModal(orderId, 'pending_orders')
    return
  }
  try {
    const payload = { status: newStatus }
    if (['completed', 'rejected', 'cancelled'].includes(newStatus)) {
      payload.archived = true
      payload.archived_at = new Date().toISOString()
    }
    const { error } = await db.from("pending_orders").update(payload).eq("id", orderId)
    if (error) throw error
    if (window.logAdminAction) await logAdminAction('Order status', `Updated order #${orderId} to ${newStatus}`)
    showMessage(`Order #${orderId} updated to ${newStatus}`, "success")
    window.renderBookingsList()
  } catch (err) {
    console.error("[v0] Error updating order status:", err)
    showMessage("Failed to update order status.", "error")
  }
}

window.deleteBooking = (id, source = 'bookings', skipConfirm = false) => {
  const table = source === 'pending_orders' ? 'pending_orders' : 'bookings'
  const proceed = skipConfirm || confirm(`Delete this ${source === 'pending_orders' ? 'order' : 'booking'}?`)
  
  if (proceed) {
    db.from(table)
      .delete()
      .eq("id", id)
      .then(({ error }) => {
        if (error) throw error
        showMessage("Record deleted!", "success")
        window.renderBookingsList()
        // Also refresh notepad/todos if it's currently rendered
        if (typeof renderTodos === 'function' && document.getElementById('todoBody')) {
          renderTodos()
        }
        // Also refresh calendar dots
        if (window.renderCalendar) window.renderCalendar(currentCalendarDate)
      })
      .catch((err) => {
        console.error("[v0] Error deleting record:", err)
        showMessage("Failed to delete record.", "error")
      })
  }
}

// --- RESCHEDULE BOOKING ---
window.rescheduleBooking = (bookingId, currentDate, currentTime) => {
  if (!bookingId) return;
  
  const modal = document.getElementById("rescheduleModal");
  if (!modal) return;

  // Set min date to tomorrow
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = tomorrow.toISOString().split('T')[0];
  
  const dateInput = document.getElementById("rescheduleDate");
  if (dateInput) {
    dateInput.min = tomorrowStr;
    // If the current booking date is today or in the past, default the picker to tomorrow
    if (!currentDate || currentDate < tomorrowStr) {
      dateInput.value = tomorrowStr;
    } else {
      dateInput.value = currentDate;
    }
  }

  document.getElementById("rescheduleBookingId").value = bookingId;
  document.getElementById("rescheduleTime").value = currentTime || "";
  
  modal.style.display = "flex";
}

window.confirmReschedule = async () => {
  const bookingId = document.getElementById("rescheduleBookingId").value;
  const nextDay = document.getElementById("rescheduleDate").value;
  const nextTime = document.getElementById("rescheduleTime").value;

  if (!nextDay || !nextTime) {
    showMessage("Please select a date and time.", "error");
    return;
  }

  try {
    // 1. Get current data for logging
    const { data: oldBooking, error: fetchErr } = await db.from("bookings").select("*").eq("id", bookingId).single();
    if (fetchErr) throw fetchErr;

    const currentDate = oldBooking.date;
    const currentTime = oldBooking.time;

    // 2. Update booking
    const { error: updateErr } = await db.from("bookings")
      .update({
        date: nextDay,
        time: nextTime,
        status: "accepted", // Automatically accept if rescheduled
        rescheduled: true
      })
      .eq("id", bookingId);
    
    if (updateErr) throw updateErr;

    // 3. Log reschedule
    const logPayload = {
      booking_id: bookingId,
      old_date: currentDate,
      new_date: nextDay,
      old_time: currentTime,
      new_time: nextTime,
      rescheduled_at: new Date().toISOString()
    }
    
    const { error: logErr } = await db.from("booking_reschedule_logs").insert([logPayload]);
    if (logErr) {
        console.warn("Could not log to dedicated table, logging to admin_logs:", logErr.message);
        if (window.logAdminAction) {
            await logAdminAction('Booking Rescheduled', `Booking #${bookingId} moved from ${currentDate} to ${nextDay}`);
        }
    }

    showMessage(`Rescheduled to ${nextDay} ${nextTime}`, "success");
    window.closeRescheduleModal();
    window.renderBookingsList();
    if (window.renderCalendar) window.renderCalendar(currentCalendarDate);
  } catch (err) {
    console.error("Error rescheduling:", err);
    showMessage("Failed to reschedule: " + err.message, "error");
  }
}

window.closeRescheduleModal = () => {
  const modal = document.getElementById("rescheduleModal")
  if (modal) modal.style.display = "none"
}

// --- TODOS ---
let isTodoSubmitting = false
window.addTodo = () => {
  console.log("addTodo function called");
  if (isTodoSubmitting) return
  if (!selectedTodoDate) return alert("Select a date first")
  const input = document.getElementById("todoInput")
  const task = input.value.trim()
  
  const btn = document.getElementById("addTodoBtn")
  if (btn) btn.disabled = true
  isTodoSubmitting = true

  if (task) {
    db.from("todos")
      .insert([{
        date: selectedTodoDate,
        task,
        priority: 'medium', // Default priority since dropdown is removed
        completed: false,
        timestamp: new Date().toISOString(),
      }])
      .then(({ error }) => {
        if (error) throw error
        input.value = ""
        renderTodos()
        showMessage("Note added!", "success")
        isTodoSubmitting = false
        if (btn) btn.disabled = false
        // Re-render calendar to update badges
        window.renderCalendar(currentCalendarDate)
      })
      .catch((err) => {
        console.error("[v0] Error adding note:", err)
        alert("Error adding note: " + (err.message || err))
        showMessage("Failed to add note: " + (err.message || err), "error")
        isTodoSubmitting = false
        if (btn) btn.disabled = false
      })
  } else {
    alert("Please enter a note description")
    isTodoSubmitting = false
    if (btn) btn.disabled = false
  }
}

window.completeTodo = (todoId) => {
  db.from("todos")
    .delete()
    .eq("id", todoId)
    .then(({ error }) => {
      if (error) throw error
      renderTodos()
      // Re-render calendar to update badges
      if (window.renderCalendar) window.renderCalendar(currentCalendarDate)
      showMessage("Note completed and removed!", "success")
    })
    .catch((err) => {
      console.error("[v0] Error completing note:", err)
      showMessage("Failed to complete note.", "error")
    })
}

window.deleteTodo = (todoId) => {
  db.from("todos")
    .delete()
    .eq("id", todoId)
    .then(({ error }) => {
      if (error) throw error
      renderTodos()
      // Re-render calendar to update badges
      if (window.renderCalendar) window.renderCalendar(currentCalendarDate)
      showMessage("Note deleted!", "success")
    })
    .catch((err) => {
      console.error("[v0] Error deleting note:", err)
      showMessage("Failed to delete note.", "error")
    })
}

function renderTodos() {
  const tbody = document.getElementById("todoBody")
  if (!tbody) return
  tbody.innerHTML = ""
  if (!selectedTodoDate) return

  // Fetch Todos and Bookings in parallel
  Promise.all([
    db.from("todos")
      .select("*")
      .eq("date", selectedTodoDate)
      .eq("completed", false),
    db.from("bookings")
      .select("*")
      .eq("date", selectedTodoDate)
  ])
  .then(([{ data: todosData, error: todosError }, { data: bookingsData, error: bookingsError }]) => {
    if (todosError) throw todosError
    if (bookingsError) throw bookingsError

    const items = []

    // Process Todos
    if (todosData) {
        todosData.forEach((d) => {
          items.push({ 
            type: 'todo',
            id: d.id, 
            ...d,
            sortPriority: { high: 0, medium: 1, low: 2 }[d.priority] || 1
          })
        })
    }

    // Process Bookings
    if (bookingsData) {
        bookingsData.forEach((b) => {
          // Only show pending or accepted bookings
          if (b.status === 'rejected' || b.status === 'cancelled') return

          let taskDescription = ""
          if (b.type === 'preorder') {
            let itemsText = ""
            try {
              const parsed = typeof b.items === 'string' ? JSON.parse(b.items || "[]") : (b.items || [])
              if (Array.isArray(parsed)) {
                itemsText = parsed.map(it => `${it.qty || it.quantity || 1}x ${it.name}`).join(", ")
              } else {
                itemsText = String(b.items || "-")
              }
            } catch (e) { itemsText = String(b.items || "-") }
            
            taskDescription = `<div style="font-weight:600; color:#2196F3;">[PRE-ORDER] Pick up: ${b.time}</div>
                               <div style="font-size:0.9em; color:#666;">Items: ${itemsText}</div>
                               <div style="font-size:0.85em; color:#888;">Customer: ${b.customer_id}</div>`
          } else {
            taskDescription = `<div style="font-weight:600; color:#795548;">[BOOKING] Check-in: ${b.time}</div>
                               <div style="font-size:0.85em; color:#888;">Customer: ${b.customer_id}</div>`
          }

          items.push({
            type: 'booking',
            id: b.id,
            priority: 'high', // Bookings are high priority
            task: taskDescription,
            sortPriority: 1 // Equivalent to high
          })
        })
    }

    if (items.length === 0) {
      const tr = document.createElement("tr")
      tr.innerHTML = '<td colspan="2" style="text-align:center;color:#999;padding:20px">No notes or bookings for this date</td>'
      tbody.appendChild(tr)
      return
    }

    // Sort by priority
    items.sort((a, b) => a.sortPriority - b.sortPriority)

    items.forEach((item) => {
      const tr = document.createElement("tr")
      
      let actions = ""

      if (item.type === 'todo') {
        actions = `<button onclick="window.deleteTodo('${item.id}')" style="background:#d97c4d;color:white;border:none;padding:6px 12px;border-radius:4px;cursor:pointer">Delete</button>`
      } else {
        // Booking styling
        actions = `
          <button onclick="window.deleteBooking('${item.id}', 'bookings', true)" style="background:#d97c4d;color:white;border:none;padding:6px 12px;border-radius:4px;cursor:pointer">Delete</button>
        `
      }

      tr.innerHTML = `<td>${item.task}</td><td>${actions}</td>`
      tbody.appendChild(tr)
    })
  })
  .catch((err) => {
    console.error("[v0] Error loading todos/bookings:", err)
    if (err.message && err.message.includes("todos")) {
        alert("Database Error: 'todos' table missing. Please run the SQL script.")
    }
  })
}

// --- PAYMENT SETTINGS ---
window.previewAdminQr = (input) => {
    const file = input.files[0]
    const previewImg = document.getElementById("adminQrPreview")
    const placeholder = document.getElementById("adminQrPlaceholder")
    
    if (file) {
        const reader = new FileReader()
        reader.onload = (e) => {
            previewImg.src = e.target.result
            previewImg.style.display = "block"
            placeholder.style.display = "none"
        }
        reader.readAsDataURL(file)
    }
}

window.savePaymentSettings = async () => {
    const fileInput = document.getElementById("adminQrCode")
    const file = fileInput.files[0]
    const btn = document.querySelector("#settings .btn-primary")
    
    if (btn) {
        btn.disabled = true
        btn.textContent = "Saving..."
    }

    try {
        let qrUrl = null

        // 1. Upload new QR if selected
        if (file) {
            const timestamp = Date.now()
            const fileName = `admin_qr_${timestamp}`
            const { data, error } = await db.storage.from('product-photos').upload(fileName, file)
            
            if (error) throw error
            
            const { data: { publicUrl } } = db.storage.from('product-photos').getPublicUrl(fileName)
            qrUrl = publicUrl
        } else {
            // Keep existing URL if image is visible
            const previewImg = document.getElementById("adminQrPreview")
            if (previewImg.style.display !== "none" && previewImg.src) {
                qrUrl = previewImg.src
            }
        }

        // 2. Save to Settings table
        if (qrUrl) {
            const { error } = await db.from('settings').upsert({ 
                key: 'admin_qr_code', 
                value: qrUrl,
                updated_at: new Date().toISOString()
            })
            if (error) throw error
            if (window.logAdminAction) await logAdminAction('Saved payment settings', 'Updated QR code')
            
            showMessage("Payment settings saved!", "success")
        } else {
             showMessage("No QR code to save.", "info")
        }

    } catch (err) {
        console.error("Error saving payment settings:", err)
        showMessage("Failed to save settings: " + err.message, "error")
    } finally {
        if (btn) {
            btn.disabled = false
            btn.textContent = "Save Settings"
        }
    }
}

// --- BOOKINGS PAGE (Incoming + Day/Month Scheduler) ---
let currentRequestType = "booking"
let currentRequestStatus = "requests"
let currentCalendarView = "month"
let selectedScheduleDate = new Date().toISOString().split("T")[0]
let hasExplicitDateSelection = false

function toDateInputValue(d) {
  const dt = new Date(d)
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`
}

function formatHeaderMonthYear(d) {
  return d.toLocaleString("default", { month: "long", year: "numeric" })
}

function getStartHour(timeStr = "") {
  const m = String(timeStr).match(/(\d{1,2}):(\d{2})/)
  if (!m) return null
  return Number(m[1])
}

function formatHourRange(h) {
  const start = h % 12 === 0 ? 12 : h % 12
  const endHour = h + 1
  const end = endHour % 12 === 0 ? 12 : endHour % 12
  return `${start}:00 - ${end}:00`
}

function parseBookingItems(itemsRaw) {
  try {
    const parsed = typeof itemsRaw === "string" ? JSON.parse(itemsRaw || "[]") : (itemsRaw || [])
    if (!Array.isArray(parsed)) return []
    return parsed.map((it) => ({
      qty: Number(it.qty || it.quantity || 1),
      name: String(it.name || it.product_name || "Item"),
    }))
  } catch (_) {
    return []
  }
}

function normalizeBookingType(b) {
  return String(b.type || "").toLowerCase() === "preorder" ? "preorder" : "booking"
}

async function fetchVisibleBookings() {
  const { data, error } = await db
    .from("bookings")
    .select("*")
    .in("status", ["pending", "accepted", "confirmed", "preparing", "ready"])
    .order("date", { ascending: true })
    .order("time", { ascending: true })
  if (error) throw error
  return data || []
}

window.switchRequestTab = (type) => {
  currentRequestType = type
  document.querySelectorAll(".request-tab").forEach((t) => t.classList.remove("active"))
  const tabBtn = document.querySelector(`.request-tab[onclick*="${type}"]`)
  if (tabBtn) tabBtn.classList.add("active")
  renderPendingRequests(type, currentRequestStatus)
}

window.switchRequestStatus = (status) => {
  currentRequestStatus = status
  document.querySelectorAll(".request-status-tab").forEach((t) => t.classList.remove("active"))
  const tabBtn = document.querySelector(`.request-status-tab[onclick*="${status}"]`)
  if (tabBtn) tabBtn.classList.add("active")
  const title = document.getElementById("requestsPanelTitle")
  if (title) title.textContent = status === "accepted" ? "Accepted Requests" : "Incoming Requests"
  renderPendingRequests(currentRequestType, status)
}

window.switchCalendarView = (view) => {
  currentCalendarView = view
  document.querySelectorAll(".view-tab").forEach((t) => t.classList.remove("active"))
  const tabBtn = document.querySelector(`.view-tab[onclick*="${view}"]`)
  if (tabBtn) tabBtn.classList.add("active")
  window.renderCalendar(currentCalendarDate)
}

window.renderPendingRequests = async (type = currentRequestType, statusFilter = currentRequestStatus) => {
  const listEl = document.getElementById("pendingRequestsList")
  if (!listEl) return
  listEl.innerHTML = `<div class="empty-requests"><p>Loading requests...</p></div>`
  try {
    const rows = await fetchVisibleBookings()
    const acceptedStates = ["accepted", "confirmed", "preparing", "ready"]
    const byStatus = rows.filter((r) => {
      const st = String(r.status || "").toLowerCase()
      if (statusFilter === "accepted") return acceptedStates.includes(st)
      return st === "pending"
    })
    let filtered = byStatus.filter((r) => normalizeBookingType(r) === (type === "preorder" ? "preorder" : "booking"))
    if (hasExplicitDateSelection && selectedScheduleDate) {
      filtered = filtered.filter((r) => String(r.date || "") === selectedScheduleDate)
    }

    if (filtered.length === 0) {
      listEl.innerHTML = `
        <div class="empty-requests">
          <div class="coffee-sketch-small">☕</div>
          <p>${statusFilter === "accepted" ? "No accepted requests" : "No incoming requests"}</p>
        </div>
      `
      return
    }

    listEl.innerHTML = ""
    filtered.forEach((r) => {
      const isPreorder = normalizeBookingType(r) === "preorder"
      const items = isPreorder ? parseBookingItems(r.items) : []
      const itemsHtml = items.length
        ? `<div class="request-items">${items.map((i) => `<div>${i.qty}x&nbsp;&nbsp;${i.name}</div>`).join("")}</div>`
        : ""
      const reschedArgDate = String(r.date || "").replace(/'/g, "\\'")
      const reschedArgTime = String(r.time || "").replace(/'/g, "\\'")
      listEl.innerHTML += `
        <div class="request-card request-${isPreorder ? "preorder" : "booking"}">
          <div class="request-head">
            <div>
              <div class="request-name">${r.customer_name || r.customer_id || "Customer"}</div>
              <div class="request-meta">${r.date || ""}</div>
              <div class="request-meta">${r.time || ""}</div>
            </div>
            <div class="request-actions">
              ${statusFilter === "accepted"
                ? `
                  <button class="icon-btn icon-resched" title="Reschedule" onclick="rescheduleBooking('${r.id}','${reschedArgDate}','${reschedArgTime}')">⚙</button>
                  <button class="icon-btn icon-reject" title="Cancel" onclick="openRejectModal('${r.id}','bookings')">✕</button>
                  <button class="icon-btn icon-accept" title="Finish" onclick="updateBookingStatus('${r.id}','completed')">✔</button>
                `
                : `
                  <button class="icon-btn icon-reject" title="Reject" onclick="openRejectModal('${r.id}','bookings')">✕</button>
                  <button class="icon-btn icon-accept" title="Accept" onclick="updateBookingStatus('${r.id}','accepted')">✔</button>
                `
              }
            </div>
          </div>
          ${itemsHtml}
        </div>
      `
    })
  } catch (err) {
    console.error("Error loading incoming requests:", err)
    listEl.innerHTML = `<div class="empty-requests"><p style="color:red;">Failed to load requests.</p></div>`
  }
}

async function renderDaySchedule(selectedDate) {
  const container = document.getElementById("calendarContainer")
  const title = document.getElementById("currentMonthYear")
  if (!container || !title) return
  title.textContent = new Date(selectedDate).toLocaleDateString(undefined, { month: "long", day: "numeric" })

  const rows = await fetchVisibleBookings()
  const dayRows = rows.filter((r) => r.date === selectedDate && String(r.status).toLowerCase() !== "pending")
  const hourly = {}
  dayRows.forEach((r) => {
    const hour = getStartHour(r.time)
    if (hour === null) return
    if (!hourly[hour]) hourly[hour] = []
    hourly[hour].push(r)
  })

  const startHour = 8
  const endHour = 21
  let html = `<div class="day-schedule">`
  for (let h = startHour; h < endHour; h++) {
    const entries = hourly[h] || []
    const hasBooking = entries.some((e) => normalizeBookingType(e) === "booking")
    const hasPreorder = entries.some((e) => normalizeBookingType(e) === "preorder")
    html += `<div class="schedule-row">
      <div class="schedule-time">${formatHourRange(h)}</div>
      <div class="schedule-cell">`
    if (entries.length === 0) {
      html += `<div class="schedule-empty"></div>`
    } else {
      entries.forEach((e) => {
        const t = normalizeBookingType(e)
        const items = t === "preorder" ? parseBookingItems(e.items) : []
        html += `
          <div class="schedule-entry ${t} ${hasBooking && hasPreorder ? "has-both" : ""}">
            <div class="entry-title">${e.customer_name || e.customer_id || "Customer"}</div>
            ${t === "preorder"
              ? `<div class="entry-items">${items.map((it) => `${it.qty}x ${it.name}`).join("<br>") || "Pre-order"}</div>`
              : `<div class="entry-items">Reservation</div>`
            }
          </div>
        `
      })
    }
    html += `</div></div>`
  }
  html += `</div>`
  container.innerHTML = html
}

async function renderMonthSchedule(dateObj) {
  const container = document.getElementById("calendarContainer")
  const title = document.getElementById("currentMonthYear")
  if (!container || !title) return
  title.textContent = formatHeaderMonthYear(dateObj)

  const year = dateObj.getFullYear()
  const month = dateObj.getMonth()
  const firstDay = new Date(year, month, 1).getDay()
  const daysInMonth = new Date(year, month + 1, 0).getDate()

  const rows = await fetchVisibleBookings()
  const accepted = rows.filter((r) => ["accepted", "confirmed", "preparing", "ready"].includes(String(r.status || "").toLowerCase()))
  const byDate = {}
  accepted.forEach((r) => {
    if (!r.date) return
    if (!byDate[r.date]) byDate[r.date] = { booking: false, preorder: false }
    const t = normalizeBookingType(r)
    byDate[r.date][t] = true
  })

  const activeMonthKey = `${year}-${String(month + 1).padStart(2, "0")}`
  let selectedInActiveMonth = selectedScheduleDate && String(selectedScheduleDate).startsWith(activeMonthKey)
  if (!selectedInActiveMonth) {
    const prevDay = Number(String(selectedScheduleDate || "").split("-")[2] || "1")
    const clampedDay = Math.max(1, Math.min(daysInMonth, prevDay))
    selectedScheduleDate = `${activeMonthKey}-${String(clampedDay).padStart(2, "0")}`
    selectedInActiveMonth = true
  }

  let html = `<div class="month-calendar">
    <div class="month-head">SUN</div><div class="month-head">MON</div><div class="month-head">TUE</div><div class="month-head">WED</div><div class="month-head">THU</div><div class="month-head">FRI</div><div class="month-head">SAT</div>`

  const totalCells = 42 // fixed 6 rows x 7 columns
  for (let cellIdx = 0; cellIdx < totalCells; cellIdx++) {
    const day = cellIdx - firstDay + 1
    if (day < 1 || day > daysInMonth) {
      html += `<div class="month-cell empty"></div>`
      continue
    }
    const dstr = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`
    const marks = byDate[dstr] || { booking: false, preorder: false }
    html += `<div class="month-cell ${dstr === selectedScheduleDate ? "selected" : ""}" onclick="window.selectScheduleDate('${dstr}')">
      <span class="month-day-num" style="position:absolute;top:6px;left:8px;line-height:1;">${day}</span>
      <div class="month-icons" style="position:absolute;left:6px;bottom:6px;">
        ${marks.booking ? `<img src="admin_icon/booking_ic.png" alt="booking" class="month-icon">` : ""}
        ${marks.preorder ? `<img src="admin_icon/preorder_ic.png" alt="preorder" class="month-icon">` : ""}
      </div>
    </div>`
  }
  html += `</div>`
  container.innerHTML = html
}

window.selectScheduleDate = (dateStr) => {
  selectedScheduleDate = dateStr
  hasExplicitDateSelection = true
  currentCalendarDate = new Date(dateStr)
  if (currentCalendarView === "day") {
    renderDaySchedule(selectedScheduleDate)
  } else {
    renderMonthSchedule(currentCalendarDate)
  }
  renderPendingRequests(currentRequestType, currentRequestStatus)
}

window.renderCalendar = async (date = new Date()) => {
  currentCalendarDate = new Date(date)
  if (currentCalendarView === "day") {
    await renderDaySchedule(selectedScheduleDate || toDateInputValue(currentCalendarDate))
  } else {
    await renderMonthSchedule(currentCalendarDate)
  }
}

window.prevMonth = () => {
  if (currentCalendarView === "day") {
    const d = new Date(selectedScheduleDate)
    d.setDate(d.getDate() - 1)
    selectedScheduleDate = toDateInputValue(d)
    hasExplicitDateSelection = true
    window.renderCalendar(d)
    renderPendingRequests(currentRequestType, currentRequestStatus)
    return
  }
  const targetDay = Number(String(selectedScheduleDate || "").split("-")[2] || "1")
  currentCalendarDate.setMonth(currentCalendarDate.getMonth() - 1)
  const y = currentCalendarDate.getFullYear()
  const m = currentCalendarDate.getMonth()
  const dim = new Date(y, m + 1, 0).getDate()
  const clamped = Math.max(1, Math.min(dim, targetDay))
  selectedScheduleDate = `${y}-${String(m + 1).padStart(2, "0")}-${String(clamped).padStart(2, "0")}`
  window.renderCalendar(currentCalendarDate)
}

window.nextMonth = () => {
  if (currentCalendarView === "day") {
    const d = new Date(selectedScheduleDate)
    d.setDate(d.getDate() + 1)
    selectedScheduleDate = toDateInputValue(d)
    hasExplicitDateSelection = true
    window.renderCalendar(d)
    renderPendingRequests(currentRequestType, currentRequestStatus)
    return
  }
  const targetDay = Number(String(selectedScheduleDate || "").split("-")[2] || "1")
  currentCalendarDate.setMonth(currentCalendarDate.getMonth() + 1)
  const y = currentCalendarDate.getFullYear()
  const m = currentCalendarDate.getMonth()
  const dim = new Date(y, m + 1, 0).getDate()
  const clamped = Math.max(1, Math.min(dim, targetDay))
  selectedScheduleDate = `${y}-${String(m + 1).padStart(2, "0")}-${String(clamped).padStart(2, "0")}`
  window.renderCalendar(currentCalendarDate)
}

window.loadPaymentSettings = async () => {
    try {
        const { data, error } = await db.from('settings').select('*').eq('key', 'admin_qr_code').single()
        
        if (data && data.value) {
            const previewImg = document.getElementById("adminQrPreview")
            const placeholder = document.getElementById("adminQrPlaceholder")
            
            if (previewImg && placeholder) {
                previewImg.src = data.value
                previewImg.style.display = "block"
                placeholder.style.display = "none"
            }
        }
    } catch (err) {
        // Ignore error if setting doesn't exist yet
        console.log("No payment settings found or error:", err)
    }
}



