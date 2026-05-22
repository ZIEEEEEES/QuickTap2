// kitchen/kitchen.js

let db = null;

async function upsertCustomerNotificationForKitchen({ customerId, orderId, sourceTable, message, type }) {
    try {
        const database = window.db || getDB();
        if (!database || !orderId || !customerId) return;

        const nowIso = new Date().toISOString();
        const { data: existing } = await database
            .from("customer_notifications")
            .select("id,status")
            .eq("order_id", String(orderId))
            .eq("source_table", sourceTable || "pending_orders")
            .in("status", ["unread", "seen", "paid"])
            .order("created_at", { ascending: false })
            .limit(1);

        if (existing && existing.length) {
            const updateData = {
                customer_id: customerId,
                status: "unread",
                message: message || null,
                updated_at: nowIso
            };
            if (type) {
                updateData.type = type;
            }
            await database.from("customer_notifications")
                .update(updateData)
                .eq("id", existing[0].id);
        } else {
            const insertData = {
                customer_id: customerId,
                order_id: String(orderId),
                source_table: sourceTable || "pending_orders",
                status: "unread",
                message: message || null,
                created_at: nowIso,
                updated_at: nowIso
            };
            if (type) {
                insertData.type = type;
            }
            await database.from("customer_notifications").insert(insertData);
        }
        console.log("[Kitchen] Customer notification upserted");
    } catch (e) {
        console.warn("[Kitchen] Failed to upsert customer notification:", e?.message || e);
    }
}
let knownOrderIds = new Set();
let knownPreorderIds = new Set();
let kitchenPollInterval = null;
const PANEL_COLOR_COUNT = 8;
let latestKitchenOrders = [];
const kitchenChecklistState = {};

function getStatusKey(order) {
    console.log("[getStatusKey] Debug info:", {
        order,
        orderStatus: order?.status,
        orderInsufficient: order?.insufficient,
        orderInsufficientPayment: order?.insufficient_payment,
        remainingDue: getRemainingDue(order)
    });
    
    if (!order) return 'pending';
    const s = String(order.status || "").toLowerCase();
    const remainingDue = getRemainingDue(order);
    
    // Insufficient orders remain in the board but are deprioritized only if remainingDue > 0!
    if (remainingDue > 0 && (s === 'insufficient' || order.insufficient)) {
        console.log("[getStatusKey] Returning pending because remainingDue > 0 AND s === 'insufficient' or order.insufficient is true!");
        return 'pending';
    }
    
    // Fully paid orders and processing orders enter pending queue; kitchen explicitly starts them.
    if (s === 'paid' || s === 'accepted' || s === 'processing') return 'pending';
    
    return s;
}

function stripInsufficientPrefix(value) {
    if (typeof value !== 'string') return value;
    const stripped = value.replace(/^\[INSUFFICIENT[^\]]*\]\s*/i, "").trim();
    return stripped || value;
}

function parseInsufficientAmountFromNotesNormalized(notes) {
    const text = String(notes || "");
    const match = text.match(/(?:need|still need|remaining|insufficient|deficit|balance|short)\s*(?:of|to pay|amount)?:?\s*(?:₱|PHP|₱)?\s*([\d,.]+)/i);
    if (!match) return 0;
    const value = Number(String(match[1] || "").replace(/,/g, ""));
    return Number.isFinite(value) ? value : 0;
}

function parseInsufficientAmountFromNotes(notes) {
    try {
        const text = String(notes || "");
        const regex = /(?:need|still need|remaining|insufficient|deficit|balance|short)\s*(?:of|to pay|amount)?:?\s*(?:₱|PHP)?:?\s*([\d,.]+)/gi;
        let match;
        let lastAmount = 0;
        while ((match = regex.exec(text)) !== null) {
            lastAmount = Number(String(match[1]).replace(/,/g, ""));
        }
        return lastAmount > 0 ? lastAmount : 0;
    } catch (_) {
        return 0;
    }
}

function parseInsufficientAmountFromCustomerId(customerId) {
  if (typeof customerId !== "string") return 0
  const match = customerId.match(/\[INSUFFICIENT[^\]]*?(\d+(?:\.\d+)?)/i)
  if (!match) return 0
  const value = Number(match[1])
  return Number.isFinite(value) ? value : 0
}

function stripInsufficientPrefix(value) {
    if (typeof value !== 'string') return value;
    const stripped = value.replace(/^\[INSUFFICIENT[^\]]*\]\s*/i, "").trim();
    return stripped || value;
}

function getItemsTotal(rawItems) {
    if (!rawItems) return 0;
    let items = rawItems;
    if (typeof items === "string") {
        try { items = JSON.parse(items); } catch (_) { items = []; }
    }
    if (!Array.isArray(items)) return 0;
    return items.reduce((sum, i) => {
        const qty = Number(i.quantity || i.qty || 1);
        const lineTotal = Number(i.amount || 0) || (Number(i.price || 0) * qty);
        return sum + (Number.isFinite(lineTotal) ? lineTotal : 0);
    }, 0);
}

function parsePaidAmountFromNotes(notes) {
    const text = String(notes || "");
    if (!text) return 0;
    const amountMatches = Array.from(text.matchAll(/amount:\s*(?:₱|PHP|₱)?\s*([\d,.]+)/gi));
    const paidMatches = Array.from(text.matchAll(/paid[:\s]*(?:₱|PHP|₱)?\s*([\d,.]+)/gi));
    let raw = null;
    if (amountMatches.length > 0) raw = amountMatches[amountMatches.length - 1][1];
    if (!raw && paidMatches.length > 0) raw = paidMatches[paidMatches.length - 1][1];
    const value = Number(String(raw || "").replace(/,/g, ""));
    return Number.isFinite(value) ? value : 0;
}

function getInsufficientAmount(order) {
    const fromColumn = Number(order && order.insufficient_amount_needed ? order.insufficient_amount_needed : 0);
    if (Number.isFinite(fromColumn) && fromColumn > 0) return fromColumn;
    const notes = [order && order.insufficient_notes, order && order.notes].filter(Boolean).join(" | ");
    if (/\-\s*paid\b/i.test(notes) || /\bpayment confirmed at\b/i.test(notes)) return 0;
    const fromNotes = parseInsufficientAmountFromNotesNormalized(notes);
    if (fromNotes > 0) return fromNotes;
    return parseInsufficientAmountFromCustomerId(order && order.customer_id);
}

function getRemainingDue(order) {
    const status = String(order && order.status || "").toLowerCase();
    const fromColumn = getInsufficientAmount(order);
    if (fromColumn > 0) return fromColumn;
    const notesText = [order && order.insufficient_notes, order && order.notes].filter(Boolean).join(" | ");
    const paid = parsePaidAmountFromNotes(notesText);
    const total = Number(order && (order.finalTotal || order.total) || 0) || getItemsTotal(order && order.items);
    if (total > 0 && paid > 0) return Math.max(0, total - paid);
    if (total > 0 && (status === 'insufficient' || /insufficient/i.test(notesText) || order && order.insufficient_payment === true)) return total;
    return 0;
}

function isInsufficientOrder(order) {
    try {
        const stillNeeded = getRemainingDue(order);
        console.log("[isInsufficientOrder] Debug info:", {
            order,
            stillNeeded,
            orderStatus: order?.status,
            orderInsufficientPayment: order?.insufficient_payment
        });
        
        if (stillNeeded === 0) {
            console.log("[isInsufficientOrder] stillNeeded is 0 - returning false!");
            return false;
        }
        
        const s = String(order.status || "").toLowerCase();
        if (s === 'insufficient') return true;
        if (order.insufficient_payment === true || order.insufficient_payment === 1 || String(order.insufficient_payment).toLowerCase() === 'true') {
            return stillNeeded > 0;
        }
        return stillNeeded > 0;
    } catch (_) {
        return false;
    }
}

function isDbReady() {
    return db !== null && db !== undefined;
}

function initializeKitchen() {
    db = getDB();
    if (!db) {
        console.warn('[v0] Database not ready, retrying...');
        setTimeout(initializeKitchen, 100);
        return;
    }
    console.log('[v0] Kitchen initialized');
    
    // Initial Load
    refreshDashboard();
    
    // Subscribe to changes
    subscribeToChanges();
    
    // Polling fallback for fast auto-sync (no hard refresh needed)
    if (!kitchenPollInterval) {
        kitchenPollInterval = setInterval(refreshDashboard, 1500);
    }

    // Refresh immediately when tab becomes active again.
    document.addEventListener("visibilitychange", () => {
        if (!document.hidden) refreshDashboard();
    });
}

async function refreshDashboard() {
    if (!isDbReady()) return;
    
    try {
        // Fetch Walk-ins and Kiosk Orders
        // Include 'pending', 'ACCEPTED', 'INSUFFICIENT', 'for_pickup' to ensure kitchen sees them
        const { data: pendingOrders, error: pendingError } = await db
            .from("pending_orders")
            .select("*")
            .in("status", ["ACCEPTED", "INSUFFICIENT", "PAID", "preparing", "ready", "accepted", "insufficient", "paid", "for_pickup", "PROCESSING", "processing"]);
        
        if (pendingError) throw pendingError;

        // Fetch Pre-orders
        const { data: preorders, error: preorderError } = await db
            .from("bookings")
            .select("*")
            .eq("type", "preorder")
            .in("status", ["ACCEPTED", "INSUFFICIENT", "PAID", "preparing", "ready", "accepted", "insufficient", "paid", "for_pickup"]);

        if (preorderError) throw preorderError;

        // Collect all unique customer IDs (could be contact or email)
        const customerIds = new Set();
        [...(pendingOrders || []), ...(preorders || [])].forEach(o => {
            if (o.customer_id && o.customer_id !== 'GUEST') {
                customerIds.add(o.customer_id);
            }
        });

        // Fetch customer info
        const customerMap = {};
        if (customerIds.size > 0) {
            const { data: customers, error: custError } = await db
                .from("customers")
                .select("name, contact, email, phone")
                .or(`contact.in.(${Array.from(customerIds).join(',')}),email.in.(${Array.from(customerIds).join(',')})`);
            
            if (!custError && customers) {
                customers.forEach(c => {
                    if (c.contact) customerMap[c.contact] = { name: c.name, email: c.email, phone: c.phone, contact: c.contact };
                    if (c.email) customerMap[c.email] = { name: c.name, email: c.email, phone: c.phone, contact: c.contact };
                });
            }
        }

        renderDashboard(pendingOrders || [], preorders || [], customerMap);
    } catch (err) {
        console.error("Error refreshing kitchen dashboard:", err);
    }
}

function isInsufficientOrder(o) {
    try {
        const s = String(o.status || "").toLowerCase();
        if (s === 'paid') return false; // PAID orders are no longer insufficient
        if (s === 'insufficient') return true;
        if (s === 'ready' || s === 'completed') return false;
        const notesText = String(o.insufficient_notes || o.notes || "");
        if (/\bpayment confirmed at\b/i.test(notesText) || /\-\s*paid\b/i.test(notesText)) return false;
        const remaining = getKitchenRemainingAmount(o);
        if (remaining > 0) return true;
        if (isInsufficientFlag(o) || isInsufficientType(o)) return true;
        if (/insufficient/i.test(notesText)) return true;
        if (/insufficient/i.test(String(o.customer_id || ""))) return true;
    } catch (_) {}
    return false;
}

function shouldSuppressKitchenLine(text) {
    const value = String(text || "").trim();
    if (!value) return true;
    return /insufficient|remaining balance|payment incomplete/i.test(value);
}

function isInsufficientFlag(o) {
    const raw = o ? o.insufficient_payment : null;
    return raw === true || raw === 1 || String(raw).toLowerCase() === 'true';
}

function isInsufficientType(o) {
    return String(o && o.type || '').toLowerCase() === 'insufficient';
}

function parseRemainingFromText(text) {
    const safeText = String(text || "");
    if (!safeText) return 0;
    if (/\bpayment confirmed at\b/i.test(safeText) || /\-\s*paid\b/i.test(safeText)) return 0;
    let match = safeText.match(/remaining balance[:\s]*[^\d]*([\d,.]+)\b/i);
    if (!match) match = safeText.match(/still need(?:ed)?[:\s]*[^\d]*([\d,.]+)\b/i);
    if (!match && /insufficient/i.test(safeText)) {
        match = safeText.match(/insufficient[^\d]*([0-9]+(?:\.[0-9]{1,2})?)/i);
    }
    if (!match) match = safeText.match(/(?:\u20B1|PHP|Php|P|\u00E2\u201A\u00B1)\s*([\d,.]+)\b/i);
    if (!match) return 0;
    const num = parseFloat(String(match[1] || '').replace(/,/g, ''));
    return isNaN(num) ? 0 : num;
}

function parsePaidAmountFromNotes(text) {
    const safeText = String(text || "");
    if (!safeText) return 0;
    const amountMatches = Array.from(safeText.matchAll(/amount:\s*(?:\u20B1|PHP|Php|P|\u00E2\u201A\u00B1)?\s*([\d,.]+)/gi));
    const paidMatches = Array.from(safeText.matchAll(/paid[:\s]*(?:\u20B1|PHP|Php|P|\u00E2\u201A\u00B1)?\s*([\d,.]+)/gi));
    let raw = null;
    if (amountMatches.length > 0) raw = amountMatches[amountMatches.length - 1][1];
    if (!raw && paidMatches.length > 0) raw = paidMatches[paidMatches.length - 1][1];
    const value = Number(String(raw || "").replace(/,/g, ""));
    return Number.isFinite(value) ? value : 0;
}

/** Parse insufficient amount from notes when insufficient_amount_needed column is missing or 0. */
function parseInsufficientAmountFromNotes(o) {
    const fromColumn = Number(o.insufficient_amount_needed || 0);
    if (fromColumn > 0) return fromColumn;
    const notesText = String(o.insufficient_notes || o.notes || '');
    const fromNotes = parseRemainingFromText(notesText);
    if (fromNotes > 0) return fromNotes;
    const fromCustomer = parseRemainingFromText(o.customer_id || '');
    if (fromCustomer > 0) return fromCustomer;
    return 0;
}

function getKitchenRemainingAmount(o) {
    const status = String(o && o.status || "").toLowerCase();
    const fromColumn = Number(o.insufficient_amount_needed || 0);
    const fromNotes = parseInsufficientAmountFromNotes(o);
    let remaining = Math.max(fromColumn, fromNotes);
    if (remaining <= 0 && (status === 'insufficient' || isInsufficientFlag(o) || isInsufficientType(o))) {
        const total = Number(o.total || 0);
        const paid = parsePaidAmountFromNotes(o.insufficient_notes || o.notes || "");
        if (total > 0 && paid > 0) remaining = Math.max(0, total - paid);
        else if (total > 0) remaining = total;
    }
    return remaining;
}

function renderDashboard(pendingOrders, preorders, customerMap) {
    const activeGrid = document.getElementById("kitchenCardsGrid");
    const forPickupGrid = document.getElementById("forPickupGrid");
    
    if (!activeGrid || !forPickupGrid) return;

    activeGrid.innerHTML = "";
    forPickupGrid.innerHTML = "";

    const now = new Date();
    
    // Combine and process orders
    let allOrders = [];

    // Process Pending Orders (Walk-ins/Kiosk)
    pendingOrders.forEach(order => {
        const custFromMap = customerMap[order.customer_id];
        let customerName = order.customer_name || (custFromMap?.name ? stripInsufficientPrefix(custFromMap.name) : stripInsufficientPrefix(order.customer_id));
        let customerContact = order.customer_id || custFromMap?.email || custFromMap?.phone || custFromMap?.contact || "";
        
        // If customerName is Guest, still show it (don't set to "")
        if (!customerName || customerName === 'null') {
            customerName = "Guest"; 
        }

        let label = 'WALK-IN';
        if (order.type === 'kiosk') label = 'KIOSK';
        if (order.type === 'redemption') label = 'REDEMPTION';

        allOrders.push({
            id: order.id,
            orderNumber: order.order_number || String(order.id).slice(-4),
            source: 'pending_orders',
            type: order.type || 'walk-in',
            status: order.status,
            items: order.items,
            timestamp: new Date(order.timestamp || order.created_at),
            total: order.total,
            customer: customerName,
            customerContact: customerContact,
            customer_id: order.customer_id,
            orderDate: "",
            priority: 0, // Walk-in/kiosk base top priority
            label: label,
            insufficient: isInsufficientOrder(order),
            insufficient_amount: getKitchenRemainingAmount(order),
            insufficient_notes: order.insufficient_notes || "",
            currently_preparing: order.currently_preparing === true,
            paid_at: order.updated_at || order.created_at
        });
    });

    // Process Pre-orders
    preorders.forEach(order => {
        const isInsufficient = isInsufficientOrder(order)
        const pickupDate = new Date(`${order.date}T${order.time}`);
        const diffMs = pickupDate - now;
        const diffMins = Math.floor(diffMs / 60000);
        
        // Date check: Today vs Tomorrow Early Morning (8:00 - 8:30 AM)
        const orderDateStr = order.date; // YYYY-MM-DD
        
        const localNow = new Date(now.getTime() - (now.getTimezoneOffset() * 60000));
        const todayStr = localNow.toISOString().split('T')[0];
        
        const tomorrow = new Date(now.getTime() + (24 * 60 * 60 * 1000));
        const localTomorrow = new Date(tomorrow.getTime() - (tomorrow.getTimezoneOffset() * 60000));
        const tomorrowStr = localTomorrow.toISOString().split('T')[0];
        
        let isToday = (orderDateStr === todayStr);
        let isTomorrow = (orderDateStr === tomorrowStr);
        
        // Pre-orders should only be shown for present date on kitchen board.
        if (!isToday) return;

        let priority = 4; // Default lower than walk-ins
        let timeLabel = `Pickup: ${order.time}`;
        let isHighPriority = false;

        if (isToday) {
            if (diffMins <= 10) {
                priority = 1; // Very high for near pickup
                isHighPriority = true;
            } else if (diffMins <= 20) {
                priority = 2; // Moderate-high for soon pickup
            } else if (diffMins < 0) {
                priority = 1; // Overdue pickup should stay urgent
            } else {
                priority = 4; // Later pre-orders
            }
        }

        const custFromMap = customerMap[order.customer_id];
        let customerName = order.customer_name || (custFromMap?.name ? stripInsufficientPrefix(custFromMap.name) : stripInsufficientPrefix(order.customer_id || ""));
        let customerContact = order.customer_id || custFromMap?.email || custFromMap?.phone || custFromMap?.contact || "";
        
        // If customerName is Guest, still show it (don't set to "")
        if (!customerName || customerName === 'null') {
            customerName = "Guest";
        }

        allOrders.push({
            id: order.id,
            orderNumber: order.order_number || String(order.id).slice(-4),
            source: 'bookings',
            type: 'preorder',
            status: order.status,
            items: order.items,
            timestamp: new Date(order.created_at),
            pickupTime: pickupDate,
            diffMins: diffMins,
            priority: priority,
            isHighPriority: isHighPriority,
            label: 'PRE-ORDER',
            customer: customerName,
            customerContact: customerContact,
            customer_id: order.customer_id,
            orderDate: order.date || "",
            timeLabel: timeLabel,
            insufficient: isInsufficient,
            insufficient_amount: getKitchenRemainingAmount(order),
            insufficient_notes: order.insufficient_notes || "",
            currently_preparing: order.currently_preparing === true,
            paid_at: order.updated_at || order.created_at
        });
    });

    // Split into active and for pickup
    const forPickupOrders = allOrders.filter(o => getStatusKey(o) === 'for_pickup');
    const activeOrders = allOrders.filter(o => getStatusKey(o) !== 'for_pickup');

    // Sort active orders: preparing first; then balanced priority among pending paid orders.
    activeOrders.sort((a, b) => {
        const statusA = getStatusKey(a);
        const statusB = getStatusKey(b);
        
        // Started orders first.
        if (statusA === 'preparing' && statusB !== 'preparing') return -1;
        if (statusA !== 'preparing' && statusB === 'preparing') return 1;

        // Hide insufficient from normal sequencing.
        if (a.insufficient && !b.insufficient) return 1;
        if (!a.insufficient && b.insufficient) return -1;

        // Pending queue: explicit priority first.
        if (statusA === 'pending' && statusB === 'pending') {
            if (a.priority !== b.priority) return a.priority - b.priority;
            // Aging: older paid orders climb in queue to avoid starvation.
            const paidA = new Date(a.paid_at || a.timestamp).getTime();
            const paidB = new Date(b.paid_at || b.timestamp).getTime();
            if (paidA !== paidB) return paidA - paidB;
        }
        
        // Final FIFO fallback.
        return a.timestamp - b.timestamp;
    });

    // Sort for pickup orders by timestamp (newest first or oldest first?)
    forPickupOrders.sort((a, b) => a.timestamp - b.timestamp);

    const panelCounters = { pending: 0, preparing: 0, ready: 0 };
    const pendingQueue = activeOrders.filter((o) => getStatusKey(o) === "pending");
    const nextPendingId = pendingQueue.length ? String(pendingQueue[0].id) : null;

    activeOrders.forEach(order => {
        const statusKey = getStatusKey(order);
        // Do not render finished cards in active board.
        if (statusKey === "ready" || statusKey === "completed" || statusKey === "for_pickup") return;
        let prepStage = "";
        if (statusKey === "preparing") prepStage = "prep-current";
        else if (statusKey === "pending") prepStage = (String(order.id) === nextPendingId ? "prep-next" : "prep-queue");
        const card = createKitchenCard(order, panelCounters[statusKey]++, prepStage, false);
        activeGrid.appendChild(card);
    });

    forPickupOrders.forEach(order => {
        const card = createKitchenCard(order, 0, "", true);
        forPickupGrid.appendChild(card);
    });

    latestKitchenOrders = allOrders;
}

function getDrinkTag(name, temperature) {
    const temp = String(temperature || "").toLowerCase();
    if (temp === "hot") return `<span class="drink-tag drink-hot">HOT</span>`;
    if (temp === "cold" || temp === "iced") return `<span class="drink-tag drink-iced">ICED</span>`;
    const text = String(name || "").toLowerCase();
    if (text.includes("hot")) return `<span class="drink-tag drink-hot">HOT</span>`;
    if (text.includes("cold") || text.includes("iced")) return `<span class="drink-tag drink-iced">ICED</span>`;
    return "";
}

function createKitchenCard(order, panelIndex = 0, prepStage = "", isForPickup = false) {
    const div = document.createElement("div");
    const statusKey = getStatusKey(order);
    const colorClass = `panel-color-${(Number(panelIndex) % PANEL_COLOR_COUNT) + 1}`;
    div.className = `kitchen-card status-${statusKey} ${order.isHighPriority ? 'priority-high' : 'priority-normal'} ${colorClass} ${prepStage} ${isForPickup ? 'for-pickup-card' : ''}`;
    
    if (isForPickup) {
        div.ondblclick = () => window.markAsPickedUp(order.id, order.source);
    }

    let itemsHtml = "";
    try {
        const items = typeof order.items === 'string' ? JSON.parse(order.items) : order.items;
        if (Array.isArray(items)) {
            itemsHtml = items
            .filter(i => !shouldSuppressKitchenLine(i && (i.name || i.item || i.title || i.label)))
            .map((i, idx) => {
                const qty = i.qty || i.quantity || 1;
                const name = i.name || "";
                const tag = getDrinkTag(name, i.temperature || i.temp);
                const checklistKey = `${order.source}:${order.id}:${idx}`;
                const isChecked = kitchenChecklistState[checklistKey] === true;
                const disabled = isForPickup ? "disabled" : "";
                return `<label class="order-item order-item-check">
                    <input type="checkbox" ${isChecked ? "checked" : ""} onchange="window.toggleKitchenChecklist('${checklistKey}', this.checked)" ${disabled} />
                    <span>${qty}x ${name}${tag ? " " + tag : ""}</span>
                </label>`;
            }).join("");
        } else if (typeof order.items === 'string') {
            itemsHtml = order.items
            .split(",")
            .map(i => i.trim())
            .filter(i => i && !shouldSuppressKitchenLine(i))
            .map((i, idx) => {
                const checklistKey = `${order.source}:${order.id}:${idx}`;
                const isChecked = kitchenChecklistState[checklistKey] === true;
                const disabled = isForPickup ? "disabled" : "";
                return `<label class="order-item order-item-check">
                    <input type="checkbox" ${isChecked ? "checked" : ""} onchange="window.toggleKitchenChecklist('${checklistKey}', this.checked)" ${disabled} />
                    <span>${i}</span>
                </label>`;
            })
            .join("");
        }
    } catch (e) {
        itemsHtml = `<div>${order.items}</div>`;
    }

    const timeStr = order.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const timeDisplay = order.type === 'preorder' 
        ? `<span class="${order.isHighPriority ? 'time-warning' : ''}">${order.timeLabel}</span>` 
        : `Ordered: ${timeStr}`;

    const stillNeeded = getRemainingDue(order);
    const insuffIcon = stillNeeded > 0 
        ? `<i class="fa-solid fa-circle-exclamation insuff-icon" title="Insufficient amount: \u20B1${Number(stillNeeded).toFixed(2)}"></i>` 
        : '';
    const paidBadge = (!order.insufficient && /paid/i.test(order.insufficient_notes || order.notes || "")) 
        ? `<span class="paid-badge">PAID</span>` 
        : '';

    const statusLabel = isForPickup ? 'For Pickup' : (statusKey === 'pending' ? 'Pending' : statusKey === 'preparing' ? 'Process' : 'Done');
    const queueLabel = isForPickup ? 'PICKUP' : (prepStage === "prep-next" ? "NEXT" : (prepStage === "prep-queue" ? "QUEUE" : (prepStage === "prep-current" ? "PROCESS" : "DONE")));
    const sourcePill = order.label === "PRE-ORDER" ? "Pre-Order" : (order.label === "KIOSK" ? "Kios" : "Walk-in");
    let actionBtn = "";
    const isInsufficient = isInsufficientOrder(order);
    const remainingDue = getRemainingDue(order);
    console.log("[createKitchenCard] Debug info for order:", {
        id: order.id,
        statusKey,
        isInsufficient,
        remainingDue,
        order
    });
    if (!isForPickup) {
        if (statusKey === "pending") {
            // Always show Start button, handleOrderTransition will block if insufficient
            actionBtn = `<button class="k-btn k-btn-primary" onclick="window.kitchenAdvanceOrder('${String(order.id)}','${order.source}'); return false;">Start</button>`;
        } else if (statusKey === "preparing") {
            // Always show Done button, handleOrderTransition will allow
            actionBtn = `<button class="k-btn k-btn-primary" onclick="window.kitchenAdvanceOrder('${String(order.id)}','${order.source}'); return false;">Done</button>`;
        } else {
            actionBtn = `<button class="k-btn" disabled>Done</button>`;
        }
    } else if (remainingDue > 0) {
        actionBtn = `<button class="k-btn" style="background: #74512D; color: white;" onclick="window.moveToCashier('${String(order.id)}','${order.source}'); return false;">Process Balance (Cashier)</button>`;
    }

    div.innerHTML = `
        <div class="k-card-top">
            <div class="k-order-id">#${order.orderNumber}</div>
            <div class="k-source-pill">${sourcePill}</div>
        </div>
        ${order.customer ? `<div style="font-weight:bold; margin:4px 0;">${order.customer}</div>` : ''}
        ${order.customerContact ? `<div style="font-size:0.85em; color:#666; margin-bottom:4px;">${order.customerContact}</div>` : ''}
        <div class="k-card-time-row">
            <span><i class="fa-regular fa-clock"></i> ${timeStr}</span>
            <span class="k-status">${statusLabel}</span>
        </div>
        <div class="order-items">
            ${itemsHtml}
        </div>
        <div class="k-card-actions">
            <button class="k-btn k-queue-pill ${prepStage || ""}">${queueLabel}</button>
            ${actionBtn}
            <div style="display:flex; align-items:center; gap:6px; margin-left:auto;">
                ${paidBadge}
            </div>
        </div>
        ${isForPickup ? '<div style="text-align:center; margin-top:8px; font-size:0.75rem; color:#888;">Double-click to mark as picked up</div>' : ''}
        ${insuffIcon}
    `;

    return div;
}

window.toggleKitchenChecklist = async (key, checked) => {
    kitchenChecklistState[key] = checked === true;
    
    // Extract order info from key: ${source}:${orderId}:${idx}
    const parts = key.split(':');
    if (parts.length >= 3) {
        const source = parts[0];
        const orderId = parts[1];
        
        // Find the order
        const order = (latestKitchenOrders || []).find(o => String(o.id) === String(orderId) && String(o.source) === String(source));
        console.log("[toggleKitchenChecklist] Debug info:", {
            key,
            checked,
            order
        });
        
        if (order) {
            const statusKey = getStatusKey(order);
            const remainingDue = getRemainingDue(order);
            
            // Auto-start the order if pending and remaining due 0
            if (statusKey === 'pending' && remainingDue === 0) {
                console.log("[toggleKitchenChecklist] Auto-starting order (pending → preparing)");
                await window.kitchenAdvanceOrder(orderId, source);
            }
        }
    }
};

window.kitchenAdvanceOrder = async (orderId, source) => {
    const match = (latestKitchenOrders || []).find((o) => String(o.id) === String(orderId) && String(o.source) === String(source));
    if (!match) {
        showMessage("Order not found. Refreshing...", "info");
        await refreshDashboard();
        return;
    }
    await handleOrderTransition(match);
};

// Kitchen filter controls intentionally removed; board always shows prioritized queue.

async function toggleCurrentlyPreparing(orderId, source, currentVal) {
    try {
        const { error } = await db
            .from(source)
            .update({ currently_preparing: !currentVal })
            .eq("id", orderId);

        if (error) throw error;
        refreshDashboard();
    } catch (err) {
        console.error("Error toggling currently preparing status:", err);
        showMessage("Failed to update status", "error");
    }
}

async function handleOrderTransition(order) {
    const statusKey = getStatusKey(order);
    let newStatus = 'preparing';
    let updatePayload = {};
    const remainingDue = getRemainingDue(order);
    
    console.log("[handleOrderTransition] Debug info:", {
        statusKey,
        order,
        remainingDue,
        orderStatus: order.status,
        orderInsufficientPayment: order.insufficient_payment,
        orderNotes: [order.insufficient_notes, order.notes].filter(Boolean).join(" | ")
    });

    // Only block moving from pending to preparing if remainingDue > 0!
    // Don't care about order.insufficient_payment or order.status if remainingDue is 0!
    if (statusKey === 'pending' && remainingDue > 0) {
        console.log("[handleOrderTransition] Blocking - remaining due > 0!");
        showMessage("Cannot process order. Handle payment first.", "error");
        return;
    }
    
    console.log("[handleOrderTransition] Allowing transition!");

    if (statusKey === 'ready') {
        newStatus = 'for_pickup';
    } else if (statusKey === 'preparing') {
        // Done from kitchen moves to for pickup.
        newStatus = 'for_pickup';
        updatePayload.currently_preparing = false;
    } else if (statusKey === 'pending') {
        newStatus = 'preparing';
        updatePayload.currently_preparing = true; // Started by kitchen
    }
    
    updatePayload.status = newStatus;

    try {
        // Use global db instance
        const database = window.db || getDB();
        
        // 1. Update the original table status
        const { error } = await database
            .from(order.source)
            .update(updatePayload)
            .eq("id", order.id);

        if (error) throw error;

        // 2. Update customer notification based on new status
        if (order.customer_id) {
            let notificationMessage = "";
            let newType = null;
            if (newStatus === 'preparing') {
                notificationMessage = "Your order is now being prepared!";
            } else if (newStatus === 'ready' || newStatus === 'for_pickup') {
                notificationMessage = "Your order is ready for pick up!";
                newType = "pickup";
            } else if (newStatus === 'completed') {
                notificationMessage = "Your order is complete!";
                newType = "completed";
            }
            
            if (notificationMessage) {
                const notificationObj = {
                    customerId: order.customer_id,
                    orderId: order.id,
                    sourceTable: order.source,
                    message: notificationMessage
                };
                if (newType) {
                    notificationObj.type = newType;
                }
                await upsertCustomerNotificationForKitchen(notificationObj);
            }
        }

        // Keep UI quiet: no move/status banners on successful transitions.
        refreshDashboard();
    } catch (err) {
        console.error("Error transitioning order:", err);
        showMessage("Failed to update order", "error");
    }
}

window.markAsPickedUp = async function(orderId, source) {
    if (!confirm("Mark this order as picked up?")) return;
    
    try {
        const database = window.db || getDB();
        const { error } = await database
            .from(source)
            .update({ status: 'completed' })
            .eq("id", orderId);
        
        if (error) throw error;
        
        // Find the order to record sale and send notification
        const order = (latestKitchenOrders || []).find(o => String(o.id) === String(orderId) && String(o.source) === String(source));
        if (order) {
            // Send customer notification for completed order
            if (order.customer_id) {
                await upsertCustomerNotificationForKitchen({
                    customerId: order.customer_id,
                    orderId: orderId,
                    sourceTable: source,
                    message: "Your order is complete!",
                    type: "completed"
                });
            }
            
            // If it's a pre-order or walk-in, record the sale
            if (order.source === 'bookings') {
                await recordPreorderCompletion(order);
            } else if (order.insufficient) {
                await recordInsufficientWalkinCompletion(order);
            } else {
                // For regular walk-ins, we might need to record sale too?
            }
        }
        
        showMessage("Order marked as picked up!", "success");
        refreshDashboard();
    } catch (err) {
        console.error("Error marking order as picked up:", err);
        showMessage("Failed to mark order as picked up", "error");
    }
};

window.moveToCashier = async function(orderId, source) {
    if (!confirm("Move this order to cashier to process balance?")) return;
    
    try {
        const database = window.db || getDB();
        const { error } = await database
            .from(source)
            .update({ status: 'insufficient' })
            .eq("id", orderId);
        
        if (error) throw error;
        
        showMessage("Order moved to cashier for balance processing!", "success");
        refreshDashboard();
    } catch (err) {
        console.error("Error moving order to cashier:", err);
        showMessage("Failed to move order to cashier", "error");
    }
};

/** 
 * Handles recording sales, order history, and awarding loyalty points 
 * for completed pre-orders (bookings table).
 */
async function recordPreorderCompletion(order) {
    try {
        const database = window.db || getDB();
        
        // Fetch full booking details
        const { data: booking, error: fetchError } = await database
            .from("bookings")
            .select("*")
            .eq("id", order.id)
            .single();
            
        if (fetchError || !booking) return;

        // 1. Check if already in sales
        const { data: existingSales } = await database
            .from("sales")
            .select("id")
            .eq("booking_id", order.id);
            
        if (!existingSales || existingSales.length === 0) {
            // Record in Sales
            let items = booking.items;
            if (typeof items === 'string') {
                try { items = JSON.parse(items); } catch(e) { items = []; }
            }
            items = Array.isArray(items) ? items : [];

            // Calculate actual paid amount for insufficient payment orders
            const totalOrderAmount = Number(booking.total || 0);
            const amountNeeded = Math.max(Number(booking.insufficient_amount_needed || 0), parseInsufficientAmountFromNotes(booking));
            const actualPaidAmount = Math.max(0, totalOrderAmount - amountNeeded);

            const salesPayload = {
                customer_id: booking.customer_id,
                items: JSON.stringify(items),
                total: actualPaidAmount,
                amount: actualPaidAmount,
                sale_date: new Date().toISOString(),
                payment_method: booking.payment_method || 'cash',
                status: 'completed',
                type: 'preorder',
                booking_id: booking.id,
                insufficient_payment: booking.insufficient_payment === true || amountNeeded > 0,
                total_order_amount: totalOrderAmount,
                amount_due: amountNeeded
            };
            
            await database.from("sales").insert(salesPayload);
            console.log("[Kitchen] Pre-order Sales Record Created");

            // 2. Record in Orders History (for customer tracking)
            const ordersPayload = items.map(i => ({
                customer_id: String(booking.customer_id || "preorder"),
                product_id: i.id || i.product_id || "",
                name: i.name || "Unknown",
                quantity: Number(i.quantity || i.qty || 1),
                price: Number(i.price || 0) || (Number(i.amount || 0) / Number(i.quantity || i.qty || 1)) || 0,
                category_id: i.category_id || null,
                timestamp: new Date().toISOString(),
                payment_method: booking.payment_method || 'cash',
                status: 'completed'
            }));
            
            if (ordersPayload.length > 0) {
                await database.from("orders").insert(ordersPayload);
            }

            // 3. Award Points
            if (booking.customer_id) {
                const { data: cust } = await database.from("customers")
                    .select("id, loyalty_points, loyalty_card")
                    .or(`email.eq.${booking.customer_id},contact.eq.${booking.customer_id}`)
                    .maybeSingle();
                
                if (cust) {
                    const points = 1; // 1 point per completed pre-order
                    const newPoints = (cust.loyalty_points || 0) + points;
                    await database.from("customers").update({ loyalty_points: newPoints }).eq("id", cust.id);
                    await database.from("loyalty_history").insert({
                        customer_id: cust.id,
                        loyalty_card: cust.loyalty_card,
                        points: points,
                        source: "preorder",
                        order_id: booking.id,
                        total: totalOrderAmount,
                        timestamp: new Date().toISOString()
                    });
                }
            }
        }
    } catch (err) {
        console.error("[Kitchen] Error in recordPreorderCompletion:", err);
    }
}

/** Handles recording sales for completed insufficient walk-in orders. */
async function recordInsufficientWalkinCompletion(order) {
    try {
        const database = window.db || getDB();
        
        // Fetch full order details
        const { data: fullOrder, error: fetchError } = await database
            .from(order.source)
            .select("*")
            .eq("id", order.id)
            .single();
            
        if (fetchError || !fullOrder) return;

        // Check if already in sales
        const { data: existingSales } = await database
            .from("sales")
            .select("id")
            .eq("id", order.id); // For walk-ins, sale ID often matches order ID
            
        if (!existingSales || existingSales.length === 0) {
            const totalOrderAmount = Number(fullOrder.total || 0);
            const amountNeeded = Math.max(Number(fullOrder.insufficient_amount_needed || 0), parseInsufficientAmountFromNotes(fullOrder));
            const actualPaidAmount = Math.max(0, totalOrderAmount - amountNeeded);

            const salesPayload = {
                customer_id: fullOrder.customer_id,
                items: typeof fullOrder.items === 'string' ? fullOrder.items : JSON.stringify(fullOrder.items),
                total: actualPaidAmount,
                sale_date: new Date().toISOString(),
                payment_method: fullOrder.payment_method || 'cash',
                status: 'completed',
                type: fullOrder.type || 'walk-in',
                insufficient_payment: true,
                total_order_amount: totalOrderAmount,
                amount_due: amountNeeded
            };
            
            await database.from("sales").insert(salesPayload);
        }
    } catch (err) {
        console.error("[Kitchen] Error in recordInsufficientWalkinCompletion:", err);
    }
}

function subscribeToChanges() {
    db.channel('kitchen-updates')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'pending_orders' }, payload => {
            refreshDashboard();
        })
        .on('postgres_changes', { event: '*', schema: 'public', table: 'bookings' }, payload => {
            refreshDashboard();
        })
        .subscribe();
}

function showMessage(msg, type) {
    const container = document.getElementById("statusMessage");
    if (container) {
        container.innerHTML = `<div class="message ${type}">${msg}</div>`;
        setTimeout(() => (container.innerHTML = ""), 2000);
    }
}

// Initialize when ready
document.addEventListener("DOMContentLoaded", () => {
    const checkDb = () => {
        if (window.dbReady) {
            initializeKitchen();
        } else {
            setTimeout(checkDb, 100);
        }
    };
    checkDb();
    document.addEventListener("visibilitychange", () => {
        if (!document.hidden) {
            refreshDashboard();
        }
    });
});
