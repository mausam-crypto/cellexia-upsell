// Single source of truth for the backend build identity. Surfaced by
// GET /api/health?probe=version (public, non-sensitive) and in the Debug tab
// header, so "which version is actually deployed on Render?" is answered by a
// URL instead of by inference. Bump on every release together with
// package.json.
export const APP_VERSION = "1.9.0";
export const APP_VERSION_DATE = "2026-08-18";
