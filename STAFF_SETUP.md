# Staff Authentication Setup

> **Cashier Monitoring & Admin Logs**: Run `sql/cashier_monitoring_and_admin_logs.sql` in Supabase to add cashier tracking and admin activity logs.

## 1. Create the staff table

Run the SQL in `sql/staff_table.sql` in your Supabase SQL Editor:

```sql
CREATE TABLE IF NOT EXISTS staff (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  id_number TEXT UNIQUE NOT NULL,
  full_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('system_admin', 'admin', 'cashier', 'kitchen_staff')),
  is_system_admin BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

## 2. First-time setup

1. Go to the home page.
2. In the **Staff Access** section, you will see **Create System Admin** (first-time only).
3. Enter ID Number, Full Name, and Password (min 6 chars).
4. Click **Create System Admin**.
5. The page reloads and shows the normal Staff Login form.

## 3. Roles & access

| Role          | Access                 | Can register staff | Removable |
|---------------|------------------------|--------------------|-----------|
| System Admin  | Admin, Cashier, Kitchen| Yes                | No        |
| Admin         | Admin, Cashier, Kitchen| Yes                | Yes       |
| Cashier       | Cashier                | No                 | Yes       |
| Kitchen Staff | Kitchen                | No                 | Yes       |

## 4. Staff attributes

- **ID Number** – used for login (e.g. CASH001, KIT001)
- **Full Name** – display name
- **Password** – min 6 characters

## 5. Login flow

- **System Admin / Admin** → Admin Dashboard (can open Staff Management and add staff)
- **Cashier** → Cashier Dashboard
- **Kitchen Staff** → Kitchen Dashboard
