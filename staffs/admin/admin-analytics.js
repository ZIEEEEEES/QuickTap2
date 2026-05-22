// Analytics JS Loaded - Supabase Ready
console.log("[v0] admin-analytics.js loaded - Supabase version")

function getDB() {
  return window.db
}
const categoryMap = { 1: "Coffee", 2: "Non-coffee", 3: "Frappe", 4: "Soda", 5: "Pastries" }
let isDashboardRunning = false
let lastUpdateTime = 0
const MIN_UPDATE_INTERVAL = 2000 // Prevent updates more frequent than 2 seconds
let analyticsUpdateTimer = null

/** Kiosk paid sales often have no booking_id but type kiosk_order / kiosk. Pre-orders use booking_id. */
function isTerminalChannelSale(rec) {
  if (!rec) return false
  const bid = rec.booking_id
  if (bid !== null && bid !== undefined && String(bid).trim() !== "") return true
  const t = String(rec.type || "")
    .toLowerCase()
    .replace(/-/g, "_")
  return t === "preorder" || t === "kiosk_order" || t === "kiosk"
}

function matchesAnSource(rec, sourceSel) {
  if (!sourceSel || sourceSel === "all") return true
  const terminal = isTerminalChannelSale(rec)
  if (sourceSel === "terminal") return terminal
  if (sourceSel === "walkin") return !terminal
  return true
}

function getTransactionChannelLabel(rec) {
  if (!rec) return "Walk-in"
  if (isTerminalChannelSale(rec)) {
    const t = String(rec.type || "").toLowerCase()
    if (t.includes("preorder")) return "Pre-order"
    if (t.includes("kiosk")) return "Kiosk"
    return "Terminal"
  }
  return "Walk-in"
}

function getTransactionInstant(rec) {
  if (!rec) return null
  const candidates = [rec.sale_date, rec.timestamp, rec.created_at, rec.date]
  for (const raw of candidates) {
    if (raw == null || raw === "") continue
    const d = new Date(raw)
    if (!isNaN(d.getTime())) return d
  }
  if (rec.date && typeof rec.date === "string" && rec.date.includes("-")) {
    const d2 = new Date(`${rec.date}T12:00:00`)
    if (!isNaN(d2.getTime())) return d2
  }
  return null
}

function formatYMDFromRecord(rec) {
  const inst = getTransactionInstant(rec)
  if (!inst) return null
  return formatDateYMD(inst)
}

function isFullyPaidSaleRecord(rec) {
  if (!rec) return false
  const status = String(rec.status || "").toLowerCase()
  if (status === "rejected" || status === "cancelled" || status === "refunded") return false

  const dueRaw = rec.amount_due ?? rec.insufficient_amount_needed
  const amountDue = Number(dueRaw)
  if (Number.isFinite(amountDue) && amountDue > 0) return false

  const insuf =
    rec.insufficient_payment === true ||
    rec.insufficient_payment === 1 ||
    String(rec.insufficient_payment || "").toLowerCase() === "true"

  const paymentStatus = String(rec.payment_status || rec.paymentStatus || "").toLowerCase()
  if (paymentStatus === "paid") return true
  if (status === "completed" || status === "paid" || status === "success") return true

  if (status === "pending" || status === "processing" || status === "partial") return false

  const total = Number(rec.total ?? rec.amount ?? 0)
  if (total > 0 && !insuf) return true
  if (total > 0 && insuf && (!Number.isFinite(amountDue) || amountDue <= 0)) return true

  return status === ""
}

function getWeekKey(d) {
  const t = new Date(d.getTime())
  const day = (d.getDay() + 6) % 7
  t.setDate(d.getDate() - day + 3)
  const first = new Date(t.getFullYear(), 0, 4)
  const week = 1 + Math.round(((t - first) / 86400000 - 3 + ((first.getDay() + 6) % 7)) / 7)
  return t.getFullYear() + "-W" + String(week).padStart(2, "0")
}

function getQuarterKey(d) {
  const y = d.getFullYear()
  const q = Math.floor(d.getMonth() / 3) + 1
  return `${y}-Q${q}`
}

function getSemiAnnualKey(d) {
  const y = d.getFullYear()
  const h = Math.floor(d.getMonth() / 6) + 1
  return `${y}-H${h}`
}

function getAnnualKey(d) {
  return String(d.getFullYear())
}

function calculateDateRange(interval) {
  const end = new Date()
  let start = new Date()
  
  switch (interval) {
      case "day":
          start.setDate(end.getDate() - 7)
          break
      case "week":
          start.setDate(end.getDate() - (8 * 7))
          break
      case "month":
          start.setMonth(end.getMonth() - 6)
          break
      case "quarter":
          start.setMonth(end.getMonth() - (4 * 3))
          break
      case "semiannual":
           start.setMonth(end.getMonth() - (4 * 6))
           break
      case "annual":
          start.setFullYear(end.getFullYear() - 5)
          break
      default:
          start.setDate(end.getDate() - 30)
  }

  const formatDate = (d) => {
      const y = d.getFullYear()
      const m = String(d.getMonth() + 1).padStart(2, '0')
      const da = String(d.getDate()).padStart(2, '0')
      return `${y}-${m}-${da}`
  }
  
  return { start: formatDate(start), end: formatDate(end) }
}

function formatDateYMD(d) {
    const y = d.getFullYear()
    const m = String(d.getMonth() + 1).padStart(2, '0')
    const da = String(d.getDate()).padStart(2, '0')
    return `${y}-${m}-${da}`
}

function escapeHtml(str) {
  return String(str == null ? "" : str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

/** Coffee menu uses `Name (Hot)` / `Name (Cold)`; analytics treat variants as one product. */
function analyticsProductGroupKey(name) {
  if (name == null || name === "") return "Custom"
  const s = String(name).trim()
  const base = s.replace(/\s*\(\s*(Hot|Cold)\s*\)\s*$/i, "").trim()
  return base || s
}

/** Inclusive calendar days between two YYYY-MM-DD strings (for Avg/Day on Transactions). */
function inclusiveDaySpanYMD(startYmd, endYmd) {
  if (!startYmd || !endYmd) return 1
  const a = new Date(`${startYmd}T12:00:00`)
  const b = new Date(`${endYmd}T12:00:00`)
  if (isNaN(a.getTime()) || isNaN(b.getTime())) return 1
  const days = Math.round((b.getTime() - a.getTime()) / 86400000) + 1
  return Math.max(1, days)
}

/** Overview / In-depth / Transactions date ranges: allow any past date (no min/max on native pickers). */
function unlockAnalyticsDateInputs() {
  const ids = ["anStart", "anEnd", "anIndepthStart", "anIndepthEnd", "transStart", "transEnd"]
  for (const id of ids) {
    const el = document.getElementById(id)
    if (el) {
      el.removeAttribute("min")
      el.removeAttribute("max")
    }
  }
}
window.unlockAnalyticsDateInputs = unlockAnalyticsDateInputs

/** Transactions tab: map dropdown / legacy spellings to keys used by grouping + calculateDateRange. */
function normalizeTransInterval(raw) {
  const v = String(raw == null ? "" : raw)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
  const map = {
    day: "day",
    daily: "day",
    week: "week",
    weekly: "week",
    month: "month",
    monthly: "month",
    quarter: "quarter",
    quarterly: "quarter",
    annual: "annual",
    yearly: "annual",
    year: "annual"
  }
  return map[v] || "week"
}

async function loadSales(startArg, endArg) {
  const interval = document.getElementById("anInterval")?.value || "week"
  const sourceSel = document.getElementById("anSource")?.value || "all"
  const mode = document.getElementById("catMode")?.value || "amount"
  const isQty = mode === "quantity"
  
  let start = startArg || document.getElementById("anStart")?.value
  let end = endArg || document.getElementById("anEnd")?.value
  if (!start || !end) {
      const range = calculateDateRange(interval)
      start = range.start
      end = range.end
  }

  const dailyTotals = {}
  let totalQty = 0
  let totalSales = 0

  // Single fetch + client filters: booking_id alone misses kiosk_order rows (no booking_id).
  const { data: salesData, error: salesError } = await getDB().from("sales").select("*")

  if (!salesError && salesData) {
      salesData.forEach((data) => {
        if (!isFullyPaidSaleRecord(data)) return
        if (!matchesAnSource(data, sourceSel)) return
        const ts = getTransactionInstant(data)
        if (!ts) return
        const dateStr = formatDateYMD(ts)
        if (start && dateStr < start) return
        if (end && dateStr > end) return
        
        const total = Number(data.total || 0)
        let items = data.items
        if (typeof items === 'string') {
            try { items = JSON.parse(items) } catch(e) { items = [] }
        }
        items = Array.isArray(items) ? items : []
        const qty = items.reduce((s, i) => s + Number(i.quantity || i.qty || 0), 0)
        
        let key = dateStr
        if (interval === "week") key = getWeekKey(ts)
        else if (interval === "month") key = ts.getFullYear() + "-" + String(ts.getMonth() + 1).padStart(2, "0")
        else if (interval === "quarter") key = getQuarterKey(ts)
        else if (interval === "semiannual") key = getSemiAnnualKey(ts)
        else if (interval === "annual") key = getAnnualKey(ts)
        
        if (!dailyTotals[key]) dailyTotals[key] = 0
        dailyTotals[key] += isQty ? qty : total
        totalSales += total
        totalQty += qty
      })
  }

  // Use sales records only for analytics totals (approval/full-payment basis).
  
  return { dailyTotals, totalQty, totalSales }
}

let descChartInstance = null
function createDescriptiveChart(labels, values, type, titleText) {
  if (descChartInstance) {
    descChartInstance.destroy()
    descChartInstance = null
  }
  const sorted = (labels || []).slice().sort()
  const map = new Map(labels.map((l, i) => [l, values[i]]))
  const sortedVals = sorted.map((l) => map.get(l) || 0)

  const canvas = document.getElementById("analyticsDescriptiveChart")
  if (!canvas) return

  const parent = canvas.parentNode
  const freshCanvas = document.createElement('canvas')
  freshCanvas.id = canvas.id
  freshCanvas.className = canvas.className
  freshCanvas.style.width = "100%"
  freshCanvas.style.height = "100%"
  freshCanvas.style.maxHeight = "none"
  
  parent.replaceChild(freshCanvas, canvas)
  
  const mode = document.getElementById("catMode")?.value || "amount"
  const isQty = mode === "quantity"
  const labelPrefix = isQty ? "Items" : "Sales (₱)"
  const valuePrefix = isQty ? "" : "₱"
  const valueSuffix = isQty ? " Qty" : ""

  descChartInstance = new window.Chart(freshCanvas, {
    type: "line",
    data: {
      labels: sorted,
      datasets: [
        {
          label: labelPrefix,
          data: sortedVals,
          backgroundColor: "rgba(116, 81, 45, 0.1)",
          borderColor: "#543310",
          borderWidth: 3,
          pointBackgroundColor: "#AF8F6F",
          pointBorderColor: "#543310",
          pointRadius: 5,
          pointHoverRadius: 7,
          tension: 0.4,
          fill: true,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: "#543310",
          titleColor: "#F8F4E1",
          bodyColor: "#F8F4E1",
          callbacks: {
            label: (ctx) => valuePrefix + ctx.parsed.y.toLocaleString() + valueSuffix,
          },
        },
      },
      scales: {
        y: { 
          beginAtZero: true, 
          grid: { display: false },
          ticks: { callback: (v) => valuePrefix + v + valueSuffix }
        },
        x: { grid: { display: false } }
      },
    },
  })
}

function generateForecast(data, count) {
  if (!data || data.length < 2) return new Array(count).fill(0)
  const n = data.length
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0
  for (let i = 0; i < n; i++) {
    sumX += i
    sumY += data[i]
    sumXY += i * data[i]
    sumX2 += i * i
  }
  const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX)
  const intercept = (sumY - slope * sumX) / n
  const results = []
  for (let i = n; i < n + count; i++) {
    results.push(Math.max(0, slope * i + intercept))
  }
  return results
}

let predChartInstance = null
function createForecastChart(pastLabels, pastValues, interval) {
  if (predChartInstance) {
      predChartInstance.destroy()
      predChartInstance = null
  }
  
  const canvas = document.getElementById("analyticsPredictiveChart")
  if (!canvas) return

  const sorted = (pastLabels || []).slice().sort()
  const map = new Map(pastLabels.map((l, i) => [l, pastValues[i]]))
  const sortedVals = sorted.map((l) => map.get(l) || 0)
  const forecast = generateForecast(sortedVals, 7)

  const mode = document.getElementById("catMode")?.value || "amount"
  const isQty = mode === "quantity"
  const valuePrefix = isQty ? "" : "₱"
  const valueSuffix = isQty ? " Qty" : ""

  predChartInstance = new window.Chart(canvas, {
    type: "line",
    data: {
      labels: [...sorted.slice(-7), "Next 7 Days"],
      datasets: [
        {
          label: "Forecast",
          data: [...sortedVals.slice(-7), forecast[0]],
          backgroundColor: "rgba(116, 81, 45, 0.1)",
          borderColor: "#543310",
          borderWidth: 3,
          pointBackgroundColor: "#AF8F6F",
          pointBorderColor: "#543310",
          pointRadius: 5,
          tension: 0.4,
          fill: true,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: "#543310",
          titleColor: "#F8F4E1",
          bodyColor: "#F8F4E1",
          callbacks: {
            label: (ctx) => valuePrefix + ctx.parsed.y.toLocaleString() + valueSuffix,
          },
        },
      },
      scales: {
        y: { 
          beginAtZero: true, 
          grid: { display: false },
          ticks: { callback: (v) => valuePrefix + v + valueSuffix }
        },
        x: { grid: { display: false } }
      },
    },
  })
}

async function loadCategoryTotals(startArg, endArg) {
  const productCats = {} // Map docId -> catId
  const productCatsByName = {} // Map name -> catId
  try {
      const { data: productData, error } = await getDB().from("products").select("*")
      if (productData) {
          productData.forEach(d => {
              const catId = d.category_id
              if (catId) {
                  productCats[d.id] = catId
                  if (d.id) {
                      productCats[d.id] = catId
                      productCats[String(d.id)] = catId
                  }
                  if (d.name) {
                      productCatsByName[d.name.trim().toLowerCase()] = catId
                  }
              }
          })
      }
  } catch (e) {
      console.error("[v0] Error loading products for mapping:", e)
  }

  const interval = document.getElementById("anInterval")?.value || "week"
  const mode = document.getElementById("catMode")?.value || "amount"
  const sourceSel = document.getElementById("anSource")?.value || "all"
  
  let start = startArg || document.getElementById("anStart")?.value
  let end = endArg || document.getElementById("anEnd")?.value
  if (!start || !end) {
      const range = calculateDateRange(interval)
      start = range.start
      end = range.end
  }
  
  const totals = {}

  const { data: salesData } = await getDB().from("sales").select("*")
  if (salesData) {
      salesData.forEach((d) => {
        if (!isFullyPaidSaleRecord(d)) return
        if (!matchesAnSource(d, sourceSel)) return
        const dateStr = formatYMDFromRecord(d)
        if (!dateStr) return
        if (start && dateStr < start) return;
        if (end && dateStr > end) return;
        
        let items = d.items || [];
        if (typeof items === 'string') {
           try { items = JSON.parse(items); } catch(e) { items = []; }
        }
        
        items.forEach((it) => {
          let catId = it.category_id || it.categoryId
          if (!catId && it.id) catId = productCats[it.id]
          if (!catId && it.name) {
              const rawLower = String(it.name).trim().toLowerCase()
              const baseLower = analyticsProductGroupKey(it.name).toLowerCase()
              catId = productCatsByName[rawLower] || productCatsByName[baseLower]
          }

          if (!catId && it.name) {
              const lowerName = String(it.name).toLowerCase()
              const baseLower = analyticsProductGroupKey(it.name).toLowerCase()
              for (const [id, label] of Object.entries(categoryMap)) {
                   const lab = label.toLowerCase()
                   if (lowerName.includes(lab) || baseLower.includes(lab)) { catId = id; break; }
              }
          }
          
          catId = Number(catId)
          let name = categoryMap[catId]
          if (!name) {
              name = isTerminalChannelSale(d) ? "Others" : "Customized"
          }
          
          if (!totals[name]) totals[name] = 0
          if (mode === "quantity") {
              totals[name] += Number(it.quantity || it.qty || 0);
          } else {
              let amt = Number(it.amount);
              if (isNaN(amt) || amt === 0) amt = Number(it.price || 0) * Number(it.quantity || it.qty || 0);
              totals[name] += amt;
          }
        })
      })
  }

  // Use sales records only for category totals.

  return { labels: Object.keys(totals), values: Object.values(totals) }
}

let categoryChartInstance = null
function createCategoryPieChart(labels, values, titlePrefix = "Sales by Category", titleSuffix = "") {
  const canvas = document.getElementById("analyticsCategoryChart")
  if (!canvas) return

  if (categoryChartInstance) {
    categoryChartInstance.destroy()
    categoryChartInstance = null
  }

  const total = values.reduce((a, b) => a + b, 0)
  
  const colorMap = {
    Coffee: "#4A2C0B",
    "Non-coffee": "#6A4317",
    Pastries: "#8A5D2A",
    Frappe: "#B38657",
    Soda: "#D8C2A6",
    Others: "#9E9E9E",
    "No Data": "#C7C7C7"
  }

  const legendContainer = document.getElementById("categoryLegend")
  if (legendContainer) {
    legendContainer.innerHTML = labels.map((l, i) => {
      const color = colorMap[l] || (String(l).toLowerCase().includes("other") ? "#9E9E9E" : "#999999")
      const pct = total > 0 ? Math.round((values[i] / total) * 100) : 0
      return `
        <div style="display: flex; align-items: center; gap: 15px;">
          <div style="width: 20px; height: 20px; border-radius: 50%; background: ${color}; border: 1px solid black;"></div>
          <span style="font-size: 1.2rem; font-weight: 500; flex: 1;">${l}</span>
          <span style="font-size: 1.2rem; font-weight: 500;">${pct}%</span>
        </div>
      `
    }).join("")
  }

  const colors = labels.map(l => colorMap[l] || (String(l).toLowerCase().includes("other") ? "#9E9E9E" : "#999999"))

  categoryChartInstance = new window.Chart(canvas, {
    type: "pie",
    data: {
      labels: labels,
      datasets: [
        {
          data: values,
          backgroundColor: colors,
          borderColor: "black",
          borderWidth: 1,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: "#543310",
          titleColor: "#F8F4E1",
          bodyColor: "#F8F4E1",
          callbacks: {
            label: (ctx) => {
              const pct = total > 0 ? Math.round((ctx.parsed / total) * 100) : 0
              return ctx.label + ": " + pct + "%"
            },
          },
        },
      },
    },
  })
}

let timeChartInstance = null
async function createTimeAnalysisChart(start, end) {
  const canvas = document.getElementById("analyticsTimeAnalysisChart")
  if (!canvas) return

  if (timeChartInstance) {
    timeChartInstance.destroy()
    timeChartInstance = null
  }

  const hourBuckets = new Array(24).fill(0)
  const sourceSel = document.getElementById("anSource")?.value || "all"
  const mode = document.getElementById("catMode")?.value || "amount"
  const isQty = mode === "quantity"
  const valuePrefix = isQty ? "" : "₱"
  const valueSuffix = isQty ? " Qty" : ""
  const datasetLabel = isQty ? "Items by Hour" : "Sales by Hour (₱)"

  const { data: salesRows } = await getDB().from("sales").select("*")
  const allData = (salesRows || []).filter((d) => isFullyPaidSaleRecord(d) && matchesAnSource(d, sourceSel))

  allData.forEach(d => {
    const date = getTransactionInstant(d)
    if (!date) return
    
    const dateStr = formatDateYMD(date)
    if (start && dateStr < start) return
    if (end && dateStr > end) return
    
    const hour = date.getHours()
    if (isQty) {
      let items = d.items
      if (typeof items === "string") try { items = JSON.parse(items) } catch (e) { items = [] }
      items = Array.isArray(items) ? items : []
      const qty = items.reduce((s, i) => s + Number(i.quantity || i.qty || 0), 0)
      hourBuckets[hour] += qty
    } else {
      hourBuckets[hour] += Number(d.total || d.amount || 0)
    }
  })

  const labels = Array.from({ length: 24 }, (_, i) => `${i}:00`)
  
  timeChartInstance = new window.Chart(canvas, {
    type: "bar",
    data: {
      labels: labels,
      datasets: [{
        label: datasetLabel,
        data: hourBuckets,
        backgroundColor: "#AF8F6F",
        borderColor: "#543310",
        borderWidth: 1,
        borderRadius: 5
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: "#543310",
          titleColor: "#F8F4E1",
          bodyColor: "#F8F4E1",
          callbacks: { label: (ctx) => valuePrefix + ctx.parsed.y.toLocaleString() + valueSuffix }
        }
      },
      scales: {
        y: { beginAtZero: true, grid: { display: false }, ticks: { callback: (v) => valuePrefix + v + valueSuffix } },
        x: { grid: { display: false } }
      }
    }
  })
}

async function runDashboard() {
  if (isDashboardRunning) return
  isDashboardRunning = true
  unlockAnalyticsDateInputs()

  try {
    const activeTab = document.querySelector(".analytics-tab-btn.active")?.getAttribute("data-tab") || "overview"
    
    let interval, start, end, mode, isQty
    
    if (activeTab === "overview") {
      interval = document.getElementById("anInterval")?.value || "week"
      mode = document.getElementById("catMode")?.value || "amount"
      isQty = mode === "quantity"
      start = document.getElementById("anStart")?.value
      end = document.getElementById("anEnd")?.value
    } else {
      interval = document.getElementById("anIndepthInterval")?.value || "week"
      mode = "amount" // In-depth usually revenue focused
      isQty = false
      start = document.getElementById("anIndepthStart")?.value
      end = document.getElementById("anIndepthEnd")?.value
    }
    
    let range = calculateDateRange(interval)
    if (!start) start = range.start
    if (!end) end = range.end
    
    const { dailyTotals, totalQty, totalSales } = await loadSales(start, end)
    
    const labels = Object.keys(dailyTotals)
    const values = Object.values(dailyTotals)
    
    // Always update Overview charts if they exist
    createDescriptiveChart(labels, values)
    createForecastChart(labels, values, interval)
    
    const kpiTotalEl = document.getElementById("kpiTotal")
    const kpiAvgEl = document.getElementById("kpiAvg")
    const kpiQtyEl = document.getElementById("kpiQty")
    const kpiQtyTopProductsEl = document.getElementById("kpiQtyTopProducts")
    const kpiQtyIndepthEl = document.getElementById("kpiQtyIndepth")
    const qtyStr = Number(totalQty || 0).toLocaleString()
    
    if (kpiTotalEl) kpiTotalEl.innerText = "P " + Number(totalSales || 0).toLocaleString()
    if (kpiQtyEl) kpiQtyEl.innerText = qtyStr
    if (kpiQtyTopProductsEl) kpiQtyTopProductsEl.innerText = qtyStr
    if (kpiQtyIndepthEl) kpiQtyIndepthEl.innerText = qtyStr
    
    const avg = values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0
    const modeFmt = document.getElementById("catMode")?.value || "amount"
    const isQtyFmt = modeFmt === "quantity"
    if (kpiAvgEl) {
      const r = Math.round(avg).toLocaleString()
      kpiAvgEl.innerText = isQtyFmt ? `${r} /day` : `P ${r} /day`
    }

    const catData = await loadCategoryTotals(start, end)
    // Sort category data in descending order by values
    const catItems = catData.labels.map((l, i) => ({ label: l, value: catData.values[i] }))
      .sort((a, b) => b.value - a.value)
    createCategoryPieChart(catItems.map(i => i.label), catItems.map(i => i.value))
    
    // Time Analysis
    createTimeAnalysisChart(start, end)
    
    // In-depth and other sub-components
    try {
      const result = await loadProductAnalyticsTotals(start, end)
      renderAnalyticsProductTable(result)
      populateProductSelect(result.totals)
      
      const selectedProduct = document.getElementById("anProduct")?.value
      if (selectedProduct) {
        updateProductInDepthCharts(selectedProduct, start, end, interval)
      }
    } catch(e) {
      console.error("Error updating sub-components:", e)
    }
    
  } catch (e) {
    console.error("Dashboard run error:", e)
  } finally {
    isDashboardRunning = false
  }
}

let productTrendChartInstance = null
let productForecastChartInstance = null

async function updateProductInDepthCharts(productName, start, end, interval) {
  const { data: salesData } = await getDB().from("sales").select("*")
  const productDailyData = {}
  
  if (salesData) {
    salesData.forEach(s => {
      if (!isFullyPaidSaleRecord(s)) return
      const inst = getTransactionInstant(s)
      if (!inst) return
      const date = formatDateYMD(inst)
      if (start && date < start) return
      if (end && date > end) return
      
      let items = s.items || []
      if (typeof items === 'string') try { items = JSON.parse(items) } catch(e) {}
      
      items.forEach(it => {
        if (analyticsProductGroupKey(it.name || "") === productName) {
          if (!productDailyData[date]) productDailyData[date] = 0
          productDailyData[date] += Number(it.amount || (Number(it.price || 0) * Number(it.quantity || 0)))
        }
      })
    })
  }

  const labels = Object.keys(productDailyData).sort()
  const values = labels.map(l => productDailyData[l])
  
  // Update Overtime Chart
  const trendCanvas = document.getElementById("analyticsProductTrendChart")
  if (trendCanvas) {
    if (productTrendChartInstance) productTrendChartInstance.destroy()
    productTrendChartInstance = new window.Chart(trendCanvas, {
      type: "line",
      data: {
        labels,
        datasets: [{
          label: "Revenue",
          data: values,
          borderColor: "#543310",
          backgroundColor: "rgba(116, 81, 45, 0.1)",
          fill: true,
          tension: 0.4
        }]
      },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } }
    })
  }

  // Update Forecast Chart
  const forecastCanvas = document.getElementById("analyticsProductForecastChart")
  if (forecastCanvas) {
    const forecast = generateForecast(values, 7)
    if (productForecastChartInstance) productForecastChartInstance.destroy()
    productForecastChartInstance = new window.Chart(forecastCanvas, {
      type: "line",
      data: {
        labels: [...labels.slice(-7), "Next 7 Days"],
        datasets: [{
          label: "Forecast",
          data: [...values.slice(-7), forecast[0]],
          borderColor: "#AF8F6F",
          backgroundColor: "rgba(175, 143, 111, 0.1)",
          fill: true,
          tension: 0.4
        }]
      },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } }
    })
  }

  // Update Predictive Recommendation
  const recEl = document.getElementById("analyticsProductInsights")
  if (recEl) {
    const avgRevenue = values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0
    const trend = values.length >= 2 ? (values[values.length-1] > values[values.length-2] ? "increasing" : "decreasing") : "stable"
    recEl.innerHTML = `
      <p>Based on recent data, <strong>${productName}</strong> shows an <strong>${trend}</strong> trend.</p>
      <p>Average revenue per day: <strong>P ${Math.round(avgRevenue).toLocaleString()}</strong>.</p>
      <p>Recommendation: ${trend === 'increasing' ? 'Consider increasing stock levels for this item.' : 'Monitor sales closely or consider a limited-time promo.'}</p>
    `
  }
}

function populateProductSelect(totals) {
  const select = document.getElementById("anProduct")
  if (!select) return
  
  const currentValue = select.value
  const items = Object.values(totals || {}).sort((a, b) => a.name.localeCompare(b.name))
  
  select.innerHTML = '<option value="">Select Product</option>' + 
    items.map(it => `<option value="${it.name}" ${currentValue === it.name ? 'selected' : ''}>${it.name}</option>`).join('')
}

async function loadProductAnalyticsTotals(start, end) {
    const { data: salesData } = await getDB().from("sales").select("*")
    const totals = {}
    
    if (salesData) {
        salesData.forEach(s => {
            if (!isFullyPaidSaleRecord(s)) return
            const inst = getTransactionInstant(s)
            if (!inst) return
            const date = formatDateYMD(inst)
            if (start && date < start) return
            if (end && date > end) return
            
            let items = s.items || []
            if (typeof items === 'string') try { items = JSON.parse(items) } catch(e) {}
            
            items.forEach(it => {
                const name = analyticsProductGroupKey(it.name || "Custom")
                if (!totals[name]) totals[name] = { name, qty: 0, revenue: 0 }
                totals[name].qty += Number(it.quantity || it.qty || 0)
                totals[name].revenue += Number(it.amount || (Number(it.price || 0) * Number(it.quantity || 0)))
            })
        })
    }
    const grandTotal = Object.values(totals).reduce((sum, row) => sum + row.revenue, 0)
    return { totals, grandTotal }
}

function renderAnalyticsProductTable(result) {
  const topProductsList = document.getElementById("topProductsList")
  const topProductsListIndepth = document.getElementById("topProductsListIndepth")
  const indepthBody = document.getElementById("analyticsProductBodyIndepth")
  
  if (topProductsList) topProductsList.innerHTML = ""
  if (topProductsListIndepth) topProductsListIndepth.innerHTML = ""
  if (indepthBody) indepthBody.innerHTML = ""

  const items = Object.values(result.totals || {}).sort((a, b) => b.revenue - a.revenue)
  if (!items.length) return

  const top5 = items.slice(0, 5)
  const colors = ["#1a1a1a", "#543310", "#74512D", "#967658", "#AF8F6F"]
  
  const renderList = (container) => {
    container.innerHTML = top5.map((item, idx) => {
      const pct = result.grandTotal ? Math.round((item.revenue / result.grandTotal) * 100) : 0
      return `
        <div style="display: flex; align-items: center; gap: 15px;">
          <div style="width: 20px; height: 20px; border-radius: 50%; background: ${colors[idx] || "#999"}; border: 1px solid black;"></div>
          <span style="font-size: 1.2rem; font-weight: 500; flex: 1;">${item.name}</span>
          <span style="font-size: 1.2rem; font-weight: 500;">${pct}%</span>
        </div>
      `
    }).join("")
  }

  if (topProductsList) renderList(topProductsList)
  if (topProductsListIndepth) renderList(topProductsListIndepth)

  if (indepthBody) {
    indepthBody.innerHTML = items.map(i => `
      <tr>
        <td>${i.name}</td>
        <td>${i.qty}</td>
        <td>P ${Math.round(i.qty ? i.revenue / i.qty : 0).toLocaleString()}</td>
        <td>P ${Math.round(i.revenue).toLocaleString()}</td>
      </tr>
    `).join("")
  }
}

// Initial Load
document.addEventListener("DOMContentLoaded", () => {
    unlockAnalyticsDateInputs()
    runDashboard()
})

if (typeof document !== "undefined") {
  document.addEventListener("DOMContentLoaded", () => {
    const tabButtons = document.querySelectorAll(".analytics-tab-btn")
    tabButtons.forEach((btn) => {
      btn.addEventListener("click", () => {
        const tab = btn.getAttribute("data-tab")
        tabButtons.forEach((b) => b.classList.remove("active"))
        btn.classList.add("active")
        
        document.querySelectorAll(".analytics-tab-content").forEach((c) => c.style.display = "none")
        let targetId = "analyticsOverviewTab"
        if (tab === "product") targetId = "analyticsProductTab"
        else if (tab === "transactions") targetId = "analyticsTransactionsTab"
        
        const target = document.getElementById(targetId)
        if (target) target.style.display = "block"
        
        if (tab === "transactions") fetchTransactions()
        else runDashboard()
      })
    })
  })
}

async function fetchTransactions() {
  console.log("[v0] Fetching transactions...")
  unlockAnalyticsDateInputs()
  const interval = normalizeTransInterval(document.getElementById("transInterval")?.value)
  const sourceSel = document.getElementById("transSource")?.value || "all"
  const userStart = document.getElementById("transStart")?.value
  const userEnd = document.getElementById("transEnd")?.value
  
  let range = calculateDateRange(interval)
  let start = userStart || range.start
  let end = userEnd || range.end

  // Update input values if they were empty
  if (document.getElementById("transStart") && !document.getElementById("transStart").value) {
    document.getElementById("transStart").value = start
  }
  if (document.getElementById("transEnd") && !document.getElementById("transEnd").value) {
    document.getElementById("transEnd").value = end
  }

  console.log(`[v0] Transaction filter: source=${sourceSel}, start=${start}, end=${end}, interval=${interval}`)

  let allTransactions = []

  try {
    const db = getDB()
    if (!db) throw new Error("Database not initialized")

    const { data: salesRows, error: salesErr } = await db
      .from("sales")
      .select("*")
      .order("timestamp", { ascending: false })
    if (salesErr) throw salesErr
    allTransactions = (salesRows || [])
      .filter(isFullyPaidSaleRecord)
      .filter((s) => matchesAnSource(s, sourceSel))
  } catch (err) {
    console.error("[v0] Error fetching transaction data:", err)
  }
    
  const list = document.getElementById("transactionsListTable")
  if (!list) return
  
  const filteredData = allTransactions.filter(t => {
    const dateObj = getTransactionInstant(t)
    if (!dateObj) return false
    const dateStr = formatDateYMD(dateObj)
    const isAfterStart = !start || dateStr >= start
    const isBeforeEnd = !end || dateStr <= end
    return isAfterStart && isBeforeEnd
  })

  const kpiT = document.getElementById("transKpiTotal")
  const kpiQ = document.getElementById("transKpiQty")
  const kpiA = document.getElementById("transKpiAvg")
  const thDate = document.getElementById("transTableHeadDate")

  if (thDate) thDate.textContent = interval === "day" ? "Date" : "Period"

  const transMode = document.getElementById("catMode")?.value || "amount"
  const transIsQty = transMode === "quantity"

  if (filteredData.length === 0) {
    list.innerHTML =
      '<tr><td colspan="4" style="text-align: center; padding: 40px; color: #888;">No transactions found for this range.</td></tr>'
    if (kpiT) kpiT.innerText = "P 0"
    if (kpiQ) kpiQ.innerText = "0"
    if (kpiA) kpiA.innerText = transIsQty ? "0 /day" : "P 0 /day"
    return
  }

  let transGrandTotal = 0
  let transGrandQty = 0
  filteredData.forEach((t) => {
    let items = t.items
    if (typeof items === "string") try { items = JSON.parse(items) } catch (e) {}
    items = Array.isArray(items) ? items : []
    transGrandQty += items.reduce((s, i) => s + Number(i.quantity || i.qty || 0), 0)
    let amt = Number(t.total || 0)
    if (amt === 0) {
      amt = items.reduce((s, i) => s + Number(i.price || 0) * Number(i.quantity || i.qty || 1), 0)
    }
    transGrandTotal += amt
  })
  const daySpan = inclusiveDaySpanYMD(start, end)
  const transAvgDay = transIsQty ? transGrandQty / daySpan : transGrandTotal / daySpan
  if (kpiT) kpiT.innerText = "P " + Number(transGrandTotal || 0).toLocaleString()
  if (kpiQ) kpiQ.innerText = Number(transGrandQty || 0).toLocaleString()
  if (kpiA) {
    const r = Math.round(transAvgDay || 0).toLocaleString()
    kpiA.innerText = transIsQty ? `${r} /day` : `P ${r} /day`
  }

  // Grouping logic for Transactions Tab (stable keys + labels; matches Overview sales bucketing)
  const groups = {}
  filteredData.forEach((t) => {
    const dateObj = getTransactionInstant(t)
    if (!dateObj) return
    let groupKey = ""
    let groupLabel = ""
    if (interval === "day") {
      groupKey = formatDateYMD(dateObj)
      groupLabel = groupKey
    } else if (interval === "week") {
      groupKey = getWeekKey(dateObj)
      groupLabel = `Week ${groupKey}`
    } else if (interval === "month") {
      const y = dateObj.getFullYear()
      const mo = dateObj.getMonth()
      groupKey = `${y}-${String(mo + 1).padStart(2, "0")}`
      groupLabel = `${dateObj.toLocaleString("default", { month: "long" })} ${y}`
    } else if (interval === "quarter") {
      groupKey = getQuarterKey(dateObj)
      const q = Math.floor(dateObj.getMonth() / 3) + 1
      groupLabel = `Quarter ${q} - ${dateObj.getFullYear()}`
    } else if (interval === "annual") {
      groupKey = getAnnualKey(dateObj)
      groupLabel = groupKey
    } else {
      groupKey = formatDateYMD(dateObj)
      groupLabel = groupKey
    }

    if (!groups[groupKey]) {
      groups[groupKey] = { label: groupLabel, itemsCount: 0, totalAmount: 0, transactions: [] }
    }

    let items = t.items
    if (typeof items === 'string') try { items = JSON.parse(items) } catch(e) {}
    items = Array.isArray(items) ? items : []
    
    const qty = items.reduce((s, i) => s + Number(i.quantity || i.qty || 0), 0)
    let amt = Number(t.total || 0)
    if (amt === 0) amt = items.reduce((s, i) => s + (Number(i.price || 0) * Number(i.quantity || i.qty || 1)), 0)

    groups[groupKey].itemsCount += qty
    groups[groupKey].totalAmount += amt
    groups[groupKey].transactions.push({ ...t, qty, amt, items, dateObj })
  })

  const showTimeOnly = interval === "day"
  const groupEntries = Object.entries(groups)
    .map(([key, g]) => {
      const maxTime = Math.max(...g.transactions.map((x) => x.dateObj.getTime()))
      return { key, g, maxTime }
    })
    .sort((a, b) => b.maxTime - a.maxTime)

  const productsCellHtml = (g) =>
    `<div style="font-size: 0.85rem; color: #666;">${g.transactions.length} transaction(s)</div>`

  list.innerHTML = groupEntries.map(({ key, g }, idx) => {
    const groupId = "trans-group-" + idx

    const transRows = g.transactions
      .sort((a, b) => b.dateObj - a.dateObj)
      .map((t) => {
        const whenStr = showTimeOnly
          ? t.dateObj.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
          : `${formatDateYMD(t.dateObj)} ${t.dateObj.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
        const itemsArr = Array.isArray(t.items) ? t.items : []
        const itemsHtml = itemsArr
          .map((it) => {
            const q = it.quantity || it.qty || 1
            const nm = escapeHtml(it.name || "Item")
            return `
        <div class="transaction-product-item" style="padding: 5px 0; border-bottom: 1px dotted #eee;">
          <div class="transaction-product-time" style="font-size: 0.8rem; color: #999;">${escapeHtml(whenStr)}</div>
          <div style="font-weight: 700;">x${q} ${nm}</div>
        </div>`
          })
          .join("")

        const ch = escapeHtml(getTransactionChannelLabel(t))
        return `
        <div style="margin-bottom: 15px; padding: 10px; background: #fff; border-radius: 6px; border: 1px solid #eee;">
          <div style="display: flex; justify-content: space-between; margin-bottom: 8px; border-bottom: 1px solid #f5f5f5; padding-bottom: 5px;">
             <span style="font-weight: 700; color: #543310;">${ch}</span>
             <span style="font-weight: 800;">Total: P ${t.amt.toLocaleString()}</span>
          </div>
          ${itemsHtml}
        </div>`
      })
      .join("")

    return `
      <tr onclick="toggleReportGroup('${groupId}')" style="cursor: pointer;" class="report-group-header">
        <td style="font-weight: 700;">${escapeHtml(g.label)}</td>
        <td style="text-align: center; font-weight: 700;">${g.itemsCount}</td>
        <td>${productsCellHtml(g)}</td>
        <td style="font-weight: 800; text-align: right;">P ${g.totalAmount.toLocaleString()}</td>
      </tr>
      <tr id="${groupId}" style="display: none; background: #fafafa;">
        <td colspan="4" style="padding: 15px; vertical-align: top;">
          ${transRows}
        </td>
      </tr>
    `
  }).join("")
}

/** Clear preset dates so switching Weekly/Monthly/etc. applies the right default range (not Daily’s 7-day window). */
window.resetTransactionDatesThenFetch = function () {
  const ts = document.getElementById("transStart")
  const te = document.getElementById("transEnd")
  if (ts) ts.value = ""
  if (te) te.value = ""
  fetchTransactions()
}

window.downloadTransactionsCSV = async function() {
  const interval = normalizeTransInterval(document.getElementById("transInterval")?.value)
  const sourceSel = document.getElementById("transSource")?.value || "all"
  const userStart = document.getElementById("transStart")?.value
  const userEnd = document.getElementById("transEnd")?.value
  
  let range = calculateDateRange(interval)
  let start = userStart || range.start
  let end = userEnd || range.end

  let allData = []
  
  try {
    const { data } = await getDB().from("sales").select("*").order("timestamp", { ascending: false })
    if (data) {
      allData = data.filter(isFullyPaidSaleRecord).filter((s) => matchesAnSource(s, sourceSel))
    }
  } catch (e) {
    console.error("CSV export fetch failed", e)
  }

  const filtered = allData.filter(t => {
    const inst = getTransactionInstant(t)
    if (!inst) return false
    const dateStr = formatDateYMD(inst)
    return (!start || dateStr >= start) && (!end || dateStr <= end)
  })

  let csv = "Date,Type,Total Items,Products,Total Sold\n"
  filtered.forEach(t => {
    let items = t.items
    if (typeof items === 'string') try { items = JSON.parse(items) } catch(e) {}
    items = Array.isArray(items) ? items : []
    const totalQty = items.reduce((s, i) => s + Number(i.quantity || i.qty || 0), 0)
    const products = items.map(i => `${i.name}(x${i.quantity || i.qty || 1})`).join("; ")
    const type = getTransactionChannelLabel(t)
    const tDate = getTransactionInstant(t) || new Date()
    csv += `"${tDate.toLocaleDateString()}",${type},${totalQty},"${products}","P ${Number(t.total || 0).toLocaleString()}"\n`
  })

  const blob = new Blob([csv], { type: 'text/csv' })
  const url = window.URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.setAttribute('hidden', '')
  a.setAttribute('href', url)
  a.setAttribute('download', `transactions_${start}_to_${end}.csv`)
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
}

window.toggleReportGroup = function(id) {
  const el = document.getElementById(id)
  if (el) {
    el.style.display = el.style.display === 'none' ? 'table-row' : 'none'
  }
}

window.renderReports = async function() {
  console.log("[v0] Rendering reports...")
  const interval = document.getElementById("repInterval")?.value || "daily"
  const start = document.getElementById("repStart")?.value
  const end = document.getElementById("repEnd")?.value
  const list = document.getElementById("repItemBody")
  if (!list) return

  list.innerHTML = '<tr><td colspan="4" style="text-align: center; padding: 20px;">Loading reports...</td></tr>'

  let allData = []
  try {
    const db = getDB()
    const { data: sales } = await db.from("sales").select("*")
    if (sales) allData = sales.filter(isFullyPaidSaleRecord)
  } catch (e) {
    console.error("Error fetching report data", e)
  }

  // Filter by date range
  const filtered = allData.filter(t => {
    const inst = getTransactionInstant(t)
    if (!inst) return false
    const dateStr = formatDateYMD(inst)
    return (!start || dateStr >= start) && (!end || dateStr <= end)
  })

  // Grouping logic
  const groups = {}
  filtered.forEach(t => {
    const dateObj = getTransactionInstant(t)
    if (!dateObj) return
    let key = ""
    if (interval === "daily") {
      key = formatDateYMD(dateObj)
    } else if (interval === "weekly") {
      const firstDayOfMonth = new Date(dateObj.getFullYear(), dateObj.getMonth(), 1)
      const weekNum = Math.ceil((dateObj.getDate() + firstDayOfMonth.getDay()) / 7)
      key = `WEEK ${weekNum} - ${dateObj.toLocaleString('default', { month: 'short' })} ${dateObj.getFullYear()}`
    } else if (interval === "monthly") {
      key = `${dateObj.toLocaleString('default', { month: 'long' })} ${dateObj.getFullYear()}`
    } else if (interval === "quarterly") {
      const q = Math.floor(dateObj.getMonth() / 3) + 1
      key = `Quarter ${q} - ${dateObj.getFullYear()}`
    } else if (interval === "yearly") {
      key = String(dateObj.getFullYear())
    }

    if (!groups[key]) {
      groups[key] = {
        label: key,
        itemsCount: 0,
        totalAmount: 0,
        transactions: []
      }
    }

    let items = t.items
    if (typeof items === 'string') try { items = JSON.parse(items) } catch(e) {}
    items = Array.isArray(items) ? items : []
    
    const qty = items.reduce((s, i) => s + Number(i.quantity || i.qty || 0), 0)
    let amt = Number(t.total || 0)
    if (amt === 0) amt = items.reduce((s, i) => s + (Number(i.price || 0) * Number(i.quantity || i.qty || 1)), 0)

    groups[key].itemsCount += qty
    groups[key].totalAmount += amt
    groups[key].transactions.push({
      ...t,
      qty,
      amt,
      items,
      dateObj
    })
  })

  const sortedKeys = Object.keys(groups).sort((a, b) => b.localeCompare(a))
  
  // KPIs
  let grandTotal = 0
  let totalTrans = filtered.length
  filtered.forEach(t => {
    let amt = Number(t.total || 0)
    if (amt === 0) {
      let items = t.items
      if (typeof items === 'string') try { items = JSON.parse(items) } catch(e) {}
      items = Array.isArray(items) ? items : []
      amt = items.reduce((s, i) => s + (Number(i.price || 0) * Number(i.quantity || i.qty || 1)), 0)
    }
    grandTotal += amt
  })

  const kpiTotal = document.getElementById("repKpiTotal")
  const kpiTrans = document.getElementById("repKpiValue2")
  const kpiAvg = document.getElementById("repKpiValue3")

  if (kpiTotal) kpiTotal.textContent = `₱${grandTotal.toLocaleString(undefined, { minimumFractionDigits: 2 })}`
  if (kpiTrans) kpiTrans.textContent = totalTrans
  if (kpiAvg) kpiAvg.textContent = `₱${(totalTrans ? grandTotal / totalTrans : 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}`

  if (sortedKeys.length === 0) {
    list.innerHTML = '<tr><td colspan="4" style="text-align: center; padding: 40px; color: #888;">No data found.</td></tr>'
    return
  }

  list.innerHTML = sortedKeys.map(key => {
    const g = groups[key]
    const groupId = "group-" + key.replace(/\s+/g, "-").toLowerCase()
    
    const transRows = g.transactions.map(t => {
      const isOnline = t.payment_method === 'online'
      const alreadyPaid = Number(t.paid_amount || 0)
      const totalAmt = t.amt
      const showPartial = isOnline && alreadyPaid > 0 && alreadyPaid < totalAmt

      const productsHtml = t.items.map(it => `
        <tr>
          <td>${it.name}</td>
          <td style="text-align: center;">${it.quantity || it.qty || 1}</td>
          <td style="text-align: right;">₱${Number(it.price || 0).toLocaleString()}</td>
          <td style="text-align: right; font-weight: 700;">₱${(Number(it.price || 0) * Number(it.quantity || it.qty || 1)).toLocaleString()}</td>
        </tr>
      `).join('')

      return `
        <div class="report-transaction-detail" style="margin-bottom: 20px; padding: 15px; background: #fff; border-radius: 8px; border-left: 4px solid #543310; box-shadow: 0 2px 5px rgba(0,0,0,0.05);">
          <div style="font-weight: 700; margin-bottom: 10px; color: #543310;">Transaction Details</div>
          <div style="font-size: 0.9rem; margin-bottom: 10px;">Payment Method: <span style="font-weight: 700; color: ${isOnline ? '#2196F3' : '#4CAF50'};">${(t.payment_method || 'CASH').toUpperCase()}</span></div>
          
          ${showPartial ? `
            <div style="background: #FFF9C4; padding: 8px 12px; border-radius: 4px; font-size: 0.85rem; margin-bottom: 10px; border-left: 3px solid #FBC02D;">
              <strong>Already Paid:</strong> ₱${alreadyPaid.toLocaleString()} of ₱${totalAmt.toLocaleString()} total amount.
            </div>
          ` : ''}

          <table style="width: 100%; border-collapse: collapse; font-size: 0.85rem;">
            <thead>
              <tr style="border-bottom: 1px solid #eee; color: #999; font-size: 0.75rem;">
                <th style="text-align: left; padding: 5px;">PRODUCT</th>
                <th style="text-align: center; padding: 5px;">QTY</th>
                <th style="text-align: right; padding: 5px;">ORIGINAL PRICE</th>
                <th style="text-align: right; padding: 5px;">ALLOCATED AMOUNT</th>
              </tr>
            </thead>
            <tbody>
              ${productsHtml}
            </tbody>
          </table>
        </div>
      `
    }).join('')

    return `
      <tr class="report-group-header" onclick="toggleReportGroup('${groupId}')" style="cursor: pointer;">
        <td style="font-weight: 700;">${g.label}</td>
        <td style="text-align: center;">${g.itemsCount}</td>
        <td style="text-align: right; font-weight: 700;">₱${g.totalAmount.toLocaleString()}</td>
        <td style="text-align: center;"><span class="status-badge status-completed">Completed</span></td>
      </tr>
      <tr id="${groupId}" class="report-group-details" style="display: none; background: #fafafa;">
        <td colspan="4" style="padding: 20px;">
          ${transRows}
        </td>
      </tr>
    `
  }).join('')
}

window.downloadReportsCSV = function() {
  console.log("CSV Download triggered")
}
