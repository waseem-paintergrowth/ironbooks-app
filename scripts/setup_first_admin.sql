-- ============================================================
-- Run this AFTER you sign up via /auth/login the first time
-- ============================================================
-- This grants admin role to Mike so he can manage clients + master COA.
-- Replace YOUR_AUTH_USER_ID below with your actual ID from auth.users.

-- 1. Find your auth user ID:
SELECT id, email, created_at FROM auth.users ORDER BY created_at DESC LIMIT 5;

-- 2. Insert yourself into the users table as admin:
INSERT INTO users (id, email, full_name, role)
VALUES (
  'PASTE_AUTH_USER_ID_HERE',
  'mike@paintergrowth.com',
  'Mike Gore-Hickman',
  'admin'
)
ON CONFLICT (id) DO UPDATE SET role = 'admin', is_active = TRUE;

-- 3. Add Lisa as lead bookkeeper (after she signs up):
-- INSERT INTO users (id, email, full_name, role)
-- VALUES ('LISAS_AUTH_ID', 'lisa@ironbooks.com', 'Lisa', 'lead')
-- ON CONFLICT (id) DO UPDATE SET role = 'lead', is_active = TRUE;

-- 4. Add bookkeepers:
-- INSERT INTO users (id, email, full_name, role)
-- VALUES ('ROWENAS_AUTH_ID', 'rowena@ironbooks.com', 'Rowena', 'bookkeeper')
-- ON CONFLICT (id) DO UPDATE SET role = 'bookkeeper', is_active = TRUE;

-- Verify:
SELECT id, email, full_name, role, is_active FROM users;
