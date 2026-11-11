-- Shapes the database like a fresh Neon project: the owner is NOT a superuser.
-- Runs once, as the container's superuser, on first start.
CREATE ROLE neondb_owner LOGIN PASSWORD 'owner_sim_pw' CREATEDB CREATEROLE BYPASSRLS;
CREATE DATABASE neondb OWNER neondb_owner;
