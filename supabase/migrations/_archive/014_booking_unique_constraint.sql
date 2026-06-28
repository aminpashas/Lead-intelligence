-- Migration 014: Prevent double-booking with database constraint
-- Creates a unique index on appointments to prevent two non-canceled
-- appointments at the same time for the same organization.

create unique index idx_appointments_no_double_book
  on appointments (organization_id, scheduled_at)
  where status != 'canceled';
