-- Database-level setup. Runs once as a superuser while connected to the resourcehub database.
ALTER SCHEMA public OWNER TO resourcehub_migrator;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO resourcehub_app, resourcehub_platform;
REVOKE ALL ON DATABASE resourcehub FROM PUBLIC;
GRANT CONNECT ON DATABASE resourcehub TO resourcehub_app, resourcehub_platform, resourcehub_migrator;
