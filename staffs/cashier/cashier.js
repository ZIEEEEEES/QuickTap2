// cashier/cashier.js - Supabase Ready

// Declare necessary variables
let currentPendingId = null
let currentPendingSource = null // 'pending_orders' | 'bookings'
let currentPendingBooking = null
let currentPendingCustomerId = null
let currentOrder = []
let currentInsufficientDue = 0
let groupedProducts = {}
let productIndexById = {}
let currentResizeIndex = null
let productSearchTerm = "" // live search filter
const categories = { 1: "Coffee", 2: "Non-coffee", 3: "Frappe", 4: "Soda", 5: "Pastries" }
let kioskNewCount = 0
let pastryFilter = "all"
let db = null
let cols = null // Declare cols variable
let kioskUnsub = null // Declare kioskUnsub variable
let preorderUnsub = null
let cashierProductsUnsub = null
let cashierMenuReloadTimer = null
let currentPaymentMethod = "cash" // Track payment method for current order
let currentProofUrl = null // Track proof of payment URL
// Cashier is NOT allowed to manage product catalog; only custom order items.

// Helper function to check if database is ready
function isDbReady() {
  return db !== null && db !== undefined
}

function getCashierRemark() {
  const el = document.getElementById("cashierRemark")
  return el ? String(el.value || "").trim() : ""
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

function composeCashierRemark(opts) {
  const manual = getCashierRemark()
  const auto = buildAutoCashierRemark(opts)
  return manual ? (manual + " | " + auto) : auto
}

function formatPaymentLogEntry(amountPaid, remainingBalance) {
  const ts = new Date().toISOString()
  const amountNum = Number(amountPaid || 0)
  const remainingNum = Number(remainingBalance || 0)
  if (remainingNum > 0) {
    return `Payment made - ${ts} - Amount: \u20B1${amountNum.toFixed(2)} - Remaining Balance: \u20B1${remainingNum.toFixed(2)}`
  }
  return `Payment made - ${ts} - Amount: \u20B1${amountNum.toFixed(2)} - Paid`
}

function formatPaymentConfirmedNote() {
  return `Payment confirmed at ${new Date().toISOString()}`
}

function appendPaymentLog(existingNotes, entry) {
  const base = String(existingNotes || "").trim()
  if (!entry) return base
  return base ? `${base} | ${entry}` : entry
}

function stripInsufficientMarkers(notes) {
  const text = String(notes || "").trim()
  if (!text) return text
  const parts = text.split("|").map((p) => p.trim()).filter(Boolean)
  const filtered = parts.filter((p) => {
    if (/^payment made\b/i.test(p)) return true
    if (/insufficient payment/i.test(p)) return false
    if (/payment incomplete/i.test(p)) return false
    if (/remaining balance/i.test(p)) return false
    return true
  })
  return filtered.join(" | ")
}

async function logStaffAction(action, details) {
  try {
    const sess = typeof getStaffSession === 'function' ? getStaffSession() : null
    const dbRef = getDB()
    if (!sess || !dbRef) return
    await dbRef.from('admin_logs').insert({
      admin_id: sess.id,
      admin_name: sess.full_name,
      action: String(action || 'Staff action'),
      details: details ? String(details) : null
    })
  } catch (e) {
    // Silent fail if logs table doesn't exist
  }
}

function updateCashierBell() {
  const badge = document.getElementById("cashierBellBadge")
  const btn = document.getElementById("cashierBell")
  if (!badge || !btn) return
  const walkInCount = (currentOrder && currentOrder.length > 0) ? 1 : 0
  const total = Number(kioskNewCount || 0) + Number(preorderNewCount || 0) + walkInCount
  badge.textContent = String(total)
  badge.style.display = total > 0 ? "inline-flex" : "none"
  btn.title = `Notifications - Kiosk: ${kioskNewCount || 0}, Pre-order: ${preorderNewCount || 0}, Walk-in: ${walkInCount}`
}

const CASHIER_POLL_MS = 2500

function scheduleCashierMenuReload() {
  if (cashierMenuReloadTimer) clearTimeout(cashierMenuReloadTimer)
  cashierMenuReloadTimer = setTimeout(() => {
    cashierMenuReloadTimer = null
    try {
      loadMenu()
    } catch (_) {}
  }, 400)
}

function subscribeToCashierProductsRealtime() {
  const d = getDB()
  if (!d) return
  if (cashierProductsUnsub && typeof cashierProductsUnsub.unsubscribe === 'function') {
    cashierProductsUnsub.unsubscribe()
    cashierProductsUnsub = null
  }
  cashierProductsUnsub = d
    .channel('cashier-products-sync')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'products' }, () => scheduleCashierMenuReload())
    .subscribe()
}

function startCashierAutoRefresh() {
  if (window.cashierAutoRefreshInterval) return
  window.cashierAutoRefreshInterval = setInterval(() => {
    try {
      loadKioskOrders(true)
    } catch (_) {}
    try {
      loadPreorders(true)
    } catch (_) {}
    try {
      const list = document.getElementById('redemptionRequestsList')
      if (list) loadRedemptions(list)
    } catch (_) {}
  }, CASHIER_POLL_MS)
}

function attachCashierVisibilityRefresh() {
  if (window.__cashierVisibilityRefreshAttached) return
  window.__cashierVisibilityRefreshAttached = true
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return
    try {
      loadKioskOrders(true)
    } catch (_) {}
    try {
      loadPreorders(true)
    } catch (_) {}
    try {
      const list = document.getElementById('redemptionRequestsList')
      if (list) loadRedemptions(list)
    } catch (_) {}
  })
}

// Initialize database when ready
function initializeCashier() {
  db = getDB()
  if (!db) {
    console.warn('[v0] Database not ready, retrying...')
    setTimeout(initializeCashier, 100)
    return
  }
  console.log('[v0] Cashier initialized')
  subscribeToKioskOrders()
  subscribeToCashierProductsRealtime()
  startCashierAutoRefresh()
  attachCashierVisibilityRefresh()

  runDatabaseCleanup()
}

// --- Database Cleanup ---
async function runDatabaseCleanup() {
    if (!isDbReady()) return
    console.log("[System Log] Running database cleanup...")
    
    try {
        const now = new Date()
        const threeDaysAgo = new Date(now)
        threeDaysAgo.setDate(now.getDate() - 3)
        const threeDaysAgoISO = threeDaysAgo.toISOString()

        // 1. Remove completed transactions older than 3 days from pending_orders
        const { error: pendingError } = await getDB()
            .from("pending_orders")
            .delete()
            .eq("status", "completed")
            .lt("created_at", threeDaysAgoISO)
        
        if (pendingError) console.error("Cleanup error (pending_orders):", pendingError)

        // 2. Remove completed bookings/preorders older than 3 days
        const { error: bookingsCompError } = await getDB()
            .from("bookings")
            .delete()
            .eq("status", "completed")
            .lt("created_at", threeDaysAgoISO)
        
        if (bookingsCompError) console.error("Cleanup error (bookings completed):", bookingsCompError)

        // 3. Remove cancelled bookings/preorders on their scheduled date
        // Scheduled date is in 'date' column (YYYY-MM-DD)
        const todayStr = now.toISOString().split('T')[0]
        const { error: bookingsCancError } = await getDB()
            .from("bookings")
            .delete()
            .or('status.eq.cancelled,status.eq.rejected')
            .lte("date", todayStr)
        
        if (bookingsCancError) console.error("Cleanup error (bookings cancelled):", bookingsCancError)

        // 4. Remove 'paid' notifications older than 24 hours
        const oneDayAgo = new Date(now)
        oneDayAgo.setDate(now.getDate() - 1)
        const oneDayAgoISO = oneDayAgo.toISOString()
        const { error: notifError } = await getDB()
            .from("customer_notifications")
            .delete()
            .eq("status", "paid")
            .lt("updated_at", oneDayAgoISO)
        
        if (notifError) console.error("Cleanup error (notifications):", notifError)

        console.log("[System Log] Database cleanup completed.")
    } catch (err) {
        console.error("Critical error during database cleanup:", err)
    }
}

if (window.dbReady) {
  initializeCashier()
} else {
  window.onSupabaseReady = initializeCashier
}

let currentLoyaltyCustomer = null
let discountCount = 0

window.changeDiscount = (delta) => {
    if (currentPaymentMethod === 'online') {
        showMessage("Discounts are not allowed for online payments", "error")
        return
    }
    discountCount += delta
    if (discountCount < 0) discountCount = 0
    updateOrderDisplay()
}

function askRejectReason() {
  const reason = window.prompt("Reason for rejection (e.g., out of stock):", "")
  return String(reason || "").trim()
}

let isBusinessOpen = () => {
  const now = new Date()
  const hours = now.getHours()
  return hours >= 8 && hours < 20
}

document.addEventListener("click", (e) => {
  if (!e.target.closest(".size-dropdown")) {
    document.querySelectorAll(".size-dropdown.open").forEach((dd) => dd.classList.remove("open"))
  }
})

function getDB() {
  return db || window.db
}

function parseInsufficientAmountFromNotesNormalized(notes) {
  const text = String(notes || "")
  if (!text) return 0
  let match = text.match(/remaining balance[:\s]*[^\d]*([\d,.]+)\b/i)
  if (!match) match = text.match(/([0-9]+(?:\.[0-9]{1,2})?)\s*still needed/i)
  if (!match && /insufficient/i.test(text)) match = text.match(/(?:\u20B1|PHP|â‚±)\s*([\d,.]+)\b/i)
  if (!match) return 0
  const value = Number(String(match[1] || "").replace(/,/g, ""))
  return Number.isFinite(value) ? value : 0
}

function parseInsufficientAmountFromNotes(notes) {
  const text = String(notes || "")
  if (!text) return 0
  let match = text.match(/remaining balance[:\s]*[^\d]*([\d,.]+)\b/i)
  if (!match) match = text.match(/([0-9]+(?:\.[0-9]{1,2})?)\s*still needed/i)
  if (!match && /insufficient/i.test(text)) match = text.match(/(?:PHP|\u20B1|â‚±)\s*([\d,.]+)\b/i)
  if (!match) return 0
  const value = Number(String(match[1] || "").replace(/,/g, ""))
  return Number.isFinite(value) ? value : 0
}

function parseInsufficientAmountFromCustomerId(customerId) {
  const text = String(customerId || "")
  if (!text) return 0
  const match =
    text.match(/insufficient[^\d]*?(?:₱|PHP)?\s*([\d,.]+)/i) ||
    text.match(/(?:₱|PHP)\s*([\d,.]+)/i)
  if (!match) return 0
  const value = Number(String(match[1] || "").replace(/,/g, ""))
  return Number.isFinite(value) ? value : 0
}

function stripInsufficientPrefix(customerId) {
  if (typeof customerId !== "string") return customerId
  const stripped = customerId.replace(/^\[INSUFFICIENT[^\]]*\]\s*/i, "").trim()
  return stripped || customerId
}

function getInsufficientAmount(record) {
  const fromColumn = Number(record && record.insufficient_amount_needed ? record.insufficient_amount_needed : 0)
  if (Number.isFinite(fromColumn) && fromColumn > 0) return fromColumn
  const notes = [record && record.insufficient_notes, record && record.notes].filter(Boolean).join(" | ")
  if (/\-\s*paid\b/i.test(notes) || /\bpayment confirmed at\b/i.test(notes)) return 0
  const fromNotes = parseInsufficientAmountFromNotesNormalized(notes)
  if (fromNotes > 0) return fromNotes
  return parseInsufficientAmountFromCustomerId(record && record.customer_id)
}

function getItemsTotal(rawItems) {
  if (!rawItems) return 0
  let items = rawItems
  if (typeof items === "string") {
    try { items = JSON.parse(items) } catch (_) { items = [] }
  }
  if (!Array.isArray(items)) return 0
  return items.reduce((sum, i) => {
    const qty = Number(i.quantity || i.qty || 1)
    const lineTotal = Number(i.amount || 0) || (Number(i.price || 0) * qty)
    return sum + (Number.isFinite(lineTotal) ? lineTotal : 0)
  }, 0)
}

function parsePaidAmountFromNotes(notes) {
  const text = String(notes || "")
  if (!text) return 0
  const amountMatches = Array.from(text.matchAll(/amount:\s*(?:\u20B1|PHP|â‚±)?\s*([\d,.]+)/gi))
  const paidMatches = Array.from(text.matchAll(/paid[:\s]*(?:\u20B1|PHP|â‚±)?\s*([\d,.]+)/gi))
  let raw = null
  if (amountMatches.length > 0) raw = amountMatches[amountMatches.length - 1][1]
  if (!raw && paidMatches.length > 0) raw = paidMatches[paidMatches.length - 1][1]
  const value = Number(String(raw || "").replace(/,/g, ""))
  return Number.isFinite(value) ? value : 0
}

function getRemainingDue(record) {
  const status = String(record && record.status || "").toLowerCase()
  const fromColumn = getInsufficientAmount(record)
  if (fromColumn > 0) return fromColumn
  const notesText = [record && record.insufficient_notes, record && record.notes].filter(Boolean).join(" | ")
  const paid = parsePaidAmountFromNotes(notesText)
  const total = Number(record && (record.finalTotal || record.total) || 0) || getItemsTotal(record && record.items)
  if (total > 0 && paid > 0) return Math.max(0, total - paid)
  if (total > 0 && (status === 'insufficient' || /insufficient/i.test(notesText) || record && record.insufficient_payment === true)) return total
  return 0
}

async function safeUpdateRow(table, id, payload) {
  let currentPayload = { ...payload }
  const tryUpdate = async () => getDB().from(table).update(currentPayload).eq("id", id)
  let { error } = await tryUpdate()
  let attempts = 0
  while (error && attempts < 6) {
    const msg = String(error.message || "")
    let removed = false
    for (const col of Object.keys(currentPayload)) {
      const colHit = msg.includes(`'${col}'`) || msg.includes(`"${col}"`) || msg.includes(` ${col} `)
      const missing = msg.includes("does not exist") || msg.includes("Could not find") || msg.includes("schema cache")
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

async function upsertCustomerNotification({ customerId, orderId, sourceTable, remainingAmount, message }) {
  try {
    const dbRef = getDB()
    if (!dbRef || !orderId) return
    const cleanCustomer = stripInsufficientPrefix(customerId || "")
    const nowIso = new Date().toISOString()
    const { data: existing } = await dbRef
      .from("customer_notifications")
      .select("id,status")
      .eq("order_id", String(orderId))
      .eq("source_table", sourceTable || "pending_orders")
      .in("status", ["unread", "seen"])
      .order("created_at", { ascending: false })
      .limit(1)
    if (existing && existing.length) {
      await dbRef.from("customer_notifications")
        .update({
          customer_id: cleanCustomer || customerId || null,
          remaining_amount: Number(remainingAmount || 0),
          status: "unread",
          message: message || null,
          updated_at: nowIso
        })
        .eq("id", existing[0].id)
    } else {
      await dbRef.from("customer_notifications").insert({
        customer_id: cleanCustomer || customerId || null,
        order_id: String(orderId),
        source_table: sourceTable || "pending_orders",
        remaining_amount: Number(remainingAmount || 0),
        status: "unread",
        message: message || null,
        created_at: nowIso,
        updated_at: nowIso
      })
    }
  } catch (e) {
    console.warn("[v0] Failed to upsert customer notification:", e?.message || e)
    try {
      showMessage("Notification insert failed. Check notifications table/RLS.", "error")
    } catch (_) {}
  }
}

async function markCustomerNotificationPaid(orderId, sourceTable) {
  try {
    const dbRef = getDB()
    if (!dbRef || !orderId) return
    await dbRef.from("customer_notifications")
      .update({ status: "paid", updated_at: new Date().toISOString() })
      .eq("order_id", String(orderId))
      .eq("source_table", sourceTable || "pending_orders")
      .in("status", ["unread", "seen"])
  } catch (e) {
    console.warn("[v0] Failed to mark customer notification paid:", e?.message || e)
  }
}

async function ensureInsufficientMarker(table, id, fallbackNotes, amountNeeded) {
  try {
    const { data } = await getDB()
      .from(table)
      .select("*")
      .eq("id", id)
      .single()
    if (!data) return
    const notesText = String(data.insufficient_notes || data.notes || "")
    const fromCustomer = parseInsufficientAmountFromCustomerId(data.customer_id)
    const hasMarker =
      data.insufficient_payment === true ||
      Number(data.insufficient_amount_needed || 0) > 0 ||
      fromCustomer > 0 ||
      /insufficient/i.test(notesText)
    const needed = Number(amountNeeded || 0)
    if (hasMarker && needed <= 0) return
    const currentCustId = String(data.customer_id || "Guest")
    const stripped = currentCustId.replace(/^\[INSUFFICIENT[^\]]*\]\s*/i, "")
    const amountLabel = needed > 0 ? ` ₱${needed.toFixed(2)}` : ""
    const markedCustId = (`[INSUFFICIENT${amountLabel}] ${stripped}`).substring(0, 100)
    const payload = { customer_id: markedCustId }
    if (fallbackNotes) {
      payload.notes = fallbackNotes
      payload.insufficient_notes = fallbackNotes
    }
    await safeUpdateRow(table, id, payload)
  } catch (e) {
    console.warn("[v0] ensureInsufficientMarker failed:", e)
  }
}

// --- Sidebar Redemption Panel Toggle ---
window.toggleRedemptionPanel = () => {
  const panel = document.getElementById("redemptionPanel")
  if (!panel) return
  panel.classList.toggle("active")
  document.body.classList.toggle("sidebar-open")
}

// Initial state for the icon removed as we use active class now
document.addEventListener("DOMContentLoaded", () => {
  // Check if we need to initialize anything for the sidebar
})

// --- Load menu ---
async function loadMenu() {
  try {
      const { data: products, error } = await getDB().from("products").select("*")
      if (error) throw error

      const visibleProducts = (products || []).filter((p) => p.archived !== true)

      visibleProducts.sort((a, b) => {
        const ca = Number(a.category_id || 0),
          cb = Number(b.category_id || 0)
        if (ca !== cb) return ca - cb
        const nameA = String(a.name || "").toLowerCase()
        const nameB = String(b.name || "").toLowerCase()
        if (nameA < nameB) return -1
        if (nameA > nameB) return 1
        return 0
      })

      groupedProducts = {}
      productIndexById = {}
      visibleProducts.forEach((p) => {
        if (p && typeof p.id !== "undefined" && p.id !== null) {
          productIndexById[String(p.id)] = p
        }
        const catName = categories[Number(p.category_id)] || "Uncategorized"
        if (!groupedProducts[catName]) groupedProducts[catName] = {}
        if (!groupedProducts[catName][p.name]) groupedProducts[catName][p.name] = []
        groupedProducts[catName][p.name].push(p)
      })

      renderMenu("All")
  } catch (err) {
      console.error("Error loading menu:", err)
      showMessage("Error loading menu: " + err.message, "error")
  }
}

// --- Render menu ---
function renderMenu(filterCat) {
  const menuList = document.getElementById("menuList")
  menuList.innerHTML = ""
  const categoryOrder = ["Coffee", "Non-coffee", "Frappe", "Soda", "Pastries", "Uncategorized"]
  const cats = categoryOrder
    .filter((c) => groupedProducts[c])
    .concat(Object.keys(groupedProducts).filter((c) => !categoryOrder.includes(c)))
  cats.forEach((cat) => {
    if (filterCat !== "All" && cat !== filterCat) return
    const catDiv = document.createElement("div")
    catDiv.className = "category-section"
    const catTitle = document.createElement("h3")
    catTitle.textContent = cat
    catDiv.appendChild(catTitle)

    const itemsContainer = document.createElement("div")
    itemsContainer.className = "category-items-container"
    catDiv.appendChild(itemsContainer)

    const prodEntries = Object.entries(groupedProducts[cat] || {}).sort((a, b) => {
      const nameA = String(a[0] || "").trim().toLowerCase()
      const nameB = String(b[0] || "").trim().toLowerCase()
      if (nameA < nameB) return -1
      if (nameA > nameB) return 1
      return 0
    })
    prodEntries.forEach(([prodName, sizesArr]) => {
      // Apply text search filter
      if (productSearchTerm) {
        const lowerName = String(prodName || "").toLowerCase()
        if (!lowerName.includes(productSearchTerm)) return
      }
      if (cat === "Pastries") {
        const lower = String(prodName || "").toLowerCase()
        if (pastryFilter === "waffle" && !lower.includes("waffle")) return
        if (pastryFilter === "croissant" && !lower.includes("croissant") && !lower.includes("croissandwich")) return
      }
      const sizes = [...sizesArr].sort((p1, p2) => Number(p1.id || 0) - Number(p2.id || 0))
      const itemDiv = document.createElement("div")
      itemDiv.className = "menu-item"

      let photoUrl = null
      for (const sizeItem of sizes) {
        photoUrl = sizeItem.image_url || sizeItem.image_url || sizeItem.photo || sizeItem.image_url || sizeItem.image || sizeItem.photoUrl || null
        if (photoUrl) break
      }

      if (photoUrl && String(photoUrl).trim()) {
        const img = document.createElement("img")
        img.src = photoUrl
        img.alt = prodName
        img.crossOrigin = "anonymous"
        img.onerror = () => { img.style.display = "none" }
        itemDiv.appendChild(img)
      }

      const nameDiv = document.createElement("div")
      nameDiv.className = "menu-item-name"
      nameDiv.textContent = prodName
      itemDiv.appendChild(nameDiv)

      if (cat === "Coffee") {
        const tempContainer = document.createElement("div")
        tempContainer.className = "temp-buttons"
        
        const updateActiveState = (selectedTemp) => {
             const btns = tempContainer.querySelectorAll(".temp-btn")
             btns.forEach(btn => btn.classList.remove("active"))
             itemDiv.classList.remove("hot")

             if (selectedTemp === "Cold") {
                 coldBtn.classList.add("active")
             }
             if (selectedTemp === "Hot") {
                 hotBtn.classList.add("active")
                 itemDiv.classList.add("hot")
             }
             itemDiv.dataset.selectedTemp = selectedTemp
        }

        const coldBtn = document.createElement("button")
        coldBtn.className = "temp-btn cold active"
        coldBtn.textContent = "Cold"
        coldBtn.title = "Cold"
        coldBtn.onclick = (e) => { e.stopPropagation(); updateActiveState("Cold") }
        
        const hotBtn = document.createElement("button")
        hotBtn.className = "temp-btn hot"
        hotBtn.textContent = "Hot"
        hotBtn.title = "Hot"
        hotBtn.onclick = (e) => { e.stopPropagation(); updateActiveState("Hot") }
        
        itemDiv.dataset.selectedTemp = "Cold"
        tempContainer.appendChild(coldBtn)
        tempContainer.appendChild(hotBtn)
        itemDiv.appendChild(tempContainer)
      }

      // Stock Toggle
      if (sizes.length === 1) {
          const p = sizes[0]
          const isAvailable = p.is_available !== false
          const stockBtn = document.createElement("button")
          stockBtn.className = `stock-toggle-btn ${isAvailable ? 'in-stock' : 'out-stock'}`
          stockBtn.style.position = "absolute"
          stockBtn.style.top = "8px"
          stockBtn.style.right = "8px"
          stockBtn.style.width = "24px"
          stockBtn.style.height = "24px"
          stockBtn.style.borderRadius = "50%"
          stockBtn.style.fontSize = "12px"
          stockBtn.textContent = isAvailable ? '✓' : '✕'
          stockBtn.title = isAvailable ? "In Stock" : "Out of Stock"
          stockBtn.onclick = (e) => { e.stopPropagation(); toggleStockStatus(p.id, !isAvailable) }
          itemDiv.appendChild(stockBtn)
          if (!isAvailable) itemDiv.classList.add("out-of-stock")
      } else {
          const stockContainer = document.createElement("div")
          stockContainer.style.position = "absolute"
          stockContainer.style.top = "8px"
          stockContainer.style.right = "8px"
          stockContainer.style.display = "flex"
          stockContainer.style.flexDirection = "column"
          stockContainer.style.gap = "4px"
          stockContainer.style.zIndex = "5"
          
          let allOut = true
          sizes.forEach(p => {
              const isAvailable = p.is_available !== false
              if (isAvailable) allOut = false
              const stockBtn = document.createElement("button")
              stockBtn.className = `stock-toggle-btn ${isAvailable ? 'in-stock' : 'out-stock'}`
              stockBtn.style.position = "static"
              stockBtn.style.width = "auto"
              stockBtn.style.padding = "2px 6px"
              stockBtn.style.fontSize = "10px"
              stockBtn.style.height = "auto"
              stockBtn.style.borderRadius = "4px"
              stockBtn.textContent = isAvailable ? `✓ ${p.size}` : `✕ ${p.size}`
              stockBtn.onclick = (e) => { e.stopPropagation(); toggleStockStatus(p.id, !isAvailable) }
              stockContainer.appendChild(stockBtn)
          })
          itemDiv.appendChild(stockContainer)
          if (allOut) itemDiv.classList.add("out-of-stock")
      }

      if (sizes.length > 1) {
        const sizeButtonsContainer = document.createElement("div")
        sizeButtonsContainer.className = "size-buttons-container"
        sizes.forEach((p) => {
          const btn = document.createElement("button")
          btn.className = "size-option-btn-new"
          const price = Number(p.price || 0)
          btn.textContent = p.size ? `${p.size}\n₱${price.toFixed(2)}` : `₱${price.toFixed(2)}`
          btn.onclick = (e) => {
            e.stopPropagation()
            const temperature = cat === "Coffee" ? (itemDiv.dataset.selectedTemp || "Hot") : null
            addToOrder(p.id, prodName, p.price, p.category_id, temperature)
          }
          sizeButtonsContainer.appendChild(btn)
        })
        itemDiv.appendChild(sizeButtonsContainer)
      } else {
        const priceDiv = document.createElement("div")
        priceDiv.className = "menu-item-price"
        priceDiv.textContent = sizes[0].size ? `${sizes[0].size} - ₱${sizes[0].price}` : `₱${sizes[0].price}`
        const addBtn = document.createElement("button")
        addBtn.className = "menu-item-btn"
        addBtn.textContent = "Add"
        addBtn.onclick = (e) => {
          e.stopPropagation()
          const temperature = cat === "Coffee" ? (itemDiv.dataset.selectedTemp || "Hot") : null
          addToOrder(sizes[0].id, prodName, sizes[0].price, sizes[0].category_id, temperature)
        }
        itemDiv.appendChild(priceDiv)
        itemDiv.appendChild(addBtn)
      }
      itemsContainer.appendChild(itemDiv)
    })
    menuList.appendChild(catDiv)
  })
}

// --- Cashier Custom Item (adds to current order only) ---
window.openCustomItemModal = () => {
  const modal = document.getElementById("customItemModal")
  const msg = document.getElementById("customItemModalMsg")
  if (msg) msg.innerHTML = ""

  const activeBtn = document.querySelector(".category-filter button.active")
  const currentCat = activeBtn ? activeBtn.textContent.trim() : "Coffee"
  const catId = Object.entries(categories).find(([, name]) => name === currentCat)?.[0] || "1"
  const cat = document.getElementById("customItemCategory")
  if (cat) cat.value = String(catId)

  const name = document.getElementById("customItemName")
  const size = document.getElementById("customItemSize")
  const price = document.getElementById("customItemPrice")
  if (name) name.value = ""
  if (size) size.value = ""
  if (price) price.value = ""

  updateCustomItemSizeVisibility()
  if (modal) modal.style.display = "flex"
}

window.closeCustomItemModal = () => {
  const modal = document.getElementById("customItemModal")
  if (modal) modal.style.display = "none"
}

window.addCustomItemToOrder = () => {
  const msg = document.getElementById("customItemModalMsg")
  if (msg) msg.innerHTML = ""

  const category_id = Number(document.getElementById("customItemCategory")?.value || 1)
  const name = String(document.getElementById("customItemName")?.value || "").trim()
  const size = String(document.getElementById("customItemSize")?.value || "").trim()
  const price = Number(document.getElementById("customItemPrice")?.value || 0)

  if (!name || !Number.isFinite(price) || price <= 0) {
    if (msg) msg.innerHTML = `<div class="message error">Please enter Item Name and a valid Price.</div>`
    return
  }

  const customId = `custom-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
  const displayName = size ? `${name} (${size}) (Custom)` : `${name} (Custom)`

  currentOrder.push({
    id: customId,
    productId: null,
    name: displayName,
    price: price,
    qty: 1,
    category_id
  })

  updateOrderDisplay()
  showMessage("Custom item added", "success")
  window.closeCustomItemModal()
}

function updateCustomItemSizeVisibility() {
  const catVal = String(document.getElementById("customItemCategory")?.value || "")
  const sizeWrap = document.getElementById("customItemSizeWrap")
  const sizeEl = document.getElementById("customItemSize")
  const isPastries = catVal === "5"
  if (sizeWrap) sizeWrap.style.display = isPastries ? "none" : "block"
  if (isPastries && sizeEl) sizeEl.value = ""
}

document.addEventListener("DOMContentLoaded", () => {
  const cat = document.getElementById("customItemCategory")
  if (cat) cat.addEventListener("change", updateCustomItemSizeVisibility)
})

// Add toggleStockStatus function
async function toggleStockStatus(id, isAvailable) {
    try {
        const { error } = await getDB().from("products").update({ is_available: isAvailable }).eq("id", id)
        if (error) throw error
        loadMenu() // Refresh UI
    } catch (err) {
        console.error("Error updating stock:", err)
        showMessage("Failed to update stock", "error")
    }
}

// Filter functions
function filterCategory(cat, el) {
  document.querySelectorAll(".category-filter button").forEach((b) => b.classList.remove("active"))
  if (el) el.classList.add("active")
  const sub = document.getElementById("pastrySubfilter")
  if (sub) {
    if (cat === "Pastries") sub.style.display = "flex"
    else {
      sub.style.display = "none"
      pastryFilter = "all"
      sub.querySelectorAll("button").forEach((b, idx) => {
        if (idx === 0) b.classList.add("active")
        else b.classList.remove("active")
      })
    }
  }
  renderMenu(cat)
}

function filterPastries(type, el) {
  pastryFilter = type
  const container = document.getElementById("pastrySubfilter")
  if (container) container.querySelectorAll("button").forEach((b) => b.classList.remove("active"))
  if (el) el.classList.add("active")
  renderMenu("Pastries")
}

// Live product search for cashier menu
function setProductSearch(query) {
  productSearchTerm = String(query || "").trim().toLowerCase()

  // Try to auto-switch to the category that contains the searched product
  let targetCat = null
  if (productSearchTerm && groupedProducts) {
    outer: for (const [catName, productsByName] of Object.entries(groupedProducts)) {
      for (const prodName of Object.keys(productsByName || {})) {
        const lowerName = String(prodName || "").toLowerCase()
        if (lowerName.includes(productSearchTerm)) {
          targetCat = catName
          break outer
        }
      }
    }
  }

  const activeBtn = document.querySelector(".category-filter button.active")
  const currentCat = activeBtn ? activeBtn.textContent.trim() : "Coffee"

  // If we found a better-matching category, activate its tab so
  // the cashier doesn't need to click it manually
  if (targetCat && targetCat !== currentCat) {
    const buttons = document.querySelectorAll(".category-filter button")
    const matchBtn = Array.from(buttons).find(
      (b) => b.textContent.trim() === targetCat
    )
    if (matchBtn) {
      filterCategory(targetCat, matchBtn)
      return
    }
  }

  // Otherwise, just re-render using the currently active category
  renderMenu(currentCat)
}

// Orders
function addToOrder(productId, productName, productPrice, categoryId, temperature = null) {
  // Log order creation if this is the first item
  if (currentOrder.length === 0) {
    logStaffAction('Order creation', `Started new walk-in order`)
  }
  
  const itemKey = temperature ? `${productId}-${temperature}` : String(productId)
  const existing = currentOrder.find((item) => item.id === itemKey)
  if (existing) existing.qty++
  else currentOrder.push({
    id: itemKey,
    productId: productId,
    name: temperature ? `${productName} (${temperature})` : productName,
    price: productPrice,
    qty: 1,
    category_id: categoryId
  })
  updateOrderDisplay()
  showMessage("Added to order!", "success")
}

function updateOrderDisplay() {
  const orderBody = document.getElementById("orderBody")
  orderBody.innerHTML = ""
  let subtotal = 0
  const allItems = []

  currentOrder.forEach((item, idx) => {
    const itemTotal = item.price * item.qty
    subtotal += itemTotal
    for(let i=0; i<item.qty; i++) allItems.push(Number(item.price))

    const row = document.createElement("tr")
    row.innerHTML = `
      <td>${item.name}</td>
      <td>₱${Number(item.price || 0).toFixed(2)}</td>
      <td>
        <div class="qty-control-wrapper">
          <button class="qty-btn minus" onclick="changeQty(${idx},-1)">-</button>
          <input type="number" value="${item.qty}" min="1" class="qty-input" onchange="setQty(${idx}, this.value)">
          <button class="qty-btn plus" onclick="changeQty(${idx},1)">+</button>
        </div>
      </td>
      <td>₱${itemTotal.toFixed(2)}</td>
      <td>
        <div class="order-action-buttons">
          <button class="resize-item-btn" onclick="resizeOrderItem(${idx})">Resize</button>
          <button class="remove-item-btn" onclick="removeFromOrder(${idx})">Remove</button>
        </div>
      </td>
    `
    orderBody.appendChild(row)
  })

  allItems.sort((a,b) => b - a)
  let discountAmount = 0
  
  // Rule out online payment for discounts
  if (currentPaymentMethod !== 'online') {
      // Discount Logic: Apply 20% discount to highest priced items first.
      // effectiveDiscounts cannot exceed total items (1 discount per item max)
      const effectiveDiscounts = Math.min(discountCount, allItems.length)
      for(let i=0; i<effectiveDiscounts; i++) discountAmount += allItems[i] * 0.20
  }
  
  const finalTotal = Math.max(subtotal - discountAmount, 0)
  document.getElementById("orderTotal").textContent = finalTotal.toFixed(2)
  
  const netSubtotal = finalTotal / 1.12
  const vat = finalTotal - netSubtotal
  if (document.getElementById("vatAmountDisplay")) document.getElementById("vatAmountDisplay").textContent = vat.toFixed(2)
  if (document.getElementById("subtotalAmountDisplay")) document.getElementById("subtotalAmountDisplay").textContent = netSubtotal.toFixed(2)

  if(document.getElementById("discountCountDisplay")) document.getElementById("discountCountDisplay").textContent = discountCount
  if(document.getElementById("discountAmount")) document.getElementById("discountAmount").textContent = discountAmount.toFixed(2)
  updateExchange()
  updateCashierBell()
}

window.changeQty = (idx, delta) => {
  currentOrder[idx].qty += delta
  if (currentOrder[idx].qty <= 0) window.removeFromOrder(idx)
  else updateOrderDisplay()
}

window.setQty = (idx, val) => {
  let newQty = parseInt(val)
  if (isNaN(newQty) || newQty < 1) newQty = 1
  currentOrder[idx].qty = newQty
  updateOrderDisplay()
}

window.removeFromOrder = (idx) => {
  currentOrder.splice(idx, 1)
  updateOrderDisplay()
}

// Allow cashier to change the size (variant) of an item using a friendly modal
window.resizeOrderItem = (idx) => {
  const item = currentOrder[idx]
  if (!item) return

  const rawId = item.productId || String(item.id || "").split("-")[0]
  let matchedName = null
  let sizesArr = null

  outer: for (const [, productsByName] of Object.entries(groupedProducts || {})) {
    for (const [prodName, variants] of Object.entries(productsByName || {})) {
      const found = (variants || []).find((p) => String(p.id) === String(rawId))
      if (found) {
        matchedName = prodName
        sizesArr = variants
        break outer
      }
    }
  }

  if (!sizesArr || sizesArr.length <= 1) {
    showMessage("No other sizes available for this item.", "info")
    return
  }

  const sorted = [...sizesArr].sort((p1, p2) => Number(p1.id || 0) - Number(p2.id || 0))
  const currentIndex = sorted.findIndex((p) => String(p.id) === String(rawId))

  const modal = document.getElementById("resizeModal")
  const title = document.getElementById("resizeTitle")
  const optionsContainer = document.getElementById("resizeOptions")
  if (!modal || !title || !optionsContainer) {
    // Fallback to prompt if modal not found
    const fallback = window.prompt("Enter new price:", Number(item.price || 0))
    if (!fallback) return
    const newPrice = Number(fallback)
    if (Number.isFinite(newPrice) && newPrice > 0) {
      item.price = newPrice
      updateOrderDisplay()
    }
    return
  }

  currentResizeIndex = idx
  title.textContent = `Resize "${matchedName || item.name}"`
  optionsContainer.innerHTML = ""

  sorted.forEach((variant, i) => {
    const isCurrent = String(variant.id) === String(rawId)
    const btn = document.createElement("button")
    btn.type = "button"
    btn.className = "btn-secondary"
    btn.style.display = "flex"
    btn.style.justifyContent = "space-between"
    btn.style.alignItems = "center"
    btn.style.width = "100%"
    btn.style.padding = "10px 12px"
    btn.style.borderRadius = "8px"

    const sizeLabel = variant.size ? String(variant.size) : "Default"
    const priceLabel = `₱${Number(variant.price || 0).toFixed(2)}`

    btn.innerHTML = `
      <span style="font-weight:600;">${sizeLabel}</span>
      <span style="font-size:0.9em; color:var(--text-secondary);">${priceLabel}${isCurrent ? " • current" : ""}</span>
    `

    btn.onclick = () => confirmResizeChoice(variant, item)
    optionsContainer.appendChild(btn)
  })

  // Show as flex (required by .modal) then position near PAY NOW
  modal.style.display = "flex"
  // Position after layout so it never covers PAY NOW
  setTimeout(positionResizePopover, 0)
}

window.closeResizeModal = () => {
  const modal = document.getElementById("resizeModal")
  if (modal) modal.style.display = "none"
  currentResizeIndex = null
}

window.confirmResizeChoice = (variant, itemRef) => {
  const idx = currentResizeIndex
  if (idx === null || typeof idx === "undefined") return
  const item = currentOrder[idx] || itemRef
  if (!item || !variant) return

  const temperature = /\(Hot\)|\(Cold\)/i.test(item.name)
    ? (item.name.toLowerCase().includes("cold") ? "Cold" : "Hot")
    : null

  item.productId = variant.id
  item.id = temperature ? `${variant.id}-${temperature}` : String(variant.id)
  item.price = Number(variant.price || 0)

  window.closeResizeModal()
  updateOrderDisplay()
}

function positionResizePopover() {
  const modal = document.getElementById("resizeModal")
  const content = modal ? modal.querySelector(".modal-content") : null
  const payBtn = document.getElementById("payNowBtn")
  if (!modal || !content || !payBtn) return

  const btnRect = payBtn.getBoundingClientRect()
  const margin = 10

  // Temporarily ensure we can measure the content
  const prevDisplay = content.style.display
  content.style.display = "block"
  const popW = content.offsetWidth || 340
  const popH = content.offsetHeight || 260
  content.style.display = prevDisplay

  // Prefer below PAY NOW, aligned to its right edge
  let left = Math.round(btnRect.right - popW)
  let top = Math.round(btnRect.bottom + margin)

  // Clamp horizontally
  left = Math.max(margin, Math.min(left, window.innerWidth - popW - margin))

  // If there's not enough space below, place above PAY NOW
  if (top + popH > window.innerHeight - margin) {
    top = Math.round(btnRect.top - popH - margin)
  }
  top = Math.max(margin, Math.min(top, window.innerHeight - popH - margin))

  content.style.left = `${left}px`
  content.style.top = `${top}px`
}

window.addEventListener("resize", () => {
  const modal = document.getElementById("resizeModal")
  if (modal && modal.style.display !== "none") positionResizePopover()
})

window.addEventListener("scroll", () => {
  const modal = document.getElementById("resizeModal")
  if (modal && modal.style.display !== "none") positionResizePopover()
}, true)

function updateExchange() {
  const total = Number.parseFloat(document.getElementById("orderTotal").textContent) || 0
  let tenderInput = document.getElementById("tender")
  let tender = Number.parseFloat(tenderInput.value) || 0
  if (tender < 0) { tender = 0; tenderInput.value = 0 }
  const exchange = Math.max(tender - total, 0)
  document.getElementById("exchange").textContent = exchange.toFixed(2)
  updatePayNowState()
}

function updatePayNowState() {
  const payBtn = document.getElementById("payNowBtn")
  if (!payBtn) return
  const total = Number.parseFloat(document.getElementById("orderTotal")?.textContent || "0") || 0
  const tenderRaw = document.getElementById("tender")?.value ?? ""
  const tender = Number.parseFloat(tenderRaw)
  const hasItems = Array.isArray(currentOrder) && currentOrder.length > 0

  let canPay = hasItems
  // Rule: cash payments require valid + sufficient tender before PAY NOW is clickable.
  if (currentPaymentMethod !== "online") {
    canPay = canPay && Number.isFinite(tender) && tender >= total && tender >= 0
  }

  payBtn.disabled = !canPay
  payBtn.style.opacity = canPay ? "1" : "0.5"
  payBtn.style.cursor = canPay ? "pointer" : "not-allowed"
}

// --- Complete Order ---
window.completeOrder = async () => {
  console.log("PAY NOW button clicked - completeOrder initiated");
  // if (!isBusinessOpen()) {
  //   showMessage("Transactions are only allowed between 8:00 AM and 8:00 PM.", "error")
  //   return
  // }
  
  // Implicit Lookup: If ID entered but not verified, try to verify now
  const custIdInput = document.getElementById("custId").value.trim()
  if (custIdInput && !currentLoyaltyCustomer) {
      console.log("[System Log] Implicitly looking up loyalty card:", custIdInput)
      await window.lookupLoyaltyCard()
  }

  const custId = document.getElementById("custId").value
  if (!currentOrder.length) {
    console.warn("Order is empty, cannot complete.");
    showMessage("Add items to order first!", "error")
    return
  }

  const displayedTotal = Number.parseFloat(document.getElementById("orderTotal").textContent)
  const isPreorderPOS = currentPendingSource === "bookings"
  const calcTotal = currentOrder.reduce((sum, i) => sum + (Number(i.price || 0) * Number(i.qty || 1)), 0)
  const fullTotal = isPreorderPOS
      ? (Number(currentPendingBooking?.total || 0) || calcTotal || displayedTotal)
      : displayedTotal
  const totalDue = (Number(currentInsufficientDue || 0) > 0) ? Number(currentInsufficientDue || 0) : fullTotal
  let tenderVal = document.getElementById("tender").value;
  let tender = Number.parseFloat(tenderVal)
  if (isNaN(tender)) tender = 0

  // Prevent submit when cash tender is invalid or insufficient.
  if (currentPaymentMethod !== "online" && (!Number.isFinite(tender) || tender < 0 || tender < totalDue)) {
      const needMore = Math.max(0, totalDue - (Number.isFinite(tender) ? tender : 0))
      showMessage(`Insufficient or invalid tender. Need ₱${needMore.toFixed(2)} more.`, "error")
      updatePayNowState()
      return
  }

  if (isPreorderPOS) {
      if (tender < 0) {
          showMessage("Tender cannot be negative", "error")
          return
      }
      if (tender < totalDue) {
          const discountForInsufficient = fullTotal * 0.20;
          const discountedTotal = fullTotal - discountForInsufficient;
          const remainingBalance = Math.max(0, discountedTotal - tender);

          // If after applying the 20% discount, the tender is enough, then mark as PAID
          if (tender >= discountedTotal) {
              console.log("Pre-order tender covers discounted total, marking as PAID with 20% discount.");
              try {
                  const paymentLog = formatPaymentLogEntry(tender, 0)
                  const existingNotes = (currentPendingBooking && (currentPendingBooking.insufficient_notes || currentPendingBooking.notes)) || ""
                  let updatedNotes = appendPaymentLog(existingNotes, paymentLog)
                  updatedNotes = stripInsufficientMarkers(updatedNotes)
                  const payload = {
                      status: "PAID",
                      total: discountedTotal, // Update total in DB
                      discount: (currentPendingBooking?.discount || 0) + discountForInsufficient,
                      insufficient_payment: false,
                      insufficient_amount_needed: 0,
                      insufficient_notes: updatedNotes,
                      notes: updatedNotes
                  }
                  await safeUpdateRow("bookings", currentPendingId, payload)
                  await logStaffAction('Order Completion', `ORDER_ID: #${currentPendingId} FINALIZED (20% Discount applied)`)
                  showMessage("Payment confirmed (20% discount applied). Order marked as PAID.", "success")
                  loadPreorders()
                  clearOrder()
                  return
              } catch (e) {
                  showMessage("Failed to confirm payment: " + (e.message || e), "error")
                  return
              }
          }

          try {
              await markPreorderInsufficientFromPOS(currentPendingBooking || { id: currentPendingId }, tender, discountedTotal)
              await logStaffAction('Insufficient payment', `ORDER_ID: #${currentPendingId} PAID: ₱${tender.toFixed(2)} REMAINING: ₱${remainingBalance.toFixed(2)} (20% Discount)`)
              showMessage(`Insufficient payment recorded (20% discount applied). Remaining \u20B1${remainingBalance.toFixed(2)}.`, "success")
              currentInsufficientDue = remainingBalance
              loadPreorders()
              clearOrder()
              return
          } catch (e) {
              showMessage("Failed to mark insufficient payment: " + (e.message || e), "error")
              return
          }
      }
      try {
          const paymentLog = formatPaymentLogEntry(tender, 0)
          const existingNotes = (currentPendingBooking && (currentPendingBooking.insufficient_notes || currentPendingBooking.notes)) || ""
          let updatedNotes = appendPaymentLog(existingNotes, paymentLog)
          if (Number(currentInsufficientDue || 0) > 0) {
              const confirmNote = formatPaymentConfirmedNote()
              if (!updatedNotes.includes(confirmNote)) updatedNotes = appendPaymentLog(updatedNotes, confirmNote)
          }
          updatedNotes = stripInsufficientMarkers(updatedNotes)
          const payload = {
              status: "PAID",
              insufficient_payment: false,
              insufficient_amount_needed: 0,
              insufficient_notes: updatedNotes,
              notes: updatedNotes
          }
          const strippedCustomer = stripInsufficientPrefix(currentPendingBooking && currentPendingBooking.customer_id)
          if (strippedCustomer && currentPendingBooking && strippedCustomer !== currentPendingBooking.customer_id) {
              payload.customer_id = strippedCustomer
          }
          await safeUpdateRow("bookings", currentPendingId, payload)
          // Update notification status to 'paid'
          await markCustomerNotificationPaid(currentPendingId, "bookings")
          
          // Notify customer: title: "Payment Confirmed", message: "Your order is now fully paid.", status_color: GREEN
          await upsertCustomerNotification({
              customerId: strippedCustomer || (currentPendingBooking && currentPendingBooking.customer_id),
              orderId: currentPendingId,
              sourceTable: "bookings",
              message: "Your order is now fully paid."
          });

          await logStaffAction('Payment Received', `ORDER_ID: #${currentPendingId} AMOUNT: ₱${tender.toFixed(2)}`)
          logStaffAction('Order Completion', `ORDER_ID: #${currentPendingId} FINALIZED`)
          showMessage("Payment confirmed. Order marked as PAID.", "success")
          loadPreorders()
          clearOrder()
          return
      } catch (e) {
          showMessage("Failed to confirm payment: " + (e.message || e), "error")
          return
      }
  }

  const total = totalDue

  if (currentPaymentMethod !== "online" && (isNaN(tender) || tender < total)) {
      // Apply 20% discount for insufficient payment
      const discountForInsufficient = total * 0.20;
      const discountedTotal = total - discountForInsufficient;
      const paidAmount = Math.max(0, Number(tender || 0))
      const remainingBalance = Math.max(0, discountedTotal - paidAmount)
      
      console.warn("Insufficient tender:", tender, "Total:", total, "Discounted:", discountedTotal)
      
      // If after applying the discount, the tender is enough, then complete the order as a normal sale
      if (paidAmount >= discountedTotal) {
          console.log("Tender covers discounted total, completing order with 20% discount.");
          // Update the global total and discount for the rest of the function
          const originalTotal = total;
          // We need to update the UI elements so that the rest of completeOrder picks up the correct values
          document.getElementById("orderTotal").textContent = discountedTotal.toFixed(2);
          if (document.getElementById("discountAmount")) {
              const currentDiscount = Number.parseFloat(document.getElementById("discountAmount").textContent) || 0;
              document.getElementById("discountAmount").textContent = (currentDiscount + discountForInsufficient).toFixed(2);
          }
          // Continue with normal flow (re-evaluating total from UI)
          return window.completeOrder(); // Recursive call will now pick up the new total and enough tender
      }

      if (currentPendingId) {
          // Instead of generic confirmPayment, use the insufficient flow
          window.openInsufficientPaymentModal({
              id: currentPendingId,
              customer_id: currentPendingCustomerId || "Guest",
              total: discountedTotal, // Use discounted total
              items: currentOrder,
              _source: "pending_orders",
              amountPaid: paidAmount
          })
          return
      } else {
          const paymentLog = formatPaymentLogEntry(paidAmount, remainingBalance)
          const notifyNote = remainingBalance > 0 ? `Payment incomplete. Remaining Balance: \u20B1${remainingBalance.toFixed(2)}` : ""
          let notes = appendPaymentLog(`Insufficient payment (20% discount applied) | Remaining Balance: \u20B1${remainingBalance.toFixed(2)}`, paymentLog)
          if (notifyNote) notes = appendPaymentLog(notes, notifyNote)

          const customerRef = currentLoyaltyCustomer
              ? (currentLoyaltyCustomer.email || currentLoyaltyCustomer.contact || currentLoyaltyCustomer.loyalty_card || currentLoyaltyCustomer.name)
              : null
          const kitchenPayload = {
              customer_id: customerRef ? String(customerRef) : null,
              items: JSON.stringify(currentOrder),
              total: discountedTotal, // Use discounted total
              status: "INSUFFICIENT",
              type: "insufficient",
              payment_method: currentPaymentMethod,
              insufficient_payment: true,
              insufficient_amount_needed: remainingBalance,
              insufficient_notes: notes,
              notes: notes,
              created_at: new Date().toISOString()
          }
          try {
              const { data: inserted } = await getDB().from("pending_orders").insert(kitchenPayload).select().single()
              if (inserted && inserted.id) {
                  await upsertCustomerNotification({
                      customerId: customerRef,
                      orderId: inserted.id,
                      sourceTable: "pending_orders",
                      remainingAmount: remainingBalance,
                      message: `Additional payment required (20% discount applied). Remaining Balance: PHP ${remainingBalance.toFixed(2)}`
                  })
              }
              await logStaffAction('Insufficient payment', `ORDER_ID: WALK-IN PAID: ₱${paidAmount.toFixed(2)} REMAINING: ₱${remainingBalance.toFixed(2)} (20% Discount)`)
          showMessage(`Insufficient payment recorded (20% discount applied). Remaining \u20B1${remainingBalance.toFixed(2)}.`, "info")
          } catch (e) {
              console.error("[System Log] Failed to create insufficient walk-in:", e)
              showMessage("Failed to record insufficient payment: " + (e.message || e), "error")
              return
          }
      }
      clearOrder()
      return
  }
  
  // Validation based on payment method
  if (currentPaymentMethod === 'online') {
      // For online payment, we assume exact payment was made (verified via receipt)
      if (isNaN(tender)) tender = total 
      console.log("Online payment detected, tender auto-filled:", tender);
  } else {
      if (tender < 0) { 
          console.warn("Tender is negative:", tender);
          showMessage("Tender cannot be negative", "error"); 
          return 
      }
      if (isNaN(tender) || tender < total) { 
          console.warn("Insufficient tender:", tender, "Total:", total);
          showMessage(`Insufficient tender. Need ₱${(total - (tender || 0)).toFixed(2)} more.`, "error")
          return 
      }
  }

  const discountAmount = Number.parseFloat(document.getElementById("discountAmount")?.textContent || "0") || 0

  try {
      console.log("[System Log] Processing Payment started. Total:", total, "Tender:", tender, "Discount:", discountAmount);
      
      if (!isDbReady()) {
          console.error("Database not ready during completeOrder");
          showMessage("Database error. Please refresh the page.", "error");
          return;
      }
      const items = currentOrder.map((i) => ({
        id: i.id,
        name: i.name,
        category_id: i.category_id,
        quantity: Number(i.qty || 1),
        amount: Number(i.price || 0) * Number(i.qty || 1),
      }))
      const dateStr = new Date().toISOString().slice(0, 10)
      const itemCount = items.reduce((sum, i) => sum + Number(i.quantity || 0), 0)
      const paymentLogEntry = formatPaymentLogEntry(total, 0)
      const cashierRemark = appendPaymentLog(composeCashierRemark({
        source: currentPendingId ? "kiosk" : "walk-in",
        paymentMethod: currentPaymentMethod,
        itemCount,
        total,
        discount: discountAmount,
        insufficient: Number(currentInsufficientDue || 0) > 0
      }), paymentLogEntry)
      
        const staffSession = typeof getStaffSession === 'function' ? getStaffSession() : null
      const baseSalesPayload = {
        items: JSON.stringify(items),
        total: total,
        amount: total, // Map total to amount (legacy vs new schema)
        timestamp: new Date().toISOString(),
        sale_date: new Date().toISOString(), // Map timestamp to sale_date (legacy vs new schema)
        date: dateStr,
        payment_method: currentPaymentMethod, // Use variable
        status: 'completed',
        type: 'walk-in',
        ...(staffSession && { cashier_id: staffSession.id, cashier_name: staffSession.full_name }),
        ...(cashierRemark ? { cashier_remarks: cashierRemark } : {})
      }
      const salesPayload = { ...baseSalesPayload }
      if (Number(discountAmount) > 0) salesPayload.discount = Number(discountAmount)
      console.log("[System Log] Inserting into Sales:", salesPayload)

      // Insert into sales with progressive fallbacks if schema lacks expected columns
      let salesInserted = false
      let insertedSaleRecord = null
      const tryInsert = async (payload) => {
        const { data, error } = await getDB().from("sales").insert(payload).select()
        if (!error && data && data.length > 0) insertedSaleRecord = data[0]
        return error || null
      }
      
      let currentPayload = { ...salesPayload }
      let err = await tryInsert(currentPayload)
      let attempt = 0
      
      while (err && attempt < 10) {
        const msg = String(err.message || "")
        console.warn(`[System Log] Sales Insert Error (Attempt ${attempt + 1}):`, msg)
        
        let removedField = false
        // Check for common missing columns and remove them from payload
        // Relaxed check: looks for column name and "does not exist"
        const columns = ['discount', 'items', 'total', 'timestamp', 'date', 'amount', 'sale_date', 'payment_method', 'status', 'type', 'booking_id', 'cashier_remarks']
        
        for (const col of columns) {
            // Check if message contains column name (quoted or not) and "does not exist"
            const colNameInMsg = msg.includes(`"${col}"`) || msg.includes(`'${col}'`) || msg.includes(` ${col} `);
            const doesNotExist = msg.includes("does not exist") || msg.includes("Could not find");
            const isGenerated = msg.includes("cannot insert a non-DEFAULT value");
            
            if (colNameInMsg && (doesNotExist || isGenerated) && currentPayload[col] !== undefined) {
                console.warn(`[System Log] Removing problematic column '${col}' from payload (Missing/Generated) and retrying...`)
                delete currentPayload[col]
                removedField = true
                break // Only remove one at a time to ensure we catch the next error correctly
            }
        }
        
        if (!removedField) {
            // If error is not about missing columns, or we can't fix it, break
            break
        }
        
        err = await tryInsert(currentPayload)
        attempt++
      }
      
      if (!err) {
        salesInserted = true
        console.log("[System Log] Sales Insert Success")
        // Log payment and completion
        const orderId = currentPendingId ? `#${currentPendingId}` : 'WALK-IN'
        logStaffAction('Payment Received', `ORDER_ID: ${orderId} AMOUNT: ₱${total.toFixed(2)}`)
        logStaffAction('Order Completion', `ORDER_ID: ${orderId} FINALIZED`)
      } else {
         console.error("[System Log] Sales Insert ultimately failed:", err)
         if (err.message && err.message.includes("policy")) {
             showMessage("Database Error: Permission denied (RLS). Run update_schema.sql.", "error")
         } else if (err.message && err.message.includes("column")) {
             showMessage(`Database Error: Missing columns. Run update_schema.sql. (${err.message})`, "error")
         } else {
             const msg = "Sales Save Failed: " + err.message
             console.error(msg)
             showMessage(msg, "error")
         }
         // CRITICAL: Stop here if sales failed to save. Do not clear order.
         return
      }

      let receiptOrderNumber = null
      if (!currentPendingId) {
          // Walk-in Order or Standalone Redemption
          console.log("[System Log] Processing Walk-in/Redemption Order")
          
          // Determine type: if all items are redemptions, type is redemption
          const isFullRedemption = currentOrder.length > 0 && currentOrder.every(item => String(item.name).includes("(Redemption)"))
          const orderType = isFullRedemption ? "redemption" : "walk-in"

          // 1. Create a Pending Order for the Kitchen
          const kitchenPayload = {
              customer_id: currentLoyaltyCustomer ? String(currentLoyaltyCustomer.name) : null,
              items: JSON.stringify(currentOrder),
              total: total,
              status: "PAID",
              type: orderType,
              payment_method: currentPaymentMethod,
              created_at: new Date().toISOString()
          }
          
          const { data: kitchenOrder, error: kitchenError } = await getDB()
              .from("pending_orders")
              .insert(kitchenPayload)
              .select("*")
              .single()
          if (kitchenError) {
              console.error("[System Log] Failed to send walk-in to kitchen:", kitchenError)
          } else {
              console.log("[System Log] Walk-in order sent to kitchen dashboard")
              receiptOrderNumber = kitchenOrder?.order_number || (kitchenOrder?.id ? String(kitchenOrder.id).slice(-4) : null)
          }

          // 2. Add to Orders History (for customer reporting/tracking)
          const orderTimestamp = new Date()
          const ordersPayload = currentOrder.map(item => ({
              customer_id: String(currentLoyaltyCustomer ? currentLoyaltyCustomer.email : (custId || "walk-in")),
              product_id: item.productId || String(item.id || "").split("-")[0],
              name: item.name,
              quantity: item.qty,
              price: item.price,
              category_id: item.category_id,
              timestamp: orderTimestamp,
              payment_method: currentPaymentMethod,
              status: 'completed'
          }))
          
          console.log("[System Log] Inserting into Orders History:", ordersPayload)
          const tryInsertOrders = async (payload) => {
              const { error } = await getDB().from("orders").insert(payload)
              return error
          }

          let ordersError = await tryInsertOrders(ordersPayload)
          
          // Progressive fallback for orders table
          if (ordersError) {
              console.warn("[System Log] Orders Insert Error:", ordersError.message)
              
              // Retry without category_id if missing
              if (ordersError.message && (ordersError.message.includes('column "category_id" does not exist') || ordersError.message.includes("Could not find the 'category_id' column"))) {
                  console.log("[System Log] Retrying orders insert without category_id")
                  const fallbackPayload = ordersPayload.map(({ category_id, ...rest }) => rest)
                  ordersError = await tryInsertOrders(fallbackPayload)
              }
          }

          if (ordersError) {
             console.error("[System Log] Orders History Insert Failed:", ordersError)
             if (ordersError.message && ordersError.message.includes("invalid input syntax")) {
                 console.error("Schema mismatch detected! orders.customer_id needs to be VARCHAR.", ordersError)
                 showMessage("Database Schema Error: Please run the update_schema.sql script.", "error")
             } else if (ordersError.message && ordersError.message.includes("column")) {
                 showMessage("Database Schema Error: Missing columns in 'orders' table. Run update_schema.sql.", "error")
             }
             // We don't throw here to allow the transaction to complete visually for the user
             // as the sales record (revenue) is more critical and was likely handled above
          } else {
            console.log("[System Log] Orders History Insert Success")
          }
      } 

      // 2. Loyalty (Applies to both walk-in and kiosk)
      if (currentLoyaltyCustomer) {
        const points = 1
        console.log("[System Log] Processing Loyalty Points. Points:", points, "Customer:", currentLoyaltyCustomer.id)
        
        // Fetch fresh points to avoid race conditions/stale data
        const { data: freshCust } = await getDB().from("customers").select("loyalty_points").eq("id", currentLoyaltyCustomer.id).single()
        const currentPoints = freshCust ? (freshCust.loyalty_points || 0) : (currentLoyaltyCustomer.loyalty_points || 0)
        const newPoints = currentPoints + points
        
        await getDB().from("customers").update({ loyalty_points: newPoints }).eq("id", currentLoyaltyCustomer.id)
        
        await getDB().from("loyalty_history").insert({
            customer_id: currentLoyaltyCustomer.id,
            loyalty_card: currentLoyaltyCustomer.loyalty_card,
            points: points,
            source: currentPendingId ? "kiosk_order" : "store_order",
            order_id: currentPendingId || "walk_in",
            total: total,
            timestamp: new Date()
        })
        console.log("[System Log] Points awarded successfully:", points)
      }
      
      // Handle Kiosk Order Completion
      if (currentPendingId) {
          console.log("[System Log] Updating Kiosk Order Status. ID:", currentPendingId)
          // Minimal payload to avoid schema mismatches across environments
          const minimalPayload = { status: "PAID" }
          const { error: updateError } = await getDB().from("pending_orders").update(minimalPayload).eq("id", currentPendingId)
          if (updateError) {
              console.warn("[System Log] Kiosk Minimal Update Failed:", String(updateError.message || updateError))
              // Do not block payment completion; proceed to receipt and clearing
          } else {
              console.log("[System Log] Kiosk Order Updated to 'PAID'")
          }

          // If this was an insufficient settlement, clear insufficient marker after payment
          if (Number(currentInsufficientDue || 0) > 0) {
              try {
                  const clearPayload = {
                      status: "PAID",
                      insufficient_payment: false,
                      insufficient_amount_needed: 0,
                      insufficient_notes: "PAID",
                      notes: "PAID"
                  }
                  const strippedCustomer = stripInsufficientPrefix(currentPendingCustomerId)
                  if (strippedCustomer && strippedCustomer !== currentPendingCustomerId) {
                      clearPayload.customer_id = strippedCustomer
                  }
                  await safeUpdateRow("pending_orders", currentPendingId, clearPayload)
                  // Update notification status to 'paid'
                  await markCustomerNotificationPaid(currentPendingId, "pending_orders")
                  
                  // Notify customer: title: "Payment Confirmed", message: "Your order is now fully paid.", status_color: GREEN
                  await upsertCustomerNotification({
                      customerId: strippedCustomer || currentPendingCustomerId,
                      orderId: currentPendingId,
                      sourceTable: "pending_orders",
                      message: "Your order is now fully paid."
                  });
              } catch (e) {
                  console.warn("[System Log] Failed clearing insufficient flag:", e)
              }
              currentInsufficientDue = 0
          }
          await logStaffAction('Kiosk payment completed', `order:${currentPendingId} total:${total.toFixed(2)} method:${currentPaymentMethod}`)
          showMessage("Payment processed! Order marked as PAID.", "success")
          receiptOrderNumber = currentPendingBooking?.order_number || String(currentPendingId).slice(-4)
      } else {
          await logStaffAction('Walk-in payment completed', `total:${total.toFixed(2)} method:${currentPaymentMethod}`)
          showMessage("Order completed!", "success")
      }

      // Print receipt
      console.log("[System Log] Generating Receipt...")
      const tenderFloat = isNaN(tender) ? total : tender
      openReceiptWindow(currentOrder, total, tenderFloat, discountAmount, receiptOrderNumber)
      console.log("[System Log] Transaction Complete. Clearing order.")
      window.clearOrder()

  } catch (err) {
      console.error("[System Log] Critical Error completing order:", err)
      showMessage("Failed to complete order: " + err.message, "error")
  }
}

window.clearOrder = () => {
  currentOrder = []
  currentLoyaltyCustomer = null
  currentPendingId = null
  currentPendingSource = null
  currentPendingBooking = null
  currentPendingCustomerId = null
  currentPaymentMethod = "cash"
  currentProofUrl = null
  discountCount = 0
  document.getElementById("custId").value = ""
  document.getElementById("tender").value = ""
  document.getElementById("exchange").textContent = "0.00"
  const remarkEl = document.getElementById("cashierRemark")
  if (remarkEl) remarkEl.value = ""
  document.getElementById("loyaltyInfoSection").style.display = "none"
  
  const pmDisplay = document.getElementById("paymentMethodDisplay")
  if (pmDisplay) pmDisplay.style.display = "none"
  
  if (document.getElementById("vatAmountDisplay")) document.getElementById("vatAmountDisplay").textContent = "0.00"
  if (document.getElementById("subtotalAmountDisplay")) document.getElementById("subtotalAmountDisplay").textContent = "0.00"

  updateOrderDisplay()
}

// Receipt
function openReceiptWindow(order, total, tender, discountAmount = 0, orderNumber = null) {
  const receiptWin = window.open("", "_blank", "width=400,height=600")
  const fallbackClaimNo = `W${Date.now().toString().slice(-6)}`
  const claimOrderNo = String(orderNumber || fallbackClaimNo)
  const orderNumStr = `ORDER #${claimOrderNo}`
  let content = `<pre style="font-family:monospace;">
==========TORI CAFETERIA==============
${orderNumStr.padStart(37, ' ')}
QTY  PRODUCT             PRICE
-------------------------------------
`
  order.forEach((item) => {
    const price = Number(item.price || 0)
    // Support both 'qty' (POS) and 'quantity' (Kiosk) property names, ensure it's a valid number
    const itemQty = Number(item.qty !== undefined ? item.qty : (item.quantity !== undefined ? item.quantity : 1)) || 1
    const qty = String(itemQty).padEnd(4, ' ')
    // Truncate name to 18 chars to fit
    const name = (item.name || "").substring(0, 18).padEnd(19, ' ')
    const p = "\u20B1" + price.toFixed(2)
    content += `${qty} ${name} ${p.padStart(9, ' ')}\n`
  })
  const exchange = Math.max(tender - total, 0)
  const subtotal = total / 1.12
  const vatAmount = total - subtotal

  content += `
-------------------------------------
Subtotal: \u20B1${subtotal.toFixed(2).padStart(9, ' ')}`

  if (discountAmount > 0) {
    content += `
Discount: \u20B1${discountAmount.toFixed(2).padStart(9, ' ')}`
  }

  content += `
VAT (12%):\u20B1${vatAmount.toFixed(2).padStart(9, ' ')}
Total:    \u20B1${total.toFixed(2).padStart(9, ' ')}
Tender:   \u20B1${tender.toFixed(2).padStart(9, ' ')}
Exchange: \u20B1${exchange.toFixed(2).padStart(9, ' ')}
Claim No: ${claimOrderNo}
=====================================
</pre>`
  receiptWin.document.write(content)
  receiptWin.document.close()
  receiptWin.print()
}

function showMessage(msg, type) {
  const container = document.getElementById("statusMessage")
  container.innerHTML = `<div class="${type}">${msg}</div>`
  setTimeout(() => (container.innerHTML = ""), 2500)
}

const repaymentToastSeen = new Set()

function showCashierToast(message, variant = "success") {
  const body = document.body
  if (!body) return
  let container = document.getElementById("cashierToastContainer")
  if (!container) {
    container = document.createElement("div")
    container.id = "cashierToastContainer"
    body.appendChild(container)
  }
  const toast = document.createElement("div")
  toast.className = `cashier-toast ${variant}`
  toast.textContent = message
  container.appendChild(toast)
  setTimeout(() => {
    toast.classList.add("hide")
    setTimeout(() => toast.remove(), 300)
  }, 3500)
}

function maybeToastRepayment(payload, sourceTable) {
  try {
    if (!payload || payload.eventType !== "UPDATE") return
    const order = payload.new || payload.record || payload
    if (!order || !order.id) return
    
    const key = `${sourceTable || "orders"}:${order.id}:${order.updated_at || order.created_at || ""}`
    if (repaymentToastSeen.has(key)) return

    // Case 1: Manual repayment (legacy/auto-complete)
    const notesText = String(order.insufficient_notes || order.notes || "")
    if (/repayment completed/i.test(notesText) && Number(order.insufficient_amount_needed || 0) <= 0) {
      repaymentToastSeen.add(key)
      showCashierToast(`Customer completed remaining payment for Order #${order.id}.`, "success")
      return
    }

    // Case 2: Second payment submitted for verification
    if (order.second_payment_status === 'pending_verification') {
      repaymentToastSeen.add(key)
      showCashierToast(`Action Needed: Verify 2nd Payment for Order #${order.id}.`, "info")
      notifyNewKioskOrder() // Play sound
      return
    }
  } catch (e) {
    console.warn("[v0] Repayment toast check failed:", e?.message || e)
  }
}

function showTab(tabName, evt) {
  document.querySelectorAll(".tab-content").forEach((t) => (t.style.display = "none"))
  const tabEl = document.getElementById(tabName + "-tab")
  
  if (tabName === "orders") {
    if (tabEl) tabEl.style.display = "flex"
  } else {
    if (tabEl) tabEl.style.display = "block"
  }

  document.querySelectorAll(".tab-button").forEach((b) => b.classList.remove("active"))
  if (evt && evt.target) evt.target.classList.add("active")

  if (tabName === "kiosk") {
    kioskNewCount = 0
    const badge = document.getElementById("kioskNewBadge")
    if (badge) {
      badge.textContent = "0"
      badge.style.display = "none"
    }
    updateCashierBell()
    loadKioskOrders()
    subscribeToKioskOrders()
  } else if (tabName === "preorders") {
    preorderNewCount = 0
    const badge = document.getElementById("preorderNewBadge")
    if (badge) {
      badge.textContent = "0"
      badge.style.display = "none"
    }
    updateCashierBell()
    loadPreorders()
    subscribeToPreorders()
  }
}

// Initialize
document.addEventListener("DOMContentLoaded", () => {
  const checkDb = () => {
    if (typeof window.db !== "undefined") {
        console.log("DB Ready, initializing cashier...")
        db = window.db
        loadMenu()
        showTab("orders", null)
        updateCashierBell()
        subscribeToRedemptions()
        subscribeToKioskOrders()
        subscribeToPreorders()
        subscribeToCashierProductsRealtime()
        startCashierAutoRefresh()
        attachCashierVisibilityRefresh()
    } else {
        console.log("Waiting for DB...")
        setTimeout(checkDb, 500)
    }
  }
  checkDb()
  console.log("DOM content loaded, PAY NOW button exists:", !!document.querySelector('button[onclick="completeOrder()"]'))
})

// --- Redemption Requests ---
let redemptionUnsub = null
function subscribeToRedemptions() {
  const list = document.getElementById("redemptionRequestsList")
  if (!list) return

  if (redemptionUnsub) {
      if (typeof redemptionUnsub.unsubscribe === 'function') redemptionUnsub.unsubscribe()
      redemptionUnsub = null
  }

  // Initial load
  loadRedemptions(list)

  // Realtime
  redemptionUnsub = getDB().channel('pending-redemptions')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'pending_orders', filter: "type=eq.redemption" }, 
    () => {
        loadRedemptions(list)
    })
    .subscribe()
}

async function loadRedemptions(list) {
    if (!list) list = document.getElementById("redemptionRequestsList")
    if (!list) return

    const { data: redemptionDocs, error } = await getDB().from("pending_orders")
        .select("*")
        .eq("status", "pending")
        .eq("type", "redemption")
        .order("timestamp", { ascending: true })
    
    if (error) {
        console.error("Error loading redemptions:", error)
        return
    }

    // Update pulse icon visibility based on requests
    const pulseIcon = document.getElementById("redemptionPulse")
    if (pulseIcon) {
      pulseIcon.style.display = (redemptionDocs && redemptionDocs.length > 0) ? "inline-block" : "none"
    }

    if (!redemptionDocs || redemptionDocs.length === 0) {
        list.innerHTML = '<div class="redemption-empty">No pending requests</div>'
        return
    }

    list.innerHTML = ""
    redemptionDocs.forEach((d) => {
        const div = document.createElement("div")
        div.className = "redemption-item"
        
        let drinkInfo = ""
        if (d.items) {
            try {
                const items = typeof d.items === 'string' ? JSON.parse(d.items) : d.items
                if (Array.isArray(items) && items.length > 0) {
                    const drink = items[0]
                    drinkInfo = `<div style="font-weight: bold; color: var(--accent-warm); margin-top: 5px;">Drink: ${drink.name} (16oz)</div>`
                }
            } catch (e) {
                console.error("Error parsing redemption items", e)
            }
        }

        div.innerHTML = `
          <div class="cust-name">${d.customer_name || "Customer"}</div>
          <div class="cust-id">ID: ${d.loyalty_card || "--"}</div>
          ${drinkInfo}
          <div class="redemption-actions">
            <button class="btn-redemption confirm" onclick="confirmRedemption('${d.id}', '${d.customer_id}')">Confirm</button>
            <button class="btn-redemption reject" onclick="rejectRedemption('${d.id}')">Reject</button>
          </div>
        `
        list.appendChild(div)
    })
}

window.confirmRedemption = async (reqId, customerId) => {
  if (!reqId || !customerId || customerId === "undefined" || customerId === "null") {
     showMessage("Error: Invalid customer data", "error")
     return
  }
  
  try {
      // 1. Update request status to 'preparing' to send it directly to the kitchen
      const { error: reqError } = await getDB().from("pending_orders")
        .update({ status: "preparing", confirmedAt: new Date() })
        .eq("id", reqId)
      if (reqError) throw reqError

      // 2. Deduct points
      const { data: custData, error: custFetchError } = await getDB().from("customers")
        .select("loyalty_points")
        .eq("contact", customerId)
        .single()
        
      if (custFetchError) {
          console.error("Failed to find customer to deduct points:", custFetchError);
          throw new Error("Customer not found for point deduction.");
      }
      
      const newPoints = Math.max(0, (custData.loyalty_points || 0) - 10)
      
      const { error: updateError } = await getDB().from("customers")
        .update({ loyalty_points: newPoints })
        .eq("contact", customerId)
      
      if (updateError) throw updateError

      // 3. Log history
      await getDB().from("loyalty_history").insert({
        customer_id: customerId,
        points: -10,
        source: "redemption",
        requestId: reqId,
        timestamp: new Date()
      })
      
      // 4. Show success and refresh the list
      showMessage("Redemption sent to kitchen!", "success")
      loadRedemptions() // Refresh the sidebar
      
  } catch (err) {
      console.error("Confirmation failed:", err)
      showMessage("Failed to confirm redemption: " + (err.message || "Unknown error"), "error")
  }
}

window.rejectRedemption = async (reqId) => {
  // No confirmation pop-up
  try {
      const { error } = await getDB().from("pending_orders").update({
        status: "rejected",
        rejectedAt: new Date()
      }).eq("id", reqId)
      if (error) throw error
      showMessage("Redemption rejected", "info")
      loadRedemptions(document.getElementById("redemptionRequestsList")) // Force refresh
  } catch (err) {
      console.error("Rejection failed:", err)
      showMessage("Failed to reject", "error")
  }
}

// --- Kiosk Orders ---
let knownOrderIds = new Set()
let isFirstLoad = true

async function recordKioskSale(data) {
    if (!data) return;
    const orderId = data.id;
    const isPreorder = (data.source === 'bookings' || data.type === 'preorder');
    
    // Check if already in sales to avoid double counting
    const query = getDB().from("sales").select("id");
    if (isPreorder) query.eq("booking_id", orderId);
    else query.eq("id", orderId);
    
    const { data: existingSales } = await query;
    if (existingSales && existingSales.length > 0) {
        console.log("[System Log] Transaction already in Sales:", orderId);
        return;
    }

    const items = (typeof data.items === 'string' ? JSON.parse(data.items) : data.items || []).map(i => {
        const unitPrice = Number(i.price || 0) || (Number(i.amount || 0) / Number(i.quantity || i.qty || 1)) || 0;
        const qty = Number(i.quantity || i.qty || 1);
        return {
            id: i.id || i.product_id || "",
            name: i.name || "Unknown",
            category_id: i.category_id || null,
            quantity: qty,
            price: unitPrice,
            amount: unitPrice * qty
        };
    });
    
    const dateStr = new Date().toISOString().slice(0, 10);
    let totalOrderAmount = Number(data.finalTotal !== undefined ? data.finalTotal : (data.total || 0));
    
    // Fallback: Calculate total from items if it's 0 or missing
    if (totalOrderAmount === 0 && items.length > 0) {
        totalOrderAmount = items.reduce((sum, item) => sum + item.amount, 0);
        console.log("[System Log] Calculated total from items:", totalOrderAmount);
    }

    const discount = Number(data.discount || 0);
    const amountNeeded = getInsufficientAmount(data);
    const actualPaidAmount = Math.max(0, totalOrderAmount - amountNeeded);

    const sess = typeof getStaffSession === 'function' ? getStaffSession() : null;
    const itemCount = items.reduce((sum, i) => sum + Number(i.quantity || 0), 0);
    const sourceLabel = isPreorder ? "preorder" : "kiosk";
    
    const cashierRemark = composeCashierRemark({
      source: sourceLabel,
      paymentMethod: data.payment_method || "online",
      itemCount,
      total: actualPaidAmount,
      discount,
      insufficient: (data.insufficient_payment === true || amountNeeded > 0)
    });
    
    const salesPayload = {
        items: JSON.stringify(items),
        total: actualPaidAmount,
        amount: actualPaidAmount,
        timestamp: new Date().toISOString(),
        sale_date: new Date().toISOString(),
        date: dateStr,
        payment_method: data.payment_method || 'online',
        status: 'completed',
        type: isPreorder ? 'preorder' : 'kiosk_order',
        insufficient_payment: (data.insufficient_payment === true || amountNeeded > 0),
        total_order_amount: totalOrderAmount,
        amount_due: amountNeeded,
        ...(sess && { cashier_id: sess.id, cashier_name: sess.full_name }),
        ...(cashierRemark ? { cashier_remarks: cashierRemark } : {})
    };
    
    if (isPreorder) {
        salesPayload.booking_id = String(orderId);
    } else {
        salesPayload.id = String(orderId);
    }
    
    const tryInsert = async (payload) => {
        const { error } = await getDB().from("sales").insert(payload);
        return error || null;
    };
    
    let currentPayload = { ...salesPayload };
    let err = await tryInsert(currentPayload);
    let attempt = 0;
    while (err && attempt < 10) {
        const msg = String(err.message || "");
        let removedField = false;
        const columns = ['discount', 'items', 'total', 'timestamp', 'date', 'amount', 'sale_date', 'payment_method', 'status', 'type', 'booking_id', 'insufficient_payment', 'total_order_amount', 'amount_due', 'cashier_remarks'];
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
        err = await tryInsert(currentPayload);
        attempt++;
    }
    
    if (!err) console.log("[System Log] Kiosk Sales Record Success");
    else console.error("[System Log] Kiosk Sales Record Failed:", err);
}

window.updateKioskStatus = async (orderId, status, btn = null) => {
  let oldText = "";
  if (btn) {
      btn.disabled = true;
      oldText = btn.innerHTML;
      btn.innerHTML = '<span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span>';
  }

  try {
      const { data: orderData } = await getDB().from("pending_orders").select("*").eq("id", orderId).single()
      
      // Normalize status casing to avoid DB check/enums rejecting uppercase values.
      const normalizedStatus = String(status || "").toLowerCase()
      const updatePayload = { status: normalizedStatus }
      if (["completed", "rejected", "cancelled"].includes(normalizedStatus)) {
          updatePayload.archived = true
          updatePayload.archived_at = new Date().toISOString()
      }

      // Handle "accept" semantics (accepted/preparing)
      if (normalizedStatus === 'accepted' || normalizedStatus === 'preparing') {
          updatePayload.status = normalizedStatus
          // Notify customer
          await upsertCustomerNotification({
              customerId: orderData.customer_id,
              orderId: orderId,
              sourceTable: "pending_orders",
              message: "Your order is now being prepared."
          });
          
          // Record sale if it was pending
          if (orderData && orderData.status === 'pending') {
              await recordKioskSale(orderData);
          }
      }

      // Handle REJECTED status
      if (normalizedStatus === 'rejected') {
          const reason = askRejectReason()
          if (!reason) {
              showMessage("Rejection reason is required.", "error")
              if (btn) {
                  btn.disabled = false;
                  btn.innerHTML = oldText;
              }
              return
          }
          updatePayload.status = 'rejected'
          updatePayload.rejection_reason = reason
          updatePayload.notes = reason
          // Notify customer
          await upsertCustomerNotification({
              customerId: orderData.customer_id,
              orderId: orderId,
              sourceTable: "pending_orders",
              message: `Your order has been declined: ${reason}`
          });
      }

      // AUTO-CONFIRM SECOND PAYMENT IF ACCEPTING (Legacy support for 'preparing')
      if ((normalizedStatus === 'accepted' || normalizedStatus === 'preparing') && orderData && orderData.second_payment_status === 'pending_verification') {
          updatePayload.insufficient_payment = false
          updatePayload.insufficient_amount_needed = 0
          updatePayload.second_payment_status = "verified"
          
          if (orderData.customer_id) {
              const stripped = stripInsufficientPrefix(orderData.customer_id)
              if (stripped !== orderData.customer_id) {
                  updatePayload.customer_id = stripped
              }
          }
          await markCustomerNotificationPaid(orderId, "pending_orders")
      }

      // NEW: Record online kiosk orders in sales when accepted (status moving to preparing)
      if (normalizedStatus === 'preparing' && orderData && orderData.payment_method === 'online' && orderData.status === 'pending') {
          console.log("[System Log] Recording Online Kiosk Order in Sales (Accepted):", orderId)
          await recordKioskSale(orderData)
          
          // AUTO-PRINT RECEIPT for online orders upon acceptance
          try {
              const items = typeof orderData.items === 'string' ? JSON.parse(orderData.items) : (orderData.items || [])
              const total = Number(orderData.finalTotal || orderData.total || 0)
              const discount = Number(orderData.discount || 0)
              const orderNum = orderData.order_number || String(orderData.id).slice(-4)
              console.log("[System Log] Printing receipt for Online Kiosk Order:", orderNum)
              openReceiptWindow(items, total, total, discount, orderNum)
          } catch (printErr) {
              console.warn("[System Log] Auto-print failed:", printErr)
          }
      }

      if (normalizedStatus === 'completed') {
          // Fetch order details
          const data = orderData; // Reuse fetched data
          if (!data) throw new Error("Order not found")
          
          const items = (typeof data.items === 'string' ? JSON.parse(data.items) : data.items || []).map(i => ({
              id: i.id || i.product_id || "",
              name: i.name || "Unknown",
              category_id: i.category_id,
              quantity: Number(i.quantity || i.qty || 1),
              amount: (Number(i.price || 0) || (Number(i.amount || 0) / Number(i.quantity || i.qty || 1))) * (Number(i.quantity || i.qty || 1))
          }))
          
          const amountNeeded = getInsufficientAmount(data)
          const totalOrderAmount = Number(data.finalTotal !== undefined ? data.finalTotal : (data.total || 0))
          const actualPaidAmount = Math.max(0, totalOrderAmount - amountNeeded)

          // NEW: Ensure ALL completed orders are recorded in Sales if they weren't already
          await recordKioskSale(data)

          // Add to Orders History (for Customer View)
          const orderTimestamp = new Date()
          const ordersPayload = items.map(item => ({
              customer_id: data.customer_id || "Guest",
              product_id: item.id,
              name: item.name,
              quantity: item.quantity,
              price: item.quantity > 0 ? item.amount / item.quantity : 0, // derived unit price
              category_id: item.category_id || null,
              timestamp: orderTimestamp,
              payment_method: data.payment_method || 'online',
              status: 'completed'
          }))
          
          try {
             await getDB().from("orders").insert(ordersPayload)
          } catch (historyError) {
             console.error("Error adding to order history:", historyError)
          }
          
          // Award Points
          let custId = null
          if (data.loyalty_card) {
              const cleanCard = String(data.loyalty_card).trim()
              const { data: c } = await getDB().from("customers").select("id, loyalty_points, loyalty_card").eq("loyalty_card", cleanCard).maybeSingle()
              if (c) custId = c
          } else if (data.customer_id && data.customer_id.includes('@')) {
              const cleanEmail = String(data.customer_id).trim()
              const { data: c } = await getDB().from("customers").select("id, loyalty_points, loyalty_card").eq("email", cleanEmail).maybeSingle()
              if (c) custId = c
          }

          if (custId) {
             const points = 1
             const newPoints = (custId.loyalty_points || 0) + points
             console.log("[System Log] Awarding Kiosk Points:", points, "to Customer:", custId.id)
             await getDB().from("customers").update({ loyalty_points: newPoints }).eq("id", custId.id)
             await getDB().from("loyalty_history").insert({
                 customer_id: custId.id,
                 loyalty_card: custId.loyalty_card,
                 points: points,
                 source: "kiosk_order",
                 order_id: orderId,
                 total: actualPaidAmount,
                 timestamp: new Date()
             })
          } else {
             console.log("[System Log] No loyalty customer found for kiosk order:", data.loyalty_card || data.customer_id)
          }
          
          await safeUpdateRow("pending_orders", orderId, updatePayload)
          
      } else {
          await safeUpdateRow("pending_orders", orderId, updatePayload)
      }

      loadKioskOrders()
      await logStaffAction('Kiosk order status', `order:${orderId} status:${status}`)
      showMessage(`Order marked as ${status}!`, "success")
  } catch (err) {
      console.error("Error updating status:", err)
      showMessage("Error updating status: " + (err.message || "Unknown error"), "error")
      if (btn) {
          btn.disabled = false;
          btn.innerHTML = oldText;
      }
  }
}

window.rejectKioskOrder = async (orderId, btn = null) => {
    return window.updateKioskStatus(orderId, "rejected", btn)
}

function subscribeToKioskOrders() {
  if (kioskUnsub) {
      if (typeof kioskUnsub.unsubscribe === 'function') kioskUnsub.unsubscribe()
      kioskUnsub = null
  }
  
  console.log("[v0] Subscribing to pending_orders channel (Broad Filter)...")
  
  // Broadened filter: Listen to ALL events on pending_orders table
  kioskUnsub = getDB().channel('pending-orders-kiosk-v2')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'pending_orders' }, 
    (payload) => {
        console.log("[v0] Realtime event received:", payload)
        maybeToastRepayment(payload, "pending_orders")
        loadKioskOrders() 
    })
    .subscribe((status) => {
        console.log("[v0] Subscription status:", status)
    })
    
    // Polling Fallback: Ensures updates even if realtime fails
    // Runs every 5 seconds
    if (!window.kioskPollInterval) {
        window.kioskPollInterval = setInterval(() => {
            loadKioskOrders(true) 
        }, CASHIER_POLL_MS)
    }
}

// Modify loadKioskOrders to check for new items during polling/realtime
function loadKioskOrders(isPolling = false) {
  // Check for Kanban board columns - NEW LAYOUT: Cash, Online, Insufficient Payment
  const colPayment = document.getElementById("col-payment") // Cash orders
  const colOnline = document.getElementById("col-online-pending") // Online orders (QR/Receipt)
  const colInsufficient = document.getElementById("col-insufficient") // Insufficient payment
  
  // If board doesn't exist, try list (legacy fallback)
  if (!colPayment) {
      const list = document.getElementById("kioskOrdersList")
      if (!list) return // No UI to update
      return
  }

  getDB().from("pending_orders")
    .select("*")
    .neq("type", "redemption") // Kiosk board only shows orders, not redemptions
    .in("status", ["pending", "ACCEPTED", "INSUFFICIENT", "preparing", "ready", "accepted", "insufficient"]) // Include all active statuses
    .order("created_at", { ascending: true })
    .then(({ data, error }) => {
      if (error) throw error
      
      const orders = data || []
      
      // Clear columns to rebuild (simplest way to ensure consistency)
      if (colPayment) colPayment.innerHTML = ""
      if (colOnline) colOnline.innerHTML = ""
      if (colInsufficient) colInsufficient.innerHTML = ""
      
      const counts = { cash: 0, online: 0, insufficient: 0 }
      let hasNewPending = false
      
      const countCash = document.getElementById("count-payment")
      const countOnline = document.getElementById("count-online-pending")
      const countInsufficient = document.getElementById("count-insufficient")

      orders.forEach((order) => {
        const card = createOrderCard(order)
        const isActuallyInsufficient = (o) => {
            try {
                const s = String(o.status || "").toLowerCase();
                if (s === 'insufficient') return true;
                if (o.insufficient_payment === true || o.insufficient_payment === 1 || String(o.insufficient_payment).toLowerCase() === 'true') return true;
                return Math.max(0, getRemainingDue(o)) > 0
            } catch (_) {
                return false
            }
        }
        
        const isRepaymentPending = order.second_payment_status === 'pending_verification';

        const shouldNotifyNew = order.status === 'pending' && !isActuallyInsufficient(order)
        if (shouldNotifyNew && !knownOrderIds.has(order.id)) {
            if (!isFirstLoad) hasNewPending = true
        }
        knownOrderIds.add(order.id)
        
        // Separate by payment method and insufficient payment status
        if (isRepaymentPending) {
            // MOVE TO ONLINE ORDERS COLUMN FOR VERIFICATION
            if (colOnline) colOnline.appendChild(card)
            counts.online++
        } else if (isActuallyInsufficient(order)) {
            // Insufficient payment orders (Still waiting for customer)
            if (colInsufficient) colInsufficient.appendChild(card)
            counts.insufficient++
        } else if (order.status.toLowerCase() !== 'pending' && order.status.toLowerCase() !== 'accepted') {
            // Ignore non-pending orders unless insufficient
            return
        } else if (order.payment_method === 'online') {
            // Online orders (New)
            if (colOnline) colOnline.appendChild(card)
            counts.online++
        } else {
            // Cash orders (New)
            if (colPayment) colPayment.appendChild(card)
            counts.cash++
        }
      })

      if (countCash) countCash.textContent = counts.cash
      if (countOnline) countOnline.textContent = counts.online
      if (countInsufficient) countInsufficient.textContent = counts.insufficient

      // Add empty states if columns are empty
      if (counts.cash === 0 && colPayment) {
          colPayment.innerHTML = `<div class="empty-state"><i class="fa-solid fa-inbox"></i><p>No active cash orders</p></div>`
      }
      if (counts.online === 0 && colOnline) {
          colOnline.innerHTML = `<div class="empty-state"><i class="fa-solid fa-inbox"></i><p>No active online orders</p></div>`
      }
      if (counts.insufficient === 0 && colInsufficient) {
          colInsufficient.innerHTML = `<div class="empty-state"><i class="fa-solid fa-inbox"></i><p>No insufficient payment orders</p></div>`
      }

      // Notify if new pending orders found
      if (hasNewPending) {
          notifyNewKioskOrder()
      }
      isFirstLoad = false
    })
    .catch((err) => {
      console.error("Error loading kiosk orders:", err)
      if (!isPolling) showMessage("Error loading kiosk orders", "error")
    })
}

let isDiscount20 = false

window.toggleDiscount20 = () => {
    if (currentPaymentMethod === 'online') {
        showMessage("Discounts are not allowed for online payments", "error")
        return
    }
    discountCount += 1
    const btn = document.getElementById("discount20Btn")
    if (btn) {
        btn.classList.add("active")
        setTimeout(() => btn.classList.remove("active"), 220)
    }
    updateOrderDisplay()
}

window.printPendingReceipt = async (orderId) => {
    try {
        const { data, error } = await getDB().from("pending_orders").select("*").eq("id", orderId).single()
        if (error || !data) throw error || new Error("Order not found")
        const items = typeof data.items === 'string' ? JSON.parse(data.items) : (data.items || [])
        const total = Number(data.finalTotal || data.total || 0)
        const discount = Number(data.discount || 0)
        const orderNum = data.order_number || String(data.id).slice(-4)
        openReceiptWindow(items, total, total, discount, orderNum)
    } catch (_) {
        showMessage("Unable to print receipt.", "error")
    }
}

window.printPreorderReceipt = async (bookingId) => {
    try {
        const { data, error } = await getDB().from("bookings").select("*").eq("id", bookingId).single()
        if (error || !data) throw error || new Error("Pre-order not found")
        const items = typeof data.items === 'string' ? JSON.parse(data.items) : (data.items || [])
        const total = Number(data.finalTotal || data.total || 0)
        const discount = Number(data.discount || 0)
        const orderNum = data.order_number ? `B${data.order_number}` : `B${String(data.id).slice(-4)}`
        openReceiptWindow(items, total, total, discount, orderNum)
    } catch (_) {
        showMessage("Unable to print receipt.", "error")
    }
}

function createOrderCard(order) {
    const div = document.createElement("div")
    div.className = "kanban-card"
    const total = Number(order.finalTotal || order.total || 0).toFixed(2)
    const items = typeof order.items === 'string' ? JSON.parse(order.items) : (order.items || [])
    const itemCount = items.reduce((s, i) => s + (Number(i.quantity) || Number(i.qty) || 0), 0)
    
    // Handle timestamp safely
    let time = "Unknown"
    if (order.created_at) {
        try {
            time = new Date(order.created_at).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})
        } catch(e) {}
    } else if (order.timestamp) {
        try {
            time = new Date(order.timestamp).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})
        } catch(e) {}
    }
    
    let paymentInfo = ""
    if (order.payment_method === 'online') {
        const proofUrl = order.proof_of_payment || ""
        const secondProofUrl = order.second_payment_proof || ""
        
        paymentInfo = `<div class="payment-info" style="font-size: 0.85em; color: #74512D; margin-top: 4px;">
            Payment: Online 
            ${proofUrl ? `<a href="${proofUrl}" target="_blank" style="text-decoration: underline; color: inherit; font-weight: bold;">(View Receipt)</a>` : '(No Receipt)'}
            ${secondProofUrl ? `<br><span style="color: #543310; font-weight: bold;">2nd Payment:</span> <a href="${secondProofUrl}" target="_blank" style="text-decoration: underline; color: #543310; font-weight: bold;">(View Receipt)</a>` : ''}
        </div>`
    } else {
        const secondProofUrl = order.second_payment_proof || ""
        paymentInfo = `<div class="payment-info" style="font-size: 0.85em; color: #74512D; margin-top: 4px;">
            Payment: Cash
            ${secondProofUrl ? `<br><span style="color: #543310; font-weight: bold;">2nd Payment:</span> <a href="${secondProofUrl}" target="_blank" style="text-decoration: underline; color: #543310; font-weight: bold;">(View Receipt)</a>` : ''}
        </div>`
    }

    // NEW: Insufficient Payment Display
    let insufficientDisplay = ""
    const stillNeededAmount = getRemainingDue(order)
    if (stillNeededAmount > 0) {
        const stillNeeded = stillNeededAmount.toFixed(2)
        const notes = order.insufficient_notes || "No notes provided"
        insufficientDisplay = `
            <div class="insufficient-alert" style="margin-top: 8px; padding: 8px; background: #AF8F6F; border-left: 4px solid #74512D; border-radius: 4px; font-size: 0.85em;">
                <div style="color: #543310; font-weight: bold;">⚠️ INSUFFICIENT PAYMENT</div>
                <div style="color: #543310; margin-top: 2px;">Still Need: <strong>₱${stillNeeded}</strong></div>
                <div style="color: #543310; font-style: italic; margin-top: 2px;">"${notes}"</div>
            </div>
        `
    }

    // NEW: Repayment Pending Badge
    let repaymentBadge = ""
    if (order.second_payment_status === 'pending_verification') {
        repaymentBadge = `<div style="background: #AF8F6F; color: #543310; padding: 4px 8px; border-radius: 4px; font-size: 0.75rem; font-weight: bold; margin-bottom: 8px; display: inline-block; border: 1px solid #74512D;">🔄 2ND PAYMENT PENDING VERIFICATION</div>`
    }

    const orderNum = order.order_number ? `#${order.order_number}` : `#${String(order.id).slice(-4)}`

    div.innerHTML = `
        <div class="card-header">
            <span class="order-id" title="Order ID: ${order.id}">${orderNum}</span>
            <span class="order-time">${time}</span>
        </div>
        ${repaymentBadge}
        <div class="card-customer">${order.customer_id || "Guest"}</div>
        <div class="card-summary">${itemCount} items • <span style="font-weight: 800; color: #543310;">₱${total}</span></div>
        ${paymentInfo}
        ${insufficientDisplay}
        <div class="card-actions"></div>
    `
    
    const actionsContainer = div.querySelector(".card-actions")

    const isInsufficientOrder = (() => {
        try {
            return Math.max(0, getRemainingDue(order)) > 0
        } catch (_) {
            return false
        }
    })()

        if (isInsufficientOrder) {
        if (order.second_payment_status === 'pending_verification') {
            const btnAccept = document.createElement("button")
            btnAccept.className = "btn-action"
            btnAccept.style.backgroundColor = "#74512D"
            btnAccept.style.color = "white"
            btnAccept.textContent = "Accept & Verify"
            // Move to kitchen (preparing) after verifying online repayment
            btnAccept.onclick = () => window.updateKioskStatus(order.id, 'accepted', btnAccept)
            actionsContainer.appendChild(btnAccept)
            
            const btnView = document.createElement("button")
            btnView.className = "btn-action"
            btnView.style.marginLeft = "5px"
            btnView.textContent = "🔍 View Receipt"
            btnView.onclick = () => window.verifySecondPayment(order.id, 'pending_orders', btnView)
            actionsContainer.appendChild(btnView)
            const btnPrint = document.createElement("button")
            btnPrint.className = "btn-action btn-secondary"
            btnPrint.style.marginLeft = "5px"
            btnPrint.textContent = "Print Receipt"
            btnPrint.onclick = () => window.printPendingReceipt(order.id)
            actionsContainer.appendChild(btnPrint)
        } else {
            const btnLoad = document.createElement("button")
            btnLoad.className = "btn-action primary"
            btnLoad.textContent = "Load to POS"
            btnLoad.onclick = () => window.loadPendingOrder(order.id, btnLoad)
            actionsContainer.appendChild(btnLoad)
            const btnPrint = document.createElement("button")
            btnPrint.className = "btn-action btn-secondary"
            btnPrint.style.marginLeft = "5px"
            btnPrint.textContent = "Print Receipt"
            btnPrint.onclick = () => window.printPendingReceipt(order.id)
            actionsContainer.appendChild(btnPrint)
        }
        } else if (order.status === 'pending' || order.status === 'ACCEPTED' || order.status === 'accepted' || order.status === 'preparing' || order.status === 'ready') {
        if (order.payment_method === 'online') {
            // ACCEPT Button
            const btnAccept = document.createElement("button")
            btnAccept.className = "btn-action"
            btnAccept.style.backgroundColor = "#74512D"
            btnAccept.style.color = "white"
            btnAccept.textContent = "ACCEPT"
            btnAccept.style.fontWeight = "bold"
            // Accept online payment then send to kitchen (removes from Online column)
            btnAccept.onclick = () => window.updateKioskStatus(order.id, 'accepted', btnAccept)
            actionsContainer.appendChild(btnAccept)

            // INSUFFICIENT AMT Button
            const btnInsufficient = document.createElement("button")
            btnInsufficient.className = "btn-action"
            btnInsufficient.style.backgroundColor = "#967658"
            btnInsufficient.style.color = "white"
            btnInsufficient.style.marginLeft = "5px"
            btnInsufficient.style.flex = "1.2"
            btnInsufficient.innerHTML = "⚠️ INSUFFICIENT<br>AMT"
            btnInsufficient.style.fontWeight = "bold"
            btnInsufficient.style.fontSize = "12px"
            btnInsufficient.style.lineHeight = "1.1"
            btnInsufficient.onclick = () => {
                window.openInsufficientPaymentModal({ ...order, _source: "pending_orders" })
            }
            actionsContainer.appendChild(btnInsufficient)

            // REJECT Button
            const btnReject = document.createElement("button")
            btnReject.className = "btn-action"
            btnReject.style.backgroundColor = "#AF8F6F"
            btnReject.style.color = "white"
            btnReject.style.marginLeft = "5px"
            btnReject.textContent = "REJECT"
            btnReject.style.fontWeight = "bold"
            btnReject.onclick = () => window.rejectKioskOrder(order.id, btnReject)
            actionsContainer.appendChild(btnReject)
            const btnPrint = document.createElement("button")
            btnPrint.className = "btn-action btn-secondary"
            btnPrint.style.marginLeft = "5px"
            btnPrint.textContent = "Print Receipt"
            btnPrint.onclick = () => window.printPendingReceipt(order.id)
            actionsContainer.appendChild(btnPrint)
        } else {
            // Cash flow
            if (order.status === 'pending') {
                const btnLoad = document.createElement("button")
                btnLoad.className = "btn-action"
                btnLoad.textContent = "Load to POS"
                btnLoad.onclick = () => window.loadPendingOrder(order.id, btnLoad)
                actionsContainer.appendChild(btnLoad)

                const btnSlip = document.createElement("button")
                btnSlip.className = "btn-action btn-secondary"
                btnSlip.style.backgroundColor = "#967658"
                btnSlip.style.color = "white"
                btnSlip.style.marginLeft = "5px"
                btnSlip.textContent = "Print Slip"
                btnSlip.onclick = () => {
                    const items = typeof order.items === 'string' ? JSON.parse(order.items) : (order.items || [])
                    const orderTotal = Number(order.finalTotal || order.total || 0)
                    const discount = Number(order.discount || 0)
                    openReceiptWindow(items, orderTotal, orderTotal, discount)
                }
                actionsContainer.appendChild(btnSlip)
            } else if (order.status === 'preparing') {
                const btnReady = document.createElement("button")
                btnReady.className = "btn-action"
                btnReady.textContent = "Mark Ready"
                btnReady.onclick = () => window.updateKioskStatus(order.id, 'ready', btnReady)
                actionsContainer.appendChild(btnReady)
                const btnPrint = document.createElement("button")
                btnPrint.className = "btn-action btn-secondary"
                btnPrint.style.marginLeft = "5px"
                btnPrint.textContent = "Print Receipt"
                btnPrint.onclick = () => window.printPendingReceipt(order.id)
                actionsContainer.appendChild(btnPrint)
            } else if (order.status === 'ready') {
                const btnComplete = document.createElement("button")
                btnComplete.className = "btn-action"
                btnComplete.textContent = "Complete"
                btnComplete.onclick = () => window.updateKioskStatus(order.id, 'completed', btnComplete)
                actionsContainer.appendChild(btnComplete)
                const btnPrint = document.createElement("button")
                btnPrint.className = "btn-action btn-secondary"
                btnPrint.style.marginLeft = "5px"
                btnPrint.textContent = "Print Receipt"
                btnPrint.onclick = () => window.printPendingReceipt(order.id)
                actionsContainer.appendChild(btnPrint)
            }
        }
    }
    
    return div
}


function notifyNewKioskOrder() {
  // Play Sound
  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (AudioContext) {
        const ctx = new AudioContext();
        // Resume context if suspended (requires user interaction previously)
        if (ctx.state === 'suspended') {
            ctx.resume().catch(e => console.warn("Audio resume failed:", e));
        }
        
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = "sine";
        o.frequency.value = 880;
        o.connect(g);
        g.connect(ctx.destination);
        g.gain.setValueAtTime(0.001, ctx.currentTime);
        g.gain.exponentialRampToValueAtTime(0.3, ctx.currentTime + 0.1);
        o.start();
        o.stop(ctx.currentTime + 0.3);
    }
  } catch (e) {
      console.warn("Audio playback failed:", e);
  }

  // Update Status Message
  const container = document.getElementById("statusMessage");
  if (container) {
    container.innerHTML = '<div class="success" style="background:#74512D;color:#F8F4E1;padding:10px;border-radius:4px;margin-bottom:10px;">New Kiosk Order Received!</div>';
    setTimeout(() => {
        if (container) container.innerHTML = "";
    }, 3000);
  }

  // Update Badge
  kioskNewCount += 1;
  const badge = document.getElementById("kioskNewBadge");
  if (badge) {
    badge.textContent = String(kioskNewCount);
    badge.style.display = "inline-flex";
  }
  updateCashierBell()
  
  console.log("[v0] New Kiosk Order Notified. Count:", kioskNewCount);
}

window.lookupLoyaltyCard = async () => {
  const custId = document.getElementById("custId").value.trim()
  if (!custId) {
    document.getElementById("loyaltyInfoSection").style.display = "none"
    currentLoyaltyCustomer = null
    return
  }

  try {
      let { data, error } = await getDB().from("customers").select("*").eq("loyalty_card", custId).maybeSingle()
      
      if (!data && custId.includes("@")) {
          const { data: dataEmail } = await getDB().from("customers").select("*").eq("email", custId).maybeSingle()
          data = dataEmail
      }

      if (data) {
        currentLoyaltyCustomer = data
        const points = data.loyalty_points || 0
        document.getElementById("displayLoyaltyCard").textContent = data.loyalty_card || data.email
        document.getElementById("displayLoyaltyPoints").textContent = points
        document.getElementById("loyaltyInfoSection").style.display = "block"
        showMessage("Loyalty card verified!", "success")
        
        // Auto-update input if found by email
        if (data.loyalty_card && document.getElementById("custId").value !== data.loyalty_card) {
            document.getElementById("custId").value = data.loyalty_card
        }
      } else {
        document.getElementById("loyaltyInfoSection").style.display = "none"
        currentLoyaltyCustomer = null
        console.log("No customer found with:", custId)
        showMessage("Loyalty card/User not found", "error")
      }
  } catch (err) {
      console.error("Error looking up loyalty card:", err)
      currentLoyaltyCustomer = null
  }
}

window.loadPendingOrder = async (orderId) => {
    // Fetch from DB to be safe and avoid passing JSON
    showMessage("Loading order...", "info")
    const { data: orderData, error } = await getDB().from("pending_orders").select("*").eq("id", orderId).single()
    
    if (error || !orderData) {
        console.error("Error loading order:", error)
        showMessage("Failed to load order: " + (error?.message || "Not found"), "error")
        return
    }

    currentPendingId = orderId
    currentPendingSource = "pending_orders"
    currentPendingBooking = null
    currentPendingCustomerId = orderData.customer_id || null
    currentOrder = []
    currentInsufficientDue = Math.max(0, getInsufficientAmount(orderData))
    
    // Payment Method Handling
    currentPaymentMethod = orderData.payment_method || "cash"
    if (currentPaymentMethod === 'online') {
        discountCount = 0
        isDiscount20 = false
        const btn = document.getElementById("discount20Btn")
        if (btn) btn.classList.remove("active")
        updateOrderDisplay()
    }
    currentProofUrl = orderData.proof_of_payment || null
    
    const pmDisplay = document.getElementById("paymentMethodDisplay")
    const pmMethod = document.getElementById("pmMethod")
    const pmProof = document.getElementById("pmProof")
    
    if (pmDisplay) {
        if (currentInsufficientDue > 0) {
            pmDisplay.style.display = "block"
            pmMethod.textContent = `Insufficient Online (Due ₱${currentInsufficientDue.toFixed(2)})`
            pmMethod.style.color = "#967658"
            if (currentProofUrl) {
                pmProof.href = currentProofUrl
                pmProof.style.display = "inline"
            } else {
                pmProof.style.display = "none"
            }
            document.getElementById("tender").value = currentInsufficientDue.toFixed(2)
        } else if (currentPaymentMethod === 'online') {
            pmDisplay.style.display = "block"
            pmMethod.textContent = "Online"
            pmMethod.style.color = "#74512D"
            if (currentProofUrl) {
                pmProof.href = currentProofUrl
                pmProof.style.display = "inline"
            } else {
                pmProof.style.display = "none"
            }
            // Auto-fill tender for online orders
            const total = Number(orderData.finalTotal || orderData.total || 0)
            document.getElementById("tender").value = total.toFixed(2)
        } else {
            // For cash, we can optionally show it or hide it. Let's show it for clarity if it's explicitly "cash" from kiosk
            pmDisplay.style.display = "block"
            pmMethod.textContent = "Cash (Pay here)"
            pmMethod.style.color = "#74512D"
            pmProof.style.display = "none"
            document.getElementById("tender").value = ""
        }
    }

    let items = orderData.items
    if (typeof items === 'string') {
        try { items = JSON.parse(items) } catch(e) { console.error("Error parsing items JSON", e) }
    }
    
    if (Array.isArray(items)) {
        items.forEach(i => {
            const baseId = i.id || i.product_id
            currentOrder.push({
                id: baseId,
                productId: baseId,
                name: i.name,
                price: Number(i.price || 0),
                qty: Number(i.quantity || i.qty),
                category_id: i.category_id
            })
        })
    }
    
    updateOrderDisplay()
    updateExchange() // Update exchange since we might have auto-filled tender
    
    if (orderData.loyalty_card || orderData.customer_id) {
        const custId = orderData.loyalty_card || orderData.customer_id
        if (custId && custId !== 'Guest' && custId !== 'walk-in') {
             document.getElementById("custId").value = custId
             window.lookupLoyaltyCard()
        }
    }
    
    showMessage("Pending order loaded. Verify payment if Online.", "info")
    showTab("orders", null)
}

window.loadPreorderToPOS = async (bookingId, btn = null) => {
    let oldText = "";
    if (btn) {
        btn.disabled = true;
        oldText = btn.innerHTML;
        btn.innerHTML = '<span class="spinner-border spinner-border-sm"></span>';
    }
    try {
        showMessage("Loading pre-order...", "info")
        const { data: booking, error } = await getDB().from("bookings").select("*").eq("id", bookingId).single()
        if (error || !booking) {
            console.error("Error loading pre-order:", error)
            showMessage("Failed to load pre-order: " + (error?.message || "Not found"), "error")
            return
        }

        currentPendingId = bookingId
        currentPendingSource = "bookings"
        currentPendingBooking = booking
        currentOrder = []
        currentInsufficientDue = Math.max(0, getInsufficientAmount(booking))

        currentPaymentMethod = booking.payment_method || "cash"
        if (currentPaymentMethod === "online") {
            discountCount = 0
            isDiscount20 = false
            const btn = document.getElementById("discount20Btn")
            if (btn) btn.classList.remove("active")
            updateOrderDisplay()
        }
        currentProofUrl = booking.proof_of_payment || null

        const pmDisplay = document.getElementById("paymentMethodDisplay")
        const pmMethod = document.getElementById("pmMethod")
        const pmProof = document.getElementById("pmProof")
        if (pmDisplay) {
            pmDisplay.style.display = "block"
            if (currentInsufficientDue > 0) {
                pmMethod.textContent = `Pre-order (Insufficient, Due ₱${currentInsufficientDue.toFixed(2)})`
                pmMethod.style.color = "#967658"
            } else if (currentPaymentMethod === "online") {
                pmMethod.textContent = "Pre-order (Online)"
                pmMethod.style.color = "#74512D"
            } else {
                pmMethod.textContent = "Pre-order (Cash)"
                pmMethod.style.color = "#74512D"
            }
            if (currentProofUrl) {
                pmProof.href = currentProofUrl
                pmProof.style.display = "inline"
            } else {
                pmProof.style.display = "none"
            }
        }

        document.getElementById("tender").value = ""

        let items = booking.items
        if (typeof items === "string") {
            try { items = JSON.parse(items) } catch (e) { items = [] }
        }
        if (Array.isArray(items)) {
            items.forEach(i => {
                const baseId = i.id || i.product_id
                currentOrder.push({
                    id: baseId,
                    productId: baseId,
                    name: i.name,
                    price: Number(i.price || 0) || (Number(i.amount || 0) / Math.max(1, Number(i.quantity || i.qty || 1))),
                    qty: Number(i.quantity || i.qty || 1),
                    category_id: i.category_id
                })
            })
        }

        updateOrderDisplay()
        updateExchange()
        
        // Use a small delay to ensure UI transition is smooth
        setTimeout(() => {
            showTab("orders", null)
            showMessage("Pre-order loaded. Enter amount paid.", "info")
        }, 100)
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = oldText;
        }
    }
}

function loadMenuItems() {
  // Placeholder for loadMenuItems function
  console.log("Loading menu items...")
}

function viewKioskOrder(orderId) {
  // Placeholder for viewKioskOrder function
  console.log("Viewing kiosk order:", orderId)
}

// --- Pre-orders (Bookings) ---
let preorderNewCount = 0
let knownPreorderIds = new Set()
let notifiedPreorderIds = new Set()
let isFirstPreorderLoad = true

function isInsufficientBooking(o) {
    try {
        const s = String(o.status || "").toLowerCase();
        if (s === 'insufficient') return true;
        if (o.insufficient_payment === true || o.insufficient_payment === 1 || String(o.insufficient_payment).toLowerCase() === 'true') return true;
        return Math.max(0, getRemainingDue(o)) > 0
    } catch (_) {}
    return false
}

window.loadPreorders = async () => {
    const { data: bookings, error } = await getDB()
        .from("bookings")
        .select("*")
        .eq("type", "preorder")
        .in("status", ["pending", "ACCEPTED", "INSUFFICIENT", "preparing", "ready", "accepted", "insufficient"]) // Include all active statuses
        .order("created_at", { ascending: false })

    if (error) {
        console.error("Error loading preorders:", error)
        return
    }

    // NEW LAYOUT: Separate cash and online
    const colCash = document.getElementById("preorder-col-cash") // Cash pre-orders
    const colOnline = document.getElementById("preorder-col-online") // Online pre-orders (QR/receipt)
    const colInsufficient = document.getElementById("preorder-col-insufficient") // Insufficient payment

    if (colCash) colCash.innerHTML = ""
    if (colOnline) colOnline.innerHTML = ""
    if (colInsufficient) colInsufficient.innerHTML = ""

    let counts = { cash: 0, online: 0, insufficient: 0 }

    let hasNewPreorder = false
    const nowTs = Date.now()
    const isRecent = (createdAt) => {
        if (!createdAt) return false
        const ts = new Date(createdAt).getTime()
        return Number.isFinite(ts) && (nowTs - ts) <= 60000
    }
    const filteredBookings = bookings || []

    filteredBookings.forEach(booking => {
        let colId = ""
        const isActuallyInsufficient = isInsufficientBooking(booking)
        const isRepaymentPending = booking.second_payment_status === 'pending_verification'
        
        // Separate by payment method and insufficient payment status
        if (isRepaymentPending) {
            // MOVE TO ONLINE PRE-ORDERS COLUMN FOR VERIFICATION
            colId = "preorder-col-online"
            counts.online++
        } else if (isActuallyInsufficient) {
            colId = "preorder-col-insufficient"
            counts.insufficient++
        } else if (booking.status.toLowerCase() !== 'pending' && booking.status.toLowerCase() !== 'accepted') {
            // preparing and ready statuses are handled by kitchen, not shown in cashier pre-order board
            colId = ""
        } else if (booking.payment_method === 'online') {
            colId = "preorder-col-online"
            counts.online++
        } else {
            colId = "preorder-col-cash"
            counts.cash++
        }

        if (!knownPreorderIds.has(booking.id)) {
            if (!isFirstPreorderLoad || isRecent(booking.created_at)) hasNewPreorder = true
            knownPreorderIds.add(booking.id)
        } else {
            knownPreorderIds.add(booking.id)
        }

        if (colId) {
            const card = createPreorderCard(booking)
            document.getElementById(colId).appendChild(card)
        }
    })

    if (hasNewPreorder) {
        notifyNewPreorder()
    }
    isFirstPreorderLoad = false

    const countCash = document.getElementById("preorder-count-cash")
    const countOnline = document.getElementById("preorder-count-online")
    const countInsufficient = document.getElementById("preorder-count-insufficient")

    if (countCash) countCash.textContent = counts.cash
    if (countOnline) countOnline.textContent = counts.online
    if (countInsufficient) countInsufficient.textContent = counts.insufficient

    // Add empty states if columns are empty
    if (counts.cash === 0 && colCash) {
        colCash.innerHTML = `<div class="empty-state"><i class="fa-solid fa-inbox"></i><p>No active cash pre-orders</p></div>`
    }
    if (counts.online === 0 && colOnline) {
        colOnline.innerHTML = `<div class="empty-state"><i class="fa-solid fa-inbox"></i><p>No active online pre-orders</p></div>`
    }
    if (counts.insufficient === 0 && colInsufficient) {
        colInsufficient.innerHTML = `<div class="empty-state"><i class="fa-solid fa-inbox"></i><p>No insufficient payment pre-orders</p></div>`
    }
}

function createPreorderCard(booking) {
    const div = document.createElement("div")
    div.className = "kanban-card"
    
    let itemsHtml = ""
    
    // Handle items (JSON or String)
    if (booking.items) {
        if (Array.isArray(booking.items)) {
            // Already array
            itemsHtml = booking.items.map(i => `<div>${i.qty}x ${i.name}</div>`).join("")
        } else if (typeof booking.items === 'string') {
            // Try JSON parse first
            try {
                const parsed = JSON.parse(booking.items)
                if (Array.isArray(parsed)) {
                    itemsHtml = parsed.map(i => `<div>${i.qty}x ${i.name}</div>`).join("")
                }
            } catch (e) {
                // Not JSON, treat as formatted string (from customer.js)
                // Format: "Item (Size) xQty, Item (Size) xQty"
                const parts = booking.items.split(",").map(s => s.trim())
                itemsHtml = parts.map(p => `<div>${p}</div>`).join("")
            }
        }
    }
    
    if (!itemsHtml) itemsHtml = "<div>No items</div>"
    
    let paymentInfo = ""
    if (booking.payment_method === 'online') {
        const proofUrl = booking.proof_of_payment || ""
        const secondProofUrl = booking.second_payment_proof || ""
        
        paymentInfo = `<div class="payment-info" style="font-size: 0.85em; color: #74512D; margin-top: 4px;">
            Payment: Online 
            ${proofUrl ? `<a href="${proofUrl}" target="_blank" style="text-decoration: underline; color: inherit; font-weight: bold;">(View Receipt)</a>` : '(No Receipt)'}
            ${secondProofUrl ? `<br><span style="color: #543310; font-weight: bold;">2nd Payment:</span> <a href="${secondProofUrl}" target="_blank" style="text-decoration: underline; color: #543310; font-weight: bold;">(View Receipt)</a>` : ''}
        </div>`
    } else {
        const secondProofUrl = booking.second_payment_proof || ""
        paymentInfo = `<div class="payment-info" style="font-size: 0.85em; color: #74512D; margin-top: 4px;">
            Payment: Cash (Pay upon pickup)
            ${secondProofUrl ? `<br><span style="color: #543310; font-weight: bold;">2nd Payment:</span> <a href="${secondProofUrl}" target="_blank" style="text-decoration: underline; color: #543310; font-weight: bold;">(View Receipt)</a>` : ''}
        </div>`
    }

    let totalAmount = Number(booking.finalTotal || booking.total || 0) || getItemsTotal(booking.items)
    const remainingAmount = Math.max(0, getRemainingDue(booking))
    const notesText = [booking.insufficient_notes, booking.notes].filter(Boolean).join(" | ")
    const paidFromNotes = parsePaidAmountFromNotes(notesText)
    if (!totalAmount || totalAmount <= 0) {
        if (remainingAmount > 0 && paidFromNotes > 0) totalAmount = remainingAmount + paidFromNotes
        else if (remainingAmount > 0) totalAmount = remainingAmount
    }
    const amountPaid = Math.max(0, totalAmount - remainingAmount)
    const isInsufficient = isInsufficientBooking(booking)
    let insufficientAmountInfo = ""
    if (booking.payment_method === 'online' && remainingAmount > 0) {
        insufficientAmountInfo = `<div class="payment-info" style="font-size: 0.85em; color: #967658; margin-top: 4px;">
            Insufficient Amount: <strong>\u20B1${remainingAmount.toFixed(2)}</strong>
        </div>`
    }

    let buttons = ""
    // Escape strings for onclick
    const safeProof = booking.proof_of_payment ? booking.proof_of_payment.replace(/'/g, "\\'") : ""
    const pMethod = booking.payment_method || "cash"

    if (isInsufficient) {
        if (booking.second_payment_status === 'pending_verification') {
            buttons = `
                <button onclick="window.updatePreorderStatus('${booking.id}', 'accepted', this)" class="btn-action" style="background-color: #74512D; color: #F8F4E1; flex: 1; padding: 10px;">Accept & Verify</button>
                <button onclick="window.verifySecondPayment('${booking.id}', 'bookings', this)" class="btn-action" style="background-color: #967658; color: #F8F4E1; margin-left: 5px; flex: 1; padding: 10px;">🔍 View Receipt</button>
                <button onclick="window.printPreorderReceipt('${booking.id}')" class="btn-action" style="background-color: #967658; color: #F8F4E1; margin-left: 5px; flex: 1; padding: 10px;">Print Receipt</button>
            `
        } else {
            buttons = `
                <button onclick="window.loadPreorderToPOS('${booking.id}', this)" class="btn-action" style="background-color: #74512D; color: #F8F4E1; margin-left: 5px; flex: 1; padding: 10px;">Load to POS</button>
            `
        }
    } else if (booking.status === "pending") {
        const isOnline = booking.payment_method === "online"
        const acceptBtn = `<button onclick="window.updatePreorderStatus('${booking.id}', 'accepted', this)" class="btn-action" style="background-color: #74512D; color: #F8F4E1; flex: 1; padding: 10px; font-weight: bold; font-size: 14px; border-radius: 8px;">ACCEPT</button>`
        const loadBtn = !isOnline ? `<button onclick="window.loadPreorderToPOS('${booking.id}', this)" class="btn-action" style="background-color: #967658; color: #F8F4E1; margin-left: 5px; flex: 1; padding: 10px; font-weight: bold; font-size: 14px; border-radius: 8px;">LOAD TO POS</button>` : ""
        const insufficientBtn = isOnline
            ? `<button onclick="window.openInsufficientPreorderModalById('${booking.id}', this)" class="btn-action" style="background-color: #AF8F6F; color: #543310; margin-left: 5px; flex: 1.2; padding: 10px; font-weight: bold; font-size: 14px; border-radius: 8px; line-height: 1.1;">⚠️ INSUFFICIENT<br>AMT</button>`
            : ""
        const rejectBtn = `<button onclick="window.rejectPreorder('${booking.id}', this)" class="btn-action" style="background-color: #AF8F6F !important; color: #543310 !important; margin-left:5px; flex: 1; padding: 10px; font-weight: bold; font-size: 14px; border-radius: 8px;">REJECT</button>`
        const printBtn = `<button onclick="window.printPreorderReceipt('${booking.id}')" class="btn-action" style="background-color: #967658; color: #F8F4E1; margin-left:5px; flex: 1; padding: 10px; font-weight: bold; font-size: 14px; border-radius: 8px;">PRINT</button>`
        
        buttons = `
            <div style="display: flex; gap: 5px; width: 100%; align-items: stretch;">
                ${acceptBtn}
                ${loadBtn}
                ${insufficientBtn}
                ${rejectBtn}
                ${printBtn}
            </div>
        `
    } else if (booking.status === "ACCEPTED" || booking.status === "accepted" || booking.status === "preparing" || booking.status === "ready") {
        if (booking.payment_method === "online") {
            // User requested to replace Complete/Print with Accept/Insufficient/Reject for all online pre-orders
            const acceptBtn = `<button onclick="window.updatePreorderStatus('${booking.id}', 'accepted', this)" class="btn-action" style="background-color: #74512D; color: #F8F4E1; flex: 1; padding: 10px; font-weight: bold; font-size: 14px; border-radius: 8px;">ACCEPT</button>`
            const insufficientBtn = `<button onclick="window.openInsufficientPreorderModalById('${booking.id}', this)" class="btn-action" style="background-color: #AF8F6F; color: #543310; margin-left: 5px; flex: 1.2; padding: 10px; font-weight: bold; font-size: 14px; border-radius: 8px; line-height: 1.1;">⚠️ INSUFFICIENT<br>AMT</button>`
            const rejectBtn = `<button onclick="window.rejectPreorder('${booking.id}', this)" class="btn-action" style="background-color: #AF8F6F !important; color: #543310 !important; margin-left:5px; flex: 1; padding: 10px; font-weight: bold; font-size: 14px; border-radius: 8px;">REJECT</button>`
            const printBtn = `<button onclick="window.printPreorderReceipt('${booking.id}')" class="btn-action" style="background-color: #967658; color: #F8F4E1; margin-left:5px; flex: 1; padding: 10px; font-weight: bold; font-size: 14px; border-radius: 8px;">PRINT</button>`
            
            buttons = `
                <div style="display: flex; gap: 5px; width: 100%; align-items: stretch;">
                    ${acceptBtn}
                    ${insufficientBtn}
                    ${rejectBtn}
                    ${printBtn}
                </div>
            `
        } else {
            buttons = `
                <div style="display:flex; gap:5px; width:100%;">
                  <button onclick="window.verifyAndCompletePreorder('${booking.id}', '${pMethod}', this)" class="btn-action" style="background-color: #74512D; color: #F8F4E1; flex: 1; padding: 10px; font-weight: bold; font-size: 14px; border-radius: 8px;">COMPLETE (PICKED UP)</button>
                  <button onclick="window.printPreorderReceipt('${booking.id}')" class="btn-action" style="background-color: #967658; color: #F8F4E1; flex: 1; padding: 10px; font-weight: bold; font-size: 14px; border-radius: 8px;">PRINT</button>
                </div>
            `
        }
    }

    // NEW: Insufficient Payment Display for Pre-orders
    let insufficientDisplay = ""
    if (isInsufficient) {
        const stillNeeded = remainingAmount.toFixed(2)
        const notes = booking.insufficient_notes || booking.notes || "No notes provided"
        insufficientDisplay = `
            <div class="insufficient-alert" style="margin-top: 8px; padding: 8px; background: #AF8F6F; border-left: 4px solid #74512D; border-radius: 4px; font-size: 0.85em;">
                <div style="color: #543310; font-weight: bold;">⚠️ INSUFFICIENT PAYMENT</div>
                <div style="color: #543310; margin-top: 2px;">Total: <strong>₱${totalAmount.toFixed(2)}</strong></div>
                <div style="color: #543310; margin-top: 2px;">Paid: <strong>₱${amountPaid.toFixed(2)}</strong></div>
                <div style="color: #543310; margin-top: 2px;">Still Need: <strong>₱${stillNeeded}</strong></div>
                <div style="color: #543310; font-style: italic; margin-top: 2px;">"${notes}"</div>
            </div>
        `
    }

    // NEW: Repayment Pending Badge
    let repaymentBadge = ""
    if (booking.second_payment_status === 'pending_verification') {
        repaymentBadge = `<div style="background: #AF8F6F; color: #543310; padding: 4px 8px; border-radius: 4px; font-size: 0.75rem; font-weight: bold; margin-bottom: 8px; display: inline-block; border: 1px solid #74512D;">🔄 2ND PAYMENT PENDING VERIFICATION</div>`
    }

    const orderNum = booking.order_number ? `#${booking.order_number}` : `#${String(booking.id).slice(-4)}`

    div.innerHTML = `
        <div class="card-header">
            <span class="order-id" title="Booking ID: ${booking.id}">${orderNum}</span>
            <span>${new Date(booking.created_at).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}</span>
        </div>
        ${repaymentBadge}
        <div class="card-customer">${booking.customer_id}</div>
        <div class="card-summary" style="margin-bottom: 8px;">
            <strong>Pick up:</strong> ${booking.date} @ ${booking.time}
        </div>
        ${paymentInfo}
        ${insufficientAmountInfo}
        ${insufficientDisplay}
        <div style="font-size: 13px; margin: 8px 0; border-top: 1px dashed #AF8F6F; padding-top: 8px;">
            ${itemsHtml}
        </div>
        <div class="card-actions">
            ${buttons}
        </div>
    `
    return div
}

window.updatePreorderStatus = async (id, status, btn = null) => {
    let oldText = "";
    if (btn) {
        btn.disabled = true;
        oldText = btn.innerHTML;
        btn.innerHTML = '<span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span>';
    }

    try {
        const dbRef = getDB()
        const { data: bookingData, error: fetchErr } = await dbRef.from("bookings").select("*").eq("id", id).single()
        if (fetchErr || !bookingData) throw fetchErr || new Error("Booking not found")

        // Normalize status casing to avoid DB check/enums rejecting uppercase values.
        const normalizedStatus = String(status || "").toLowerCase()
        const finalStatus = normalizedStatus
        const payload = { status: finalStatus }
        if (["completed", "rejected", "cancelled"].includes(normalizedStatus)) {
            payload.archived = true
            payload.archived_at = new Date().toISOString()
        }

        // Handle "accept" semantics (accepted/preparing)
        if (normalizedStatus === 'accepted' || normalizedStatus === 'preparing') {
            // For cashier board: moving to "preparing" removes it from cashier lists (kitchen handles next steps)
            payload.status = (normalizedStatus === 'preparing') ? 'preparing' : 'accepted'
            // Notify customer
            await upsertCustomerNotification({
                customerId: bookingData.customer_id,
                orderId: id,
                sourceTable: "bookings",
                message: "Your order is now being prepared."
            });
            
            // Record sale if it was pending
            if (bookingData && bookingData.status === 'pending') {
                await recordKioskSale({ ...bookingData, source: 'bookings' });
                
                // AUTO-PRINT RECEIPT for pre-orders upon acceptance
                try {
                    const items = typeof bookingData.items === 'string' ? JSON.parse(bookingData.items) : (bookingData.items || [])
                    const total = Number(bookingData.total || 0)
                    const discount = Number(bookingData.discount || 0)
                    const orderNum = bookingData.id ? `B${bookingData.id}` : ""
                    console.log("[System Log] Printing receipt for Pre-order:", orderNum)
                    openReceiptWindow(items, total, total, discount, orderNum)
                } catch (printErr) {
                    console.warn("[System Log] Pre-order auto-print failed:", printErr)
                }
            }
        }

        // Handle REJECTED status
        if (normalizedStatus === 'rejected') {
            const reason = askRejectReason()
            if (!reason) {
                showMessage("Rejection reason is required.", "error")
                if (btn) {
                    btn.disabled = false;
                    btn.innerHTML = oldText;
                }
                return
            }
            payload.status = 'rejected'
            payload.rejection_reason = reason
            payload.notes = reason
            // Notify customer
            await upsertCustomerNotification({
                customerId: bookingData.customer_id,
                orderId: id,
                sourceTable: "bookings",
                message: `Your order has been declined: ${reason}`
            });
        }

        // AUTO-CONFIRM SECOND PAYMENT IF ACCEPTING
        if (normalizedStatus === 'accepted' && bookingData.second_payment_status === 'pending_verification') {
            payload.insufficient_payment = false
            payload.insufficient_amount_needed = 0
            payload.second_payment_status = "verified"
            
            if (bookingData.customer_id) {
                const stripped = stripInsufficientPrefix(bookingData.customer_id)
                if (stripped !== bookingData.customer_id) {
                    payload.customer_id = stripped
                }
            }
            // Fire and forget customer notification update
            markCustomerNotificationPaid(id, "bookings").catch(e => console.error("Notification update failed:", e))
        }

        // Sequential critical updates
        await safeUpdateRow("bookings", id, payload)
        
        // Non-critical logging
        logStaffAction('Preorder status', `booking:${id} status:${finalStatus}`).catch(e => {})
        
        // Record sale and award points if completed
        if (status === 'completed') {
             // We need to wait for this as it awards points
             await handlePreorderCompletion(bookingData, id)
        }
        
        // Snappy UI reload
        window.loadPreorders()
        
        if (normalizedStatus === 'completed') {
            showMessage("Order Completed!", "success")
        } else {
            showMessage(`Order ${status.toUpperCase()}!`, "success")
        }

    } catch (err) {
        console.error("Error updating preorder:", err)
        showMessage("Update failed: " + (err.message || "Unknown error"), "error")
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = oldText;
        }
    }
}

window.rejectPreorder = async (id, btn = null) => {
    return window.updatePreorderStatus(id, "rejected", btn)
}

// Helper to clean up updatePreorderStatus
async function handlePreorderCompletion(booking, id) {
    // 1. Record in Sales using robust helper
    await recordKioskSale({ ...booking, source: 'bookings' })

    // 2. Record in Orders History
    const items = (typeof booking.items === 'string' ? JSON.parse(booking.items) : booking.items || [])
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
    await getDB().from("orders").insert(ordersPayload)

    // 3. Award Points
    if (booking.customer_id) {
        const { data: c } = await getDB().from("customers")
           .select("id, loyalty_points, loyalty_card")
           .or(`email.eq.${booking.customer_id},contact.eq.${booking.customer_id}`)
           .maybeSingle()
        
        if (c) {
            const totalOrderAmount = Number(booking.total || 0)
            const amountNeeded = getInsufficientAmount(booking)
            const actualPaidAmount = Math.max(0, totalOrderAmount - amountNeeded)
            const points = 1
            const newPoints = (c.loyalty_points || 0) + points
            
            await getDB().from("customers").update({ loyalty_points: newPoints }).eq("id", c.id)
            await getDB().from("loyalty_history").insert({
                customer_id: c.id,
                loyalty_card: c.loyalty_card,
                points: points,
                source: "preorder",
                order_id: id,
                total: actualPaidAmount,
                timestamp: new Date()
            })
        }
    }
}

function subscribeToPreorders() {
    if (preorderUnsub) {
        if (typeof preorderUnsub.unsubscribe === 'function') preorderUnsub.unsubscribe()
        preorderUnsub = null
    }

    preorderUnsub = getDB()
        .channel('public:bookings')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'bookings' }, payload => {
            const data = payload.new || payload.old
            if (!data || data.type !== 'preorder') return
            console.log("New/Updated Preorder:", payload)
            maybeToastRepayment(payload, "bookings")
            // If it's a new insertion, notify
            if (payload.eventType === 'INSERT' && !notifiedPreorderIds.has(payload.new.id)) {
                notifyNewPreorder()
                notifiedPreorderIds.add(payload.new.id)
            }
            // Always reload to reflect changes (insert or update)
            loadPreorders()
        })
        .subscribe()

    // Polling fallback for preorders (every 5 seconds)
    if (!window.preorderPollInterval) {
        window.preorderPollInterval = setInterval(() => {
            loadPreorders(true)
        }, 5000)
    }
}

function notifyNewPreorder() {
    // Play sound
    try {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        if (AudioContext) {
            const ctx = new AudioContext();
            if (ctx.state === 'suspended') ctx.resume().catch(e => {});
            
            const o = ctx.createOscillator();
            const g = ctx.createGain();
            o.type = "sine";
            o.frequency.value = 880;
            o.connect(g);
            g.connect(ctx.destination);
            g.gain.setValueAtTime(0.001, ctx.currentTime);
            g.gain.exponentialRampToValueAtTime(0.3, ctx.currentTime + 0.1);
            o.start();
            o.stop(ctx.currentTime + 0.3);
        }
    } catch (e) {}

    // Update Status Message
    const container = document.getElementById("statusMessage");
    if (container) {
        container.innerHTML = '<div class="success" style="background:#74512D;color:#F8F4E1;padding:10px;border-radius:4px;margin-bottom:10px;">New Pre-order Received!</div>';
        setTimeout(() => {
            if (container) container.innerHTML = "";
        }, 3000);
    }

    // Update Badge
    preorderNewCount += 1;
    const badge = document.getElementById("preorderNewBadge");
    if (badge) {
        badge.textContent = String(preorderNewCount);
        badge.style.display = "inline-flex";
    }
    updateCashierBell()
}

window.verifyAndAcceptPreorder = async (id, paymentMethod, proofUrl) => {
    // No confirmation pop-up
    await updatePreorderStatus(id, 'accepted')
}

window.printPreorderReceipt = async (bookingId) => {
    try {
        const { data: booking, error } = await getDB().from("bookings").select("*").eq("id", bookingId).single()
        if (error || !booking) throw error || new Error("Booking not found")
        let items = booking.items
        if (typeof items === "string") {
            try { items = JSON.parse(items) } catch (_) { items = [] }
        }
        items = Array.isArray(items) ? items : []
        const total = Number(booking.finalTotal || booking.total || 0) || getItemsTotal(items)
        const discount = Number(booking.discount || 0)
        openReceiptWindow(items, total, total, discount)
    } catch (e) {
        showMessage("Failed to print receipt: " + (e.message || e), "error")
    }
}

window.verifyAndCompletePreorder = async (id, paymentMethod, btn = null) => {
    // No confirmation pop-up
    await window.updatePreorderStatus(id, 'completed', btn)
}

window.openInsufficientPreorderModalById = async (bookingId, btn = null) => {
    let oldText = "";
    if (btn) {
        btn.disabled = true;
        oldText = btn.innerHTML;
        btn.innerHTML = '<span class="spinner-border spinner-border-sm"></span>';
    }
    try {
        const { data: booking, error } = await getDB().from("bookings").select("*").eq("id", bookingId).single()
        if (error || !booking) throw error || new Error("Booking not found")
        
        // Pass a modified object with _source: "bookings" to reuse kiosk logic
        window.openInsufficientPaymentModal({ ...booking, _source: "bookings" })
    } catch (e) {
        showMessage("Failed to open insufficient payment: " + (e.message || e), "error")
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = oldText;
        }
    }
}

// --- Insufficient Payment Modal ---
let insufficientTenderListener = null
window.openInsufficientPaymentModal = (order) => {
    const modal = document.getElementById("insufficientPaymentModal")
    if (!modal) return
    
    const total = Number(order.finalTotal || order.total || 0) || getItemsTotal(order.items)
    const receipt = order.proof_of_payment
    
    // Try to extract amount from receipt or estimate
    let amountPaid = 0
    if (receipt && receipt.includes("₱")) {
        const match = receipt.match(/₱([\d,.]+)/)
        if (match) amountPaid = parseFloat(match[1])
    }
    
    // Calculate still needed
    const stillNeed = Math.max(0, total - amountPaid)
    const isCurrentPosOrder = String(currentPendingId || "") === String(order.id || "") && !!currentPendingSource
    let effectiveTotal = total
    let effectiveAmountPaid = amountPaid
    const orderTotalEl = document.getElementById("orderTotal")
    if (isCurrentPosOrder && orderTotalEl) {
        const displayedTotal = Number(orderTotalEl.textContent || 0)
        if (displayedTotal > 0) effectiveTotal = displayedTotal
    }
    if (isCurrentPosOrder) {
        const tenderEl = document.getElementById("tender")
        const tenderVal = tenderEl ? Number(tenderEl.value || 0) : 0
        effectiveAmountPaid = Math.max(0, tenderVal)
    }
    const effectiveStillNeed = Math.max(0, effectiveTotal - effectiveAmountPaid)
    
    // Populate modal fields
    document.getElementById("insufficientOrderId").textContent = "#" + order.id
    document.getElementById("insufficientTotalAmount").textContent = "₱" + total.toFixed(2)
    document.getElementById("insufficientReceivedAmount").textContent = "₱" + amountPaid.toFixed(2)
    document.getElementById("insufficientStillNeedAmount").textContent = stillNeed.toFixed(2)
    const stillNeedInput = document.getElementById("insufficientStillNeedInput")
    if (stillNeedInput) stillNeedInput.value = stillNeed.toFixed(2)
    if (stillNeedInput) {
        stillNeedInput.value = effectiveStillNeed.toFixed(2)
        stillNeedInput.dataset.manual = "false"
        stillNeedInput.oninput = () => { stillNeedInput.dataset.manual = "true" }
    }
    document.getElementById("insufficientTotalAmount").textContent = "â‚±" + effectiveTotal.toFixed(2)
    document.getElementById("insufficientReceivedAmount").textContent = "â‚±" + effectiveAmountPaid.toFixed(2)
    document.getElementById("insufficientStillNeedAmount").textContent = effectiveStillNeed.toFixed(2)
    document.getElementById("insufficientTotalAmount").textContent = "PHP " + effectiveTotal.toFixed(2)
    document.getElementById("insufficientReceivedAmount").textContent = "PHP " + effectiveAmountPaid.toFixed(2)
    document.getElementById("insufficientPaymentNotes").value = ""
    
    const ensureReceivedInput = () => {
        let input = document.getElementById("insufficientReceivedInput")
        if (!input) {
            const existing = document.getElementById("insufficientReceivedAmount")
            if (existing) {
                const replacement = document.createElement("input")
                replacement.id = "insufficientReceivedInput"
                replacement.type = "number"
                replacement.min = "0"
                replacement.step = "0.01"
                replacement.placeholder = "0.00"
                replacement.style.cssText = "display: block; margin-top: 6px; width: 180px; padding: 8px; border: 1px solid #AF8F6F; border-radius: 4px; font-size: 0.95em;"
                existing.style.display = "none"
                existing.insertAdjacentElement("afterend", replacement)
                input = replacement
            }
        }
        return input
    }

    const applyInsufficientAmounts = (totalVal, receivedVal) => {
        const totalEl = document.getElementById("insufficientTotalAmount")
        const stillNeedEl = document.getElementById("insufficientStillNeedAmount")
        const stillNeedInputEl = document.getElementById("insufficientStillNeedInput")
        const receivedInputEl = ensureReceivedInput()

        const safeTotal = Math.max(0, Number(totalVal || 0))
        const safeReceived = Math.max(0, Number(receivedVal || 0))
        const need = Math.max(0, safeTotal - safeReceived)

        if (totalEl) totalEl.textContent = "PHP " + safeTotal.toFixed(2)
        if (receivedInputEl) receivedInputEl.value = safeReceived.toFixed(2)
        if (stillNeedEl) stillNeedEl.textContent = need.toFixed(2)
        if (stillNeedInputEl) {
            stillNeedInputEl.value = need.toFixed(2)
            stillNeedInputEl.dataset.manual = "false"
            stillNeedInputEl.oninput = () => { stillNeedInputEl.dataset.manual = "true" }
        }

        if (receivedInputEl) {
            receivedInputEl.oninput = () => {
                const paid = Math.max(0, Number(receivedInputEl.value || 0))
                const updatedNeed = Math.max(0, safeTotal - paid)
                if (stillNeedEl) stillNeedEl.textContent = updatedNeed.toFixed(2)
                if (stillNeedInputEl) {
                    stillNeedInputEl.value = updatedNeed.toFixed(2)
                    stillNeedInputEl.dataset.manual = "false"
                }
                if (window.currentInsufficientOrder) {
                    window.currentInsufficientOrder.amountPaid = paid
                    window.currentInsufficientOrder.stillNeed = updatedNeed
                }
            }
        }

        return { safeTotal, safeReceived, need }
    }

    let computedTotal = effectiveTotal
    if (!computedTotal || computedTotal <= 0) {
        let items = order.items
        if (typeof items === "string") {
            try { items = JSON.parse(items) } catch (_) { items = [] }
        }
        if (Array.isArray(items)) {
            computedTotal = items.reduce((sum, item) => {
                const qty = Number(item.qty || item.quantity || 1) || 1
                const amount = Number(item.amount || 0)
                const price = Number(item.price || 0)
                const line = amount > 0 ? amount : (price * qty)
                return sum + (Number.isFinite(line) ? line : 0)
            }, 0)
        }
    }

    const applied = applyInsufficientAmounts(computedTotal, effectiveAmountPaid)
    
    const source = order._source || ((order.type === "preorder" || order.date) ? "bookings" : "pending_orders")
    window.currentInsufficientOrder = { ...order, _source: source, totalAmount: applied.safeTotal, amountPaid: applied.safeReceived, stillNeed: applied.need }

    // Live update from POS tender input if this order is loaded in POS
    const tenderEl = document.getElementById("tender")
    if (tenderEl && isCurrentPosOrder) {
        if (insufficientTenderListener) tenderEl.removeEventListener("input", insufficientTenderListener)
        insufficientTenderListener = () => {
            const tenderVal = Number(tenderEl.value || 0)
            const paid = Math.max(0, tenderVal)
            const need = Math.max(0, effectiveTotal - paid)
            document.getElementById("insufficientReceivedAmount").textContent = "â‚±" + paid.toFixed(2)
              document.getElementById("insufficientStillNeedAmount").textContent = need.toFixed(2)
              document.getElementById("insufficientReceivedAmount").textContent = "PHP " + paid.toFixed(2)
              const receivedInputEl = document.getElementById("insufficientReceivedInput")
              if (receivedInputEl) receivedInputEl.value = paid.toFixed(2)
              const stillNeedInputEl = document.getElementById("insufficientStillNeedInput")
            if (stillNeedInputEl && stillNeedInputEl.dataset.manual !== "true") {
                stillNeedInputEl.value = need.toFixed(2)
            }
            if (window.currentInsufficientOrder) {
                window.currentInsufficientOrder.amountPaid = paid
                window.currentInsufficientOrder.stillNeed = need
            }
        }
        tenderEl.addEventListener("input", insufficientTenderListener)
    }
    
    // Use flex to center with CSS
    modal.style.display = "flex"
}

window.closeInsufficientModal = () => {
    const modal = document.getElementById("insufficientPaymentModal")
    if (modal) modal.style.display = "none"
    window.currentInsufficientOrder = null
    const tenderEl = document.getElementById("tender")
    if (tenderEl && insufficientTenderListener) {
        tenderEl.removeEventListener("input", insufficientTenderListener)
        insufficientTenderListener = null
    }
}

window.confirmInsufficientPayment = async () => {
    const order = window.currentInsufficientOrder
    if (!order) return
    
    let notes = document.getElementById("insufficientPaymentNotes").value.trim()
    let stillNeed = order.stillNeed
    const stillNeedInput = document.getElementById("insufficientStillNeedInput")
    if (stillNeedInput && stillNeedInput.value !== "") {
        const v = parseFloat(stillNeedInput.value)
        if (!isNaN(v) && v >= 0) stillNeed = v
    }
    
    // Make notes optional; fallback to default label
    if (!notes) notes = "Insufficient payment"
    const notifyNote = stillNeed > 0 ? `Payment incomplete. Remaining Balance: \u20B1${stillNeed.toFixed(2)}` : ""
    const paidAmount = Number(order.amountPaid || 0)
    const paymentLog = formatPaymentLogEntry(paidAmount, stillNeed)
    const baseNotes = `${notes} | Remaining Balance: \u20B1${stillNeed.toFixed(2)}`
    let notesWithAmountDb = appendPaymentLog(baseNotes, paymentLog)
    if (notifyNote) notesWithAmountDb = appendPaymentLog(notesWithAmountDb, notifyNote)
    
    // Always embed amount in notes so kitchen can parse it even if insufficient_amount_needed column doesn't exist
    const notesWithAmount = `${notes} | Remaining Balance: \u20B1${stillNeed.toFixed(2)}`
    
    try {
        const targetTable = order._source === "bookings" ? "bookings" : "pending_orders"
        const payload = {
            status: "INSUFFICIENT",
            insufficient_payment: true,
            insufficient_amount_needed: stillNeed,
            insufficient_notes: notesWithAmountDb,
            notes: notesWithAmountDb
        }
        if (targetTable === "pending_orders") payload.type = "insufficient"

        await safeUpdateRow(targetTable, order.id, payload)
        await ensureInsufficientMarker(targetTable, order.id, notesWithAmountDb, stillNeed)

        // Fallback: if order was mis-routed, attempt the other table
        if (order._source !== "bookings") {
            try {
                await ensureInsufficientMarker("bookings", order.id, notesWithAmountDb)
            } catch (_) {}
        }

        await upsertCustomerNotification({
            customerId: order.customer_id,
            orderId: order.id,
            sourceTable: targetTable,
            remainingAmount: stillNeed,
            message: `Your order has insufficient payment. Remaining balance: ₱${stillNeed.toFixed(2)}`
        })

        await logStaffAction('Marked insufficient payment', `order:${order.id} source:${targetTable} remaining:${stillNeed.toFixed(2)}`)

        showMessage("Order marked as insufficient payment. Kitchen staff notified.", "success")
        window.closeInsufficientModal()
        
        // Refresh appropriate board
        if (typeof window.loadKioskOrders === "function") window.loadKioskOrders()
        if (typeof window.loadPreorders === "function") window.loadPreorders()
        
    } catch (err) {
        console.error("[v0] Error marking insufficient payment:", err)
        showMessage("Failed to update order: " + err.message, "error")
    }
}





async function markPreorderInsufficientFromPOS(booking, amountPaid, totalAmount) {
    const stillNeed = Math.max(0, Number(totalAmount || 0) - Number(amountPaid || 0))
    const baseNotes = `Insufficient payment | Remaining Balance: \u20B1${stillNeed.toFixed(2)}`
    const noteWithPaid = `Paid: \u20B1${Number(amountPaid || 0).toFixed(2)}`
    const notifyNote = stillNeed > 0 ? `Payment incomplete. Remaining Balance: \u20B1${stillNeed.toFixed(2)}` : ""
    const paymentLog = formatPaymentLogEntry(amountPaid, stillNeed)
    let notesForDbFinal = `${baseNotes} | ${noteWithPaid}`
    notesForDbFinal = appendPaymentLog(notesForDbFinal, paymentLog)
    if (notifyNote) notesForDbFinal = appendPaymentLog(notesForDbFinal, notifyNote)

    const payload = {
        status: "INSUFFICIENT",
        insufficient_payment: true,
        insufficient_amount_needed: stillNeed,
        insufficient_notes: notesForDbFinal,
        notes: notesForDbFinal
    }
    await safeUpdateRow("bookings", booking.id, payload)
    await ensureInsufficientMarker("bookings", booking.id, notesForDbFinal, stillNeed)
    await upsertCustomerNotification({
        customerId: booking.customer_id,
        orderId: booking.id,
        sourceTable: "bookings",
        remainingAmount: stillNeed,
        message: `Your order has insufficient payment. Remaining balance: ₱${stillNeed.toFixed(2)}`
    })
}

window.sendKioskPaymentNotification = async (orderId) => {
    try {
        const { data: order, error } = await getDB().from("pending_orders").select("*").eq("id", orderId).single()
        if (error || !order) throw error || new Error("Order not found")
        let remaining = Math.max(0, getRemainingDue(order))
        const total = Number(order.finalTotal || order.total || 0) || getItemsTotal(order.items)
        if (remaining <= 0 && total > 0) remaining = total
        if (remaining <= 0) {
            showMessage("No remaining balance to notify.", "info")
            return
        }
        const paid = total > 0 ? Math.max(0, total - remaining) : 0
        const baseNote = `Insufficient payment | Remaining Balance: \u20B1${remaining.toFixed(2)}`
        const paidNote = paid > 0 ? ` | Paid: \u20B1${paid.toFixed(2)}` : ""
        const notifyNote = remaining > 0 ? `Payment incomplete. Remaining Balance: \u20B1${remaining.toFixed(2)}` : ""
        const nextNote = `${baseNote}${paidNote} | ${notifyNote}`
        const existing = order.insufficient_notes || order.notes || ""
        const updatedNotes = existing.includes(notifyNote) ? existing : (existing ? `${existing} | ${nextNote}` : nextNote)
        const payload = {
            insufficient_payment: true,
            insufficient_amount_needed: remaining,
            insufficient_notes: updatedNotes,
            notes: updatedNotes
        }
        const strippedCustomer = typeof order.customer_id === "string"
            ? order.customer_id.replace(/^\[INSUFFICIENT\]\s*/i, "")
            : order.customer_id
        if (strippedCustomer && strippedCustomer !== order.customer_id) {
            payload.customer_id = strippedCustomer
        }
        await safeUpdateRow("pending_orders", orderId, payload)
        await ensureInsufficientMarker("pending_orders", orderId, updatedNotes, remaining)
        await upsertCustomerNotification({
            customerId: strippedCustomer || order.customer_id,
            orderId,
            sourceTable: "pending_orders",
            remainingAmount: remaining,
            message: `Additional payment required. Remaining Balance: PHP ${remaining.toFixed(2)}`
        })
        await logStaffAction('Payment notification', `order:${orderId} remaining:${remaining.toFixed(2)}`)
        showMessage("Payment notification sent.", "success")
        loadKioskOrders()
    } catch (e) {
        showMessage("Failed to send notification: " + (e.message || e), "error")
    }
}

window.confirmPayment = async (orderId, amountPaid) => {
    try {
        const dbRef = getDB()
        if (!dbRef) throw new Error("Database not ready")

        let order = null
        let source = "pending_orders"

        const { data: pending } = await dbRef.from("pending_orders").select("*").eq("id", orderId).maybeSingle()
        if (pending) {
            order = pending
            source = "pending_orders"
        } else {
            const { data: booking } = await dbRef.from("bookings").select("*").eq("id", orderId).maybeSingle()
            if (booking) {
                order = booking
                source = "bookings"
            }
        }

        if (!order) throw new Error("Order not found")

        const remaining = Math.max(0, getRemainingDue(order))
        const totalAmount = Number(order.finalTotal || order.total || 0) || getItemsTotal(order.items)
        const baseRemaining = remaining > 0 ? remaining : (totalAmount > 0 ? totalAmount : 0)
        const paidAmountRaw = Number(amountPaid || 0)
        const paidAmount = paidAmountRaw > 0 ? paidAmountRaw : baseRemaining
        const remainingAfter = Math.max(0, baseRemaining - paidAmount)
        const paymentLog = formatPaymentLogEntry(paidAmount, remainingAfter)
        const existingNotes = order.insufficient_notes || order.notes || ""
        let updatedNotes = appendPaymentLog(existingNotes, paymentLog)

        if (remainingAfter > 0) {
            const notifyNote = `Payment incomplete. Remaining Balance: \u20B1${remainingAfter.toFixed(2)}`
            if (!updatedNotes.includes(notifyNote)) updatedNotes = appendPaymentLog(updatedNotes, notifyNote)
            const partialPayload = {
                status: "pending",
                insufficient_payment: true,
                insufficient_amount_needed: remainingAfter,
                insufficient_notes: updatedNotes,
                notes: updatedNotes
            }
            if (source === "pending_orders") partialPayload.type = "insufficient"
            await safeUpdateRow(source, orderId, partialPayload)
            await ensureInsufficientMarker(source, orderId, updatedNotes, remainingAfter)
            await upsertCustomerNotification({
                customerId: order.customer_id,
                orderId,
                sourceTable: source,
                remainingAmount: remainingAfter,
                message: `Additional payment required. Remaining Balance: PHP ${remainingAfter.toFixed(2)}`
            })
            await logStaffAction('Partial payment', `order:${orderId} source:${source} paid:${paidAmount.toFixed(2)} remaining:${remainingAfter.toFixed(2)}`)
            showMessage(`Partial payment recorded. Remaining \u20B1${remainingAfter.toFixed(2)}.`, "info")
            if (typeof window.loadKioskOrders === "function") window.loadKioskOrders()
            if (typeof window.loadPreorders === "function") window.loadPreorders()
            return
        }

        const confirmNote = formatPaymentConfirmedNote()
        if (!updatedNotes.includes(confirmNote)) updatedNotes = appendPaymentLog(updatedNotes, confirmNote)
        updatedNotes = stripInsufficientMarkers(updatedNotes)

        const payload = {
            status: source === "bookings" ? "accepted" : "preparing",
            insufficient_payment: false,
            insufficient_amount_needed: 0,
            insufficient_notes: updatedNotes,
            notes: updatedNotes,
            payment_status: "paid",
            paymentStatus: "paid"
        }

        const strippedCustomer = stripInsufficientPrefix(order.customer_id)
        if (strippedCustomer && strippedCustomer !== order.customer_id) payload.customer_id = strippedCustomer

        await safeUpdateRow(source, orderId, payload)
        await markCustomerNotificationPaid(orderId, source)

        if (source === "pending_orders" && order.type === "insufficient") {
            try {
                await dbRef.from("pending_orders").update({ type: null }).eq("id", orderId)
            } catch (_) {}
        }

        await logStaffAction('Payment confirmed', `order:${orderId} source:${source} amount:${paidAmount.toFixed(2)}`)

        const successMsg = source === "bookings" 
            ? "Payment confirmed. Pre-order accepted and ready for kitchen."
            : "Payment confirmed. Order moved to preparing."
        showMessage(successMsg, "success")
        if (typeof window.loadKioskOrders === "function") window.loadKioskOrders()
        if (typeof window.loadPreorders === "function") window.loadPreorders()
    } catch (e) {
        showMessage("Failed to confirm payment: " + (e.message || e), "error")
    }
}

window.confirmKioskInsufficientPayment = async (orderId) => {
    try {
        await window.confirmPayment(orderId, 0)
    } catch (e) {
        showMessage("Failed to confirm payment: " + (e.message || e), "error")
    }
}

window.sendPaymentNotification = async (bookingId) => {
    try {
        const { data: booking, error } = await getDB().from("bookings").select("*").eq("id", bookingId).single()
        if (error || !booking) throw error || new Error("Booking not found")
        let remaining = Math.max(0, getRemainingDue(booking))
        const total = Number(booking.finalTotal || booking.total || 0) || getItemsTotal(booking.items)
        if (remaining <= 0 && total > 0) remaining = total
        if (remaining <= 0) {
            showMessage("No remaining balance to notify.", "info")
            return
        }
        const paid = total > 0 ? Math.max(0, total - remaining) : 0
        const baseNote = `Insufficient payment | Remaining Balance: \u20B1${remaining.toFixed(2)}`
        const paidNote = paid > 0 ? ` | Paid: \u20B1${paid.toFixed(2)}` : ""
        const notifyNote = remaining > 0 ? `Payment incomplete. Remaining Balance: \u20B1${remaining.toFixed(2)}` : ""
        const nextNote = `${baseNote}${paidNote} | ${notifyNote}`
        const existing = booking.insufficient_notes || booking.notes || ""
        const updatedNotes = existing.includes(notifyNote) ? existing : (existing ? `${existing} | ${nextNote}` : nextNote)
        await safeUpdateRow("bookings", bookingId, {
            insufficient_payment: true,
            insufficient_amount_needed: remaining,
            insufficient_notes: updatedNotes,
            notes: updatedNotes
        })
        await ensureInsufficientMarker("bookings", bookingId, updatedNotes, remaining)
        await upsertCustomerNotification({
            customerId: booking.customer_id,
            orderId: bookingId,
            sourceTable: "bookings",
            remainingAmount: remaining,
            message: `Additional payment required. Remaining Balance: PHP ${remaining.toFixed(2)}`
        })
        await logStaffAction('Payment notification', `booking:${bookingId} remaining:${remaining.toFixed(2)}`)
        showMessage("Payment notification sent.", "success")
        loadPreorders()
    } catch (e) {
        showMessage("Failed to send notification: " + (e.message || e), "error")
    }
}

window.confirmPreorderPayment = async (bookingId) => {
    try {
        await window.confirmPayment(bookingId, 0)
    } catch (e) {
        showMessage("Failed to confirm payment: " + (e.message || e), "error")
    }
}

// --- Second Payment Verification ---
window.verifySecondPayment = async (orderId, source, btn = null) => {
    let oldText = "";
    if (btn) {
        btn.disabled = true;
        oldText = btn.innerHTML;
        btn.innerHTML = '<span class="spinner-border spinner-border-sm"></span>';
    }
    try {
        const { data: order, error } = await getDB().from(source).select("*").eq("id", orderId).single()
        if (error || !order) throw error || new Error("Order not found")

        const modal = document.getElementById("verificationModal")
        const text = document.getElementById("verificationText")
        const img = document.getElementById("verificationProofImg")
        const noProof = document.getElementById("noProofText")
        const btnConfirm = document.getElementById("btnConfirmSecondPayment")

        if (modal && text && img && noProof && btnConfirm) {
            text.textContent = `Order #${order.id} - Verification for ${order.second_payment_method || 'Unknown'} payment`
            
            if (order.second_payment_proof) {
                img.src = order.second_payment_proof
                img.style.display = "block"
                noProof.style.display = "none"
            } else {
                img.style.display = "none"
                noProof.style.display = "block"
            }

            btnConfirm.onclick = () => window.confirmSecondPayment(orderId, source)
            modal.style.display = "flex"
        }
    } catch (e) {
        showMessage("Failed to load verification: " + (e.message || e), "error")
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = oldText;
        }
    }
}

window.closeVerificationModal = () => {
    const modal = document.getElementById("verificationModal")
    if (modal) modal.style.display = "none"
}

window.confirmSecondPayment = async (orderId, source) => {
    try {
        const dbRef = getDB()
        const { data: order } = await dbRef.from(source).select("customer_id").eq("id", orderId).single()
        
        // Clear insufficient payment flags and mark second payment as verified
        const payload = {
            insufficient_payment: false,
            insufficient_amount_needed: 0,
            second_payment_status: "verified",
            status: "preparing" 
        }

        // Strip [INSUFFICIENT] prefix from customer_id to remove kitchen tag
        if (order && order.customer_id) {
            const stripped = stripInsufficientPrefix(order.customer_id)
            if (stripped !== order.customer_id) {
                payload.customer_id = stripped
            }
        }

        await safeUpdateRow(source, orderId, payload)
        
        // Mark customer notification as paid
        await markCustomerNotificationPaid(orderId, source)

        showMessage("Second payment confirmed! Order is now Preparing.", "success")
        window.closeVerificationModal()
        
        // Refresh boards
        if (typeof window.loadKioskOrders === "function") window.loadKioskOrders()
        if (typeof window.loadPreorders === "function") window.loadPreorders()
        
        await logStaffAction('Confirmed second payment', `order:${orderId} source:${source}`)
    } catch (e) {
        showMessage("Failed to confirm second payment: " + (e.message || e), "error")
    }
}





