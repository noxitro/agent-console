/**
 * Runs before every test file (vitest `setupFiles`).
 *
 * `src/core/paths.ts` reads `AC_HOME` before the legacy `AM_HOME`, and most
 * tests isolate HOME by setting `AM_HOME` to a temporary directory. A developer
 * who has `AC_HOME` (or `AC_APPDATA` / `AC_CONFIG_HOME`) set in their own shell
 * would otherwise have every one of those tests resolve paths under *their*
 * directory instead of the temporary one. Clearing the three here keeps each
 * test in the HOME it built for itself; tests that exercise `AC_*` set them
 * explicitly.
 */

for (const name of ["AC_HOME", "AC_APPDATA", "AC_CONFIG_HOME"]) {
  delete process.env[name];
}
