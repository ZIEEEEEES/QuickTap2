# QuickTap Setup Guide

This guide covers setup for both Staff Portal and Customer Portal.

## 1. Supabase Database Setup

First, configure your Supabase credentials in both `QuickTap_Staffs/supabase-init.js` and `Quicktap_Customer/supabase-init.js`:

```javascript
const SUPABASE_URL = 'YOUR_SUPABASE_URL';
const SUPABASE_ANON_KEY = 'YOUR_SUPABASE_ANON_KEY';
```

### Required Database Tables

Run these SQL commands in your Supabase SQL Editor:

#### 1.1 Staff Table (for Staff Portal)
```sql
CREATE TABLE IF NOT EXISTS staff (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  id_number TEXT UNIQUE NOT NULL,
  full_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  plain_password TEXT,
  role TEXT NOT NULL CHECK (role IN ('system_admin', 'admin', 'cashier', 'kitchen_staff')),
  is_system_admin BOOLEAN DEFAULT FALSE,
  archived BOOLEAN DEFAULT FALSE,
  username TEXT UNIQUE,
  email TEXT UNIQUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

#### 1.2 Admin Logs Table
```sql
CREATE TABLE IF NOT EXISTS admin_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id UUID NOT NULL,
  admin_name TEXT NOT NULL,
  action TEXT NOT NULL,
  details TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

#### 1.3 Pending Orders Table (for both portals)
```sql
CREATE TABLE IF NOT EXISTS pending_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id TEXT,
  type TEXT NOT NULL DEFAULT 'walk_in',
  items TEXT,
  total NUMERIC DEFAULT 0,
  status TEXT DEFAULT 'pending',
  payment_status TEXT DEFAULT 'unpaid',
  insufficient_payment BOOLEAN DEFAULT FALSE,
  insufficient_amount_needed NUMERIC DEFAULT 0,
  insufficient_notes TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

#### 1.4 Orders Table (history)
```sql
CREATE TABLE IF NOT EXISTS orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id TEXT,
  type TEXT NOT NULL DEFAULT 'walk_in',
  items TEXT,
  total NUMERIC DEFAULT 0,
  status TEXT DEFAULT 'completed',
  rejection_reason TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  is_redemption BOOLEAN DEFAULT FALSE
);
```

#### 1.5 Bookings Table
```sql
CREATE TABLE IF NOT EXISTS bookings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id TEXT,
  type TEXT NOT NULL DEFAULT 'visit',
  date TEXT,
  time TEXT,
  check_in_time TEXT,
  check_out_time TEXT,
  pickup_date TEXT,
  pickup_time TEXT,
  new_date TEXT,
  new_time TEXT,
  reschedule_reason TEXT,
  rejection_reason TEXT,
  status TEXT DEFAULT 'pending',
  items TEXT,
  total NUMERIC DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

#### 1.6 Customer Notifications Table
```sql
CREATE TABLE IF NOT EXISTS customer_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id TEXT,
  order_id UUID,
  source_table TEXT,
  message TEXT,
  remaining_amount NUMERIC,
  status TEXT DEFAULT 'unread',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

#### 1.7 Promos Table
```sql
CREATE TABLE IF NOT EXISTS promos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  description TEXT,
  image_url TEXT,
  active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

#### 1.8 Products Table
```sql
CREATE TABLE IF NOT EXISTS products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  category TEXT,
  price NUMERIC NOT NULL,
  image_url TEXT,
  description TEXT,
  size TEXT,
  active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

### 1.9 Row Level Security (RLS) Policies (Recommended)
Enable RLS on all tables and create appropriate policies for staff and customer access!

## 2. First-time Staff Setup

1. Open `QuickTap_Staffs/index.html` in your browser.
2. If no staff exist, you'll see **Create System Admin** (first-time only).
3. Enter ID Number, Full Name, and Password (min 6 characters).
4. Click **Create System Admin**.
5. The page will reload, and you can now log in with your credentials!

## 3. Staff Roles & Access

| Role          | Access                 | Can register staff | Removable |
|---------------|------------------------|--------------------|-----------|
| System Admin  | Admin, Cashier, Kitchen| Yes                | No        |
| Admin         | Admin, Cashier, Kitchen| Yes                | Yes       |
| Cashier       | Cashier                | No                 | Yes       |
| Kitchen Staff | Kitchen                | No                 | Yes       |

## 4. Staff Attributes

- **ID Number** – used for login (e.g., CASH001, KIT001)
- **Full Name** – display name
- **Password** – minimum 6 characters
- **Username/Email** (optional) – can be added via Admin Dashboard

## 5. Login Flow

- **System Admin / Admin** → Admin Dashboard (Staff Management, Analytics, Bookings, Pre-orders)
- **Cashier** → Cashier Dashboard
- **Kitchen Staff** → Kitchen Dashboard

## 6. Customer Portal Setup

The Customer Portal (`Quicktap_Customer/customer/customer.html`) allows customers to:
- Browse menu
- Place walk-in orders
- Book visits
- Place pre-orders
- Track orders and bookings
- View promos
- Spin the wheel (if enabled)
- Manage loyalty points

### 6.1 Customer Features

- **Order Tracking**:
  - Pre-orders not preparing: Processing
  - Pre-orders on pickup day + preparing: To Prepare
  - Pre-orders done preparing: To Pick Up
  - Pre-orders picked up: Completed
- **Booking Tracking**:
  - Accepted: Accepted (blue badge)
  - Rejected: Rejected (red badge, shows reason)
  - Rescheduled: Rescheduled (orange badge, shows reason + new date/time)
  - Rejected/Cancelled: Stay in active section for 3 days, then move to Completed

## 7. Important Notes

- **Supabase Credentials**: Make sure to update `SUPABASE_URL` and `SUPABASE_ANON_KEY` in both `QuickTap_Staffs/supabase-init.js` and `Quicktap_Customer/supabase-init.js`!
- **Admin Logs**: All staff actions (login, logout, staff registration) are logged to the `admin_logs` table!
- **Auto-logout**: Admin users are automatically logged out after 5 minutes of inactivity (configurable via `window.QUICKTAP_ADMIN_INACTIVITY_MS`)!
